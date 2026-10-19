ALTER TABLE source_analyses ADD COLUMN billing_user_id uuid REFERENCES users(id);
ALTER TABLE source_projects ADD COLUMN content_hash text;
CREATE INDEX source_projects_content_hash ON source_projects(owner_id, content_hash);

CREATE FUNCTION preserve_source_billing_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.billing_user_id IS DISTINCT FROM OLD.billing_user_id THEN
    RAISE EXCEPTION 'immutable source billing identity';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER source_billing_identity BEFORE UPDATE ON source_analyses
FOR EACH ROW EXECUTE FUNCTION preserve_source_billing_identity();
