import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { serveStatic } from '@hono/node-server/serve-static';
import { z } from '@hono/zod-openapi';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { FetchError } from 'aws-jwt-verify/error';
import type { Context, Hono, Env as HonoEnv, MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { log } from './log';
import type { PublicConfig } from './schemas';

export type Env = { Variables: { caller: Caller } };

/** Register before the routes, or the responses of routes registered earlier get no security headers. */
export function securityHeaders<E extends HonoEnv>(app: Hono<E>, region: string): void {
  app.use(
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        // Mantine sets CSS variables and some styles inline.
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        // A wildcard for the managed login domain: it is read from SSM after startup, so it is not known here.
        connectSrc: [
          "'self'",
          `https://cognito-idp.${region}.amazonaws.com`,
          `https://*.auth.${region}.amazoncognito.com`,
        ],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    }),
  );
}

export const noStore: MiddlewareHandler<Env> = async (c, next) => {
  await next();
  c.res.headers.set('Cache-Control', 'no-store');
};

export const limitBody = bodyLimit({
  maxSize: 16 * 1024,
  onError: (c) => c.json({ error: 'payload_too_large', message: 'The body is larger than 16 KiB.' }, 413),
});

/** A FetchError (JWKS not fetched) is 503, not 401, so a Cognito outage does not send the user back to sign-in. */
export function requireCaller(auth: AuthSettings): MiddlewareHandler<Env> {
  return async (c, next) => {
    const match = /^Bearer ([A-Za-z0-9\-_.]+)$/.exec(c.req.header('authorization') ?? '');
    if (!match?.[1]) return unauthorized(c);
    let verifier;
    try {
      verifier = await auth.verifier();
    } catch (error) {
      return authUnavailable(c, error);
    }
    try {
      c.set('caller', await verifier.verify(match[1]));
    } catch (error) {
      if (error instanceof FetchError) return authUnavailable(c, error);
      return unauthorized(c);
    }
    await next();
  };
}

export function unauthorized(c: Context) {
  c.header('WWW-Authenticate', 'Bearer');
  return c.json({ error: 'unauthorized', message: 'Sign in again.' }, 401);
}

export function authUnavailable(c: Context, error: unknown) {
  log('error', 'authentication unavailable', { error: String(error) });
  return c.json({ error: 'service_unavailable', message: 'Try again later.' }, 503);
}

export interface Caller {
  sub: string;
  username: string;
}

interface TokenVerifier {
  verify(token: string): Promise<Caller>;
}

export interface AuthSettings {
  publicConfig(): Promise<PublicConfig>;
  verifier(): Promise<TokenVerifier>;
}

const StoredAuthConfigSchema = z.object({
  userPoolId: z.string().min(1),
  clientId: z.string().min(1),
  domain: z.url(),
});

/** From SSM, not environment variables, to avoid a dependency cycle: see AUTH_CONFIG_PARAMETER in cdk/lib/todo-stack.ts. */
export function ssmAuthSettings(parameterName: string, region: string): AuthSettings {
  const ssm = new SSMClient({ region });
  let loading: Promise<{ config: PublicConfig; verifier: TokenVerifier }> | undefined;

  const load = () => {
    loading ??= (async () => {
      const result = await ssm.send(new GetParameterCommand({ Name: parameterName }));
      const stored = StoredAuthConfigSchema.parse(JSON.parse(result.Parameter?.Value ?? 'null'));
      const jwt = CognitoJwtVerifier.create({
        userPoolId: stored.userPoolId,
        tokenUse: 'access',
        clientId: stored.clientId,
      });
      const verifier: TokenVerifier = {
        async verify(token) {
          const payload = await jwt.verify(token);
          return { sub: payload.sub, username: payload.username };
        },
      };
      return { config: { region, ...stored }, verifier };
    })().catch((error: unknown) => {
      loading = undefined; // otherwise one failed load would fail every later request
      throw error;
    });
    return loading;
  };

  return {
    publicConfig: async () => (await load()).config,
    verifier: async () => (await load()).verifier,
  };
}

const IMMUTABLE = 'public, max-age=31536000, immutable';

export function mountStatic<E extends HonoEnv>(app: Hono<E>, staticRoot: string): void {
  app.use('/assets/*', async (c, next) => {
    await next();
    c.res.headers.set('Cache-Control', c.res.ok ? IMMUTABLE : 'no-store');
  });
  app.use('/assets/*', serveStatic({ root: staticRoot }));
  app.get('/assets/*', (c) => c.text('Not Found', 404));
  app.get('*', async (c, next) => {
    await next();
    if (c.res.ok) c.res.headers.set('Cache-Control', 'no-cache');
  });
  app.get('*', serveStatic({ root: staticRoot, path: 'index.html' }));
}
