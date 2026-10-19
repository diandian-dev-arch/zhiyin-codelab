-- Provider account ownership is verified using the owner's encrypted connection.
-- Author display names/emails alone never establish a platform member mapping.
CREATE TABLE course_git_identities (
 user_id uuid NOT NULL REFERENCES users(id), provider text NOT NULL CHECK(provider IN ('github','gitee')),
 provider_user_id text NOT NULL, login text NOT NULL, connection_id uuid NOT NULL REFERENCES course_repository_connections(id),
 verified_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(user_id,provider), UNIQUE(provider,provider_user_id)
);

-- Read projections preserve original IDs, sharing, reports and historical lateness.
-- They do not manufacture immutable snapshots, provider SHAs or model consent.
CREATE VIEW course_legacy_assignment_projection AS
SELECT t.id AS assignment_id,t.id AS task_id,t.class_id,t.title,1 AS task_count
FROM tasks t WHERE t.kind='project' AND NOT EXISTS(SELECT 1 FROM course_tasks c WHERE c.task_id=t.id);
CREATE VIEW course_legacy_subject_projection AS
SELECT DISTINCT md5(s.task_id::text||':'||s.user_id::text)::uuid AS subject_id,
s.task_id AS assignment_id,s.user_id FROM project_submissions s
JOIN course_legacy_assignment_projection a ON a.task_id=s.task_id;
CREATE VIEW course_legacy_submission_projection AS
SELECT s.id,s.task_id,p.subject_id,s.user_id AS submitted_by,s.version AS sequence,
s.created_at,s.share_with_class,s.analysis_id,
CASE WHEN t.due_at IS NOT NULL AND s.created_at>=t.due_at THEN 'historical-late' ELSE 'historical' END AS timing,
'historical-incomplete'::text AS snapshot_status
FROM project_submissions s JOIN tasks t ON t.id=s.task_id
JOIN course_legacy_subject_projection p ON p.assignment_id=s.task_id AND p.user_id=s.user_id;
