CREATE TABLE source_projects (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES users(id),
 name text NOT NULL, sha256 text NOT NULL, files jsonb NOT NULL, omitted jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(owner_id,sha256)
);
CREATE TABLE source_analyses (
 id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES source_projects(id) ON DELETE CASCADE,
 status text NOT NULL CHECK(status IN ('queued','running','succeeded','failed','cancelled')),
 events jsonb NOT NULL DEFAULT '[]', report jsonb, code text,
 created_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz, finished_at timestamptz,
 deadline timestamptz
);
CREATE UNIQUE INDEX source_one_active ON source_analyses(project_id) WHERE status IN ('queued','running');
CREATE INDEX source_projects_owner ON source_projects(owner_id,created_at);
