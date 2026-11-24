import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FetchError, JwtExpiredError } from 'aws-jwt-verify/error';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createApp, DEFAULT_PAGE_SIZE } from '../src/app';
import type { AuthSettings, Caller } from '../src/middleware';
import { DELETE_ATTEMPTS, DELETE_BATCH_SIZE, ListRepository, TodoRepository, UserRepository } from '../src/repository';
import {
  conflict,
  type FakeQuery,
  fakeDatabase,
  foreignKeyViolation,
  LIST_ID,
  listRow,
  listSummaryRow,
  type Responder,
  todoRow,
} from './fake-database';

const staticRoot = mkdtempSync(join(tmpdir(), 'todo-static-'));
mkdirSync(join(staticRoot, 'assets'));
writeFileSync(join(staticRoot, 'index.html'), '<!doctype html><title>spa</title>');
writeFileSync(join(staticRoot, 'assets', 'index-abc123.js'), 'console.log(1)');
afterAll(() => rmSync(staticRoot, { recursive: true, force: true }));

const auth: AuthSettings = {
  publicConfig: async () => ({
    region: 'us-east-1',
    userPoolId: 'us-east-1_example',
    clientId: 'exampleclientid',
    domain: 'https://example.auth.us-east-1.amazoncognito.com',
  }),
  verifier: async () => ({
    verify: async (token) => {
      if (token !== 'valid-token') throw new Error('invalid token');
      return { sub: 'sub-alice', username: 'alice' };
    },
  }),
};

function setup(respond: Responder, onConnect?: () => void, authSettings: AuthSettings = auth) {
  // log() writes the expected warnings and errors (500s, retries); keep them out of the test output.
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { database, executed } = fakeDatabase(respond, onConnect);
  const app = createApp({
    users: new UserRepository(database),
    lists: new ListRepository(database),
    todos: new TodoRepository(database),
    auth: authSettings,
    staticRoot,
    region: 'us-east-1',
  });
  const request = (path: string, init: RequestInit = {}, token: string | null = 'valid-token') => {
    const headers = new Headers(init.headers);
    if (token) headers.set('Authorization', `Bearer ${token}`);
    if (init.body) headers.set('Content-Type', 'application/json');
    return app.request(path, { ...init, headers });
  };
  return { request, executed };
}

const ID = todoRow().id;
const TODOS = `/api/lists/${LIST_ID}/todos`;
const TODO = `${TODOS}/${ID}`;
const LIST = `/api/lists/${LIST_ID}`;
const isUpdate = (q: FakeQuery) => q.sql.startsWith('update');
const isSelect = (q: FakeQuery) => q.sql.startsWith('select');
const isUserUpsert = (q: FakeQuery) => q.sql.startsWith('insert into "users"');

describe('authentication', () => {
  it('rejects every /api/lists route without a valid bearer token', async () => {
    const { request, executed } = setup(() => []);
    const missing = await request('/api/lists', {}, null);
    expect(missing.status).toBe(401);
    expect(missing.headers.get('WWW-Authenticate')).toBe('Bearer');
    expect((await request('/api/lists', {}, 'forged')).status).toBe(401);
    for (const [path, method] of [
      ['/api/lists', 'POST'],
      [LIST, 'DELETE'],
      [TODOS, 'GET'],
      [TODOS, 'POST'],
      [TODO, 'PATCH'],
      [TODO, 'DELETE'],
      ['/api/openapi.json', 'GET'],
    ] as const) {
      expect((await request(path, { method }, null)).status).toBe(401);
    }
    expect(executed).toHaveLength(0);
  });

  it('serves /api/config without a token', async () => {
    const { request } = setup(() => []);
    const response = await request('/api/config', {}, null);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ clientId: 'exampleclientid' });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('answers 503 when the token verifier cannot fetch the JWKS, and 401 when the token is expired', async () => {
    const withVerifier = (verify: () => Promise<Caller>) =>
      setup(() => [], undefined, { ...auth, verifier: async () => ({ verify }) }).request('/api/lists');

    const unreachable = await withVerifier(() => {
      throw new FetchError('https://cognito-idp/.well-known/jwks.json', 'network down');
    });
    expect(unreachable.status).toBe(503);
    expect(await unreachable.json()).toMatchObject({ error: 'service_unavailable' });

    const expired = await withVerifier(() => {
      throw new JwtExpiredError('Token expired', '0', '1');
    });
    expect(expired.status).toBe(401);
    expect(expired.headers.get('WWW-Authenticate')).toBe('Bearer');
  });
});

describe('optimistic locking (If-Match / ETag)', () => {
  const body = JSON.stringify({ title: 'Buy oat milk', completed: false });

  // parseIfMatch (server/src/app.ts) accepts only a single strong
  // "<1..int4>"; anything else is 428 and never reaches the database.
  it.each([
    ['missing', undefined],
    ['the wildcard *', '*'],
    ['a weak ETag', 'W/"1"'],
    ['several ETags', '"1", "2"'],
    ['zero', '"0"'],
    ['above the int4 max', '"2147483648"'],
  ])('answers 428 when If-Match is %s, without touching the database', async (_label, ifMatch) => {
    const { request, executed } = setup(() => []);
    const headers: Record<string, string> = ifMatch === undefined ? {} : { 'If-Match': ifMatch };
    const response = await request(TODO, { method: 'PATCH', body, headers });
    expect(response.status).toBe(428);
    expect(await response.json()).toMatchObject({ error: 'precondition_required' });
    expect(executed).toHaveLength(0);
  });

  it('answers 428 without If-Match for DELETE', async () => {
    const { request, executed } = setup(() => []);
    expect((await request(TODO, { method: 'DELETE' })).status).toBe(428);
    expect(executed).toHaveLength(0);
  });

  it('updates when the version matches and returns the new ETag', async () => {
    // The fake returns a row only when the UPDATE carries the expected version,
    // so this checks the If-Match behavior, not the compiled SQL string.
    const { request } = setup((q) =>
      isUpdate(q) && q.parameters.includes(1) ? [todoRow({ title: 'Buy oat milk', version: 2 })] : [],
    );
    const response = await request(TODO, { method: 'PATCH', body, headers: { 'If-Match': '"1"' } });
    expect(response.status).toBe(200);
    expect(response.headers.get('ETag')).toBe('"2"');
    expect(await response.json()).toMatchObject({ title: 'Buy oat milk', version: 2 });
  });

  it('answers 409 with the latest content when the version is stale, for PATCH and DELETE', async () => {
    const latest = todoRow({ title: 'Buy soy milk', version: 3, updated_by_name: 'bob' });
    const { request } = setup((q) => (isSelect(q) ? [latest] : []));
    for (const init of [
      { method: 'PATCH', body, headers: { 'If-Match': '"1"' } },
      { method: 'DELETE', headers: { 'If-Match': '"1"' } },
    ]) {
      const response = await request(TODO, init);
      expect(response.status).toBe(409);
      expect(response.headers.get('ETag')).toBe('"3"');
      expect(await response.json()).toMatchObject({
        error: 'version_conflict',
        current: { title: 'Buy soy milk', version: 3, updatedBy: 'bob' },
      });
    }
  });

  it('answers 404 when the row is gone', async () => {
    const { request } = setup(() => []);
    const response = await request(TODO, { method: 'PATCH', body, headers: { 'If-Match': '"1"' } });
    expect(response.status).toBe(404);
  });

  it('answers 400 when the body changes nothing (neither title nor completed)', async () => {
    const { request, executed } = setup(() => []);
    const response = await request(TODO, {
      method: 'PATCH',
      body: JSON.stringify({}),
      headers: { 'If-Match': '"1"' },
    });
    expect(response.status).toBe(400);
    expect(executed).toHaveLength(0);
  });

  it('deletes when the version matches', async () => {
    const { request } = setup((q) => (q.sql.startsWith('delete') && q.parameters.includes(1) ? [{ id: ID }] : []));
    const response = await request(TODO, { method: 'DELETE', headers: { 'If-Match': '"1"' } });
    expect(response.status).toBe(204);
  });
});

describe('OCC through the API', () => {
  it('answers 409 when two people save the same version: the retried UPDATE matches no row', async () => {
    let updates = 0;
    const current = todoRow({ completed: true, version: 2, updated_by_name: 'bob' });
    const { request } = setup((q) => {
      if (isUpdate(q)) {
        if (++updates === 1) throw conflict();
        return []; // the retry hits version 2, not 1
      }
      return isSelect(q) ? [current] : [];
    });
    const response = await request(TODO, {
      method: 'PATCH',
      body: JSON.stringify({ completed: true }),
      headers: { 'If-Match': '"1"' },
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'version_conflict', current: { version: 2 } });
  });

  it('answers 409 when the retries do not settle', async () => {
    const { request } = setup((q) => {
      if (isUpdate(q)) throw conflict();
      return [];
    });
    const response = await request(TODO, {
      method: 'PATCH',
      body: JSON.stringify({ completed: true }),
      headers: { 'If-Match': '"1"' },
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'conflict' });
  });

  it('answers 503 without a retry when the connection is lost during a write', async () => {
    const { request } = setup((q) => {
      if (isUpdate(q)) throw new Error('Connection terminated unexpectedly');
      return [];
    });
    const response = await request(TODO, {
      method: 'PATCH',
      body: JSON.stringify({ completed: true }),
      headers: { 'If-Match': '"1"' },
    });
    expect(response.status).toBe(503);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ error: 'outcome_unknown' });
  });

  it('answers 503 when a read keeps losing its connection after one retry', async () => {
    const { request } = setup(() => {
      throw new Error('Connection terminated unexpectedly');
    });
    const response = await request(TODOS);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: 'service_unavailable' });
  });

  it('answers 503 when no pooled connection is free in time', async () => {
    const { request } = setup(
      () => [],
      () => {
        throw new Error('timeout exceeded when trying to connect');
      },
    );
    const response = await request(TODOS);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: 'service_unavailable' });
  });
});

describe('todos', () => {
  it('creates a TODO in the list for the signed-in user', async () => {
    // The fake echoes the values the INSERT carried, so the response shows the
    // request reached the database with the title trimmed and the caller's sub.
    const { request, executed } = setup((q) => {
      if (!q.sql.startsWith('insert into "todos"')) return [];
      const [listId, title, updatedBy] = q.parameters as string[];
      expect(updatedBy).toBe('sub-alice');
      return [todoRow({ list_id: listId, title })];
    });
    const response = await request(TODOS, { method: 'POST', body: JSON.stringify({ title: '  Walk the dog ' }) });
    expect(response.status).toBe(201);
    expect(response.headers.get('ETag')).toBe('"1"');
    expect(await response.json()).toMatchObject({ listId: LIST_ID, title: 'Walk the dog', updatedBy: 'alice' });
    // The users upsert runs first, so the foreign key on updated_by holds.
    expect(isUserUpsert(executed[0]!)).toBe(true);
  });

  it('answers 404 when the list is gone: the foreign key on list_id rejects the INSERT', async () => {
    const { request } = setup((q) => {
      if (q.sql.startsWith('insert into "todos"')) throw foreignKeyViolation();
      return [];
    });
    const response = await request(TODOS, { method: 'POST', body: JSON.stringify({ title: 'Walk the dog' }) });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: 'not_found' });
  });

  it('answers 500 when another foreign key rejects the INSERT: only a missing list is 404', async () => {
    const { request } = setup((q) => {
      if (q.sql.startsWith('insert into "todos"')) throw foreignKeyViolation('todos_updated_by_fkey');
      return [];
    });
    const response = await request(TODOS, { method: 'POST', body: JSON.stringify({ title: 'Walk the dog' }) });
    expect(response.status).toBe(500);
  });

  it('lists TODOs with the name of who changed each, and 404 for a missing list', async () => {
    const { request } = setup((q) => (q.sql.includes('from "todos"') ? [todoRow({ updated_by_name: 'bob' })] : []));
    const page = (await (await request(TODOS)).json()) as { items: Array<{ updatedBy: string }> };
    expect(page.items[0]?.updatedBy).toBe('bob');

    const missing = setup(() => []); // no TODOs and no list
    expect((await missing.request(TODOS)).status).toBe(404);
  });

  it('pages with a keyset cursor', async () => {
    const rows = Array.from({ length: DEFAULT_PAGE_SIZE + 1 }, (_, i) =>
      todoRow({
        id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
        created_at: new Date(Date.UTC(2026, 10, 13, 0, 0, 0, i + 1)),
      }),
    );
    // Count list calls instead of reading the compiled SQL: the first returns
    // the first slice (+1 extra row, so nextCursor is set), the second the rest.
    let listCalls = 0;
    const { request, executed } = setup((q) => {
      if (!isSelect(q)) return [];
      return ++listCalls === 1 ? rows : rows.slice(DEFAULT_PAGE_SIZE);
    });

    const first = (await (await request(TODOS)).json()) as { items: unknown[]; nextCursor: string | null };
    expect(first.items).toHaveLength(DEFAULT_PAGE_SIZE); // the extra row only sets nextCursor
    expect(first.nextCursor).not.toBeNull();

    const second = (await (await request(`${TODOS}?cursor=${first.nextCursor}`)).json()) as {
      items: unknown[];
      nextCursor: string | null;
    };
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    // The second query starts after the last row of page 1.
    expect(executed.filter(isSelect)[1]?.parameters).toContain(rows[DEFAULT_PAGE_SIZE - 1]!.id);
  });

  it('rejects an invalid cursor with 400', async () => {
    const { request } = setup(() => []);
    expect((await request(`${TODOS}?cursor=not-a-cursor`)).status).toBe(400);
  });

  it('answers 400 for an id that is not a UUID, and 413 in JSON for a body over 16 KiB', async () => {
    const { request, executed } = setup(() => []);
    expect((await request(`${TODOS}/not-a-uuid`, { method: 'DELETE' })).status).toBe(400);
    const tooLarge = await request(TODOS, { method: 'POST', body: JSON.stringify({ title: 'x'.repeat(17 * 1024) }) });
    expect(tooLarge.status).toBe(413);
    expect(await tooLarge.json()).toMatchObject({ error: 'payload_too_large' });
    expect(executed).toHaveLength(0);
  });
});

describe('lists', () => {
  it('returns every list with its creator and TODO counts from one statement', async () => {
    const { request, executed } = setup(() => [listSummaryRow({ open_count: 2, total_count: 5 })]);
    const response = await request('/api/lists');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      items: [{ id: LIST_ID, name: 'Groceries', createdBy: 'alice', openCount: 2, totalCount: 5 }],
    });
    expect(executed).toHaveLength(1);
  });

  it('creates a list, upserting the caller from the token and never from the body', async () => {
    const { request, executed } = setup((q) =>
      q.sql.startsWith('insert into "lists"') ? [listRow({ name: q.parameters[0] as string })] : [],
    );
    const response = await request('/api/lists', {
      method: 'POST',
      // Extra fields are dropped by the schema; they must not reach the users row.
      body: JSON.stringify({ name: ' Errands ', sub: 'sub-mallory', username: 'mallory' }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ name: 'Errands', createdBy: 'alice', openCount: 0, totalCount: 0 });
    const [upsert, insert] = executed;
    expect(upsert?.parameters).toContain('sub-alice');
    expect(upsert?.parameters).not.toContain('sub-mallory');
    expect(insert?.parameters).toEqual(['Errands', 'sub-alice']);
  });

  describe('delete', () => {
    const isTodoDelete = (q: FakeQuery) => q.sql.startsWith('delete from "todos"');
    const isListDelete = (q: FakeQuery) => q.sql.startsWith('delete from "lists"');
    const ids = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `todo-${i}` }));
    const del = (request: ReturnType<typeof setup>['request']) => request(LIST, { method: 'DELETE' });

    it('deletes the TODOs in batches of DELETE_BATCH_SIZE, then the list', async () => {
      let batches = 0;
      const { request, executed } = setup((q) => {
        if (isTodoDelete(q)) return ++batches === 1 ? ids(DELETE_BATCH_SIZE) : ids(5);
        if (isListDelete(q)) return [{ id: LIST_ID }];
        return [];
      });
      expect((await del(request)).status).toBe(204);
      const kinds = executed.map((q) => (isTodoDelete(q) ? 'todos' : 'list'));
      expect(kinds).toEqual(['todos', 'todos', 'list']);
      expect(executed.find(isTodoDelete)?.parameters).toEqual([LIST_ID, DELETE_BATCH_SIZE]);
    });

    it('answers 404 when the list is gone', async () => {
      const gone = setup(() => []);
      expect((await del(gone.request)).status).toBe(404);
    });

    it('clears the TODOs again when one was added meanwhile (foreign key), and answers 409 after DELETE_ATTEMPTS', async () => {
      let listDeletes = 0;
      const once = setup((q) => {
        if (isListDelete(q) && ++listDeletes === 1) throw foreignKeyViolation();
        return isListDelete(q) ? [{ id: LIST_ID }] : [];
      });
      expect((await del(once.request)).status).toBe(204);
      expect(once.executed.filter(isTodoDelete)).toHaveLength(2);

      const always = setup((q) => {
        if (isListDelete(q)) throw foreignKeyViolation();
        return [];
      });
      const response = await del(always.request);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: 'conflict' });
      expect(always.executed.filter(isListDelete)).toHaveLength(DELETE_ATTEMPTS);
    });
  });
});

describe('static files and the SPA', () => {
  it('serves hashed assets as immutable', async () => {
    const { request } = setup(() => []);
    const response = await request('/assets/index-abc123.js', {}, null);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
  });

  it('answers 404 for a missing asset instead of index.html', async () => {
    const { request } = setup(() => []);
    expect((await request('/assets/missing.js', {}, null)).status).toBe(404);
  });

  it('answers index.html for client-side routes, not cached', async () => {
    const { request } = setup(() => []);
    const response = await request('/todos/123', {}, null);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<title>spa</title>');
    expect(response.headers.get('Cache-Control')).toBe('no-cache');
    expect(response.headers.get('Content-Security-Policy')).toContain("default-src 'self'");
    // Only this origin can be a form's target, so a submit cannot be redirected off-site.
    expect(response.headers.get('Content-Security-Policy')).toContain("form-action 'self'");
  });

  it('answers JSON 404 for unknown API paths', async () => {
    const { request } = setup(() => []);
    const response = await request('/api/nothing', {}, null);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: 'not_found' });
  });
});
