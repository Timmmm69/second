import { productColor } from "../shared/catalog-attributes.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "./db.js";
import { assert } from "./errors.js";
import { lockItems, setPhysical, audit, idem } from "./inventory.js";
import { assertActiveCategory } from "./categories.js";
const ids = z.array(z.uuid()).max(10000);
const itemInput = z
  .object({
    sku: z.string().trim().min(1).max(80).optional(),
    title: z.string().trim().min(1).max(180),
    category: z.string().min(1).max(100),
    priceMinor: z.number().int().min(0).max(100000000),
    attributes: z
      .record(
        z.string(),
        z.union([
          z.string().max(4000),
          z.number().finite(),
          z.boolean(),
          z.array(z.string().max(500)),
        ]),
      )
      .default({}),
    measurements: z
      .record(z.string(), z.number().int().min(0).max(20000))
      .optional(),
    hasDefect: z.boolean().default(false),
    defectDescription: z.string().trim().max(4000).default(""),
    storageLocation: z.string().max(200).default(""),
    version: z.number().int().optional(),
  })
  .strict()
  .refine(b => !b.hasDefect || b.defectDescription.length > 0, { message: "Опишите конкретный дефект", path: ["defectDescription"] });
function normalizeColor(attributes: z.infer<typeof itemInput>["attributes"], previousColor?: unknown) {
  const value = attributes.color;
  const color = productColor(value);
  if (!color && previousColor && !productColor(previousColor) &&
      (value === previousColor || value === undefined || (typeof value === "string" && !value.trim()))) {
    return { ...attributes, color: previousColor };
  }
  if (value === undefined) return attributes;
  assert(color || (typeof value === "string" && !value.trim()), 422, "COLOR", "Укажите название цвета словами");
  return { ...attributes, color };
}
export async function mapItem(row: any, staff = false) {
  return (await mapItems([row], staff))[0];
}
async function mapItems(rows: any[], staff = false) {
  if (!rows.length) return [];
  const assets = (
    await pool.query(
      "SELECT item_id,id,width,height,variants,role,position FROM media_assets WHERE item_id=ANY($1::uuid[]) AND state='READY' ORDER BY item_id,position,created_at",
      [rows.map((row) => row.id)],
    )
  ).rows;
  const byItem = new Map<string, any[]>();
  for (const { item_id, ...asset } of assets) {
    const media = byItem.get(item_id) ?? [];
    media.push(asset);
    byItem.set(item_id, media);
  }
  return rows.map((row) => itemWithMedia(row, byItem.get(row.id) ?? [], staff));
}
function itemWithMedia(row: any, assets: any[], staff: boolean) {
  return {
    id: row.id,
    sku: row.sku,
    title: row.title,
    category: row.category,
    priceMinor: row.price_minor,
    publication: row.publication,
    physical: staff ? row.physical : undefined,
    version: row.version,
    hasDefect: row.has_defect ?? false,
    defectDescription: row.has_defect ? row.defect_description : "",
    attributes: row.attributes,
    measurements: row.measurements,
    media: assets.map((m) => ({
      ...m,
      url: m.variants["480"] ?? m.variants["240"],
    })),
    available:
      row.publication === "PUBLISHED" &&
      row.physical === "AVAILABLE" &&
      !row.claimed,
    ...(staff ? { storageLocation: row.storage_location } : {}),
  };
}
export async function readItems(itemIds: string[], staff = false) {
  if (!itemIds.length) return [];
  const { rows } = await pool.query(
    `SELECT i.*, (EXISTS(SELECT 1 FROM inventory_claim c WHERE c.item_id=i.id AND (c.owner_type<>'CHECKOUT' OR c.expires_at>clock_timestamp())) OR EXISTS(SELECT 1 FROM operation_issues oi WHERE oi.item_id=i.id AND oi.state='OPEN' AND oi.kind IN ('NOT_FOUND','QUALITY','QUALITY_CHECK','INSPECTION','RETURN_INSPECTION'))) AS claimed FROM items i WHERE i.id=ANY($1::uuid[])`,
    [itemIds],
  );
  const items = await mapItems(rows, staff);
  return itemIds.map((id) => items.find((i) => i.id === id)).filter(Boolean);
}

const uuidParam = z.object({ id: z.uuid() });
export async function registerCatalog(app: FastifyInstance) {
  app.get("/catalog", async (req) => {
    const namedColor = "CASE WHEN btrim(i.attributes->>'color') !~* '(#|^[0-9a-f]{6}$|^[0-9a-f]{8}$)' THEN btrim(i.attributes->>'color') END";
    const q = z.record(z.string(), z.string()).parse(req.query),
      where = [
        "i.publication='PUBLISHED'",
        "i.physical='AVAILABLE'",
        "NOT EXISTS(SELECT 1 FROM inventory_claim c WHERE c.item_id=i.id AND (c.owner_type<>'CHECKOUT' OR c.expires_at>clock_timestamp()))",
        "NOT EXISTS(SELECT 1 FROM operation_issues oi WHERE oi.item_id=i.id AND oi.state='OPEN' AND oi.kind IN ('NOT_FOUND','QUALITY','QUALITY_CHECK','INSPECTION','RETURN_INSPECTION'))",
      ],
      params: any[] = [];
    const add = (sql: string, value: any) => {
      params.push(value);
      where.push(sql.replace("?", `$${params.length}`));
    };
    if (q.q)
      add(
        `lower(regexp_replace(concat_ws(' ',i.title,i.sku,i.attributes->>'brand',${namedColor}),'\\s+',' ','g')) LIKE ?`,
        "%" + q.q.toLowerCase().trim().replace(/\s+/g, " ") + "%",
      );
    if (q.category) add("i.category=?", q.category);
    for (const key of [
      "brand",
      "material",
      "season",
      "audience",
    ])
      if (q[key]) add(`lower(i.attributes->>'${key}')=lower(?)`, q[key]);
    if (q.color) add(`lower(${namedColor})=lower(?)`, q.color.trim());
    const size = q.sizeLabel?.trim();
    if (size) add("i.attributes->>'sizeSystem' IN ('INT','RU') AND lower(btrim(i.attributes->>'sizeLabel'))=lower(?)", size);
    for (const [key, op] of [
      ["minPrice", ">="],
      ["maxPrice", "<="],
    ] as const) {
      if (q[key]) {
        const val = Number(q[key]);
        assert(
          Number.isFinite(val) && val >= 0,
          422,
          "FILTER",
          "Укажите корректный диапазон",
        );
        add(`i.price_minor${op}?`, val);
      }
    }
    if (q.minPrice && q.maxPrice)
      assert(
        +q.minPrice <= +q.maxPrice,
        422,
        "FILTER",
        "Минимальная цена больше максимальной",
      );
    // Cursor is an opaque offset scoped to currently applied query; stock always comes from PostgreSQL.
    const offset = q.cursor
      ? Number(Buffer.from(q.cursor, "base64url").toString())
      : 0;
    assert(
      Number.isInteger(offset) && offset >= 0 && offset < 1000000,
      422,
      "CURSOR",
      "Обновите список",
    );
    const sort =
      q.sort === "price_asc"
        ? "i.price_minor ASC,i.id"
        : q.sort === "price_desc"
          ? "i.price_minor DESC,i.id"
          : "i.created_at DESC,i.id";
    const { rows } = await pool.query(
      `SELECT i.* FROM items i WHERE ${where.join(" AND ")} ORDER BY ${sort} LIMIT 41 OFFSET ${offset}`,
      params,
    );
    return {
      items: await mapItems(rows.slice(0, 40)),
      nextCursor:
        rows.length > 40
          ? Buffer.from(String(offset + 40)).toString("base64url")
          : null,
      serverNow: new Date().toISOString(),
    };
  });
  app.get("/items/:id", async (req) => {
    const { id } = uuidParam.parse(req.params);
    const row = (await readItems([id]))[0];
    assert(row, 404, "NOT_FOUND", "Вещь не найдена");
    return row;
  });
  app.get("/me/selection", async (req) => {
    const s = (
      await pool.query("SELECT item_ids FROM selections WHERE user_id=$1", [
        req.actor.id,
      ])
    ).rows[0];
    const itemIds = s?.item_ids ?? [];
    return { itemIds, items: await readItems(itemIds) };
  });
  app.put("/me/selection", async (req) => {
    const { itemIds } = z.object({ itemIds: ids }).parse(req.body),
      distinct = [...new Set(itemIds)];
    await pool.query(
      "INSERT INTO selections(user_id,item_ids) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET item_ids=excluded.item_ids,updated_at=now()",
      [req.actor.id, distinct],
    );
    return { itemIds: distinct, items: await readItems(distinct) };
  });
  app.get("/me/events", async (req) => {
    const { rows } = await pool.query(
      'SELECT id,type,message,created_at AS "createdAt",order_id AS "orderId",read_at AS "readAt" FROM user_events WHERE user_id=$1 ORDER BY created_at DESC LIMIT 200',
      [req.actor.id],
    );
    return { events: rows };
  });
  app.post("/me/events/:id/read", async (req) => {
    const { id } = uuidParam.parse(req.params);
    await pool.query(
      "UPDATE user_events SET read_at=now() WHERE id=$1 AND user_id=$2",
      [id, req.actor.id],
    );
    return { ok: true };
  });
  app.post("/staff/items/bulk-hide", async (req) => {
    const b = z
      .object({
        items: z
          .array(z.object({ id: z.uuid(), version: z.number().int() }))
          .min(1)
          .max(10000),
        confirmed: z.literal(true),
      })
      .parse(req.body);
    return idem(
      req.actor,
      req.headers["idempotency-key"],
      "items.bulk-hide",
      b,
      async (c) => {
        const items = await lockItems(
          c,
          b.items.map((i) => i.id),
        );
        for (const item of items) {
          assert(
            item.version === b.items.find((i) => i.id === item.id)?.version,
            409,
            "VERSION",
            "Список изменился. Обновите выбранные вещи",
          );
          assert(
            item.physical === "AVAILABLE" &&
              !(
                await c.query(
                  "SELECT 1 FROM inventory_claim WHERE item_id=$1",
                  [item.id],
                )
              ).rowCount,
            409,
            "CLAIMED",
            "В наборе есть закреплённая вещь. Обработайте обращение",
          );
        }
        await c.query(
          "UPDATE items SET publication='HIDDEN',version=version+1 WHERE id=ANY($1::uuid[])",
          [items.map((i) => i.id)],
        );
        for (const item of items)
          await audit(c, req.actor.id, "ITEM_BULK_HIDE", "ITEM", item.id, {});
        return {
          items: items.map((i) => ({
            ...i,
            publication: "HIDDEN",
            version: i.version + 1,
          })),
        };
      },
    );
  });
  app.get("/staff/items", async (req) => {
    const q = z
      .object({ q: z.string().optional(), state: z.string().optional() })
      .parse(req.query);
    const { rows } = await pool.query(
      "SELECT i.*,EXISTS(SELECT 1 FROM inventory_claim c WHERE c.item_id=i.id) claimed FROM items i WHERE ($1='' OR i.title ILIKE $1 OR i.sku ILIKE $1) AND ($2='' OR i.publication=$2 OR i.physical=$2) ORDER BY i.created_at DESC LIMIT 300",
      [q.q ? "%" + q.q + "%" : "", q.state ?? ""],
    );
    return { items: await mapItems(rows, true) };
  });
  app.get("/staff/items/:id", async (req) => {
    const { id } = uuidParam.parse(req.params),
      i = (await readItems([id], true))[0];
    assert(i, 404, "NOT_FOUND", "Вещь не найдена");
    return i;
  });
  app.post("/staff/items", async (req) => {
    const b = itemInput.parse(req.body);
    return idem(
      req.actor,
      req.headers["idempotency-key"],
      "items.create",
      b,
      async (c) => {
        await assertActiveCategory(c, b.category);
        const { rows } = await c.query(
          "INSERT INTO items(sku,title,category,price_minor,attributes,measurements,storage_location,has_defect,defect_description) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *",
          [
            b.sku ?? "V-" + crypto.randomUUID().slice(0, 8).toUpperCase(),
            b.title,
            b.category,
            b.priceMinor,
            normalizeColor(b.attributes),
            b.measurements ?? {},
            b.storageLocation,
            b.hasDefect,
            b.hasDefect ? b.defectDescription : "",
          ],
        );
        await audit(c, req.actor.id, "ITEM_CREATE", "ITEM", rows[0].id, {});
        return mapItem(rows[0], true);
      },
    );
  });
  app.patch("/staff/items/:id", async (req) => {
    const { id } = uuidParam.parse(req.params),
      b = itemInput.parse(req.body);
    return idem(
      req.actor,
      req.headers["idempotency-key"],
      "items.edit:" + id,
      b,
      async (c) => {
        await assertActiveCategory(c, b.category);
        const [old] = await lockItems(c, [id]);
        assert(
          old && old.version === b.version,
          409,
          "VERSION",
          "Карточку изменили. Обновите её перед сохранением",
        );
        assert(
          !(
            await c.query("SELECT 1 FROM inventory_claim WHERE item_id=$1", [
              id,
            ])
          ).rowCount,
          409,
          "CLAIMED",
          "Сначала согласуйте изменения действующего обращения",
        );
        const row = (
          await c.query(
            "UPDATE items SET sku=$2,title=$3,category=$4,price_minor=$5,attributes=$6,measurements=$7,storage_location=$8,has_defect=$9,defect_description=$10,version=version+1,updated_at=now() WHERE id=$1 RETURNING *",
            [
              id,
              b.sku ?? old.sku,
              b.title,
              b.category,
              b.priceMinor,
              normalizeColor(b.attributes, old.attributes.color),
              b.measurements ?? old.measurements,
              b.storageLocation,
              b.hasDefect,
              b.hasDefect ? b.defectDescription : "",
            ],
          )
        ).rows[0];
        await audit(c, req.actor.id, "ITEM_EDIT", "ITEM", id, {
          previousVersion: old.version,
          version: row.version,
        });
        return mapItem(row, true);
      },
    );
  });
  for (const command of ["publish", "hide", "inspect", "write-off"] as const)
    app.post("/staff/items/:id/" + command, async (req) => {
      const { id } = uuidParam.parse(req.params),
        b = z
          .object({
            version: z.number().int(),
            checked: z.boolean().optional(),
            suitable: z.boolean().optional(),
            reason: z.string().max(1000).optional(),
          })
          .parse(req.body);
      return idem(
        req.actor,
        req.headers["idempotency-key"],
        "items." + command + ":" + id,
        b,
        async (c) => {
          const [item] = await lockItems(c, [id]);
          assert(
            item && item.version === b.version,
            409,
            "VERSION",
            "Обновите карточку",
          );
          assert(
            !(
              await c.query("SELECT 1 FROM inventory_claim WHERE item_id=$1", [
                id,
              ])
            ).rowCount,
            409,
            "CLAIMED",
            "Вещь закреплена. Сначала обработайте связанное обращение",
          );
          if (command === "publish") {
            const fields: Record<string, string> = {};
            for (const key of [
              "material",
              "care",
              "manufacturer",
              "importer",
              "origin",
              "documents",
            ])
              if (
                !item.attributes[key] ||
                (Array.isArray(item.attributes[key]) &&
                  !item.attributes[key].length)
              )
                fields[key] = "Заполните сведения для нового товара";
            if (item.has_defect && !item.defect_description?.trim())
              fields.defectDescription = "Опишите конкретный дефект";
            if (!item.storage_location)
              fields.storageLocation = "Укажите место хранения";
            if (!b.checked) fields.checked = "Подтвердите физическую проверку";
            if (!["bags", "accessories"].includes(item.category) && !String(item.attributes.sizeLabel ?? "").trim())
              fields.sizeLabel = "Укажите размер";
            if (
              !(
                await c.query(
                  "SELECT 1 FROM media_assets WHERE item_id=$1 AND state='READY'",
                  [id],
                )
              ).rowCount
            )
              fields.media = "Добавьте фотографию";
            assert(
              !Object.keys(fields).length,
              422,
              "PUBLICATION_FIELDS",
              Object.entries(fields)
                .map(([k, v]) => `${k}: ${v}`)
                .join("; "),
            );
            assert(
              ["INTAKE", "AVAILABLE"].includes(item.physical),
              409,
              "PHYSICAL",
              "Сначала выполните допустимую приёмку вещи",
            );
            await setPhysical(
              c,
              [id],
              "AVAILABLE",
              req.actor.id,
              "PUBLISH_CHECK",
            );
            await c.query(
              "UPDATE items SET publication='PUBLISHED',published_snapshot=$2,version=version+1 WHERE id=$1",
              [
                id,
                JSON.stringify({
                  hasDefect: item.has_defect,
                  defectDescription: item.has_defect ? item.defect_description : "",
                  title: item.title,
                  priceMinor: item.price_minor,
                  attributes: item.attributes,
                  measurements: item.measurements,
                }),
              ],
            );
          } else if (command === "hide") {
            await c.query(
              "UPDATE items SET publication='HIDDEN',version=version+1 WHERE id=$1",
              [id],
            );
          } else if (command === "inspect") {
            assert(
              item.physical === "INSPECTION" || item.physical === "INTAKE",
              409,
              "PHYSICAL",
              "Осмотр доступен для принятой или освобождённой вещи",
            );
            assert(
              !(
                await c.query(
                  "SELECT 1 FROM return_lines rl JOIN order_lines ol ON ol.id=rl.order_line_id JOIN return_cases rc ON rc.id=rl.return_id WHERE ol.item_id=$1 AND rc.status NOT IN ('CLOSED','REJECTED')",
                  [id],
                )
              ).rowCount,
              409,
              "RETURN_OPEN",
              "Сначала дождитесь решения владельца по возврату",
            );
            assert(
              b.suitable === true,
              422,
              "INSPECTION",
              "Подтвердите пригодность и физическое наличие в зале",
            );
            await setPhysical(c, [id], "AVAILABLE", req.actor.id, "INSPECTED");
            await c.query(
              "UPDATE operation_issues SET state='RESOLVED',resolved_at=now(),resolution='Физически проверена' WHERE item_id=$1 AND state='OPEN'",
              [id],
            );
          } else {
            assert(
              req.actor.role === "OWNER",
              403,
              "OWNER",
              "Списание выполняет владелец",
            );
            assert(
              item.physical === "INSPECTION" && b.reason,
              422,
              "WRITE_OFF",
              "Нужны осмотр и причина списания",
            );
            await setPhysical(c, [id], "WRITTEN_OFF", req.actor.id, b.reason);
            await c.query(
              "UPDATE items SET publication='ARCHIVED' WHERE id=$1",
              [id],
            );
          }
          await audit(
            c,
            req.actor.id,
            "ITEM_" + command.toUpperCase(),
            "ITEM",
            id,
            { reason: b.reason ?? "" },
          );
          return mapItem(
            (await c.query("SELECT * FROM items WHERE id=$1", [id])).rows[0],
            true,
          );
        },
      );
    });
}
