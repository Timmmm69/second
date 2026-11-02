-- Generation/revision survive draft deletion so delayed saves cannot revive a completed form.
ALTER TABLE users ADD COLUMN checkout_token uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE users ADD COLUMN checkout_revision integer NOT NULL DEFAULT 0;
CREATE TABLE recipient_profiles (
 user_id uuid PRIMARY KEY REFERENCES users(id),
 value_enc text,
 enabled boolean NOT NULL DEFAULT true,
 version integer NOT NULL DEFAULT 1,
 updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE orders ADD COLUMN buyer_snapshot_enc text;
-- One short-lived, authenticated contact handoff; it does not mutate the form on webhook arrival.
ALTER TABLE users ADD COLUMN contact_phone_enc text;
ALTER TABLE users ADD COLUMN contact_phone_at timestamptz;
