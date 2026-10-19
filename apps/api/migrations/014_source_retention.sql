-- No project FK: the minimal audit ledger must survive authorized project deletion.
CREATE TABLE source_retention_events (
 id uuid PRIMARY KEY,
 project_id uuid NOT NULL,
 request_id uuid NOT NULL UNIQUE,
 action text NOT NULL CHECK(action IN ('hold','release','delete')),
 hold_id uuid REFERENCES source_retention_events(id),
 reason text NOT NULL CHECK(char_length(reason) BETWEEN 3 AND 300),
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 receipt jsonb NOT NULL CHECK(jsonb_typeof(receipt)='object'),
 access_method text NOT NULL DEFAULT 'local_operator' CHECK(access_method='local_operator'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((action='release') = (hold_id IS NOT NULL))
);
CREATE UNIQUE INDEX source_retention_release_once ON source_retention_events(hold_id) WHERE action='release';
CREATE UNIQUE INDEX source_retention_delete_once ON source_retention_events(project_id) WHERE action='delete';
CREATE INDEX source_retention_project ON source_retention_events(project_id);
CREATE TRIGGER source_retention_immutable BEFORE UPDATE OR DELETE ON source_retention_events
 FOR EACH ROW EXECUTE FUNCTION immutable_record();
CREATE TRIGGER source_retention_no_truncate BEFORE TRUNCATE ON source_retention_events
 FOR EACH STATEMENT EXECUTE FUNCTION immutable_record();
