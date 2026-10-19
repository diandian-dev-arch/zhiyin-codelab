-- Internal outbox. Only a future authorized course-delete transaction may produce a batch.
-- No producer/HTTP endpoint is enabled by this migration.
CREATE TABLE course_evidence_cleanup_batches (
 id uuid PRIMARY KEY,
 authorization_id uuid NOT NULL UNIQUE REFERENCES course_retention_authorizations(id),
 run_ids uuid[] NOT NULL CHECK(cardinality(run_ids)<=10000),
 submission_ids uuid[] NOT NULL CHECK(cardinality(submission_ids) BETWEEN 1 AND 10000),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE course_evidence_cleanup_files (
 batch_id uuid NOT NULL REFERENCES course_evidence_cleanup_batches(id),
 storage_key text NOT NULL,
 evidence jsonb NOT NULL CHECK(jsonb_typeof(evidence)='object'),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','removed','already_missing')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
 last_error text,
 finished_at timestamptz,
 PRIMARY KEY(batch_id,storage_key),
 CHECK((state='pending')=(finished_at IS NULL))
);
CREATE TRIGGER course_cleanup_batch_immutable BEFORE UPDATE OR DELETE ON course_evidence_cleanup_batches
 FOR EACH ROW EXECUTE FUNCTION immutable_record();
CREATE TRIGGER course_cleanup_batch_no_truncate BEFORE TRUNCATE ON course_evidence_cleanup_batches
 FOR EACH STATEMENT EXECUTE FUNCTION immutable_record();
CREATE FUNCTION guard_course_cleanup_file() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'UPDATE' THEN RAISE EXCEPTION 'cleanup ledger is append only'; END IF;
 IF OLD.state<>'pending' OR ROW(NEW.batch_id,NEW.storage_key,NEW.evidence) IS DISTINCT FROM ROW(OLD.batch_id,OLD.storage_key,OLD.evidence)
 THEN RAISE EXCEPTION 'cleanup identity and completed receipt are immutable'; END IF;
 IF NEW.attempts<>OLD.attempts+1 THEN RAISE EXCEPTION 'cleanup attempt must advance once'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER course_cleanup_file_guard BEFORE UPDATE OR DELETE ON course_evidence_cleanup_files
 FOR EACH ROW EXECUTE FUNCTION guard_course_cleanup_file();
CREATE TRIGGER course_cleanup_file_no_truncate BEFORE TRUNCATE ON course_evidence_cleanup_files
 FOR EACH STATEMENT EXECUTE FUNCTION immutable_record();
