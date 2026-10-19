CREATE TABLE user_model_settings (
 user_id uuid PRIMARY KEY REFERENCES users(id),
 revision uuid NOT NULL,
 settings jsonb NOT NULL CHECK (jsonb_typeof(settings)='object'),
 encrypted_key text NOT NULL CHECK (length(encrypted_key) BETWEEN 40 AND 4096),
 updated_at timestamptz NOT NULL DEFAULT now()
);
