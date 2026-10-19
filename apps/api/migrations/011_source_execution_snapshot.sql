-- Historical tasks retain NULL: their queue-time model/capacity was not recorded.
ALTER TABLE source_analyses ADD COLUMN execution_snapshot jsonb;
ALTER TABLE source_analyses ADD CONSTRAINT source_execution_snapshot_valid CHECK (
 execution_snapshot IS NULL OR COALESCE((
  jsonb_typeof(execution_snapshot) = 'object'
  AND execution_snapshot->'version' = '1'::jsonb
  AND jsonb_typeof(execution_snapshot->'model') = 'object'
  AND jsonb_typeof(execution_snapshot->'context') = 'object'
  AND execution_snapshot ?& ARRAY['version','model','context']
 ), false)
);
CREATE FUNCTION preserve_source_execution_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.execution_snapshot IS DISTINCT FROM OLD.execution_snapshot THEN
  RAISE EXCEPTION 'immutable source execution snapshot';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER source_execution_snapshot_immutable BEFORE UPDATE ON source_analyses
 FOR EACH ROW EXECUTE FUNCTION preserve_source_execution_snapshot();
