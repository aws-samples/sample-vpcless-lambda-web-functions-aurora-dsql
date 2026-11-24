/**
 * A Kysely driver that never opens a connection. Each SQL statement the real
 * code compiles is passed to `respond`, which returns rows or throws a
 * `pg`-shaped error (for example SQLSTATE 40001).
 */
import {
  CompiledQuery,
  type DatabaseConnection,
  type Driver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type QueryResult,
} from 'kysely';
import { type DB, Database, guardConnect, type ListRow, type ListSummaryRow, type TodoRow } from '../src/db';

export interface FakeQuery {
  sql: string;
  parameters: readonly unknown[];
}

export type Responder = (query: FakeQuery) => unknown[] | Promise<unknown[]>;

class FakeDriver implements Driver {
  constructor(
    private readonly respond: Responder,
    private readonly executed: FakeQuery[],
    private readonly onConnect: () => void,
  ) {}

  async init() {}
  async releaseConnection() {}
  async destroy() {}

  async acquireConnection(): Promise<DatabaseConnection> {
    this.onConnect(); // throws to simulate a failure before any SQL is sent
    const run = async <R>(query: CompiledQuery): Promise<QueryResult<R>> => {
      const recorded = { sql: query.sql, parameters: query.parameters };
      this.executed.push(recorded);
      return { rows: (await this.respond(recorded)) as R[] };
    };
    return {
      executeQuery: run,
      streamQuery: () => {
        throw new Error('not used');
      },
    };
  }

  // The application runs one autocommit statement at a time (see db.ts).
  async beginTransaction(): Promise<void> {
    throw new Error('not used');
  }
  async commitTransaction(): Promise<void> {
    throw new Error('not used');
  }
  async rollbackTransaction(): Promise<void> {
    throw new Error('not used');
  }
}

/**
 * A Database whose OCC backoff does not wait; the requested delays are
 * recorded. `random` defaults to 0 (no jitter), so the recorded delays are
 * the base delays. The dialect is wrapped with the real guardConnect().
 */
export function fakeDatabase(respond: Responder, onConnect: () => void = () => {}, random: () => number = () => 0) {
  const executed: FakeQuery[] = [];
  const sleeps: number[] = [];
  const kysely = new Kysely<DB>({
    dialect: guardConnect({
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new FakeDriver(respond, executed, onConnect),
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    }),
  });
  const database = new Database(kysely, {
    random,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { database, executed, sleeps };
}

/** An error as `pg` reports it: SQLSTATE in `code`. */
export function pgError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

export const conflict = () => pgError('40001', 'change conflicts with another transaction, please retry: (OC000)');
export const staleSchema = () => pgError('40001', 'schema has been updated by another transaction, please retry: (OC001)');

export const LIST_ID = '7d1e9b2a-4c3f-4a8e-9b6d-2e5f1a0c3b4d';

/** An error as `pg` reports a broken foreign key: the constraint name in `constraint`. */
export const foreignKeyViolation = (constraint = 'todos_list_id_fkey') =>
  Object.assign(pgError('23503', `insert or update on table "todos" violates foreign key constraint "${constraint}"`), {
    constraint,
  });

export function listRow(overrides: Partial<ListRow> = {}): ListRow {
  return {
    id: LIST_ID,
    name: 'Groceries',
    created_by: 'sub-alice',
    created_at: new Date('2026-11-13T00:00:00.000Z'),
    ...overrides,
  };
}

export function listSummaryRow(overrides: Partial<ListSummaryRow> = {}): ListSummaryRow {
  return { ...listRow(), created_by_name: 'alice', open_count: 0, total_count: 0, ...overrides };
}

export function todoRow(overrides: Partial<TodoRow> = {}): TodoRow {
  return {
    id: '3f8a2c1e-5b7d-4e9f-8a6b-1c2d3e4f5a6b',
    list_id: LIST_ID,
    title: 'Buy milk',
    completed: false,
    version: 1,
    updated_by_name: 'alice',
    created_at: new Date('2026-11-13T00:00:00.000Z'),
    updated_at: new Date('2026-11-13T00:00:00.000Z'),
    ...overrides,
  };
}
