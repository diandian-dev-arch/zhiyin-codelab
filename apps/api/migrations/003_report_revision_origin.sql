-- Historical correction revisions retain the publication they originate from.
-- Existing revisions have no inferred origin; their content remains unchanged.
ALTER TABLE report_revisions ADD COLUMN origin_publication_id uuid;
ALTER TABLE report_revisions ADD CONSTRAINT report_revision_origin_same_run
  FOREIGN KEY(origin_publication_id,run_id) REFERENCES publications(id,run_id);
