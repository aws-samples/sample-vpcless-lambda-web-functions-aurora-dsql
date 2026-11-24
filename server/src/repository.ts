import { z } from '@hono/zod-openapi';
import { type Kysely, sql } from 'kysely';
import type { Caller } from './middleware';
import {
  ConflictError,
  type Database,
  type DB,
  isForeignKeyViolation,
  type ListRow,
  type ListSummaryRow,
  type TodoRow,
} from './db';

const LIST_COLUMNS = ['id', 'name', 'created_by', 'created_at'] as const;
const QUALIFIED_LIST_COLUMNS = LIST_COLUMNS.map((column) => `lists.${column}` as const);

/** TODOs removed per statement: well under Aurora DSQL's 3,000 rows per transaction. */
export const DELETE_BATCH_SIZE = 1_000;
export const DELETE_ATTEMPTS = 3;

export class ListRepository {
  constructor(private readonly db: Database) {}

  summaries(limit: number): Promise<ListSummaryRow[]> {
    return this.db.statement('idempotent', (k) =>
      k
        .selectFrom('lists')
        .innerJoin('users', 'users.id', 'lists.created_by')
        .leftJoin('todos', 'todos.list_id', 'lists.id')
        .select(QUALIFIED_LIST_COLUMNS)
        .select((eb) => [
          'users.display_name as created_by_name',
          // count is bigint, which pg returns as a string; integer comes back as a number.
          eb.cast<number>(eb.fn.count('todos.id'), 'integer').as('total_count'),
          eb.cast<number>(eb.fn.count('todos.id').filterWhere('todos.completed', '=', false), 'integer').as('open_count'),
        ])
        .groupBy([...QUALIFIED_LIST_COLUMNS, 'users.display_name'])
        .orderBy('lists.created_at')
        .orderBy('lists.id')
        .limit(limit)
        .execute(),
    );
  }

  get(id: string): Promise<ListRow | undefined> {
    return this.db.statement('idempotent', (k) => k.selectFrom('lists').select(LIST_COLUMNS).where('id', '=', id).executeTakeFirst());
  }

  create(name: string, caller: Caller): Promise<ListRow> {
    return this.db.statement('not-idempotent', (k) =>
      k.insertInto('lists').values({ name, created_by: caller.sub }).returning(LIST_COLUMNS).executeTakeFirstOrThrow(),
    );
  }

  /**
   * A TODO added meanwhile makes the list's DELETE fail on the foreign key, so the TODOs are cleared again, up to
   * DELETE_ATTEMPTS times (then 409).
   */
  async delete(id: string): Promise<{ kind: 'deleted' | 'not-found' }> {
    for (let attempt = 1; ; attempt++) {
      await this.deleteTodos(id);
      try {
        const row = await this.db.statement('not-idempotent', (k) =>
          k.deleteFrom('lists').where('id', '=', id).returning('id').executeTakeFirst(),
        );
        return { kind: row ? 'deleted' : 'not-found' };
      } catch (error) {
        if (!isForeignKeyViolation(error, 'todos_list_id_fkey')) throw error;
        if (attempt >= DELETE_ATTEMPTS) throw new ConflictError(error);
      }
    }
  }

  private async deleteTodos(listId: string): Promise<void> {
    for (;;) {
      const rows = await this.db.statement('not-idempotent', (k) =>
        k
          .deleteFrom('todos')
          .where('id', 'in', (eb) => eb.selectFrom('todos').select('id').where('list_id', '=', listId).limit(DELETE_BATCH_SIZE))
          .returning('id')
          .execute(),
      );
      if (rows.length < DELETE_BATCH_SIZE) return;
    }
  }
}

const TODO_COLUMNS = ['id', 'list_id', 'title', 'completed', 'version', 'created_at', 'updated_at'] as const;
const QUALIFIED_TODO_COLUMNS = TODO_COLUMNS.map((column) => `todos.${column}` as const);

const todosOf = (k: Kysely<DB>, listId: string) =>
  k
    .selectFrom('todos')
    .innerJoin('users', 'users.id', 'todos.updated_by')
    .select(QUALIFIED_TODO_COLUMNS)
    .select('users.display_name as updated_by_name')
    .where('todos.list_id', '=', listId);

export interface PageAfter {
  createdAt: Date;
  id: string;
}

type Miss = { kind: 'conflict'; current: TodoRow } | { kind: 'not-found' };

export class TodoRepository {
  constructor(private readonly db: Database) {}

  list(listId: string, limit: number, after?: PageAfter): Promise<TodoRow[]> {
    return this.db.statement('idempotent', (k) => {
      let query = todosOf(k, listId);
      if (after) {
        // `created_at >=` looks redundant but is the Index Cond: Aurora DSQL uses the row-value comparison only as a
        // Filter, so without it every page reads the index from its first entry.
        query = query
          .where('todos.created_at', '>=', after.createdAt)
          .where(({ eb, refTuple, tuple }) =>
            eb(refTuple('todos.created_at', 'todos.id'), '>', tuple(after.createdAt, after.id)),
          );
      }
      return query.orderBy('todos.created_at').orderBy('todos.id').limit(limit).execute();
    });
  }

  get(listId: string, id: string): Promise<TodoRow | undefined> {
    return this.db.statement('idempotent', (k) => todosOf(k, listId).where('todos.id', '=', id).executeTakeFirst());
  }

  /** The foreign key `todos_list_id_fkey` (migrations/0003) is the list existence check, so a concurrent delete cannot slip past. */
  async create(listId: string, title: string, caller: Caller): Promise<TodoRow | undefined> {
    try {
      const row = await this.db.statement('not-idempotent', (k) =>
        k
          .insertInto('todos')
          .values({ list_id: listId, title, updated_by: caller.sub })
          .returning(TODO_COLUMNS)
          .executeTakeFirstOrThrow(),
      );
      return { ...row, updated_by_name: caller.username };
    } catch (error) {
      if (isForeignKeyViolation(error, 'todos_list_id_fkey')) return undefined;
      throw error;
    }
  }

  async update(
    listId: string,
    id: string,
    expectedVersion: number,
    changes: { title?: string; completed?: boolean },
    caller: Caller,
  ): Promise<{ kind: 'changed'; row: TodoRow } | Miss> {
    const row = await this.db.statement('not-idempotent', (k) =>
      k
        .updateTable('todos')
        .set({
          ...changes,
          version: sql<number>`version + 1`,
          updated_by: caller.sub,
          updated_at: sql<Date>`now()`,
        })
        .where('list_id', '=', listId)
        .where('id', '=', id)
        .where('version', '=', expectedVersion)
        .returning(TODO_COLUMNS)
        .executeTakeFirst(),
    );
    if (row) return { kind: 'changed', row: { ...row, updated_by_name: caller.username } };
    return this.explainMiss(listId, id);
  }

  async delete(listId: string, id: string, expectedVersion: number): Promise<{ kind: 'deleted' } | Miss> {
    const row = await this.db.statement('not-idempotent', (k) =>
      k
        .deleteFrom('todos')
        .where('list_id', '=', listId)
        .where('id', '=', id)
        .where('version', '=', expectedVersion)
        .returning('id')
        .executeTakeFirst(),
    );
    if (row) return { kind: 'deleted' };
    return this.explainMiss(listId, id);
  }

  private async explainMiss(listId: string, id: string): Promise<Miss> {
    const current = await this.get(listId, id);
    return current ? { kind: 'conflict', current } : { kind: 'not-found' };
  }
}

const CursorSchema = z.object({ t: z.iso.datetime(), id: z.uuid() });

export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ t: createdAt.toISOString(), id })).toString('base64url');
}

export function decodeCursor(cursor: string): PageAfter | undefined {
  try {
    const parsed = CursorSchema.safeParse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
    if (!parsed.success) return undefined;
    return { createdAt: new Date(parsed.data.t), id: parsed.data.id };
  } catch {
    return undefined;
  }
}

export class UserRepository {
  constructor(private readonly db: Database) {}

  /**
   * Call before writing lists.created_by or todos.updated_by: both reference this row (foreign keys), so without it a
   * first-time user's write fails with 500.
   * NOT EXISTS skips the write when the row exists, so calling this before those writes adds no OCC conflicts
   * (`ON CONFLICT DO UPDATE ... WHERE` alone still got 40001 on a live cluster). DO NOTHING covers two first requests at once.
   */
  upsert(caller: Caller): Promise<void> {
    return this.db.statement('idempotent', async (k) => {
      await k
        .insertInto('users')
        .columns(['id', 'display_name'])
        .expression(
          k
            .selectNoFrom((eb) => [eb.val(caller.sub).as('id'), eb.val(caller.username).as('display_name')])
            .where(({ not, exists, selectFrom, lit }) =>
              not(exists(selectFrom('users').select(lit(1).as('one')).where('id', '=', caller.sub))),
            ),
        )
        .onConflict((oc) => oc.column('id').doNothing())
        .execute();
    });
  }
}
