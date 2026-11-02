import type { PoolClient } from "pg";
import { createHash } from "node:crypto";
import { tx } from "./db.js";
import { AppError } from "./errors.js";
import { encrypt, decrypt } from "./crypto.js";
import type { Actor } from "./types.js";
export type ItemRow = {
  id: string;
  sku: string;
  title: string;
  category: string;
  price_minor: number;
  publication: string;
  physical: string;
  version: number;
  attributes: Record<string, unknown>;
  measurements: Record<string, number>;
  storage_location: string;
};
export async function audit(
  c: PoolClient,
  actorId: string | null,
  command: string,
  entityType: string,
  entityId: string,
  details: Record<string, unknown> = {},
) {
  await c.query(
    "INSERT INTO audit_events(actor_id,command,entity_type,entity_id,details) VALUES($1,$2,$3,$4,$5)",
    [actorId, command, entityType, entityId, JSON.stringify(details)],
  );
}
export async function lockItems(
  c: PoolClient,
  ids: string[],
): Promise<ItemRow[]> {
  const unique = [...new Set(ids)].sort();
  if (!unique.length)
    throw new AppError(422, "EMPTY_SELECTION", "Выберите хотя бы одну вещь");
  const { rows } = await c.query<ItemRow>(
    "SELECT * FROM items WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE",
    [unique],
  );
  if (rows.length !== unique.length)
    throw new AppError(
      409,
      "ITEM_NOT_FOUND",
      "Некоторые вещи больше недоступны",
    );
  return rows;
}
export async function releaseClaims(
  c: PoolClient,
  ids: string[],
  reason: string,
) {
  if (!ids.length) return;
  await c.query(
    `INSERT INTO claim_history(item_id,owner_type,owner_id,user_id,action,reason) SELECT item_id,owner_type,owner_id,user_id,'RELEASED',$2 FROM inventory_claim WHERE item_id=ANY($1::uuid[])`,
    [ids, reason],
  );
  await c.query("DELETE FROM inventory_claim WHERE item_id=ANY($1::uuid[])", [
    ids,
  ]);
}
export async function expireCheckoutClaims(c: PoolClient, ids: string[]) {
  const { rows } = await c.query(
    `SELECT item_id FROM inventory_claim WHERE item_id=ANY($1::uuid[]) AND owner_type='CHECKOUT' AND expires_at<=clock_timestamp()`,
    [ids],
  );
  await releaseClaims(
    c,
    rows.map((r) => r.item_id),
    "checkout ttl",
  );
}
export async function claimItems(
  c: PoolClient,
  ids: string[],
  type: string,
  ownerId: string,
  userId: string | null,
  expiresAt: Date | null,
) {
  for (const itemId of [...ids].sort()) {
    await c.query(
      "INSERT INTO inventory_claim(item_id,owner_type,owner_id,user_id,expires_at) VALUES($1,$2,$3,$4,$5)",
      [itemId, type, ownerId, userId, expiresAt],
    );
    await c.query(
      `INSERT INTO claim_history(item_id,owner_type,owner_id,user_id,action) VALUES($1,$2,$3,$4,'CLAIMED')`,
      [itemId, type, ownerId, userId],
    );
  }
}
export async function convertClaims(
  c: PoolClient,
  ids: string[],
  fromType: string,
  fromId: string,
  type: string,
  ownerId: string,
  expiresAt: Date | null,
) {
  const result = await c.query(
    "UPDATE inventory_claim SET owner_type=$4,owner_id=$5,expires_at=$6,version=version+1 WHERE item_id=ANY($1::uuid[]) AND owner_type=$2 AND owner_id=$3",
    [ids, fromType, fromId, type, ownerId, expiresAt],
  );
  if (result.rowCount !== ids.length)
    throw new AppError(
      409,
      "CLAIM_LOST",
      "Закрепление вещей изменилось. Обновите обращение",
    );
  await c.query(
    `INSERT INTO claim_history(item_id,owner_type,owner_id,user_id,action) SELECT item_id,owner_type,owner_id,user_id,'CONVERTED' FROM inventory_claim WHERE item_id=ANY($1::uuid[])`,
    [ids],
  );
}
export async function setPhysical(
  c: PoolClient,
  ids: string[],
  physical: string,
  actorId: string | null = null,
  reason = "",
) {
  if (!ids.length) return;
  await c.query(
    "UPDATE items SET physical=$2,version=version+1,updated_at=clock_timestamp() WHERE id=ANY($1::uuid[])",
    [ids, physical],
  );
  for (const id of ids)
    await audit(c, actorId, "inventory." + physical, "item", id, { reason });
}
export async function assertAvailable(c: PoolClient, items: ItemRow[]) {
  await expireCheckoutClaims(
    c,
    items.map((i) => i.id),
  );
  const { rows } = await c.query(
    "SELECT item_id FROM inventory_claim WHERE item_id=ANY($1::uuid[])",
    [items.map((i) => i.id)],
  );
  const occupied = new Set(rows.map((r) => r.item_id));
  const blocked = (
    await c.query(
      "SELECT DISTINCT item_id FROM operation_issues WHERE item_id=ANY($1::uuid[]) AND state='OPEN' AND kind IN ('NOT_FOUND','QUALITY','QUALITY_CHECK','INSPECTION','RETURN_INSPECTION')",
      [items.map((i) => i.id)],
    )
  ).rows;
  for (const row of blocked) occupied.add(row.item_id);
  const conflicts = items
    .filter(
      (i) =>
        i.publication !== "PUBLISHED" ||
        i.physical !== "AVAILABLE" ||
        occupied.has(i.id),
    )
    .map((i) => ({
      itemId: i.id,
      reason: "Вещь уже закреплена или снята с продажи",
    }));
  if (conflicts.length) {
    const e = new AppError(
      409,
      "AVAILABILITY_CONFLICT",
      "Не удалось закрепить весь набор. Выберите новый состав",
    );
    Object.assign(e, { conflicts });
    throw e;
  }
}
export async function itemSnapshot(c: PoolClient, i: ItemRow) {
  const { rows } = await c.query(
    "SELECT id,variants,width,height,role FROM media_assets WHERE item_id=$1 AND state='READY' ORDER BY position,id",
    [i.id],
  );
  const media = rows.map((r) => ({
    id: r.id,
    url: r.variants["480"] ?? r.variants["960"] ?? "",
    variants: r.variants,
    width: r.width,
    height: r.height,
    role: r.role,
  }));
  return {
    id: i.id,
    sku: i.sku,
    title: i.title,
    category: i.category,
    priceMinor: i.price_minor,
    version: i.version,
    attributes: i.attributes,
    measurements: i.measurements,
    media,
  };
}
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, stable(v)]),
    );
  return value;
}
export async function idem<T>(
  actor: Actor,
  key: unknown,
  scope: string,
  body: unknown,
  fn: (c: PoolClient) => Promise<T>,
): Promise<T> {
  if (typeof key !== "string" || !/^[-a-zA-Z0-9_:]{8,120}$/.test(key))
    throw new AppError(
      422,
      "IDEMPOTENCY_KEY",
      "Нужен ключ операции Idempotency-Key",
    );
  const hash = createHash("sha256")
    .update(JSON.stringify(stable({ scope, body })))
    .digest("hex");
  return tx(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      actor.id + ":" + key,
    ]);
    const old = (
      await c.query(
        "SELECT * FROM idempotency_records WHERE actor_id=$1 AND key=$2",
        [actor.id, key],
      )
    ).rows[0];
    if (old) {
      if (old.request_hash !== hash || old.scope !== scope)
        throw new AppError(
          409,
          "IDEMPOTENCY_MISMATCH",
          "Этот ключ уже использован для другого действия",
        );
      await authorizeReplay(c, actor, old);
      return decrypt(old.response.encrypted) as T;
    }
    const result = await fn(c);
    const object = result as Record<string, unknown> | null;
    const reference = object && (object.orderId ?? object.id);
    const entityId =
      typeof reference === "string" && /^[0-9a-f-]{36}$/i.test(reference)
        ? reference
        : null;
    await c.query(
      "INSERT INTO idempotency_records(actor_id,key,scope,request_hash,response,entity_id) VALUES($1,$2,$3,$4,$5,$6)",
      [
        actor.id,
        key,
        scope,
        hash,
        JSON.stringify({ encrypted: encrypt(result) }),
        entityId,
      ],
    );
    return result;
  });
}
export async function issue(
  c: PoolClient,
  entityId: string,
  kind: string,
  message: string,
  orderId: string | null = null,
  itemId: string | null = null,
) {
  await c.query(
    `INSERT INTO operation_issues(entity_id,kind,message,order_id,item_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT(kind,entity_id) WHERE state='OPEN' DO NOTHING`,
    [entityId, kind, message, orderId, itemId],
  );
}
export async function event(
  c: PoolClient,
  o: { id: string; user_id: string; version: number; number: string | number },
  type: string,
  message: string,
) {
  const text = `№${o.number}: ${message}`;
  const inserted = await c.query(
    `INSERT INTO outbox_events(entity_id,entity_version,event_type,recipient_id,message) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id`,
    [o.id, o.version, type, o.user_id, text],
  );
  if (inserted.rowCount)
    await c.query(
      "INSERT INTO user_events(user_id,order_id,type,message) VALUES($1,$2,$3,$4)",
      [o.user_id, o.id, type, text],
    );
}

export async function authorizeReplay(
  c: PoolClient,
  actor: Actor,
  record: { scope: string; entity_id?: string | null },
) {
  if (actor.role !== "BUYER") return;
  if (
    !/^(checkout\.lease|lease\.release(?:$|:)|orders\.create$|orders\.cancel:|orders\.recipient:|orders\.proposal-response:)/.test(
      record.scope,
    )
  )
    throw new AppError(
      403,
      "FORBIDDEN",
      "Служебный результат больше недоступен после отзыва роли",
    );
  if (record.entity_id) {
    const row = (
      await c.query("SELECT user_id FROM orders WHERE id=$1", [
        record.entity_id,
      ])
    ).rows[0];
    if (row && row.user_id !== actor.id)
      throw new AppError(403, "FORBIDDEN", "Нет доступа к этому обращению");
  }
}
