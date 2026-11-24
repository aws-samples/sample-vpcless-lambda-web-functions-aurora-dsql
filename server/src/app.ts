import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { ConflictError, OutcomeUnknownError, UnavailableError } from './db';
import { log } from './log';
import {
  type AuthSettings,
  authUnavailable,
  type Env,
  limitBody,
  mountStatic,
  noStore,
  requireCaller,
  securityHeaders,
} from './middleware';
import { decodeCursor, encodeCursor, type ListRepository, type TodoRepository, type UserRepository } from './repository';
import {
  CreateTodoSchema,
  ErrorSchema,
  IdParamSchema,
  INT4_MAX,
  ListBodySchema,
  ListIdParamSchema,
  ListSummariesSchema,
  ListSummarySchema,
  PublicConfigSchema,
  type Todo,
  TodoIdParamSchema,
  TodoPageSchema,
  TodoSchema,
  toList,
  toListSummary,
  toTodo,
  UpdateTodoSchema,
  VersionConflictSchema,
} from './schemas';

export interface AppOptions {
  users: UserRepository;
  lists: ListRepository;
  todos: TodoRepository;
  auth: AuthSettings;
  staticRoot: string;
  region: string;
}

export const DEFAULT_PAGE_SIZE = 50;
/** Largest page of TODOs; also caps how many lists GET /api/lists returns. */
const MAX_PAGE_SIZE = 100;

const IfMatchHeaderSchema = z.object({
  'if-match': z
    .string()
    // Optional so that a missing header reaches parseIfMatch and gets 428, not the validator's 400.
    .optional()
    .openapi({ description: 'Required. The TODO version in quotes, as sent in ETag or the version field, for example "3". Without it: 428.' }),
});

const jsonBody = <T extends z.ZodType>(schema: T) => ({
  body: { content: { 'application/json': { schema } }, required: true },
});

export function createApp(options: AppOptions): OpenAPIHono<Env> {
  const { users, lists, todos, auth } = options;

  const app = new OpenAPIHono<Env>({
    defaultHook: (result, c) => {
      if (!result.success) {
        return badRequest(c, z.prettifyError(result.error));
      }
    },
  });

  securityHeaders(app, options.region);

  app.use('/api/*', noStore);
  app.use('/api/*', limitBody);
  app.use('/api/lists/*', requireCaller(auth));
  app.use('/api/openapi.json', requireCaller(auth));

  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/config',
      summary: 'Settings the SPA needs to sign in. No authentication.',
      responses: { 200: json(PublicConfigSchema, 'Public settings'), 503: unavailableResponse },
    }),
    async (c) => {
      try {
        return c.json(await auth.publicConfig(), 200);
      } catch (error) {
        return authUnavailable(c, error);
      }
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/lists',
      summary: "Every list, oldest first, with its creator's name and its TODO counts (one JOIN + GROUP BY)",
      responses: {
        200: json(ListSummariesSchema, 'The lists'),
        ...authed,
        409: retriesConflictResponse,
      },
    }),
    async (c) => {
      // shortcut: the first MAX_PAGE_SIZE lists only, no paging; page like the TODOs if you expect more.
      const rows = await lists.summaries(MAX_PAGE_SIZE);
      return c.json({ items: rows.map(toListSummary) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/lists',
      summary: 'Add a list',
      request: jsonBody(ListBodySchema),
      responses: {
        201: json(ListSummarySchema, 'Created'),
        400: badRequestResponse,
        ...authed,
        409: retriesConflictResponse,
        413: tooLargeResponse,
      },
    }),
    async (c) => {
      const { name } = c.req.valid('json');
      const caller = c.get('caller');
      await users.upsert(caller);
      const list = toList(await lists.create(name, caller));
      return c.json({ ...list, createdBy: caller.username, openCount: 0, totalCount: 0 }, 201);
    },
  );

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/api/lists/{id}',
      summary: 'Delete a list: its TODOs in batches first, then the list (not atomic)',
      request: { params: IdParamSchema },
      responses: {
        204: { description: 'Deleted, with its TODOs' },
        400: badRequestResponse,
        ...authed,
        404: notFoundResponse,
        409: retriesConflictResponse,
      },
    }),
    async (c) => {
      const result = await lists.delete(c.req.valid('param').id);
      if (result.kind === 'not-found') return notFound(c);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/lists/{listId}/todos',
      summary: "A list's TODOs, oldest first (keyset pagination), with who changed each last",
      request: {
        params: ListIdParamSchema,
        query: z.object({
          limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
          cursor: z.string().max(512).optional(),
        }),
      },
      responses: {
        200: json(TodoPageSchema, 'One page'),
        400: badRequestResponse,
        ...authed,
        404: notFoundResponse,
        409: retriesConflictResponse,
      },
    }),
    async (c) => {
      const { listId } = c.req.valid('param');
      const { limit = DEFAULT_PAGE_SIZE, cursor } = c.req.valid('query');
      const after = cursor === undefined ? undefined : decodeCursor(cursor);
      if (cursor !== undefined && !after) {
        return badRequest(c, 'The cursor is not valid.');
      }
      // One extra row tells whether there is a next page.
      const rows = await todos.list(listId, limit + 1, after);
      // No rows: an empty list, or no list at all (404).
      if (rows.length === 0 && !(await lists.get(listId))) return notFound(c);
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      const nextCursor = rows.length > limit && last ? encodeCursor(last.created_at, last.id) : null;
      return c.json({ items: page.map(toTodo), nextCursor }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/lists/{listId}/todos',
      summary: 'Add a TODO to a list',
      request: { params: ListIdParamSchema, ...jsonBody(CreateTodoSchema) },
      responses: {
        201: json(TodoSchema, 'Created. The ETag header carries its version.'),
        400: badRequestResponse,
        ...authed,
        404: notFoundResponse,
        409: retriesConflictResponse,
        413: tooLargeResponse,
      },
    }),
    async (c) => {
      const { listId } = c.req.valid('param');
      const { title } = c.req.valid('json');
      const caller = c.get('caller');
      await users.upsert(caller);
      const row = await todos.create(listId, title, caller);
      if (!row) return notFound(c);
      const todo = toTodo(row);
      return c.json(todo, 201, { ETag: etagOf(todo.version) });
    },
  );

  app.openapi(
    createRoute({
      method: 'patch',
      path: '/api/lists/{listId}/todos/{id}',
      summary: 'Change a TODO: title, completed, or both (at least one)',
      request: { params: TodoIdParamSchema, headers: IfMatchHeaderSchema, ...jsonBody(UpdateTodoSchema) },
      responses: {
        200: json(TodoSchema, 'Changed. The ETag header carries the new version.'),
        400: badRequestResponse,
        ...authed,
        404: notFoundResponse,
        409: conflictResponse,
        413: tooLargeResponse,
        428: preconditionRequiredResponse,
      },
    }),
    async (c) => {
      const expected = parseIfMatch(c.req.valid('header')['if-match']);
      if (expected === undefined) return preconditionRequired(c);
      const { listId, id } = c.req.valid('param');
      const caller = c.get('caller');
      await users.upsert(caller);
      const result = await todos.update(listId, id, expected, c.req.valid('json'), caller);
      if (result.kind === 'not-found') return notFound(c);
      if (result.kind === 'conflict') return versionConflict(c, toTodo(result.current));
      const todo = toTodo(result.row);
      return c.json(todo, 200, { ETag: etagOf(todo.version) });
    },
  );

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/api/lists/{listId}/todos/{id}',
      summary: 'Delete a TODO',
      request: { params: TodoIdParamSchema, headers: IfMatchHeaderSchema },
      responses: {
        204: { description: 'Deleted' },
        400: badRequestResponse,
        ...authed,
        404: notFoundResponse,
        409: conflictResponse,
        428: preconditionRequiredResponse,
      },
    }),
    async (c) => {
      const expected = parseIfMatch(c.req.valid('header')['if-match']);
      if (expected === undefined) return preconditionRequired(c);
      const { listId, id } = c.req.valid('param');
      const result = await todos.delete(listId, id, expected);
      if (result.kind === 'not-found') return notFound(c);
      if (result.kind === 'conflict') return versionConflict(c, toTodo(result.current));
      return c.body(null, 204);
    },
  );

  app.doc31('/api/openapi.json', { openapi: '3.1.0', info: { title: 'Shared TODO API', version: '1.0.0' } });

  app.all('/api/*', (c) => notFound(c));

  // After the API routes, so the SPA's catch-all does not shadow them.
  mountStatic(app, options.staticRoot);

  app.notFound((c) => c.text('Not Found', 404));

  app.onError(respondToError);

  return app;
}

export const json = <T extends z.ZodType>(schema: T, description: string) => ({
  content: { 'application/json': { schema } },
  description,
});

const errorResponse = (description: string) => json(ErrorSchema, description);

const unauthorizedResponse = errorResponse('Missing or invalid access token');
export const unavailableResponse = errorResponse('A backend was not reachable, or the outcome of a write is unknown; try again');
export const authed = { 401: unauthorizedResponse, 503: unavailableResponse };
export const preconditionRequiredResponse = errorResponse('If-Match is missing or not a quoted TODO version, for example "3"');
export const notFoundResponse = errorResponse('No such list or TODO');
export const badRequestResponse = errorResponse('Invalid id, query, or body');
export const tooLargeResponse = errorResponse('The body is larger than 16 KiB');
export const retriesConflictResponse = errorResponse('OCC retries did not settle');
const CONFLICT = 'A concurrent change: `current` is present on a version mismatch, absent when OCC retries did not settle.';
export const conflictResponse = json(z.union([VersionConflictSchema, ErrorSchema]), CONFLICT);

export function badRequest(c: Context, message: string) {
  return c.json({ error: 'bad_request', message }, 400);
}

export function notFound(c: Context) {
  return c.json({ error: 'not_found', message: 'Not found.' }, 404);
}

export function preconditionRequired(c: Context) {
  return c.json(
    { error: 'precondition_required', message: 'Send If-Match with the TODO version in quotes, for example "3".' },
    428,
  );
}

export function versionConflict(c: Context, current: Todo) {
  return c.json(
    { error: 'version_conflict', message: 'The version does not match. `current` is the latest.', current },
    409,
    { ETag: etagOf(current.version) },
  );
}

export function respondToError(error: Error, c: Context): Response {
  if (error instanceof ConflictError) {
    return c.json({ error: 'conflict', message: error.message }, 409);
  }
  if (error instanceof OutcomeUnknownError) {
    log('warn', 'database connection lost during a write', { error: String(error.cause) });
    return c.json(
      { error: 'outcome_unknown', message: 'The change may or may not have been saved. Reload and check.' },
      503,
    );
  }
  if (error instanceof UnavailableError) {
    if (error.reason === 'busy') {
      log('warn', 'no free database connection', { error: String(error.cause) });
      return c.json({ error: 'service_unavailable', message: 'The service is busy. Try again.' }, 503);
    }
    log('error', 'could not reach the database', { error: String(error.cause) });
    return c.json({ error: 'service_unavailable', message: 'The database is not reachable. Try again.' }, 503);
  }
  if (error instanceof HTTPException) return error.getResponse();
  log('error', 'unhandled error', { error: String(error), stack: error.stack });
  return c.json({ error: 'internal_error', message: 'Something went wrong.' }, 500);
}

export function etagOf(version: number): string {
  return `"${version}"`;
}

/** Accepts only one strong ETag this API issued; `*` ("any version") would bypass the version check. */
export function parseIfMatch(header: string | undefined): number | undefined {
  if (header === undefined) return undefined;
  const match = /^"([1-9][0-9]{0,9})"$/.exec(header.trim());
  if (!match) return undefined;
  const version = Number(match[1]);
  return version <= INT4_MAX ? version : undefined;
}
