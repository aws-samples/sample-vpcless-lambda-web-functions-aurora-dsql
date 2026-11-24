import type { List, ListSummaries, ListSummary, PublicConfig, Todo, TodoPage } from '../../server/src/schemas';

export type { List, ListSummary, PublicConfig, Todo };

export class VersionConflictError extends Error {
  constructor(readonly current: unknown) {
    super('version_conflict');
  }
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

export type FailureKind =
  | 'unauthorized'
  | 'version-conflict'
  | 'gone'
  | 'outcome-unknown'
  | 'contended'
  | 'failed';

export function failureKind(error: unknown): FailureKind {
  if (error instanceof VersionConflictError) return 'version-conflict';
  if (!(error instanceof ApiError)) return 'failed';
  if (error.status === 401) return 'unauthorized';
  if (error.status === 404) return 'gone';
  if (error.code === 'outcome_unknown') return 'outcome-unknown';
  // A 409 without `current`: the OCC retries on the server did not settle.
  if (error.status === 409) return 'contended';
  return 'failed';
}

export async function fetchConfig(): Promise<PublicConfig> {
  const response = await fetch('/api/config');
  if (!response.ok) throw new ApiError(response.status, 'config_unavailable');
  return (await response.json()) as PublicConfig;
}

// The same format as etagOf() in server/src/app.ts; not imported, to keep server code out of the bundle.
const ifMatch = (item: { version: number }) => ({ 'If-Match': `"${item.version}"` });

export function createApi(accessToken: () => string | undefined) {
  async function call(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    const token = accessToken();
    if (token) headers.set('Authorization', `Bearer ${token}`);
    if (init.body) headers.set('Content-Type', 'application/json');
    const response = await fetch(path, { ...init, headers });
    if (response.ok) return response;

    const body = (await response.json().catch(() => ({}))) as { error?: string; current?: unknown };
    if (response.status === 409 && body.error === 'version_conflict' && body.current) {
      throw new VersionConflictError(body.current);
    }
    throw new ApiError(response.status, body.error ?? 'error');
  }

  const todos = (listId: string) => `/api/lists/${listId}/todos`;

  return {
    async lists(): Promise<ListSummaries> {
      return (await call('/api/lists')).json() as Promise<ListSummaries>;
    },
    async createList(name: string): Promise<ListSummary> {
      return (await call('/api/lists', { method: 'POST', body: JSON.stringify({ name }) })).json() as Promise<ListSummary>;
    },
    async removeList(list: List): Promise<void> {
      await call(`/api/lists/${list.id}`, { method: 'DELETE' });
    },

    async list(listId: string, cursor?: string): Promise<TodoPage> {
      const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
      return (await call(`${todos(listId)}${query}`)).json() as Promise<TodoPage>;
    },
    async create(listId: string, title: string): Promise<Todo> {
      return (await call(todos(listId), { method: 'POST', body: JSON.stringify({ title }) })).json() as Promise<Todo>;
    },
    async update(todo: Todo, changes: { title?: string; completed?: boolean }): Promise<Todo> {
      const response = await call(`${todos(todo.listId)}/${todo.id}`, {
        method: 'PATCH',
        headers: ifMatch(todo),
        body: JSON.stringify(changes),
      });
      return response.json() as Promise<Todo>;
    },
    async remove(todo: Todo): Promise<void> {
      await call(`${todos(todo.listId)}/${todo.id}`, { method: 'DELETE', headers: ifMatch(todo) });
    },
  };
}

export type Api = ReturnType<typeof createApi>;
