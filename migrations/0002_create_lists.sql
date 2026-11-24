CREATE TABLE IF NOT EXISTS lists (
  id          uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  name        varchar(100)   NOT NULL,
  created_by  varchar(128)   NOT NULL REFERENCES users (id),
  created_at  timestamptz(3) NOT NULL DEFAULT now()
);
