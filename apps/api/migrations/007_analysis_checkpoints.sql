-- Private LangGraph checkpoints, keyed by analysis identity rather than Run.
CREATE TABLE analysis_checkpoints (
  analysis_attempt_id uuid NOT NULL REFERENCES analysis_attempts(id),
  checkpoint_id text NOT NULL,
  parent_checkpoint_id text,
  checkpoint_type text NOT NULL,
  checkpoint_data text NOT NULL,
  metadata_type text NOT NULL,
  metadata_data text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(analysis_attempt_id,checkpoint_id)
);
CREATE TABLE analysis_checkpoint_writes (
  analysis_attempt_id uuid NOT NULL,
  checkpoint_id text NOT NULL,
  task_id text NOT NULL,
  write_index integer NOT NULL,
  channel text NOT NULL,
  value_type text NOT NULL,
  value_data text NOT NULL,
  PRIMARY KEY(analysis_attempt_id,checkpoint_id,task_id,write_index),
  FOREIGN KEY(analysis_attempt_id,checkpoint_id) REFERENCES analysis_checkpoints(analysis_attempt_id,checkpoint_id)
);
