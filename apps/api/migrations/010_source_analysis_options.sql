ALTER TABLE source_analyses ADD COLUMN analysis_options jsonb;
ALTER TABLE source_analyses ADD CONSTRAINT source_analysis_options_valid CHECK (
 analysis_options IS NULL OR COALESCE((
  jsonb_typeof(analysis_options) = 'object'
  AND analysis_options->'version' = '1'::jsonb
  AND analysis_options->>'mode' IN ('quick','deep')
  AND jsonb_typeof(analysis_options->'modules') = 'array'
  AND CASE WHEN jsonb_typeof(analysis_options->'modules') = 'array'
       THEN jsonb_array_length(analysis_options->'modules') <= 6
       ELSE false END
  AND analysis_options ?& ARRAY['version','mode','modules']
 ), false)
);
CREATE FUNCTION preserve_source_analysis_options() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.analysis_options IS DISTINCT FROM OLD.analysis_options THEN
  RAISE EXCEPTION 'immutable source analysis options';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER source_analysis_options_immutable BEFORE UPDATE ON source_analyses
 FOR EACH ROW EXECUTE FUNCTION preserve_source_analysis_options();
