import type { PoolClient } from "pg";
import { z } from "zod";
import { assert } from "./errors.js";

export type MaterialPart = { materialId: string; name: string; percent: number | null };
export type MaterialType = { id: string; name: string; aliases: string[] };
export const compositionSchema = z.array(z.object({
  materialId: z.uuid().transform(id => id.toLowerCase()),
  percent: z.number().int().min(1).max(100).nullable(),
}).strict()).max(20).superRefine((parts, context) => {
  if (new Set(parts.map(part => part.materialId)).size !== parts.length)
    context.addIssue({ code: "custom", message: "Материал повторяется" });
  const total = parts.reduce((sum, part) => sum + (part.percent ?? 0), 0);
  if (total > 100 || (total === 100 && parts.some(part => part.percent === null)))
    context.addIssue({ code: "custom", message: "Проверьте сумму процентов" });
});

export function normalizedMaterial(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("ru").replaceAll("ё", "е");
}

export function formatComposition(parts: readonly MaterialPart[]): string {
  return parts.map(part => part.percent === null ? part.name : `${part.percent}% ${part.name.toLocaleLowerCase("ru")}`).join(", ");
}

export async function resolveComposition(c: PoolClient, input: z.infer<typeof compositionSchema>): Promise<MaterialPart[]> {
  if (!input.length) return [];
  const ids = input.map(part => part.materialId);
  const { rows } = await c.query<{id: string; name: string}>(
    "SELECT id,name FROM material_types WHERE id=ANY($1::uuid[])", [ids],
  );
  assert(rows.length === ids.length, 422, "MATERIAL", "Выберите материал из списка");
  const names = new Map(rows.map(row => [row.id, row.name]));
  return input.map(part => ({
    materialId: part.materialId,
    name: names.get(part.materialId)!,
    percent: part.percent,
  }));
}

export function parseLegacyComposition(raw: string, materials: MaterialType[]): MaterialPart[] | null {
  const segments = raw.trim().split(/\s*[,;]\s*/).map(segment => segment.trim()).filter(Boolean);
  if (!segments.length || segments.length > 20) return null;
  const known = new Map<string, MaterialType>();
  for (const m of materials) for (const label of [m.name, ...m.aliases])
    known.set(normalizedMaterial(label), m);
  let total = 0;
  const parsed: MaterialPart[] = [];
  for (const segment of segments) {
    const before = /^(\d{1,3})\s*%\s*(.+)$/.exec(segment);
    const after = /^(.+?)\s+(\d{1,3})\s*%$/.exec(segment);
    const percent = before ? Number(before[1]) : after ? Number(after[2]) : null;
    const name = before ? before[2] : after ? after[1] : segment;
    if (percent !== null && (percent < 1 || percent > 100)) return null;
    const material = known.get(normalizedMaterial(name));
    if (!material || parsed.some(part => part.materialId === material.id)) return null;
    total += percent ?? 0;
    if (total > 100) return null;
    parsed.push({ materialId: material.id, name: material.name, percent });
  }
  if (total === 100 && parsed.some(part => part.percent === null)) return null;
  return parsed;
}

// One-time, conservative migration. Unknown/ambiguous old strings are left untouched.
export async function backfillLegacyCompositions(c: PoolClient): Promise<number> {
  const materials = (await c.query<MaterialType>(
    "SELECT id,name,aliases FROM material_types",
  )).rows;
  const source = (await c.query<{id: string; material: string}>(
    "SELECT id,attributes->>'material' material FROM items WHERE composition='[]'::jsonb AND nullif(btrim(attributes->>'material'),'') IS NOT NULL",
  )).rows;
  const updates = source.map(item => ({
    id: item.id,
    composition: parseLegacyComposition(item.material, materials),
  })).filter((item): item is {id: string; composition: MaterialPart[]} => item.composition !== null);
  for (let offset = 0; offset < updates.length; offset += 200) {
    const batch = updates.slice(offset, offset + 200);
    await c.query(
      `UPDATE items AS i SET composition=vals.composition
       FROM unnest($1::uuid[],$2::jsonb[]) AS vals(id,composition)
       WHERE i.id=vals.id AND i.composition='[]'::jsonb`,
      [batch.map(x => x.id), batch.map(x => JSON.stringify(x.composition))],
    );
  }
  return updates.length;
}

export async function createMaterial(c: PoolClient, requested: string): Promise<MaterialType> {
  const name = requested.normalize("NFKC").trim().replace(/\s+/g, " ");
  const normalized = normalizedMaterial(name);
  assert(name.length >= 2 && name.length <= 120 && /\p{L}/u.test(name), 422,
    "MATERIAL", "Укажите корректное название материала");
  const found = (await c.query<MaterialType>(
    "SELECT id,name,aliases FROM material_types WHERE normalized_name=$1 OR $1=ANY(aliases) LIMIT 1",
    [normalized],
  )).rows[0];
  if (found) return found;
  const created = await c.query<MaterialType>(
    `INSERT INTO material_types(name,normalized_name) VALUES($1,$2)
     ON CONFLICT(normalized_name) DO UPDATE SET normalized_name=excluded.normalized_name
     RETURNING id,name,aliases`,
    [name, normalized],
  );
  return created.rows[0];
}
