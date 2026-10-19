-- Operator preservation reasons are append-only. Releasing a hold is not deletion authority.
CREATE TABLE retention_holds (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES runs(id),
  request_id uuid NOT NULL UNIQUE,
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 300),
  access_method text NOT NULL DEFAULT 'local_operator' CHECK (access_method='local_operator'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX retention_holds_run ON retention_holds(run_id);
CREATE TABLE retention_hold_releases (
  id uuid PRIMARY KEY,
  hold_id uuid NOT NULL UNIQUE REFERENCES retention_holds(id),
  request_id uuid NOT NULL UNIQUE,
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 300),
  access_method text NOT NULL DEFAULT 'local_operator' CHECK (access_method='local_operator'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER retention_holds_immutable BEFORE UPDATE OR DELETE ON retention_holds
  FOR EACH ROW EXECUTE FUNCTION immutable_record();
CREATE TRIGGER retention_hold_releases_immutable BEFORE UPDATE OR DELETE ON retention_hold_releases
  FOR EACH ROW EXECUTE FUNCTION immutable_record();
CREATE TRIGGER retention_holds_no_truncate BEFORE TRUNCATE ON retention_holds
  FOR EACH STATEMENT EXECUTE FUNCTION immutable_record();
CREATE TRIGGER retention_hold_releases_no_truncate BEFORE TRUNCATE ON retention_hold_releases
  FOR EACH STATEMENT EXECUTE FUNCTION immutable_record();
