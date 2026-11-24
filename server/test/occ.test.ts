import { describe, expect, it, vi } from 'vitest';
import { ConflictError, OutcomeUnknownError, UnavailableError } from '../src/db';
import { conflict, fakeDatabase, pgError, staleSchema } from './fake-database';

const selectOne = (db: ReturnType<typeof fakeDatabase>['database']) =>
  db.statement('idempotent', (k) => k.selectFrom('todos').select('id').execute());

const updateOne = (db: ReturnType<typeof fakeDatabase>['database']) =>
  db.statement('not-idempotent', (k) => k.updateTable('todos').set({ title: 'x' }).execute());

/** Responds with `errors` one by one, then with an empty result. */
function failing(...errors: Error[]) {
  return () => {
    const next = errors.shift();
    if (next) throw next;
    return [];
  };
}

describe('Database.statement (one statement outside a transaction)', () => {
  it('gives up after three retries with a ConflictError; the delays stay within the jitter bounds', async () => {
    // random 0 gives the base delays (lower bound); random 1 gives base x 1.25.
    const base = fakeDatabase(() => {
      throw conflict();
    });
    await expect(selectOne(base.database)).rejects.toBeInstanceOf(ConflictError);
    expect(base.executed).toHaveLength(4);
    expect(base.sleeps).toEqual([50, 100, 200]);

    const jittered = fakeDatabase(
      () => {
        throw conflict();
      },
      undefined,
      () => 1,
    );
    await expect(selectOne(jittered.database)).rejects.toBeInstanceOf(ConflictError);
    expect(jittered.sleeps).toEqual([62.5, 125, 250]);
  });

  it('re-runs OC001 exactly once, without waiting', async () => {
    const once = fakeDatabase(failing(staleSchema()));
    await expect(selectOne(once.database)).resolves.toEqual([]);
    expect(once.executed).toHaveLength(2);
    expect(once.sleeps).toEqual([]);

    const twice = fakeDatabase(failing(staleSchema(), staleSchema()));
    await expect(selectOne(twice.database)).rejects.toBeInstanceOf(ConflictError);
    expect(twice.executed).toHaveLength(2);
  });

  it('re-runs an idempotent statement once after a lost connection, then gives the error back', async () => {
    const once = fakeDatabase(failing(new Error('Connection terminated unexpectedly')));
    await expect(selectOne(once.database)).resolves.toEqual([]);
    expect(once.executed).toHaveLength(2);

    const twice = fakeDatabase(
      failing(new Error('Connection terminated unexpectedly'), new Error('Connection terminated unexpectedly')),
    );
    await expect(selectOne(twice.database)).rejects.toMatchObject({ name: 'UnavailableError', reason: 'unreachable' });
    expect(twice.executed).toHaveLength(2);
  });

  it('never re-runs a not-idempotent statement after a lost connection and does not wait: the outcome is unknown', async () => {
    for (const lost of [new Error('Connection terminated unexpectedly'), pgError('ECONNRESET', 'read ECONNRESET')]) {
      const { database, executed, sleeps } = fakeDatabase(failing(lost), undefined, () => 0.5);
      await expect(updateOne(database)).rejects.toBeInstanceOf(OutcomeUnknownError);
      expect(executed).toHaveLength(1);
      expect(sleeps).toEqual([]);
    }
  });

  it('re-runs once, after a wait, when getting the connection fails (no SQL was sent); a second failure is unreachable', async () => {
    let connects = 0;
    const once = fakeDatabase(
      () => [],
      () => {
        if (++connects === 1) throw new Error('Failed to generate DSQL token: ECONNRESET');
      },
    );
    await updateOne(once.database);
    expect(connects).toBe(2);
    expect(once.executed).toHaveLength(1);
    expect(once.sleeps).toEqual([50]);

    const always = fakeDatabase(
      () => [],
      () => {
        throw new Error('Connection terminated unexpectedly');
      },
    );
    await expect(updateOne(always.database)).rejects.toMatchObject({ name: 'UnavailableError', reason: 'unreachable' });
    expect(always.executed).toHaveLength(0);
  });

  it('does not retry or wait on a pool timeout (busy)', async () => {
    let connects = 0;
    const { database, sleeps } = fakeDatabase(
      () => [],
      () => {
        connects += 1;
        throw new Error('timeout exceeded when trying to connect');
      },
      () => 0.5,
    );
    await expect(updateOne(database)).rejects.toMatchObject({ name: 'UnavailableError', reason: 'busy' });
    expect(connects).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it('still retries a not-idempotent statement on 40001 (the database answered: not committed)', async () => {
    const { database, executed, sleeps } = fakeDatabase(failing(conflict(), staleSchema()));
    await updateOne(database);
    expect(executed).toHaveLength(3);
    expect(sleeps).toEqual([50]);
  });

  it('does not retry other errors', async () => {
    const { database, executed } = fakeDatabase(failing(pgError('42601', 'syntax error')));
    await expect(selectOne(database)).rejects.toThrow('syntax error');
    expect(executed).toHaveLength(1);
  });

  it('logs one line per OCC conflict retry so the retries can be seen in the logs', async () => {
    const lines = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { database } = fakeDatabase(failing(conflict(), staleSchema()));
      await updateOne(database);
      const retries = lines.mock.calls
        .map(([line]) => line as { message?: string })
        .filter((line) => line.message === 'retrying after an Aurora DSQL OCC conflict');
      expect(retries).toMatchObject([{ conflict: 'OC000', attempt: 1 }, { conflict: 'OC001' }]);
    } finally {
      lines.mockRestore();
    }
  });
});
