import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createIndexAsync, migrate, readSettings, Session, type SqlClient } from '../src/migrate';
import { conflict, pgError } from './fake-database';

// Keep the migration's progress lines ('applying', 'retrying') out of the test output.
beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

/**
 * A fake admin session that records SQL and answers pg_index lookups from
 * `validity`, in order (undefined = the index does not exist).
 */
function fakeSession(validity: Array<boolean | undefined>) {
  const sql: string[] = [];
  const client = {
    async query(text: string) {
      sql.push(text);
      if (text.includes('pg_index')) {
        const valid = validity.shift();
        return { rows: valid === undefined ? [] : [{ valid }] };
      }
      if (text.startsWith('CREATE INDEX ASYNC')) return { rows: [{ job_id: 'job1' }] };
      return { rows: [] };
    },
  };
  const session = { run: <T>(_step: string, work: (db: never) => Promise<T>) => work(client as never) };
  return { session, sql };
}

const STATEMENT = 'CREATE INDEX ASYNC IF NOT EXISTS todos_idx ON todos (created_at, id)';

// Aurora DSQL builds every index asynchronously (the ASYNC keyword is
// required).
describe('createIndexAsync', () => {
  it('does nothing when the index is already valid', async () => {
    const { session, sql } = fakeSession([true]);
    await createIndexAsync(session, '0002.sql', 'todos_idx', STATEMENT);
    expect(sql.some((text) => text.startsWith('CREATE INDEX ASYNC'))).toBe(false);
  });

  it('drops a leftover INVALID index, then builds it again', async () => {
    const { session, sql } = fakeSession([false, true]);
    await createIndexAsync(session, '0002.sql', 'todos_idx', STATEMENT);
    expect(sql.indexOf('DROP INDEX todos_idx')).toBeGreaterThan(-1);
    expect(sql.indexOf('DROP INDEX todos_idx')).toBeLessThan(sql.indexOf(STATEMENT));
  });

  it('drops the index and fails when it is still not valid after the wait', async () => {
    const { session, sql } = fakeSession([undefined, false]);
    await expect(createIndexAsync(session, '0002.sql', 'todos_idx', STATEMENT)).rejects.toThrow(/did not finish/);
    expect(sql.some((text) => text.startsWith('DROP INDEX IF EXISTS todos_idx'))).toBe(true);
  });
});

describe('Session.run', () => {
  const client: SqlClient = { query: async () => ({ rows: [], rowCount: 0 }), end: async () => {} };

  it('opens the connection again after it failed, with exponential backoff', async () => {
    const sleeps: number[] = [];
    let fails = 2;
    let connects = 0;
    const open = async () => {
      if (fails-- > 0) throw pgError('ECONNRESET', 'read ECONNRESET');
      connects += 1;
      return client;
    };
    await new Session(open, async (ms) => {
      sleeps.push(ms);
    }).run('step', (db) => db.query('SELECT 1'));
    expect(connects).toBe(1);
    expect(sleeps).toEqual([100, 200]);
  });

  it('runs the step again after a 40001 conflict', async () => {
    const sleeps: number[] = [];
    let conflicts = 1;
    await new Session(async () => client, async (ms) => {
      sleeps.push(ms);
    }).run('step', (db) => {
      if (conflicts-- > 0) throw conflict();
      return db.query('SELECT 1');
    });
    expect(sleeps).toEqual([100]);
  });
});

/** A migrations directory backed by a tiny in-memory _migrations table. */
function fakeServer() {
  const recorded = new Set<string>();
  const sent: string[] = [];
  const client: SqlClient = {
    async query<R>(text: string, values?: unknown[]) {
      sent.push(text);
      let rows: unknown[] = [];
      if (text.startsWith('SELECT name FROM _migrations')) {
        rows = [...recorded].map((name) => ({ name }));
      } else if (text.startsWith('INSERT INTO _migrations')) {
        recorded.add(String(values?.[0]));
      }
      return { rows: rows as R[], rowCount: rows.length };
    },
    async end() {},
  };
  return { sent, session: () => new Session(async () => client) };
}

describe('migrate', () => {
  let directory: string;
  const setup = () => {
    directory = mkdtempSync(join(tmpdir(), 'migrations-'));
    writeFileSync(join(directory, '0001_create_items.sql'), 'CREATE TABLE items (id uuid PRIMARY KEY)');
    return fakeServer();
  };
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it('runs each new file once and records it in _migrations', async () => {
    const server = setup();
    await migrate(server.session(), directory);
    expect(server.sent.filter((text) => text.startsWith('CREATE TABLE items'))).toHaveLength(1);
    await migrate(server.session(), directory);
    expect(server.sent.filter((text) => text.startsWith('CREATE TABLE items'))).toHaveLength(1);
  });
});

describe('readSettings', () => {
  afterEach(() => {
    delete process.env.DSQL_ENDPOINT;
    delete process.env.APP_ROLE_IAM_ARN;
  });

  // The ARN is interpolated into AWS IAM GRANT, so a value with a quote (or any
  // other shape) must be rejected before it reaches the SQL.
  it('rejects an ARN that is not a plain IAM role ARN', () => {
    process.env.DSQL_ENDPOINT = 'cluster.dsql.example';
    process.env.APP_ROLE_IAM_ARN = "arn:aws:iam::123456789012:role/x'; DROP TABLE todos; --";
    expect(() => readSettings()).toThrow(/Invalid IAM role ARN/);
  });
});
