-- Ordinary existing stock stays ordinary. A disclosed defect is not an inventory issue.
ALTER TABLE items ADD COLUMN has_defect boolean NOT NULL DEFAULT false;
ALTER TABLE items ADD COLUMN defect_description text NOT NULL DEFAULT '';
ALTER TABLE items ADD CONSTRAINT item_defect_consistent CHECK (
  (has_defect AND length(btrim(defect_description)) BETWEEN 1 AND 4000)
  OR (NOT has_defect AND defect_description='')
);
