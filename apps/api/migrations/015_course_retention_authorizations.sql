-- Authorization assertions survive later removal of the referenced course history.
-- No business-row FK and no permission to bypass immutable course records.
CREATE TABLE course_retention_authorizations (
 id uuid PRIMARY KEY,
 request_id uuid NOT NULL UNIQUE,
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 task_id uuid NOT NULL,
 student_id uuid NOT NULL,
 fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
 policy_reference text NOT NULL CHECK(length(policy_reference) BETWEEN 3 AND 300),
 authorization_reference text NOT NULL CHECK(length(authorization_reference) BETWEEN 3 AND 300),
 reason text NOT NULL CHECK(length(reason) BETWEEN 3 AND 300),
 external_references_reviewed boolean NOT NULL CHECK(external_references_reviewed),
 access_method text NOT NULL DEFAULT 'local_operator' CHECK(access_method='local_operator'),
 created_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL,
 CHECK(expires_at > created_at AND expires_at <= created_at + interval '24 hours')
);
CREATE TABLE course_retention_revocations (
 id uuid PRIMARY KEY,
 authorization_id uuid NOT NULL UNIQUE REFERENCES course_retention_authorizations(id),
 request_id uuid NOT NULL UNIQUE,
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 reason text NOT NULL CHECK(length(reason) BETWEEN 3 AND 300),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER course_authorization_immutable BEFORE UPDATE OR DELETE ON course_retention_authorizations
 FOR EACH ROW EXECUTE FUNCTION immutable_record();
CREATE TRIGGER course_authorization_no_truncate BEFORE TRUNCATE ON course_retention_authorizations
 FOR EACH STATEMENT EXECUTE FUNCTION immutable_record();
CREATE TRIGGER course_revocation_immutable BEFORE UPDATE OR DELETE ON course_retention_revocations
 FOR EACH ROW EXECUTE FUNCTION immutable_record();
CREATE TRIGGER course_revocation_no_truncate BEFORE TRUNCATE ON course_retention_revocations
 FOR EACH STATEMENT EXECUTE FUNCTION immutable_record();
