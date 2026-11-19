-- Structured composition is optional; the original label text remains in attributes.material.
CREATE TABLE material_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  normalized_name text NOT NULL UNIQUE,
  aliases text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (length(name) BETWEEN 1 AND 120),
  CHECK (length(normalized_name) BETWEEN 1 AND 120)
);

ALTER TABLE items ADD COLUMN composition jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE items ADD CONSTRAINT items_composition_array CHECK (jsonb_typeof(composition)='array');
-- A membership lookup uses @> before applying the optional numeric threshold.
CREATE INDEX items_composition_gin ON items USING GIN (composition jsonb_path_ops);

INSERT INTO material_types(name,normalized_name,aliases) VALUES
 ('Хлопок','хлопок',ARRAY['cotton']),
 ('Полиэстер','полиэстер',ARRAY['полиэфир','polyester','pes']),
 ('Эластан','эластан',ARRAY['лайкра','спандекс','elastane','spandex','lycra']),
 ('Вискоза','вискоза',ARRAY['viscose','rayon']),
 ('Шерсть','шерсть',ARRAY['wool']),
 ('Лён','лен',ARRAY['лён','linen','flax']),
 ('Акрил','акрил',ARRAY['acrylic']),
 ('Полиамид','полиамид',ARRAY['нейлон','nylon','polyamide','pa']),
 ('Шёлк','шелк',ARRAY['шёлк','silk']),
 ('Кашемир','кашемир',ARRAY['cashmere']),
 ('Модал','модал',ARRAY['modal']),
 ('Лиоцелл','лиоцелл',ARRAY['тенсел','tencel','lyocell']),
 ('Полиуретан','полиуретан',ARRAY['polyurethane']),
 ('Кожа','кожа',ARRAY['leather']),
 ('Замша','замша',ARRAY['suede']),
 ('Пух','пух',ARRAY['down']),
 ('Перо','перо',ARRAY['feather']),
 ('Ацетат','ацетат',ARRAY['acetate']);
