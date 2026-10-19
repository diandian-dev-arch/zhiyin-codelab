-- Original provider output is private audit material, never public evidence.
CREATE TABLE analysis_private_io (
  analysis_attempt_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  input jsonb NOT NULL,
  response text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(analysis_attempt_id,operation_id),
  FOREIGN KEY(analysis_attempt_id,operation_id)
    REFERENCES analysis_operations(analysis_attempt_id,operation_id)
);
