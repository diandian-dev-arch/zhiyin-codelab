ALTER TABLE tasks ADD COLUMN kind text NOT NULL DEFAULT 'template' CHECK(kind IN ('template','project'));
ALTER TABLE tasks ADD COLUMN due_at timestamptz;
ALTER TABLE tasks ADD COLUMN rubric jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(rubric)='array');

CREATE TABLE project_submissions (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES tasks(id),
  user_id uuid NOT NULL REFERENCES users(id),
  project_id uuid NOT NULL REFERENCES source_projects(id),
  project_sha256 text NOT NULL,
  version integer NOT NULL CHECK(version>0),
  note text NOT NULL DEFAULT '',
  revision_note text NOT NULL DEFAULT '',
  share_with_class boolean NOT NULL CHECK(share_with_class),
  showcase_consent boolean NOT NULL DEFAULT false,
  analysis_id uuid REFERENCES source_analyses(id),
  pending_analysis_id uuid REFERENCES source_analyses(id),
  request_key text NOT NULL,
  request_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(task_id,user_id,version),
  UNIQUE(task_id,user_id,project_id),
  UNIQUE(task_id,user_id,request_key)
);
CREATE INDEX project_submissions_task ON project_submissions(task_id,created_at DESC,id);

CREATE TABLE project_peer_reviews (
  id uuid PRIMARY KEY,
  submission_id uuid NOT NULL REFERENCES project_submissions(id),
  reviewer_id uuid NOT NULL REFERENCES users(id),
  analysis_id uuid REFERENCES source_analyses(id),
  strength text NOT NULL CHECK(length(trim(strength)) BETWEEN 2 AND 2000),
  improvement text NOT NULL CHECK(length(trim(improvement)) BETWEEN 2 AND 2000),
  recommend boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(submission_id,reviewer_id)
);

CREATE TABLE project_evaluations (
  submission_id uuid PRIMARY KEY REFERENCES project_submissions(id),
  teacher_id uuid NOT NULL REFERENCES users(id),
  analysis_id uuid REFERENCES source_analyses(id),
  feedback text NOT NULL CHECK(length(trim(feedback)) BETWEEN 1 AND 5000),
  outcome text NOT NULL CHECK(outcome IN ('achieved','needs_revision','pending')),
  featured boolean NOT NULL DEFAULT false,
  feature_reason text NOT NULL DEFAULT '',
  revision integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK(NOT featured OR (outcome='achieved' AND length(trim(feature_reason))>0))
);
CREATE TABLE project_evaluation_revisions (
  id uuid PRIMARY KEY,
  submission_id uuid NOT NULL REFERENCES project_submissions(id),
  revision integer NOT NULL,
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(submission_id,revision)
);

CREATE FUNCTION protect_submitted_source_project() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM project_submissions WHERE project_id=OLD.id) AND
    (NEW.id IS DISTINCT FROM OLD.id OR NEW.owner_id IS DISTINCT FROM OLD.owner_id OR
     NEW.files IS DISTINCT FROM OLD.files OR NEW.sha256 IS DISTINCT FROM OLD.sha256 OR
     NEW.omitted IS DISTINCT FROM OLD.omitted) THEN
    RAISE EXCEPTION 'SUBMITTED_SOURCE_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER submitted_source_project_immutable BEFORE UPDATE ON source_projects
  FOR EACH ROW EXECUTE FUNCTION protect_submitted_source_project();

CREATE FUNCTION protect_project_submission_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.task_id IS DISTINCT FROM OLD.task_id OR
     NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.project_id IS DISTINCT FROM OLD.project_id OR
     NEW.project_sha256 IS DISTINCT FROM OLD.project_sha256 OR NEW.version IS DISTINCT FROM OLD.version OR
     NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.note IS DISTINCT FROM OLD.note OR
     NEW.revision_note IS DISTINCT FROM OLD.revision_note OR NEW.share_with_class IS DISTINCT FROM OLD.share_with_class OR
     NEW.showcase_consent IS DISTINCT FROM OLD.showcase_consent OR NEW.request_key IS DISTINCT FROM OLD.request_key OR
     NEW.request_hash IS DISTINCT FROM OLD.request_hash THEN
    RAISE EXCEPTION 'PROJECT_SUBMISSION_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER project_submission_immutable BEFORE UPDATE ON project_submissions
  FOR EACH ROW EXECUTE FUNCTION protect_project_submission_identity();
