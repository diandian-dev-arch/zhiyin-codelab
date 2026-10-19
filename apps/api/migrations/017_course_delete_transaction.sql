-- A batch created by the same transaction is the deletion context, not a session flag.
-- Database owners remain trusted; this is not a boundary against arbitrary owner SQL.
ALTER TABLE course_evidence_cleanup_batches ADD COLUMN deletion_request_id uuid UNIQUE;
ALTER TABLE course_evidence_cleanup_batches ADD COLUMN deletion_request_hash text;
ALTER TABLE course_evidence_cleanup_batches ADD COLUMN deletion_transaction bigint;
ALTER TABLE course_evidence_cleanup_batches ADD CONSTRAINT deletion_context_complete CHECK(
 (deletion_request_id IS NULL AND deletion_request_hash IS NULL AND deletion_transaction IS NULL) OR
 (deletion_request_id IS NOT NULL AND deletion_request_hash IS NOT NULL AND deletion_request_hash ~ '^[a-f0-9]{64}$' AND deletion_transaction IS NOT NULL)
);
ALTER TABLE runs ALTER CONSTRAINT runs_accepted_attempt_same_run DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE report_revisions ALTER CONSTRAINT report_revision_origin_same_run DEFERRABLE INITIALLY IMMEDIATE;

CREATE FUNCTION guard_authorized_course_delete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_run uuid; target_submission uuid; allowed boolean;
BEGIN
 IF TG_OP<>'DELETE' THEN RAISE EXCEPTION 'immutable record'; END IF;
 IF TG_TABLE_NAME='submissions' THEN target_submission:=OLD.id;
 ELSIF TG_TABLE_NAME='retention_hold_releases' THEN
   SELECT run_id INTO target_run FROM retention_holds WHERE id=OLD.hold_id;
 ELSE target_run:=OLD.run_id;
 END IF;
 SELECT EXISTS(
   SELECT 1 FROM course_evidence_cleanup_batches b
   JOIN course_retention_authorizations a ON a.id=b.authorization_id
   WHERE b.deletion_transaction=txid_current() AND b.deletion_request_id IS NOT NULL
   AND a.expires_at>clock_timestamp()
   AND NOT EXISTS(SELECT 1 FROM course_retention_revocations r WHERE r.authorization_id=a.id)
   AND ((target_submission IS NOT NULL AND target_submission=ANY(b.submission_ids)
     AND EXISTS(SELECT 1 FROM submissions s WHERE s.id=target_submission AND s.task_id=a.task_id AND s.user_id=a.student_id))
   OR (target_run IS NOT NULL AND target_run=ANY(b.run_ids)
     AND EXISTS(SELECT 1 FROM runs r JOIN submissions s ON s.id=r.submission_id
       WHERE r.id=target_run AND s.id=ANY(b.submission_ids) AND s.task_id=a.task_id AND s.user_id=a.student_id)))
 ) INTO allowed;
 IF NOT allowed THEN RAISE EXCEPTION 'immutable record: no matching course deletion transaction'; END IF;
 RETURN OLD;
END; $$;
DROP TRIGGER submissions_immutable ON submissions;
CREATE TRIGGER submissions_immutable BEFORE UPDATE OR DELETE ON submissions FOR EACH ROW EXECUTE FUNCTION guard_authorized_course_delete();
DROP TRIGGER report_revisions_immutable ON report_revisions;
CREATE TRIGGER report_revisions_immutable BEFORE UPDATE OR DELETE ON report_revisions FOR EACH ROW EXECUTE FUNCTION guard_authorized_course_delete();
DROP TRIGGER publications_immutable ON publications;
CREATE TRIGGER publications_immutable BEFORE UPDATE OR DELETE ON publications FOR EACH ROW EXECUTE FUNCTION guard_authorized_course_delete();
DROP TRIGGER retention_holds_immutable ON retention_holds;
CREATE TRIGGER retention_holds_immutable BEFORE UPDATE OR DELETE ON retention_holds FOR EACH ROW EXECUTE FUNCTION guard_authorized_course_delete();
DROP TRIGGER retention_hold_releases_immutable ON retention_hold_releases;
CREATE TRIGGER retention_hold_releases_immutable BEFORE UPDATE OR DELETE ON retention_hold_releases FOR EACH ROW EXECUTE FUNCTION guard_authorized_course_delete();
DROP TRIGGER execution_base_guard ON execution_attempts;
CREATE TRIGGER execution_base_guard BEFORE UPDATE ON execution_attempts FOR EACH ROW EXECUTE FUNCTION guard_execution_base_v2();
CREATE TRIGGER execution_delete_guard BEFORE DELETE ON execution_attempts FOR EACH ROW EXECUTE FUNCTION guard_authorized_course_delete();
