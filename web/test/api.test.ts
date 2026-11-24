import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApi, failureKind, type Todo, VersionConflictError } from '../src/api';

const todo: Todo = {
  id: '3f8a2c1e-5b7d-4e9f-8a6b-1c2d3e4f5a6b',
  listId: '7d1e9b2a-4c3f-4a8e-9b6d-2e5f1a0c3b4d',
  title: 'Buy milk',
  completed: false,
  version: 3,
  updatedBy: 'alice',
  createdAt: '2026-11-13T00:00:00.000Z',
  updatedAt: '2026-11-13T00:00:00.000Z',
};

afterEach(() => vi.unstubAllGlobals());

/** Records each request's If-Match and Authorization and answers with `body` and `status`. */
function stubFetch(body: unknown, status = 200) {
  const calls: Array<{ url: string; init: RequestInit; ifMatch: string | null; authorization: string | null }> = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    calls.push({ url, init, ifMatch: headers.get('If-Match'), authorization: headers.get('Authorization') });
    return new Response(status === 204 ? null : JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  return calls;
}

describe('access token', () => {
  it('sends the token as a Bearer header and reads it again on each call', async () => {
    const calls = stubFetch({ items: [] });
    let token = 'first';
    const api = createApi(() => token);
    await api.lists();
    token = 'refreshed';
    await api.lists();
    expect(calls.map((call) => call.authorization)).toEqual(['Bearer first', 'Bearer refreshed']);
  });
});

// The server returns 428 without If-Match; this is the client half of that
// contract: every TODO change sends the current version as the ETag.
describe('If-Match on every change', () => {
  it('sends If-Match "<version>" on PATCH and DELETE of a TODO under its list', async () => {
    const api = createApi(() => 'token');
    const todoUrl = `/api/lists/${todo.listId}/todos/${todo.id}`;

    const cases: Array<[string, string, () => Promise<unknown>, number]> = [
      ['PATCH', todoUrl, () => api.update(todo, { completed: true }), 200],
      ['DELETE', todoUrl, () => api.remove(todo), 204],
    ];
    for (const [method, url, run, status] of cases) {
      const calls = stubFetch(status === 204 ? undefined : todo, status);
      await run();
      expect(calls[0]?.url).toBe(url);
      expect(calls[0]?.init.method).toBe(method);
      expect(calls[0]?.ifMatch).toBe('"3"');
    }
  });
});

describe('version conflict', () => {
  it('turns a 409 version_conflict into a VersionConflictError holding the latest TODO', async () => {
    const latest: Todo = { ...todo, title: 'Buy soy milk', version: 4, updatedBy: 'bob' };
    stubFetch({ error: 'version_conflict', current: latest }, 409);
    const api = createApi(() => 'token');
    await expect(api.update(todo, { title: 'Buy oat milk' })).rejects.toMatchObject({
      current: { version: 4, updatedBy: 'bob', title: 'Buy soy milk' },
    });
    await expect(api.remove(todo)).rejects.toBeInstanceOf(VersionConflictError);
  });

  it('keeps a 409 conflict (OCC retries exhausted, no `current`) as a plain ApiError', async () => {
    stubFetch({ error: 'conflict' }, 409);
    const api = createApi(() => 'token');
    // The UI tells these apart: version_conflict -> "someone else changed it",
    // conflict -> "too many at once".
    await expect(api.update(todo, { completed: true })).rejects.toMatchObject({ status: 409, code: 'conflict' });
    await expect(api.update(todo, { completed: true }).catch(failureKind)).resolves.toBe('contended');
  });
});
