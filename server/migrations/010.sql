-- Drafts may lack merchandising data; old rows and historical media stay intact.
-- Public/hidden items must still have complete core fields.
ALTER TABLE items ALTER COLUMN title DROP NOT NULL;
ALTER TABLE items ALTER COLUMN category DROP NOT NULL;
ALTER TABLE items ALTER COLUMN price_minor DROP NOT NULL;
ALTER TABLE items ADD CONSTRAINT items_visible_required_fields CHECK (
  publication NOT IN ('PUBLISHED', 'HIDDEN') OR
  (title IS NOT NULL AND length(btrim(title)) > 0 AND category IS NOT NULL AND price_minor IS NOT NULL)
);
