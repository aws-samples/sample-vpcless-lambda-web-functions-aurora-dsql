import { z } from '@hono/zod-openapi';
import type { ListRow, ListSummaryRow, TodoRow } from './db';

/** `version` is int4: a larger If-Match value would fail in SQL (500) instead of getting 428. */
export const INT4_MAX = 2_147_483_647;

export const Version = z.number().int().min(1).max(INT4_MAX).openapi({ description: 'Also sent as the ETag, for example "3"' });

export const ErrorSchema = z
  .object({
    error: z.string().openapi({ example: 'precondition_required' }),
    message: z.string(),
  })
  .openapi('Error');

export const PublicConfigSchema = z
  .object({
    region: z.string(),
    userPoolId: z.string(),
    clientId: z.string(),
    domain: z.url().openapi({ description: 'Base URL of the Cognito managed login, for example https://<prefix>.auth.<region>.amazoncognito.com' }),
  })
  .openapi('PublicConfig');

export type PublicConfig = z.infer<typeof PublicConfigSchema>;

export const IdParamSchema = z.object({
  id: z.uuid().openapi({ param: { name: 'id', in: 'path' } }),
});

const ListName = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .openapi({ example: 'Groceries', description: '1-100 characters, not only spaces' });

const ListSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    createdAt: z.iso.datetime(),
  })
  .openapi('List');

export type List = z.infer<typeof ListSchema>;

export const ListSummarySchema = ListSchema.extend({
  createdBy: z.string().openapi({ description: 'Username of who created the list' }),
  openCount: z.number().int().openapi({ description: 'TODOs not completed yet' }),
  totalCount: z.number().int(),
}).openapi('ListSummary');

export type ListSummary = z.infer<typeof ListSummarySchema>;

export const ListSummariesSchema = z.object({ items: z.array(ListSummarySchema) }).openapi('ListSummaries');

export type ListSummaries = z.infer<typeof ListSummariesSchema>;

export const ListBodySchema = z.object({ name: ListName }).openapi('ListBody');

export function toList(row: ListRow): List {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at.toISOString(),
  };
}

export function toListSummary(row: ListSummaryRow): ListSummary {
  return { ...toList(row), createdBy: row.created_by_name, openCount: row.open_count, totalCount: row.total_count };
}

const Title = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .openapi({ example: 'Buy milk', description: '1-200 characters, not only spaces' });

export const TodoSchema = z
  .object({
    id: z.uuid(),
    listId: z.uuid(),
    title: z.string(),
    completed: z.boolean(),
    version: Version,
    updatedBy: z.string().openapi({ description: 'Username of who changed it last' }),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .openapi('Todo');

export type Todo = z.infer<typeof TodoSchema>;

export const TodoPageSchema = z
  .object({
    items: z.array(TodoSchema),
    nextCursor: z.string().nullable().openapi({ description: 'Pass as `cursor` to get the next page; null on the last page' }),
  })
  .openapi('TodoPage');

export type TodoPage = z.infer<typeof TodoPageSchema>;

export const CreateTodoSchema = z.object({ title: Title }).openapi('CreateTodo');

export const UpdateTodoSchema = z
  .object({ title: Title.optional(), completed: z.boolean().optional() })
  .refine((body) => body.title !== undefined || body.completed !== undefined, {
    message: 'Send at least one of title or completed.',
  })
  .openapi('UpdateTodo');

export const VersionConflictSchema = ErrorSchema.extend({ current: TodoSchema }).openapi('VersionConflict');

export const ListIdParamSchema = z.object({
  listId: z.uuid().openapi({ param: { name: 'listId', in: 'path' } }),
});

export const TodoIdParamSchema = ListIdParamSchema.extend(IdParamSchema.shape);

export function toTodo(row: TodoRow): Todo {
  return {
    id: row.id,
    listId: row.list_id,
    title: row.title,
    completed: row.completed,
    version: row.version,
    updatedBy: row.updated_by_name,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
