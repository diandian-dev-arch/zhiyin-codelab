-- New explicit analysis requests have their own identity; historical rows remain readable.
ALTER TABLE analysis_attempts ADD COLUMN requested_by uuid REFERENCES users(id);
ALTER TABLE analysis_attempts ADD COLUMN idempotency_key text;
ALTER TABLE analysis_attempts ADD COLUMN request_hash text;
ALTER TABLE analysis_attempts ADD CONSTRAINT reanalysis_request_identity CHECK (
  (requested_by IS NULL AND idempotency_key IS NULL AND request_hash IS NULL) OR
  (mode='reanalysis' AND requested_by IS NOT NULL AND idempotency_key IS NOT NULL
    AND request_hash IS NOT NULL AND request_hash ~ '^[0-9a-f]{64}$')
);
CREATE UNIQUE INDEX reanalysis_request_once ON analysis_attempts(run_id,requested_by,idempotency_key)
  WHERE idempotency_key IS NOT NULL;
