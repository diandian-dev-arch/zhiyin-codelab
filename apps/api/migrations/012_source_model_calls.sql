ALTER TABLE source_analyses ADD COLUMN usage_recording_version integer CHECK (usage_recording_version = 1);
CREATE FUNCTION preserve_source_usage_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.usage_recording_version IS DISTINCT FROM OLD.usage_recording_version
 AND NOT (OLD.usage_recording_version IS NULL AND NEW.usage_recording_version = 1
          AND OLD.status = 'queued' AND NEW.status = 'running') THEN
  RAISE EXCEPTION 'immutable source usage version';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER source_usage_version_immutable BEFORE UPDATE ON source_analyses
 FOR EACH ROW EXECUTE FUNCTION preserve_source_usage_version();
CREATE TABLE source_model_calls (
 id uuid PRIMARY KEY,
 analysis_id uuid NOT NULL REFERENCES source_analyses(id),
 call_no integer NOT NULL CHECK (call_no BETWEEN 1 AND 16),
 state text NOT NULL CHECK (state IN ('started','returned','failed','unknown')),
 started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
 duration_ms integer CHECK (duration_ms >= 0),
 budget jsonb NOT NULL CHECK (jsonb_typeof(budget) = 'object'),
 usage jsonb CHECK (usage IS NULL OR jsonb_typeof(usage) = 'object'),
 request_id text CHECK (length(request_id) <= 256), error_code text,
 UNIQUE(analysis_id,call_no),
 CHECK ((state='started' AND finished_at IS NULL AND duration_ms IS NULL AND usage IS NULL AND request_id IS NULL AND error_code IS NULL)
     OR (state <> 'started' AND finished_at IS NOT NULL AND duration_ms IS NOT NULL)),
 CHECK (state='returned' OR usage IS NULL),
 CHECK (state <> 'returned' OR error_code IS NULL),
 CHECK (usage IS NULL OR COALESCE(
   jsonb_typeof(usage->'inputTokens')='number' AND jsonb_typeof(usage->'outputTokens')='number'
   AND (usage->>'inputTokens')::numeric BETWEEN 0 AND 9007199254740991
   AND (usage->>'outputTokens')::numeric BETWEEN 0 AND 9007199254740991
   AND trunc((usage->>'inputTokens')::numeric)=(usage->>'inputTokens')::numeric
   AND trunc((usage->>'outputTokens')::numeric)=(usage->>'outputTokens')::numeric, false))
);
CREATE FUNCTION preserve_source_model_call() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.state <> 'started'
 OR NEW.state = 'started'
 OR ROW(NEW.id,NEW.analysis_id,NEW.call_no,NEW.started_at,NEW.budget)
    IS DISTINCT FROM ROW(OLD.id,OLD.analysis_id,OLD.call_no,OLD.started_at,OLD.budget) THEN
  RAISE EXCEPTION 'immutable source model call';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER source_model_call_receipt_once BEFORE UPDATE ON source_model_calls
 FOR EACH ROW EXECUTE FUNCTION preserve_source_model_call();
