CREATE TABLE categories (
 id text PRIMARY KEY,
 name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
 measurements text[] NOT NULL DEFAULT '{}',
 sort_order integer NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
 archived boolean NOT NULL DEFAULT false,
 version integer NOT NULL DEFAULT 1,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX categories_name ON categories(lower(translate(btrim(name), 'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯІЎ', 'абвгдеёжзийклмнопрстуфхцчшщъыьэюяіў')));
INSERT INTO categories(id,name,measurements,sort_order) VALUES
 ('outerwear','Куртки',ARRAY['chest','length','sleeve'],10),
 ('knit','Трикотаж',ARRAY['chest','length','sleeve'],20),
 ('shirts','Рубашки',ARRAY['chest','length','sleeve'],30),
 ('tops','Футболки и топы',ARRAY['chest','length'],40),
 ('trousers','Брюки и джинсы',ARRAY['waist','rise','length','inseam'],50),
 ('dresses','Платья и юбки',ARRAY['chest','waist','length'],60),
 ('children','Детское',ARRAY['chest','length'],70),
 ('bags','Сумки',ARRAY['width','height','depth','strap'],80),
 ('accessories','Аксессуары',ARRAY['length','width'],90);
-- Preserve any legacy category identifiers without changing items or snapshots.
INSERT INTO categories(id,name)
SELECT DISTINCT i.category, 'Категория ' || i.category FROM items i
WHERE NOT EXISTS (SELECT 1 FROM categories c WHERE c.id=i.category);
ALTER TABLE items ADD CONSTRAINT items_category_fk FOREIGN KEY(category) REFERENCES categories(id);
