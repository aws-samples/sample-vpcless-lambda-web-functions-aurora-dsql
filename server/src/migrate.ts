// Aurora DSQL allows one DDL per transaction and no DML in it: keep one DDL statement per migrations/*.sql file.
// https://docs.aws.amazon.com/aurora-dsql/latest/userguide/working-with-ddl.html
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AuroraDSQLClient } from '@aws/aurora-dsql-node-postgres-connector';
import type { CloudFormationCustomResourceEvent } from 'aws-lambda';
import { APP_ROLE, isDataConflict, isStaleSchema } from './db';
import { log } from './log';

/** From the environment, not the event: otherwise anyone who can invoke this function could map any role to the app role. */
interface Settings {
  endpoint: string;
  appRoleIamArn: string;
}

const PHYSICAL_ID = 'database-schema';
const MAX_ATTEMPTS = 6;
const IAM_ROLE_ARN = /^arn:aws[a-z-]*:iam::\d{12}:role\/[\w+=,.@/-]{1,512}$/;
const APP_TABLES = ['users', 'lists', 'todos'] as const;
const CREATE_INDEX_ASYNC = /^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s+ASYNC\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)/i;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function handler(event: CloudFormationCustomResourceEvent): Promise<{ PhysicalResourceId: string }> {
  // The cluster is deleted with the stack, so there is nothing to undo; running the migration here could block the delete.
  if (event.RequestType === 'Delete') return { PhysicalResourceId: event.PhysicalResourceId };

  const settings = readSettings();

  const session = new Session(() => openAdminConnection(settings.endpoint));
  try {
    await migrate(session, join(import.meta.dirname, 'migrations'));
    await grantAppRole(session, settings);
  } finally {
    await session.close();
  }
  return { PhysicalResourceId: PHYSICAL_ID };
}

export function readSettings(): Settings {
  const endpoint = requireEnv('DSQL_ENDPOINT');
  const appRoleIamArn = requireEnv('APP_ROLE_IAM_ARN');
  if (!IAM_ROLE_ARN.test(appRoleIamArn)) throw new Error(`Invalid IAM role ARN: ${appRoleIamArn}`);
  return { endpoint, appRoleIamArn };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

export interface SqlClient {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;
  end(): Promise<void>;
}

async function openAdminConnection(host: string): Promise<SqlClient> {
  const client = new AuroraDSQLClient({ host, user: 'admin' });
  client.on('error', (error) => log('warn', 'connection error', { error: String(error) }));
  try {
    await client.connect();
  } catch (error) {
    await client.end().catch(() => undefined);
    throw error;
  }
  return client;
}

export class Session {
  private client: SqlClient | undefined;
  constructor(
    private readonly open: () => Promise<SqlClient>,
    private readonly sleep: (ms: number) => Promise<void> = defaultSleep,
  ) {}

  // Retries only a failed connect and 40001. After a lost connection the DDL may have committed, so the step is not
  // re-run here; IF NOT EXISTS lets the next deploy run it again.
  async run<T>(step: string, work: (client: SqlClient) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      let client: SqlClient;
      try {
        client = await this.connect();
      } catch (error) {
        if (attempt >= MAX_ATTEMPTS) throw error;
        await this.backoff(step, attempt, error);
        continue;
      }
      try {
        return await work(client);
      } catch (error) {
        if (isDataConflict(error) || isStaleSchema(error)) {
          if (attempt >= MAX_ATTEMPTS) throw error;
          await this.backoff(step, attempt, error);
          continue;
        }
        throw error;
      }
    }
  }

  private async backoff(step: string, attempt: number, error: unknown): Promise<void> {
    const delay = 100 * 2 ** (attempt - 1);
    log('warn', 'retrying', { step, attempt, delay, error: String(error) });
    await this.sleep(delay);
  }

  private async connect(): Promise<SqlClient> {
    this.client ??= await this.open();
    return this.client;
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    await client?.end().catch(() => undefined);
  }
}

export async function migrate(session: Pick<Session, 'run'>, directory: string): Promise<void> {
  await session.run('create _migrations', (db) =>
    db.query(
      'CREATE TABLE IF NOT EXISTS _migrations (name varchar(255) PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    ),
  );
  const applied = new Set(
    (await session.run('read _migrations', (db) => db.query<{ name: string }>('SELECT name FROM _migrations'))).rows.map(
      (row) => row.name,
    ),
  );

  const files = readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  for (const name of files) {
    // Applied by name only: an edited applied file is never re-run, so change the schema in a new file.
    if (applied.has(name)) continue;
    const statement = readFileSync(join(directory, name), 'utf8');
    const indexName = CREATE_INDEX_ASYNC.exec(withoutComments(statement))?.[1];
    log('info', 'applying', { name });
    // The DDL and its record cannot share a transaction; IF NOT EXISTS makes re-running an unrecorded file safe.
    if (indexName) await createIndexAsync(session, name, indexName, statement);
    else await session.run(name, (db) => db.query(statement));
    await session.run(`record ${name}`, (db) =>
      db.query('INSERT INTO _migrations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING', [name]),
    );
  }
}

/** A failed build leaves an INVALID index that IF NOT EXISTS would keep forever, so an INVALID index is dropped first. */
export async function createIndexAsync(
  session: Pick<Session, 'run'>,
  name: string,
  indexName: string,
  statement: string,
): Promise<void> {
  const isValid = async (step: string) =>
    (
      await session.run(step, (db) =>
        db.query<{ valid: boolean }>(
          'SELECT i.indisvalid AS valid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = $1',
          [indexName],
        ),
      )
    ).rows[0]?.valid;

  const existing = await isValid(`check ${indexName}`);
  if (existing === true) return;
  if (existing === false) {
    log('warn', 'dropping invalid index', { indexName });
    await session.run(`drop ${indexName}`, (db) => db.query(`DROP INDEX ${indexName}`));
  }

  const job = await session.run(name, (db) => db.query<{ job_id: string }>(statement));
  const jobId = job.rows[0]?.job_id;
  if (!jobId) throw new Error(`${name}: CREATE INDEX ASYNC returned no job_id`);
  // Validity is read from pg_index rather than the wait's Boolean, so an index left INVALID is caught too.
  await session.run(`wait ${jobId}`, (db) => db.query('CALL sys.wait_for_job($1)', [jobId]));
  if ((await isValid(`verify ${indexName}`)) === true) return;

  await session.run(`drop failed ${indexName}`, (db) => db.query(`DROP INDEX IF EXISTS ${indexName}`));
  throw new Error(`${name}: building index ${indexName} did not finish; it was dropped. Deploy again.`);
}

async function grantAppRole(session: Pick<Session, 'run'>, settings: Settings): Promise<void> {
  const roles = await session.run('check role', (db) => db.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [APP_ROLE]));
  if (roles.rowCount === 0) await session.run('create role', (db) => db.query(`CREATE ROLE ${APP_ROLE} WITH LOGIN`));

  const mapped = await session.run('check IAM mapping', (db) =>
    db.query('SELECT 1 FROM sys.iam_pg_role_mappings WHERE pg_role_name = $1 AND arn = $2', [APP_ROLE, settings.appRoleIamArn]),
  );
  // The ARN was checked against IAM_ROLE_ARN, which allows no quote characters.
  if (mapped.rowCount === 0) {
    await session.run('map IAM role', (db) => db.query(`AWS IAM GRANT ${APP_ROLE} TO '${settings.appRoleIamArn}'`));
  }

  // A migration that adds a table must add it to APP_TABLES too, or the app gets permission denied (42501).
  for (const table of APP_TABLES) {
    await session.run(`grant ${table}`, (db) => db.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${table} TO ${APP_ROLE}`));
  }
}

function withoutComments(sql: string): string {
  return sql.replace(/--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
}
