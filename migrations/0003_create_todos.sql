CREATE TABLE IF NOT EXISTS todos (
  -- A random UUID, not a sequence: Aurora DSQL spreads writes better across a
  -- random primary key. https://docs.aws.amazon.com/aurora-dsql/latest/userguide/working-with-concurrency-control.html
  id          uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  -- No ON DELETE CASCADE: a list has no limit on its TODOs, and cascaded rows
  -- count toward Aurora DSQL's 3,000-row limit per transaction, so AWS
  -- recommends NO ACTION (the default) here. ListRepository.delete removes the
  -- TODOs in batches first.
  -- https://docs.aws.amazon.com/aurora-dsql/latest/userguide/create-table-syntax-support.html#create-table-fk-actions
  -- Named so the API can tell this foreign key from the one on updated_by.
  list_id     uuid           NOT NULL CONSTRAINT todos_list_id_fkey REFERENCES lists (id),
  title       varchar(200)   NOT NULL,
  completed   boolean        NOT NULL DEFAULT false,
  version     integer        NOT NULL DEFAULT 1,
  updated_by  varchar(128)   NOT NULL REFERENCES users (id),
  -- Millisecond precision: the pagination cursor round-trips created_at through a JS Date.
  created_at  timestamptz(3) NOT NULL DEFAULT now(),
  updated_at  timestamptz(3) NOT NULL DEFAULT now()
);
