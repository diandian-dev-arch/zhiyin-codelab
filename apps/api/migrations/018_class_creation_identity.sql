CREATE TABLE class_creation_requests (
  teacher_id uuid NOT NULL REFERENCES users(id),
  request_key text NOT NULL,
  class_id uuid NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  request_name text NOT NULL,
  PRIMARY KEY(teacher_id,request_key)
);
