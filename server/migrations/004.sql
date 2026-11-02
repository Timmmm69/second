-- Rename only the original placeholder; preserve owner-entered names and data.
WITH previous AS (
  INSERT INTO rule_versions(settings_version, value)
  SELECT version, value FROM store_settings
  WHERE id = true AND value->>'name' = 'Вещи'
  RETURNING settings_version
)
UPDATE store_settings
SET value = jsonb_set(value, '{name}', '"Лучок"'::jsonb),
    version = version + 1,
    updated_at = now()
WHERE id = true AND version IN (SELECT settings_version FROM previous)
  AND value->>'name' = 'Вещи';
