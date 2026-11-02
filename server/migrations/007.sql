-- No shared secret is copied into personal credentials. Existing owners must enroll via server CLI.
ALTER TABLE users ADD COLUMN telegram_verified_at timestamptz;
UPDATE users u SET telegram_verified_at=(SELECT max(a.created_at) FROM auth_replays a WHERE a.user_id=u.id)
WHERE EXISTS(SELECT 1 FROM auth_replays a WHERE a.user_id=u.id);
CREATE TABLE owner_credentials (
 user_id uuid PRIMARY KEY REFERENCES users(id), secret_enc text NOT NULL,
 last_step bigint NOT NULL DEFAULT -1, updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE sessions ADD COLUMN owner_step_up_at timestamptz;
