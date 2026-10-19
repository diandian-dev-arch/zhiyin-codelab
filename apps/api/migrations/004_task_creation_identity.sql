-- Shared task creation gains request identity without changing legacy records.
ALTER TABLE tasks
  ADD COLUMN idempotency_key text,
  ADD COLUMN request_hash text,
  ADD CONSTRAINT task_creation_identity_complete
    CHECK((idempotency_key IS NULL) = (request_hash IS NULL));
CREATE UNIQUE INDEX tasks_creation_idempotency
  ON tasks(class_id,idempotency_key) WHERE idempotency_key IS NOT NULL;
