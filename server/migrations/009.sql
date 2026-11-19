-- Product descriptions are optional and do not affect existing inventory.
ALTER TABLE items ADD COLUMN description text NOT NULL DEFAULT ''
  CHECK (char_length(description) <= 4000);
