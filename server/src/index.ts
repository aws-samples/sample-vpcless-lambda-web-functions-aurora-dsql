import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { config } from '../../config';
import { createApp } from './app';
import { APP_ROLE, createDatabase } from './db';
import { log } from './log';
import { ssmAuthSettings } from './middleware';
import { ListRepository, TodoRepository, UserRepository } from './repository';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

const region = requireEnv('AWS_REGION');

// Keep the pool lazy: Lambda requires the server to listen within 10 seconds of start.
const database = createDatabase({
  host: requireEnv('DSQL_ENDPOINT'),
  user: APP_ROLE,
  ...config.database.pool,
});

const app = createApp({
  users: new UserRepository(database),
  lists: new ListRepository(database),
  todos: new TodoRepository(database),
  auth: ssmAuthSettings(requireEnv('AUTH_CONFIG_PARAMETER'), region),
  staticRoot: join(import.meta.dirname, 'public'),
  region,
});

// Lambda gives the address in AWS_LAMBDA_HTTP_ENDPOINT. Anywhere else, listen on loopback only.
// https://docs.aws.amazon.com/lambda/latest/dg/web-functions-runtimes.html
const [hostname = '127.0.0.1', port = '3000'] = (process.env.AWS_LAMBDA_HTTP_ENDPOINT ?? '127.0.0.1:3000').split(':');

serve({ fetch: app.fetch, hostname, port: Number(port) }, (info) => {
  log('info', 'listening', { address: info.address, port: info.port });
});

// Lambda allows 1 second after SIGTERM, so exit within it.
process.on('SIGTERM', () => {
  void database.destroy().finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 800).unref();
});
