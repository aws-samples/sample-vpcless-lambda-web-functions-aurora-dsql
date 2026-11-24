-- One row per person who has created a list or created or changed a TODO,
-- made by the API just before writing lists.created_by or todos.updated_by
-- (UserRepository.upsert). Only the Cognito `sub` and the username are kept;
-- no e-mail or other personal data is copied here.
CREATE TABLE IF NOT EXISTS users (
  id            varchar(128)   PRIMARY KEY,
  display_name  varchar(128)   NOT NULL,
  created_at    timestamptz(3) NOT NULL DEFAULT now()
);
