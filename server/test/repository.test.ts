import { describe, expect, it } from 'vitest';
import { TodoRepository } from '../src/repository';
import { fakeDatabase, LIST_ID } from './fake-database';

describe('TodoRepository.list', () => {
  it('adds created_at >= to the keyset predicate so that Aurora DSQL uses it as an Index Cond', async () => {
    const { database, executed } = fakeDatabase(() => []);
    await new TodoRepository(database).list(LIST_ID, 3, {
      createdAt: new Date('2026-11-13T00:00:00.000Z'),
      id: '00000000-0000-4000-8000-000000000001',
    });
    // list_id = and created_at >= are the leading columns of todos_list_id_created_at_id_idx.
    expect(executed.at(-1)?.sql).toMatch(/"todos"."list_id" = \$1 and "todos"."created_at" >= /);
  });
});
