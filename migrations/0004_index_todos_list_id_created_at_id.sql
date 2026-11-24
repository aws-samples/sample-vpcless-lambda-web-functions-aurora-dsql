-- Supports the keyset pagination of one list's TODOs (WHERE list_id ORDER BY
-- created_at, id), the per-list counts, and the batched delete of a list's TODOs.
CREATE INDEX ASYNC IF NOT EXISTS todos_list_id_created_at_id_idx ON todos (list_id, created_at, id);
