import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { z } from "zod";
import { pool } from "./db.js";
import { assert } from "./errors.js";
import { audit, idem } from "./inventory.js";

const measurementKeys = [
  "chest", "waist", "hips", "length", "sleeve", "inseam", "rise",
  "width", "height", "depth", "strap", "shoulders",
] as const;
const input = z.object({
  name: z.string().trim().min(1).max(100),
  measurements: z.array(z.enum(measurementKeys)).max(12)
    .refine(v => new Set(v).size === v.length, "Замеры не должны повторяться").optional(),
  sortOrder: z.number().int().min(0).max(1000000),
  archived: z.boolean(),
}).strict();
const columns = 'id,name,measurements,sort_order AS "sortOrder",archived,version';

export async function readCategories(includeArchived = false) {
  return (await pool.query(
    `SELECT ${columns} FROM categories WHERE ($1 OR NOT archived) ORDER BY sort_order,lower(name),id`,
    [includeArchived],
  )).rows;
}
export async function assertActiveCategory(c: PoolClient, id: string) {
  const row = (await c.query("SELECT archived FROM categories WHERE id=$1 FOR SHARE", [id])).rows[0];
  assert(row && !row.archived, 422, "CATEGORY", "Выберите действующую категорию");
}
export async function registerCategories(app: FastifyInstance) {
  app.get("/categories", () => readCategories());
  app.get("/staff/categories", () => readCategories(true));
  app.get("/owner/categories", () => readCategories(true));
  app.post("/owner/categories", async req => {
    const b = input.parse(req.body);
    return idem(req.actor, req.headers["idempotency-key"], "categories.create", b, async c => {
      const row = (await c.query(
        `INSERT INTO categories(id,name,measurements,sort_order,archived) VALUES($1,$2,$3,$4,$5) RETURNING ${columns}`,
        [randomUUID(),b.name,b.measurements ?? [],b.sortOrder,b.archived],
      )).rows[0];
      await audit(c,req.actor.id,"CATEGORY_CREATE","CATEGORY",row.id,{name:row.name});
      return row;
    });
  });
  app.patch("/owner/categories/:id", async req => {
    const { id } = z.object({id:z.string().min(1).max(100)}).parse(req.params);
    const b = input.extend({version:z.number().int().positive()}).parse(req.body);
    return idem(req.actor,req.headers["idempotency-key"],"categories.edit:"+id,b,async c => {
      const old = (await c.query("SELECT * FROM categories WHERE id=$1 FOR UPDATE",[id])).rows[0];
      assert(old,404,"CATEGORY","Категория не найдена");
      assert(old.version===b.version,409,"VERSION","Категория изменена. Обновите список");
      if (b.archived) assert(
        !(await c.query("SELECT 1 FROM items WHERE category=$1 LIMIT 1",[id])).rowCount,
        409,"CATEGORY_IN_USE","Сначала перенесите вещи из этой категории в другую. История обращений сохраняется",
      );
      const row = (await c.query(
        `UPDATE categories SET name=$2,measurements=$3,sort_order=$4,archived=$5,version=version+1,updated_at=now() WHERE id=$1 RETURNING ${columns}`,
        [id,b.name,b.measurements ?? old.measurements,b.sortOrder,b.archived],
      )).rows[0];
      await audit(c,req.actor.id,"CATEGORY_EDIT","CATEGORY",id,{previousVersion:old.version,version:row.version,name:row.name,archived:row.archived});
      return row;
    });
  });
}
