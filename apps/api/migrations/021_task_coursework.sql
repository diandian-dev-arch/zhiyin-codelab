-- New tasks opt into this flow. Historical project tasks and sharing stay intact.
CREATE TABLE course_assignments (
 id uuid PRIMARY KEY, class_id uuid NOT NULL REFERENCES classes(id), title text NOT NULL,
 subject_mode text NOT NULL CHECK(subject_mode IN ('individual','team')),
 status text NOT NULL CHECK(status IN ('draft','published')), created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE course_tasks (
 task_id uuid PRIMARY KEY REFERENCES tasks(id), assignment_id uuid NOT NULL REFERENCES course_assignments(id),
 current_revision_id uuid, position int NOT NULL, UNIQUE(assignment_id,position)
);
CREATE TABLE course_task_revisions (
 id uuid PRIMARY KEY, task_id uuid NOT NULL REFERENCES course_tasks(task_id), sequence int NOT NULL,
 config jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(task_id,sequence)
);
ALTER TABLE course_tasks ADD FOREIGN KEY(current_revision_id) REFERENCES course_task_revisions(id);
CREATE TRIGGER course_revision_immutable BEFORE UPDATE OR DELETE ON course_task_revisions FOR EACH ROW EXECUTE FUNCTION immutable_record();
CREATE TABLE course_subjects (
 id uuid PRIMARY KEY, assignment_id uuid NOT NULL REFERENCES course_assignments(id),
 user_id uuid REFERENCES users(id), name text NOT NULL, UNIQUE(assignment_id,user_id)
);
CREATE TABLE course_team_members (
 subject_id uuid NOT NULL REFERENCES course_subjects(id), user_id uuid NOT NULL REFERENCES users(id),
 role text NOT NULL CHECK(role IN ('submitter','member')), status text NOT NULL CHECK(status IN ('invited','active','left')),
 PRIMARY KEY(subject_id,user_id)
);
CREATE TABLE course_repository_connections (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES users(id), provider text NOT NULL CHECK(provider IN ('github','gitee')),
 label text NOT NULL, credential text NOT NULL, revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE course_imports (
 id uuid PRIMARY KEY, task_id uuid NOT NULL REFERENCES course_tasks(task_id), owner_id uuid NOT NULL REFERENCES users(id),
 source_type text NOT NULL, status text NOT NULL CHECK(status IN ('created','fetching','validating','ready','failed','cancelled')),
 source jsonb NOT NULL, resolved_commit text, snapshot_id uuid, failure_code text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), started_at timestamptz, finished_at timestamptz
);
CREATE TABLE course_snapshots (
 id uuid PRIMARY KEY, import_id uuid UNIQUE NOT NULL REFERENCES course_imports(id), owner_id uuid NOT NULL REFERENCES users(id),
 files jsonb NOT NULL, manifest jsonb NOT NULL, content_hash text NOT NULL, source jsonb NOT NULL,
 omitted jsonb NOT NULL DEFAULT '[]', created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE course_imports ADD FOREIGN KEY(snapshot_id) REFERENCES course_snapshots(id);
CREATE TRIGGER course_snapshot_immutable BEFORE UPDATE OR DELETE ON course_snapshots FOR EACH ROW EXECUTE FUNCTION immutable_record();
CREATE TABLE course_late_grants (
 id uuid PRIMARY KEY, task_id uuid NOT NULL REFERENCES course_tasks(task_id), subject_id uuid NOT NULL REFERENCES course_subjects(id),
 opens_at timestamptz NOT NULL, closes_at timestamptz NOT NULL, granted_by uuid NOT NULL REFERENCES users(id),
 reason text NOT NULL, revoked_at timestamptz, CHECK(closes_at>opens_at)
);
CREATE TABLE course_submissions (
 id uuid PRIMARY KEY, task_id uuid NOT NULL REFERENCES course_tasks(task_id), subject_id uuid NOT NULL REFERENCES course_subjects(id),
 sequence int NOT NULL CHECK(sequence>0), snapshot_id uuid NOT NULL REFERENCES course_snapshots(id),
 task_revision_id uuid NOT NULL REFERENCES course_task_revisions(id), base_submission_id uuid REFERENCES course_submissions(id),
 accepted_at timestamptz NOT NULL, late_grant_id uuid REFERENCES course_late_grants(id), submitted_by uuid NOT NULL REFERENCES users(id),
 member_snapshot jsonb NOT NULL, note text NOT NULL, request_key text NOT NULL, request_hash text NOT NULL,
 UNIQUE(task_id,subject_id,sequence), UNIQUE(task_id,submitted_by,request_key)
);
CREATE TRIGGER course_submission_immutable BEFORE UPDATE OR DELETE ON course_submissions FOR EACH ROW EXECUTE FUNCTION immutable_record();
CREATE TABLE course_self_checks (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES users(id), task_id uuid NOT NULL REFERENCES course_tasks(task_id),
 snapshot_id uuid NOT NULL REFERENCES course_snapshots(id), task_revision_id uuid NOT NULL REFERENCES course_task_revisions(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE course_analyses (
 id uuid PRIMARY KEY, snapshot_id uuid NOT NULL REFERENCES course_snapshots(id), task_revision_id uuid NOT NULL REFERENCES course_task_revisions(id),
 submission_id uuid REFERENCES course_submissions(id), self_check_id uuid REFERENCES course_self_checks(id),
 billing_user_id uuid NOT NULL REFERENCES users(id), level int NOT NULL CHECK(level BETWEEN 1 AND 3), question text NOT NULL DEFAULT '',
 status text NOT NULL CHECK(status IN ('queued','running','succeeded','failed','cancelled')),
 model_config jsonb NOT NULL, consent jsonb NOT NULL, report jsonb, usage jsonb, failure_code text, request_id text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), started_at timestamptz, finished_at timestamptz,
 CHECK((submission_id IS NULL) <> (self_check_id IS NULL))
);
CREATE INDEX course_analysis_queue ON course_analyses(status,created_at);
CREATE TABLE course_evaluations (
 id uuid PRIMARY KEY, submission_id uuid NOT NULL REFERENCES course_submissions(id), teacher_id uuid NOT NULL REFERENCES users(id),
 revision int NOT NULL, status text NOT NULL CHECK(status IN ('draft','published')), feedback text NOT NULL,
 outcome text NOT NULL CHECK(outcome IN ('achieved','needs_revision','pending')), analysis_id uuid REFERENCES course_analyses(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), published_at timestamptz, UNIQUE(submission_id,revision)
);
CREATE FUNCTION course_protect_published() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF OLD.status='published' THEN RAISE EXCEPTION 'PUBLISHED_EVALUATION_IMMUTABLE'; END IF; RETURN NEW; END $$;
CREATE TRIGGER course_published_immutable BEFORE UPDATE OR DELETE ON course_evaluations FOR EACH ROW EXECUTE FUNCTION course_protect_published();
CREATE TABLE course_contribution_statements (
 submission_id uuid NOT NULL REFERENCES course_submissions(id), user_id uuid NOT NULL REFERENCES users(id),
 statement text NOT NULL, updated_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(submission_id,user_id)
);
CREATE TABLE course_model_consents (
 id uuid PRIMARY KEY, snapshot_id uuid NOT NULL REFERENCES course_snapshots(id), actor_id uuid NOT NULL REFERENCES users(id),
 recipient_hash text NOT NULL, purpose text NOT NULL CHECK(purpose IN ('self-check','formal')),
 recipient jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), revoked_at timestamptz
);
CREATE TABLE course_audit (
 id bigserial PRIMARY KEY, actor_id uuid NOT NULL REFERENCES users(id), kind text NOT NULL, object_id uuid NOT NULL,
 metadata jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
