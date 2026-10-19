-- New columns default to legacy semantics. Do not rewrite historical records.
ALTER TABLE rules ADD COLUMN contract_version integer NOT NULL DEFAULT 1 CHECK(contract_version IN (1,2));
ALTER TABLE rules ADD COLUMN rule_snapshot jsonb;
ALTER TABLE rules ADD COLUMN idempotency_key text;
ALTER TABLE rules ADD COLUMN request_hash text;
ALTER TABLE rules ADD CONSTRAINT rules_v2_snapshot CHECK(contract_version=1 OR (rule_snapshot IS NOT NULL AND jsonb_typeof(rule_snapshot)='object' AND rule_snapshot<>'{}'::jsonb AND idempotency_key IS NOT NULL AND length(idempotency_key)>0 AND request_hash IS NOT NULL AND length(request_hash)>0));
CREATE UNIQUE INDEX rules_v2_idempotency ON rules(task_id,idempotency_key) WHERE contract_version=2;
ALTER TABLE submissions ADD COLUMN contract_version integer NOT NULL DEFAULT 1 CHECK(contract_version IN (1,2));
ALTER TABLE submissions ADD COLUMN source_manifest jsonb;
ALTER TABLE submissions ADD COLUMN source_manifest_sha256 text;
ALTER TABLE submissions ADD COLUMN source_manifest_version text;
ALTER TABLE submissions ADD CONSTRAINT submissions_v2_source CHECK(contract_version=1 OR (source_manifest IS NOT NULL AND jsonb_typeof(source_manifest)='object' AND source_manifest_sha256 IS NOT NULL AND source_manifest_sha256 ~ '^[0-9a-f]{64}$'));

ALTER TABLE runs ADD COLUMN contract_version integer NOT NULL DEFAULT 1 CHECK(contract_version IN (1,2));
ALTER TABLE runs ADD COLUMN rule_id uuid REFERENCES rules(id);
ALTER TABLE runs ADD COLUMN idempotency_key text;
ALTER TABLE runs ADD COLUMN request_hash text;
ALTER TABLE runs ADD COLUMN accepted_execution_attempt_id uuid;
ALTER TABLE runs ADD COLUMN pipeline_started_at timestamptz;
ALTER TABLE runs ADD COLUMN pipeline_deadline_at timestamptz;
ALTER TABLE runs ADD COLUMN retry_of_run_id uuid REFERENCES runs(id);
ALTER TABLE runs DROP CONSTRAINT runs_status_check;
ALTER TABLE runs ADD CONSTRAINT runs_status_by_contract CHECK(
  (contract_version=1 AND status IN ('queued','building','analyzing','review','published','infra_error','cancelled')) OR
  (contract_version=2 AND status IN ('queued','preparing','building','checking','completed','build_error','infra_error','interrupted','cancelled'))
);
ALTER TABLE runs ADD CONSTRAINT runs_v2_context CHECK(contract_version=1 OR (rule_id IS NOT NULL AND idempotency_key IS NOT NULL AND length(idempotency_key)>0 AND request_hash IS NOT NULL AND length(request_hash)>0));
CREATE UNIQUE INDEX runs_v2_idempotency ON runs(submission_id,idempotency_key) WHERE contract_version=2;

CREATE TABLE execution_attempts(
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES runs(id),
  attempt_no integer NOT NULL CHECK(attempt_no>0),
  owner_phase text NOT NULL CHECK(owner_phase IN ('preparing','building','checking','initial_analysis','analyzing','cleaning','lost','cleanup_pending','recovering','closed')),
  lease_token uuid,
  lease_until timestamptz,
  heartbeat_at timestamptz,
  pipeline_started_at timestamptz NOT NULL,
  pipeline_deadline_at timestamptz NOT NULL,
  work_deadline_at timestamptz NOT NULL,
  base_sealed_at timestamptz,
  base_results jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(base_results)='array'),
  base_manifest jsonb,
  actual_fingerprint jsonb,
  cleanup_state text NOT NULL DEFAULT 'pending' CHECK(cleanup_state IN ('pending','cleaning','clean','cleanup_pending')),
  cleanup_receipt jsonb,
  control_operations jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(control_operations)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE(run_id,attempt_no), UNIQUE(id,run_id),
  CHECK(pipeline_started_at<work_deadline_at AND work_deadline_at<=pipeline_deadline_at),
  CHECK(base_sealed_at IS NULL OR (base_manifest IS NOT NULL AND actual_fingerprint IS NOT NULL)),
  CHECK(owner_phase<>'closed' OR (cleanup_state='clean' AND cleanup_receipt IS NOT NULL AND jsonb_typeof(cleanup_receipt)='object' AND cleanup_receipt<>'{}'::jsonb))
);
CREATE UNIQUE INDEX execution_one_sealed_base ON execution_attempts(run_id) WHERE base_sealed_at IS NOT NULL;
CREATE INDEX execution_resource_owners ON execution_attempts(owner_phase) WHERE owner_phase<>'closed';
ALTER TABLE runs ADD CONSTRAINT runs_accepted_attempt_same_run FOREIGN KEY(accepted_execution_attempt_id,id) REFERENCES execution_attempts(id,run_id);

CREATE TABLE analysis_attempts(
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES runs(id),
  base_manifest_id uuid,
  mode text NOT NULL CHECK(mode IN ('initial','reanalysis')),
  owner_execution_attempt_id uuid,
  status text NOT NULL CHECK(status IN ('queued','running','succeeded','degraded','interrupted','cancelled')),
  configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  budget jsonb NOT NULL DEFAULT '{}'::jsonb,
  deadlines jsonb NOT NULL DEFAULT '{}'::jsonb,
  usage jsonb NOT NULL DEFAULT '{}'::jsonb,
  candidate jsonb,
  selected_at_start_revision_id uuid,
  owner_phase text CHECK(owner_phase IN ('preparing','analyzing','cleaning','lost','cleanup_pending','recovering','closed')),
  lease_token uuid,
  lease_until timestamptz,
  heartbeat_at timestamptz,
  work_deadline_at timestamptz,
  hard_deadline_at timestamptz,
  cleanup_state text NOT NULL DEFAULT 'pending' CHECK(cleanup_state IN ('pending','cleaning','clean','cleanup_pending')),
  cleanup_receipt jsonb,
  control_operations jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(control_operations)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE(id,run_id),
  FOREIGN KEY(owner_execution_attempt_id,run_id) REFERENCES execution_attempts(id,run_id),
  CHECK((mode='initial' AND owner_execution_attempt_id IS NOT NULL AND owner_phase IS NULL AND lease_token IS NULL AND lease_until IS NULL AND heartbeat_at IS NULL AND work_deadline_at IS NULL AND hard_deadline_at IS NULL AND cleanup_receipt IS NULL AND cleanup_state='pending') OR (mode='reanalysis' AND owner_execution_attempt_id IS NULL)),
  CHECK(mode<>'reanalysis' OR status<>'queued' OR (owner_phase IS NULL AND lease_token IS NULL AND lease_until IS NULL)),
  CHECK(owner_phase IS NULL OR (work_deadline_at IS NOT NULL AND hard_deadline_at IS NOT NULL AND work_deadline_at<=hard_deadline_at)),
  CHECK(owner_phase IS DISTINCT FROM 'closed' OR (cleanup_state='clean' AND cleanup_receipt IS NOT NULL AND jsonb_typeof(cleanup_receipt)='object' AND cleanup_receipt<>'{}'::jsonb))
);
CREATE UNIQUE INDEX analysis_one_active_per_run ON analysis_attempts(run_id) WHERE status IN ('queued','running');
CREATE INDEX analysis_resource_owners ON analysis_attempts(owner_phase) WHERE mode='reanalysis' AND owner_phase IS NOT NULL AND owner_phase<>'closed';

CREATE TABLE analysis_operations(
  analysis_attempt_id uuid NOT NULL REFERENCES analysis_attempts(id),
  operation_id uuid NOT NULL,
  kind text NOT NULL,
  request_hash text NOT NULL,
  state text NOT NULL CHECK(state IN ('reserved','sent','completed','failed','unknown')),
  reserved_budget jsonb NOT NULL,
  actual_usage jsonb,
  provider_request_id text,
  response_hash text,
  supplemental_manifest jsonb,
  error jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  PRIMARY KEY(analysis_attempt_id,operation_id)
);

CREATE TABLE report_revisions(
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES runs(id),
  revision_no integer NOT NULL CHECK(revision_no>0),
  parent_revision_id uuid,
  base_manifest_id uuid NOT NULL,
  selected_supplemental_manifest_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  feedback jsonb NOT NULL DEFAULT '[]'::jsonb,
  teacher_judgments jsonb NOT NULL DEFAULT '[]'::jsonb,
  confirmations jsonb NOT NULL DEFAULT '[]'::jsonb,
  source text NOT NULL,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  UNIQUE(run_id,revision_no), UNIQUE(run_id,idempotency_key), UNIQUE(id,run_id),
  FOREIGN KEY(parent_revision_id,run_id) REFERENCES report_revisions(id,run_id)
);
CREATE TRIGGER report_revisions_immutable BEFORE UPDATE OR DELETE ON report_revisions FOR EACH ROW EXECUTE FUNCTION immutable_record();
ALTER TABLE analysis_attempts ADD CONSTRAINT analysis_start_revision_same_run FOREIGN KEY(selected_at_start_revision_id,run_id) REFERENCES report_revisions(id,run_id);

CREATE TABLE publications(
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES runs(id),
  publication_no integer NOT NULL CHECK(publication_no>0),
  revision_id uuid NOT NULL,
  supersedes_publication_id uuid,
  purpose text NOT NULL CHECK(purpose IN ('latest','historical_correction')),
  correction_reason text,
  snapshot jsonb NOT NULL,
  public_evidence_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  published_by uuid NOT NULL REFERENCES users(id),
  published_at timestamptz NOT NULL DEFAULT now(),
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  UNIQUE(run_id,publication_no), UNIQUE(run_id,idempotency_key), UNIQUE(id,run_id),
  FOREIGN KEY(revision_id,run_id) REFERENCES report_revisions(id,run_id),
  FOREIGN KEY(supersedes_publication_id,run_id) REFERENCES publications(id,run_id),
  CHECK(purpose<>'historical_correction' OR (supersedes_publication_id IS NOT NULL AND correction_reason IS NOT NULL AND length(trim(correction_reason))>0))
);
CREATE TRIGGER publications_immutable BEFORE UPDATE OR DELETE ON publications FOR EACH ROW EXECUTE FUNCTION immutable_record();

CREATE FUNCTION guard_execution_base_v2() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'execution attempt audit records cannot be deleted'; END IF;
  IF ROW(NEW.id,NEW.run_id,NEW.attempt_no,NEW.pipeline_started_at,NEW.pipeline_deadline_at,NEW.work_deadline_at,NEW.created_at)
     IS DISTINCT FROM ROW(OLD.id,OLD.run_id,OLD.attempt_no,OLD.pipeline_started_at,OLD.pipeline_deadline_at,OLD.work_deadline_at,OLD.created_at)
    THEN RAISE EXCEPTION 'execution identity and deadlines are immutable'; END IF;
  IF OLD.base_sealed_at IS NOT NULL AND
     ROW(NEW.base_sealed_at,NEW.base_results,NEW.base_manifest,NEW.actual_fingerprint)
     IS DISTINCT FROM ROW(OLD.base_sealed_at,OLD.base_results,OLD.base_manifest,OLD.actual_fingerprint)
    THEN RAISE EXCEPTION 'sealed base is immutable'; END IF;
  IF OLD.owner_phase='closed' AND NEW.owner_phase<>'closed' THEN RAISE EXCEPTION 'closed execution owner cannot reopen'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER execution_base_guard BEFORE UPDATE OR DELETE ON execution_attempts FOR EACH ROW EXECUTE FUNCTION guard_execution_base_v2();

CREATE FUNCTION guard_run_v2() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.contract_version IS DISTINCT FROM OLD.contract_version THEN RAISE EXCEPTION 'run contract version is immutable'; END IF;
  IF OLD.contract_version=2 THEN
    IF ROW(NEW.id,NEW.submission_id,NEW.rule_id,NEW.idempotency_key,NEW.request_hash,NEW.created_at)
       IS DISTINCT FROM ROW(OLD.id,OLD.submission_id,OLD.rule_id,OLD.idempotency_key,OLD.request_hash,OLD.created_at)
      THEN RAISE EXCEPTION 'run execution context is immutable'; END IF;
    IF OLD.status IN ('completed','build_error','infra_error','interrupted','cancelled') AND NEW.status<>OLD.status
      THEN RAISE EXCEPTION 'terminal run cannot reopen'; END IF;
    IF OLD.accepted_execution_attempt_id IS NOT NULL AND NEW.accepted_execution_attempt_id IS DISTINCT FROM OLD.accepted_execution_attempt_id
      THEN RAISE EXCEPTION 'accepted execution attempt cannot change'; END IF;
    IF OLD.pipeline_started_at IS NOT NULL AND NEW.pipeline_started_at IS DISTINCT FROM OLD.pipeline_started_at
      THEN RAISE EXCEPTION 'pipeline start cannot reset'; END IF;
    IF OLD.pipeline_deadline_at IS NOT NULL AND NEW.pipeline_deadline_at IS DISTINCT FROM OLD.pipeline_deadline_at
      THEN RAISE EXCEPTION 'pipeline deadline cannot reset'; END IF;
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER runs_v2_guard BEFORE UPDATE ON runs FOR EACH ROW EXECUTE FUNCTION guard_run_v2();

CREATE FUNCTION guard_analysis_owner_v2() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id,NEW.run_id,NEW.mode,NEW.owner_execution_attempt_id,NEW.created_at)
     IS DISTINCT FROM ROW(OLD.id,OLD.run_id,OLD.mode,OLD.owner_execution_attempt_id,OLD.created_at)
    THEN RAISE EXCEPTION 'analysis identity is immutable'; END IF;
  IF OLD.owner_phase='closed' AND NEW.owner_phase IS DISTINCT FROM 'closed' THEN RAISE EXCEPTION 'closed analysis owner cannot reopen'; END IF;
  IF OLD.work_deadline_at IS NOT NULL AND NEW.work_deadline_at IS DISTINCT FROM OLD.work_deadline_at THEN RAISE EXCEPTION 'analysis work deadline cannot reset'; END IF;
  IF OLD.hard_deadline_at IS NOT NULL AND NEW.hard_deadline_at IS DISTINCT FROM OLD.hard_deadline_at THEN RAISE EXCEPTION 'analysis hard deadline cannot reset'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER analysis_owner_guard BEFORE UPDATE ON analysis_attempts FOR EACH ROW EXECUTE FUNCTION guard_analysis_owner_v2();
