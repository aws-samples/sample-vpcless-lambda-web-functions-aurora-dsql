import { AuroraDSQLPool } from '@aws/aurora-dsql-node-postgres-connector';
import {
  type DatabaseConnection,
  type Dialect,
  type Driver,
  type Generated,
  Kysely,
  PostgresDialect,
  type Selectable,
  type TransactionSettings,
} from 'kysely';
import { log } from './log';

interface PoolSettings {
  host: string;
  user: string;
  max: number;
  connectionTimeoutMillis: number;
}

/** AuroraDSQLPool, not a plain pg.Pool: it makes a fresh IAM auth token for every new connection, so none uses an expired one. */
export function createDatabase(settings: PoolSettings): Database {
  const pool = new AuroraDSQLPool({
    host: settings.host,
    // Always set: the connector defaults to `admin` (dsql:DbConnectAdmin).
    user: settings.user,
    max: settings.max,
    // pg-pool waits forever by default; give up and answer 503 instead.
    connectionTimeoutMillis: settings.connectionTimeoutMillis,
  });

  // Without an 'error' listener, an idle connection closed by the server crashes the process.
  pool.on('error', (error) => {
    log('warn', 'idle database connection failed', { error: String(error) });
  });

  return new Database(new Kysely<DB>({ dialect: guardConnect(new PostgresDialect({ pool })) }));
}

// Aurora DSQL has no lock waits: a concurrent change fails with 40001 at commit, so the caller must retry. A
// 'not-idempotent' statement whose connection dropped after SQL was sent may have committed, so it is never re-run.

const CONFLICT_RETRY_DELAYS_MS: readonly number[] = [50, 100, 200];
const CONFLICT_RETRY_JITTER = 0.25;
const CONNECT_RETRY_DELAY_MS = 50;

/** Mark a statement 'idempotent' only if running it twice has the same effect as once: it may be re-run. */
export type Rerun = 'idempotent' | 'not-idempotent';

export class ConflictError extends Error {
  constructor(cause: unknown) {
    super('Could not complete the request because of concurrent changes. Try again.', { cause });
    this.name = 'ConflictError';
  }
}

export class OutcomeUnknownError extends Error {
  constructor(cause: unknown) {
    super('The connection to the database was lost; the change may or may not have been saved.', { cause });
    this.name = 'OutcomeUnknownError';
  }
}

export class UnavailableError extends Error {
  constructor(
    readonly reason: 'busy' | 'unreachable',
    cause: unknown,
  ) {
    super('The database is not reachable.', { cause });
    this.name = 'UnavailableError';
  }
}

export interface RetryOptions {
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class Database {
  constructor(
    private readonly kysely: Kysely<DB>,
    private readonly options: RetryOptions = {},
  ) {}

  destroy(): Promise<void> {
    return this.kysely.destroy();
  }

  /** `run` is called again on each retry, so it must be safe to run more than once. */
  async statement<T>(rerun: Rerun, run: (db: Kysely<DB>) => Promise<T>): Promise<T> {
    const sleep = this.options.sleep ?? defaultSleep;
    const random = this.options.random ?? Math.random;
    let conflictRetries = 0;
    let staleSchemaRetried = false;
    let lostConnectionRetried = false;
    let connectRetried = false;

    for (;;) {
      try {
        return await run(this.kysely);
      } catch (error) {
        if (error instanceof ConnectError) {
          // A pool timeout means every connection is in use; waiting would only lengthen the queue.
          if (isPoolTimeout(error.cause)) throw new UnavailableError('busy', error.cause);
          if (connectRetried) throw new UnavailableError('unreachable', error.cause);
          connectRetried = true;
          await sleep(CONNECT_RETRY_DELAY_MS * (1 + random()));
          continue;
        }

        // OC001 is a stale cached schema, not contention: one retry, no wait.
        if (isStaleSchema(error)) {
          if (staleSchemaRetried) throw new ConflictError(error);
          staleSchemaRetried = true;
          log('warn', 'retrying after an Aurora DSQL OCC conflict', { conflict: 'OC001', rerun, attempt: 1 });
          continue;
        }

        if (isDataConflict(error)) {
          const delay = CONFLICT_RETRY_DELAYS_MS[conflictRetries];
          if (delay === undefined) throw new ConflictError(error);
          conflictRetries += 1;
          log('warn', 'retrying after an Aurora DSQL OCC conflict', { conflict: 'OC000', rerun, attempt: conflictRetries });
          await sleep(delay * (1 + CONFLICT_RETRY_JITTER * random()));
          continue;
        }

        if (isDroppedConnection(error)) {
          if (rerun === 'not-idempotent') throw new OutcomeUnknownError(error);
          if (!lostConnectionRetried) {
            lostConnectionRetried = true;
            continue;
          }
          throw new UnavailableError('unreachable', error);
        }

        throw error;
      }
    }
  }
}

const SERIALIZATION_FAILURE = '40001';

function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') return error.code;
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Matches the message: Aurora DSQL reports OC000 and OC001 under the same SQLSTATE 40001. */
export function isStaleSchema(error: unknown): boolean {
  return errorCode(error) === SERIALIZATION_FAILURE && errorMessage(error).includes('OC001');
}

export function isDataConflict(error: unknown): boolean {
  return errorCode(error) === SERIALIZATION_FAILURE && !isStaleSchema(error);
}

export function isForeignKeyViolation(error: unknown, constraint: string): boolean {
  return (
    errorCode(error) === '23503' &&
    typeof error === 'object' &&
    error !== null &&
    'constraint' in error &&
    error.constraint === constraint
  );
}

/** pg-pool's message when no client became free within connectionTimeoutMillis. */
export function isPoolTimeout(error: unknown): boolean {
  return /timeout exceeded when trying to connect/i.test(errorMessage(error));
}

/** Also matches `pg`'s wording: when the socket closes, the error can have no code at all. */
export function isDroppedConnection(error: unknown): boolean {
  const code = errorCode(error) ?? '';
  return (
    /^08[0-9A-Z]{3}$/.test(code) ||
    ['57P01', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT'].includes(code) ||
    /socket hang up|connection.*closed|Connection terminated/i.test(errorMessage(error))
  );
}

// Wraps the Driver because only acquireConnection proves no SQL was sent: Database.statement retries a ConnectError even
// for a not-idempotent statement, and must not retry a failure after SQL was sent.

export class ConnectError extends Error {
  constructor(cause: unknown) {
    super('Could not get a database connection', { cause });
    this.name = 'ConnectError';
  }
}

class ConnectGuardDriver implements Driver {
  constructor(private readonly inner: Driver) {}

  init() {
    return this.inner.init();
  }

  async acquireConnection(): Promise<DatabaseConnection> {
    try {
      return await this.inner.acquireConnection();
    } catch (error) {
      throw new ConnectError(error);
    }
  }

  beginTransaction(connection: DatabaseConnection, settings: TransactionSettings) {
    return this.inner.beginTransaction(connection, settings);
  }
  commitTransaction(connection: DatabaseConnection) {
    return this.inner.commitTransaction(connection);
  }
  rollbackTransaction(connection: DatabaseConnection) {
    return this.inner.rollbackTransaction(connection);
  }
  releaseConnection(connection: DatabaseConnection) {
    return this.inner.releaseConnection(connection);
  }
  destroy() {
    return this.inner.destroy();
  }
  // No savepoint methods on purpose: Aurora DSQL has no SAVEPOINT, so Kysely fails before sending one.
  // https://docs.aws.amazon.com/aurora-dsql/latest/userguide/working-with-postgresql-compatibility-supported-sql-features.html
}

export function guardConnect(dialect: Dialect): Dialect {
  return {
    createAdapter: () => dialect.createAdapter(),
    createDriver: () => new ConnectGuardDriver(dialect.createDriver()),
    createIntrospector: (db) => dialect.createIntrospector(db),
    createQueryCompiler: () => dialect.createQueryCompiler(),
  };
}

export interface UsersTable {
  id: string;
  display_name: string;
  created_at: Generated<Date>;
}

export interface ListsTable {
  id: Generated<string>;
  name: string;
  created_by: string;
  created_at: Generated<Date>;
}

export interface TodosTable {
  id: Generated<string>;
  list_id: string;
  title: string;
  completed: Generated<boolean>;
  version: Generated<number>;
  updated_by: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export const APP_ROLE = 'todo_app';

export interface DB {
  users: UsersTable;
  lists: ListsTable;
  todos: TodosTable;
}

export type ListRow = Selectable<ListsTable>;

export type ListSummaryRow = ListRow & { created_by_name: string; open_count: number; total_count: number };

export type TodoRow = Omit<Selectable<TodosTable>, 'updated_by'> & { updated_by_name: string };
