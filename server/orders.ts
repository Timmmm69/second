import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import {
  randomUUID,
  randomInt,
  createHash,
  timingSafeEqual,
} from "node:crypto";
import { z } from "zod";
import { tx } from "./db.js";
import { AppError, assert } from "./errors.js";
import type { Actor } from "./types.js";
import { encrypt, decrypt } from "./crypto.js";
import {
  type Calendar,
  pickupDeadline,
  dispatchDeadline,
  addOpenHours,
} from "./calendar.js";
import {
  audit,
  lockItems,
  setPhysical,
  releaseClaims,
  claimItems,
  convertClaims,
  assertAvailable,
  itemSnapshot,
  idem,
  issue,
  event,
  authorizeReplay,
} from "./inventory.js";
const ids = z
  .array(z.string().uuid())
  .min(1)
  .refine((a) => new Set(a).size === a.length, "Вещи не должны повторяться");
const version = z.number().int().positive();
const recipientSchema = z.object({
  phone: z
    .string()
    .trim()
    .regex(/^\+?[\d\s()-]{9,22}$/, "Укажите телефон с кодом страны"),
  fullName: z.string().trim().max(200).optional(),
  city: z.string().trim().max(150).optional(),
  office: z.string().trim().max(350).optional(),
  postalCode: z.string().trim().max(20).optional(),
  comment: z.string().trim().max(1000).optional(),
});
export interface OrderRow {
  id: string;
  user_id: string;
  version: number;
  number: string;
  [key: string]: any;
}
export async function getSettings(c: PoolClient) {
  const r = await c.query(
    "SELECT value,version FROM store_settings WHERE id=true",
  );
  return { ...r.rows[0].value, version: r.rows[0].version };
}
export async function lockedOrder(
  c: PoolClient,
  id: string,
  actor?: Actor,
): Promise<OrderRow> {
  const o = (await c.query("SELECT * FROM orders WHERE id=$1 FOR UPDATE", [id]))
    .rows[0];
  assert(o, 404, "ORDER_NOT_FOUND", "Обращение не найдено");
  if (actor)
    assert(
      o.user_id === actor.id || actor.role !== "BUYER",
      403,
      "FORBIDDEN",
      "Нет доступа к этому обращению",
    );
  return o;
}
export async function orderLines(c: PoolClient, id: string) {
  return (
    await c.query(
      "SELECT ol.*,i.storage_location FROM order_lines ol JOIN items i ON i.id=ol.item_id WHERE ol.order_id=$1 ORDER BY ol.item_id",
      [id],
    )
  ).rows;
}
function expected(o: OrderRow, v: number) {
  assert(
    o.version === v,
    409,
    "VERSION_CONFLICT",
    "Обращение изменилось. Обновите данные и повторите действие",
  );
}
async function now(c: PoolClient): Promise<Date> {
  return (await c.query("SELECT clock_timestamp() AS at")).rows[0].at;
}
async function bump(c: PoolClient, o: OrderRow, status?: string) {
  const r = await c.query(
    "UPDATE orders SET status=COALESCE($2,status),version=version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING *",
    [o.id, status ?? null],
  );
  Object.assign(o, r.rows[0]);
}
async function setReservation(c: PoolClient, o: OrderRow, status: string) {
  await c.query(
    "UPDATE reservations SET status=$2,ready_at=$3,pickup_deadline=$4 WHERE order_id=$1",
    [o.id, status, o.ready_at, o.pickup_deadline],
  );
}
async function outcomes(c: PoolClient, lines: any[], outcome: string) {
  if (!lines.length) return;
  const lineIds = lines.map((l) => l.id);
  await c.query("UPDATE order_lines SET outcome=$2 WHERE id=ANY($1::uuid[])", [
    lineIds,
    outcome,
  ]);
  await c.query(
    "UPDATE reservation_lines SET status=$2 WHERE order_line_id=ANY($1::uuid[])",
    [lineIds, outcome],
  );
}
async function releaseLines(
  c: PoolClient,
  o: OrderRow,
  lines: any[],
  reason: string,
  outcome = "CANCELLED",
) {
  const itemIds = lines.map((l) => l.item_id);
  if (!itemIds.length) return;
  await lockItems(c, itemIds);
  await releaseClaims(c, itemIds, reason);
  await setPhysical(c, itemIds, "INSPECTION", null, reason);
  await outcomes(c, lines, outcome);
  for (const l of lines)
    await issue(
      c,
      l.item_id,
      "INSPECTION",
      "Осмотрите вещь и верните её в торговый зал",
      o.id,
      l.item_id,
    );
}
export async function readOrder(c: PoolClient, id: string, actor: Actor) {
  const o = (
    await c.query(
      "SELECT o.*,r.status AS reservation_status FROM orders o JOIN reservations r ON r.order_id=o.id WHERE o.id=$1",
      [id],
    )
  ).rows[0];
  assert(o, 404, "ORDER_NOT_FOUND", "Обращение не найдено");
  assert(
    actor.id === o.user_id || actor.role !== "BUYER",
    403,
    "FORBIDDEN",
    "Нет доступа к этому обращению",
  );
  if (actor.role !== "BUYER")
    await c.query(
      "INSERT INTO access_events(actor_id,action,entity_id) VALUES($1,$2,$3)",
      [actor.id, "order.read", id],
    );
  const lines = await orderLines(c, id),
    sh = (
      await c.query(
        "SELECT * FROM shipments WHERE order_id=$1 AND status<>'CANCELLED' ORDER BY created_at DESC LIMIT 1",
        [id],
      )
    ).rows[0];
  const handover = (
    await c.query("SELECT id,state FROM handovers WHERE order_id=$1", [id])
  ).rows[0];
  const ruleSnapshot = structuredClone(o.rule_snapshot);
  if (actor.role === "BUYER" && ruleSnapshot.carriers)
    ruleSnapshot.carriers = Object.fromEntries(
      Object.entries(ruleSnapshot.carriers as Record<string, any>).map(
        ([name, carrier]) => [
          name,
          { enabled: carrier.enabled, terms: carrier.terms },
        ],
      ),
    );
  const returnCases = (
    await c.query(
      'SELECT id,status,created_at AS "createdAt",received_at AS "receivedAt",closed_at AS "closedAt" FROM return_cases WHERE order_id=$1 ORDER BY created_at DESC',
      [id],
    )
  ).rows.map((r) => ({
    ...r,
    decision:
      r.status === "CLOSED"
        ? "Решение принято; подробности сообщит магазин"
        : undefined,
  }));
  const notes =
    actor.role === "BUYER"
      ? undefined
      : (
          await c.query(
            "SELECT id,note_enc,created_at FROM contact_notes WHERE order_id=$1 ORDER BY created_at",
            [id],
          )
        ).rows.map((r) => ({
          id: r.id,
          note: decrypt(r.note_enc),
          createdAt: r.created_at,
        }));
  return {
    id: o.id,
    number: String(o.number),
    method: o.method,
    status: o.status,
    reservationStatus: o.reservation_status,
    version: o.version,
    totalMinor: o.total_minor,
    createdAt: o.created_at,
    verifyBy: o.verify_by,
    readyAt: o.ready_at,
    pickupDeadline: o.pickup_deadline,
    dispatchDeadline: o.dispatch_deadline,
    recipient: o.recipient_enc ? decrypt(o.recipient_enc) : {},
    pickupCode:
      actor.id === o.user_id &&
      o.pickup_code_enc &&
      ["READY_FOR_PICKUP", "HANDOVER"].includes(o.status)
        ? decrypt<string>(o.pickup_code_enc)
        : undefined,
    assignedTo: o.assigned_to,
    proposal: o.proposal,
    cancelRequested: o.cancel_requested?.recipientEnc
      ? {
          type: o.cancel_requested.type,
          recipient: decrypt(o.cancel_requested.recipientEnc),
        }
      : o.cancel_requested,
    exception: o.exception,
    ruleSnapshot,
    returnCases,
    notes,
    handover: actor.role !== "BUYER" ? handover : undefined,
    lines: lines.map((l) => ({
      ...l.snapshot,
      id: l.id,
      itemId: l.item_id,
      priceMinor: l.price_minor,
      outcome: l.outcome,
      checked: l.checked,
      ...(actor.role !== "BUYER"
        ? { storageLocation: l.storage_location }
        : {}),
    })),
    shipment: sh
      ? {
          id: sh.id,
          tracking: sh.tracking,
          status: sh.status,
          version: sh.version,
          source: sh.source,
          updatedAt: sh.updated_at,
          trackingUrl:
            sh.carrier === "BELPOST"
              ? `https://belpost.by/Otslezhivanie?number=${encodeURIComponent(sh.tracking)}`
              : `https://evropochta.by/?tracking=${encodeURIComponent(sh.tracking)}`,
        }
      : undefined,
  };
}
export async function createLease(
  actor: Actor,
  key: unknown,
  body: { itemIds: string[] },
) {
  ids.parse(body.itemIds);
  return idem(actor, key, "checkout.lease", body, async (c) => {
    await c.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [actor.id]);
    const settings = await getSettings(c);
    assert(
      settings.acceptingOrders,
      503,
      "STORE_CLOSED",
      "Оформление временно закрыто. Выбор сохранён",
    );
    const items = await lockItems(c, body.itemIds);
    await assertAvailable(c, items);
    const id = randomUUID(),
      at = await now(c),
      expiresAt = new Date(at.getTime() + 600000);
    await c.query(
      "INSERT INTO leases(id,user_id,expires_at) VALUES($1,$2,$3)",
      [id, actor.id, expiresAt],
    );
    const snapshots = [];
    for (const i of items) {
      const snap = await itemSnapshot(c, i);
      snapshots.push(snap);
      await c.query(
        "INSERT INTO lease_lines(lease_id,item_id,item_version,snapshot) VALUES($1,$2,$3,$4)",
        [id, i.id, i.version, JSON.stringify(snap)],
      );
    }
    await claimItems(c, body.itemIds, "CHECKOUT", id, actor.id, expiresAt);
    await audit(c, actor.id, "checkout.lease", "lease", id, {
      itemIds: body.itemIds,
    });
    return { id, expiresAt, items: snapshots };
  });
}
export async function confirmOrder(actor: Actor, key: unknown, raw: unknown) {
  const body = recipientSchema
    .extend({
      leaseId: z.string().uuid(),
      method: z.enum(["PICKUP", "BELPOST", "EUROPOST"]),
      termsAccepted: z.literal(true),
    })
    .parse(raw);
  if (body.method !== "PICKUP")
    for (const field of ["fullName", "city", "office"] as const)
      assert(
        body[field]?.trim(),
        422,
        "RECIPIENT_REQUIRED",
        `Заполните ${field === "fullName" ? "ФИО получателя" : field === "city" ? "населённый пункт" : "отделение"}`,
      );
  return idem(actor, key, "orders.create", body, async (c) => {
    await c.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [actor.id]);
    const lease = (
      await c.query("SELECT * FROM leases WHERE id=$1 FOR UPDATE", [
        body.leaseId,
      ])
    ).rows[0];
    assert(
      lease && lease.user_id === actor.id,
      403,
      "LEASE_FORBIDDEN",
      "Удержание не найдено",
    );
    const ls = (
      await c.query(
        "SELECT * FROM lease_lines WHERE lease_id=$1 ORDER BY item_id",
        [lease.id],
      )
    ).rows;
    const items = await lockItems(
        c,
        ls.map((l) => l.item_id),
      ),
      at = await now(c);
    assert(
      lease.state === "ACTIVE" && lease.expires_at > at,
      410,
      "LEASE_EXPIRED",
      "Время удержания истекло. Перепроверьте состав; данные сохранены",
    );
    const claims = (
      await c.query(
        "SELECT * FROM inventory_claim WHERE item_id=ANY($1::uuid[])",
        [items.map((i) => i.id)],
      )
    ).rows;
    assert(
      claims.length === items.length &&
        claims.every(
          (cl) =>
            cl.owner_type === "CHECKOUT" &&
            cl.owner_id === lease.id &&
            cl.expires_at > at,
        ),
      410,
      "LEASE_EXPIRED",
      "Удержание больше не действует",
    );
    assert(
      items.every(
        (i) =>
          i.version === ls.find((l) => l.item_id === i.id).item_version &&
          i.physical === "AVAILABLE" &&
          i.publication === "PUBLISHED",
      ),
      409,
      "ITEM_CHANGED",
      "Описание вещи изменилось. Перепроверьте состав",
    );
    const settings = await getSettings(c);
    assert(
      settings.acceptingOrders,
      503,
      "STORE_CLOSED",
      "Оформление временно закрыто",
    );
    if (body.method !== "PICKUP")
      assert(
        settings.carriers?.[body.method]?.enabled,
        422,
        "DELIVERY_DISABLED",
        "Этот способ получения пока недоступен",
      );
    const id = randomUUID(),
      reservationId = randomUUID(),
      total = ls.reduce((a, l) => a + l.snapshot.priceMinor, 0);
    const recipient = {
      phone: body.phone,
      fullName: body.fullName ?? "",
      city: body.city ?? "",
      office: body.office ?? "",
      postalCode: body.postalCode ?? "",
      comment: body.comment ?? "",
      phoneSource: "MANUAL",
    };
    const verifyBy = addOpenHours(at, 4, settings.calendar),
      cancelBy = addOpenHours(at, 8, settings.calendar);
    const o = (
      await c.query(
        "INSERT INTO orders(id,user_id,method,total_minor,recipient_enc,rule_snapshot,verify_by,cancel_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",
        [
          id,
          actor.id,
          body.method,
          total,
          encrypt(recipient),
          JSON.stringify(settings),
          verifyBy,
          cancelBy,
        ],
      )
    ).rows[0];
    await c.query(
      "INSERT INTO reservations(id,order_id,user_id) VALUES($1,$2,$3)",
      [reservationId, id, actor.id],
    );
    for (const l of ls) {
      const lineId = randomUUID();
      await c.query(
        "INSERT INTO order_lines(id,order_id,item_id,snapshot,price_minor) VALUES($1,$2,$3,$4,$5)",
        [
          lineId,
          id,
          l.item_id,
          JSON.stringify(l.snapshot),
          l.snapshot.priceMinor,
        ],
      );
      await c.query(
        "INSERT INTO reservation_lines(reservation_id,order_line_id) VALUES($1,$2)",
        [reservationId, lineId],
      );
    }
    await convertClaims(
      c,
      items.map((i) => i.id),
      "CHECKOUT",
      lease.id,
      "RESERVATION",
      id,
      null,
    );
    await c.query("UPDATE leases SET state='CONVERTED' WHERE id=$1", [
      lease.id,
    ]);
    await c.query("DELETE FROM checkout_drafts WHERE user_id=$1", [actor.id]);
    await c.query(
      "UPDATE selections SET item_ids=array(SELECT unnest(item_ids) EXCEPT SELECT unnest($2::uuid[])),updated_at=now() WHERE user_id=$1",
      [actor.id, items.map((i) => i.id)],
    );
    await audit(c, actor.id, "orders.create", "order", id, {
      method: body.method,
      itemIds: items.map((i) => i.id),
    });
    await event(
      c,
      o,
      "ORDER_CREATED",
      "Вещи закреплены. Проверяем физическое наличие",
    );
    if (body.method !== "PICKUP") {
      const owners = (await c.query("SELECT id FROM users WHERE role='OWNER'"))
        .rows;
      for (const owner of owners)
        await c.query(
          "INSERT INTO outbox_events(entity_id,entity_version,event_type,recipient_id,message) VALUES($1,1,'SHIPMENT_REQUEST',$2,$3) ON CONFLICT DO NOTHING",
          [
            id,
            owner.id,
            `Заявка №${o.number}: ${items.length} вещей, ${body.method === "BELPOST" ? "Белпочта" : "Европочта"}. Откройте защищённую очередь.`,
          ],
        );
    }
    return readOrder(c, id, actor);
  });
}
export async function expireOrder(c: PoolClient, o: OrderRow, at?: Date) {
  const current = at ?? (await now(c));
  const proposalExpired =
    o.status === "AWAITING_CUSTOMER" &&
    o.proposal?.respondBy &&
    new Date(o.proposal.respondBy) <= current;
  const checkingExpired = o.status === "CHECKING" && o.cancel_by <= current;
  const pickupExpired =
    o.status === "READY_FOR_PICKUP" &&
    o.pickup_deadline &&
    o.pickup_deadline <= current;
  if (!proposalExpired && !checkingExpired && !pickupExpired) return false;
  const lines = (await orderLines(c, o.id)).filter(
    (l) => l.outcome === "RESERVED",
  );
  await releaseLines(c, o, lines, "Обращение просрочено", "EXPIRED");
  await bump(c, o, "EXPIRED");
  await setReservation(c, o, "EXPIRED");
  await c.query(
    "UPDATE orders SET completed_at=clock_timestamp(),pickup_code_hash=NULL,pickup_code_enc=NULL WHERE id=$1",
    [o.id],
  );
  await event(
    c,
    o,
    "ORDER_EXPIRED",
    "Срок обращения истёк. Санкций за неявку нет",
  );
  await audit(c, null, "orders.expire", "order", o.id);
  return true;
}
export async function reflowCalendar(
  c: PoolClient,
  calendar: Calendar,
  settingsVersion: number,
) {
  const orders = (
    await c.query(
      "SELECT * FROM orders WHERE status IN ('CHECKING','READY_FOR_PICKUP','PREPARING','DISPATCH_READY') ORDER BY id FOR UPDATE",
    )
  ).rows;
  for (const o of orders) {
    const changes: Record<string, { previous: string; deadline: string }> = {};
    const extend = (field: string, candidate: Date) => {
      const previous = o[field] as Date | null;
      if (previous && candidate > previous) {
        changes[field] = {
          previous: previous.toISOString(),
          deadline: candidate.toISOString(),
        };
        o[field] = candidate;
      }
    };
    if (o.status === "CHECKING") {
      extend("verify_by", addOpenHours(o.created_at, 4, calendar));
      extend("cancel_by", addOpenHours(o.created_at, 8, calendar));
    } else if (o.status === "READY_FOR_PICKUP")
      extend("pickup_deadline", pickupDeadline(o.ready_at, calendar));
    else if (o.verified_at)
      extend("dispatch_deadline", dispatchDeadline(o.verified_at, calendar));
    else
      await issue(
        c,
        o.id,
        "VERIFICATION_TIME_REQUIRED",
        "Для пересчёта срока сдачи подтвердите фактическое время проверки заявки",
        o.id,
      );
    if (!Object.keys(changes).length) continue;
    await c.query(
      "UPDATE orders SET verify_by=$2,cancel_by=$3,pickup_deadline=$4,dispatch_deadline=$5,version=version+1,updated_at=clock_timestamp() WHERE id=$1",
      [o.id, o.verify_by, o.cancel_by, o.pickup_deadline, o.dispatch_deadline],
    );
    o.version++;
    if (o.status === "READY_FOR_PICKUP") await setReservation(c, o, "ACTIVE");
    await audit(c, null, "calendar.deadline_extended", "order", o.id, {
      changes,
      settingsVersion,
    });
    const deadline =
      o.status === "CHECKING"
        ? o.verify_by
        : o.status === "READY_FOR_PICKUP"
          ? o.pickup_deadline
          : o.dispatch_deadline;
    const label =
      o.status === "CHECKING"
        ? "проверки"
        : o.status === "READY_FOR_PICKUP"
          ? "хранения"
          : "сдачи посылки";
    await event(
      c,
      o,
      "CALENDAR_CHANGED",
      `Из-за закрытия магазина срок ${label} перенесён до ${deadline.toLocaleString("ru-RU", { timeZone: "Europe/Minsk" })}`,
    );
  }
}
export async function markReady(c: PoolClient, o: OrderRow, actorId: string) {
  assert(
    o.status === "CHECKING",
    409,
    "STAGE",
    "Сначала завершите проверку обращения",
  );
  const lines = (await orderLines(c, o.id)).filter(
    (l) => l.outcome === "RESERVED",
  );
  assert(
    lines.length && lines.every((l) => l.checked),
    422,
    "NOT_VERIFIED",
    "Отметьте наличие каждой вещи",
  );
  await lockItems(
    c,
    lines.map((l) => l.item_id),
  );
  const settings = await getSettings(c),
    at = await now(c);
  if (await expireOrder(c, o, at))
    throw new AppError(410, "ORDER_EXPIRED", "Срок проверки истёк");
  if (o.method === "PICKUP") {
    const code = String(randomInt(100000, 1000000)),
      deadline = pickupDeadline(at, settings.calendar);
    await c.query(
      "UPDATE orders SET ready_at=$2,verified_at=$2,pickup_deadline=$3,pickup_code_hash=$4,pickup_code_enc=$5,code_attempts=0,code_window_at=NULL WHERE id=$1",
      [
        o.id,
        at,
        deadline,
        createHash("sha256").update(code).digest("hex"),
        encrypt(code),
      ],
    );
    o.ready_at = at;
    o.pickup_deadline = deadline;
    await bump(c, o, "READY_FOR_PICKUP");
    await event(
      c,
      o,
      "READY",
      "Можно забирать. Храним до " +
        deadline.toLocaleString("ru-RU", { timeZone: "Europe/Minsk" }),
    );
  } else {
    const deadline = dispatchDeadline(at, settings.calendar);
    await c.query(
      "UPDATE orders SET dispatch_deadline=$2,verified_at=$3 WHERE id=$1",
      [o.id, deadline, at],
    );
    await bump(c, o, "PREPARING");
    await event(c, o, "PREPARING", "Вещи проверены. Готовим отправку вручную");
  }
  await setReservation(c, o, "ACTIVE");
  await audit(c, actorId, "orders.ready", "order", o.id);
}
async function cancelDirect(
  c: PoolClient,
  o: OrderRow,
  lines: any[],
  actorId: string,
) {
  await releaseLines(c, o, lines, "Отмена обращения");
  const rest = (await orderLines(c, o.id)).filter(
    (l) => l.outcome === "RESERVED",
  );
  await c.query(
    "UPDATE orders SET total_minor=$2,cancel_requested=NULL WHERE id=$1",
    [o.id, rest.reduce((a, l) => a + l.price_minor, 0)],
  );
  await bump(c, o, rest.length ? undefined : "CANCELLED");
  if (!rest.length) {
    await setReservation(c, o, "CANCELLED");
    await c.query(
      "UPDATE orders SET completed_at=clock_timestamp(),pickup_code_enc=NULL,pickup_code_hash=NULL WHERE id=$1",
      [o.id],
    );
  }
  await audit(c, actorId, "orders.cancel", "order", o.id, {
    lineIds: lines.map((l) => l.id),
  });
  await event(
    c,
    o,
    "CANCELLED",
    rest.length ? "Состав обращения изменён" : "Обращение отменено",
  );
}
async function shipmentOrder(c: PoolClient, id: string, actor: Actor) {
  const row = (
    await c.query("SELECT order_id FROM shipments WHERE id=$1", [id])
  ).rows[0];
  assert(row, 404, "SHIPMENT_NOT_FOUND", "Отправление не найдено");
  const o = await lockedOrder(c, row.order_id, actor);
  const s = (
    await c.query("SELECT * FROM shipments WHERE id=$1 FOR UPDATE", [id])
  ).rows[0];
  return { o, s };
}
function codeMatches(value: string, hash: string) {
  const actual = Buffer.from(
      createHash("sha256").update(value).digest("hex"),
      "hex",
    ),
    expected = Buffer.from(hash ?? "", "hex");
  return expected.length === actual.length && timingSafeEqual(actual, expected);
}
export async function registerOrders(app: FastifyInstance) {
  const actor = (r: FastifyRequest) => r.actor;
  const id = (r: FastifyRequest) =>
    z
      .string()
      .uuid()
      .parse((r.params as any).id);
  const command = async (
    r: FastifyRequest,
    scope: string,
    body: unknown,
    fn: (c: PoolClient) => Promise<any>,
  ) => idem(actor(r), r.headers["idempotency-key"], scope, body, fn);
  app.post("/checkout/leases", async (r) =>
    createLease(
      actor(r),
      r.headers["idempotency-key"],
      z.object({ itemIds: ids }).parse(r.body),
    ),
  );
  app.delete("/checkout/leases/:id", async (r) =>
    command(r, "lease.release", { id: id(r) }, async (c) => {
      await c.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [
        actor(r).id,
      ]);
      const lease = (
        await c.query("SELECT * FROM leases WHERE id=$1 FOR UPDATE", [id(r)])
      ).rows[0];
      assert(
        lease && lease.user_id === actor(r).id,
        403,
        "FORBIDDEN",
        "Нет доступа к удержанию",
      );
      const ls = (
        await c.query("SELECT item_id FROM lease_lines WHERE lease_id=$1", [
          lease.id,
        ])
      ).rows;
      await lockItems(
        c,
        ls.map((l) => l.item_id),
      );
      const own = (
        await c.query(
          "SELECT item_id FROM inventory_claim WHERE owner_id=$1 AND owner_type='CHECKOUT'",
          [lease.id],
        )
      ).rows;
      await releaseClaims(
        c,
        own.map((l) => l.item_id),
        "Покупатель вернулся к выбору",
      );
      await c.query(
        "UPDATE leases SET state='RELEASED' WHERE id=$1 AND state='ACTIVE'",
        [lease.id],
      );
      return { released: true };
    }),
  );
  app.post("/orders", async (r) =>
    confirmOrder(actor(r), r.headers["idempotency-key"], r.body),
  );
  app.get("/operations/:key", async (r) => {
    const key = z
      .string()
      .max(120)
      .parse((r.params as any).key);
    return tx(async (c) => {
      const row = (
        await c.query(
          "SELECT * FROM idempotency_records WHERE actor_id=$1 AND key=$2",
          [actor(r).id, key],
        )
      ).rows[0];
      assert(
        row,
        404,
        "OPERATION_UNKNOWN",
        "Результат ещё не найден. Повторите исходное действие с тем же ключом",
      );
      await authorizeReplay(c, actor(r), row);
      return decrypt(row.response.encrypted);
    });
  });
  app.get("/me/orders", async (r) =>
    tx(async (c) => {
      const rows = (
        await c.query(
          "SELECT * FROM orders WHERE user_id=$1 ORDER BY created_at DESC LIMIT 200 FOR UPDATE",
          [actor(r).id],
        )
      ).rows;
      const orders = [];
      for (const o of rows) {
        await expireOrder(c, o);
        orders.push(await readOrder(c, o.id, actor(r)));
      }
      return { orders };
    }),
  );
  app.get("/orders/:id", async (r) =>
    tx(async (c) => {
      const o = await lockedOrder(c, id(r), actor(r));
      await expireOrder(c, o);
      return readOrder(c, o.id, actor(r));
    }),
  );
  app.post("/orders/:id/cancel", async (r) => {
    const body = z.object({ version, lineIds: ids.optional() }).parse(r.body);
    return command(r, "orders.cancel:" + id(r), body, async (c) => {
      const o = await lockedOrder(c, id(r), actor(r));
      await expireOrder(c, o);
      expected(o, body.version);
      const all = (await orderLines(c, o.id)).filter(
        (l) => l.outcome === "RESERVED",
      );
      const selected = body.lineIds
        ? all.filter((l) => body.lineIds!.includes(l.id))
        : all;
      assert(
        selected.length &&
          (body.lineIds ? selected.length === body.lineIds.length : true),
        422,
        "LINES",
        "Выберите действующие строки обращения",
      );
      assert(
        ![
          "HANDOVER",
          "FULFILLED",
          "CANCELLED",
          "EXPIRED",
          "CLOSED",
          "RETURNED",
        ].includes(o.status),
        409,
        "STAGE",
        "На этом этапе отмена недоступна. Свяжитесь с магазином",
      );
      if (
        ["PREPARING", "DISPATCH_READY", "IN_FULFILLMENT", "RETURNING"].includes(
          o.status,
        )
      ) {
        await c.query(
          "UPDATE orders SET cancel_requested=$2,exception=true WHERE id=$1",
          [
            o.id,
            JSON.stringify({
              type: "CANCEL",
              lineIds: selected.map((l) => l.id),
              requestedAt: (await now(c)).toISOString(),
            }),
          ],
        );
        await bump(c, o);
        await issue(
          c,
          o.id,
          "CHANGE_REQUEST",
          "Покупатель запросил отмену. До решения сдача заблокирована",
          o.id,
        );
        await event(
          c,
          o,
          "CANCEL_REQUESTED",
          "Запрос отмены передан сотруднику; вещи пока закреплены",
        );
      } else await cancelDirect(c, o, selected, actor(r).id);
      return readOrder(c, o.id, actor(r));
    });
  });
  app.patch("/orders/:id/recipient", async (r) => {
    const body = recipientSchema.extend({ version }).parse(r.body);
    return command(r, "orders.recipient:" + id(r), body, async (c) => {
      const o = await lockedOrder(c, id(r), actor(r));
      await expireOrder(c, o);
      expected(o, body.version);
      assert(
        o.method !== "PICKUP",
        422,
        "METHOD",
        "Для самовывоза получатель почты не нужен",
      );
      for (const field of ["fullName", "city", "office"] as const)
        assert(
          body[field],
          422,
          "RECIPIENT_REQUIRED",
          "Заполните ФИО, населённый пункт и отделение",
        );
      const { version: _, ...recipient } = body;
      void _;
      if (o.status === "CHECKING") {
        await c.query(
          "INSERT INTO recipient_history(order_id,version,value_enc) VALUES($1,$2,$3)",
          [o.id, o.version, o.recipient_enc],
        );
        await c.query("UPDATE orders SET recipient_enc=$2 WHERE id=$1", [
          o.id,
          encrypt(recipient),
        ]);
        await bump(c, o);
        await audit(c, actor(r).id, "orders.recipient.changed", "order", o.id);
      } else if (["PREPARING", "DISPATCH_READY"].includes(o.status)) {
        await c.query(
          "UPDATE orders SET cancel_requested=$2,exception=true WHERE id=$1",
          [
            o.id,
            JSON.stringify({
              type: "RECIPIENT",
              recipientEnc: encrypt(recipient),
            }),
          ],
        );
        await bump(c, o);
        await issue(
          c,
          o.id,
          "CHANGE_REQUEST",
          "Покупатель запросил изменение получателя/отделения",
          o.id,
        );
        await event(
          c,
          o,
          "CHANGE_REQUESTED",
          "Изменение передано сотруднику до сдачи посылки",
        );
      } else
        throw new AppError(
          409,
          "STAGE",
          "После сдачи посылки изменение оформляется через связь с магазином",
        );
      return readOrder(c, o.id, actor(r));
    });
  });
  app.post("/orders/:id/proposal-response", async (r) => {
    const body = z.object({ version, accept: z.boolean() }).parse(r.body);
    return command(r, "orders.proposal-response:" + id(r), body, async (c) => {
      const o = await lockedOrder(c, id(r), actor(r));
      assert(
        o.user_id === actor(r).id,
        403,
        "FORBIDDEN",
        "Изменение принимает покупатель",
      );
      expected(o, body.version);
      assert(
        o.status === "AWAITING_CUSTOMER" && o.proposal,
        409,
        "NO_PROPOSAL",
        "Нет актуального предложения",
      );
      assert(
        new Date(o.proposal.respondBy) > (await now(c)),
        410,
        "PROPOSAL_EXPIRED",
        "Срок ответа истёк",
      );
      const lines = (await orderLines(c, o.id)).filter(
        (l) => l.outcome === "RESERVED",
      );
      if (!body.accept) await cancelDirect(c, o, lines, actor(r).id);
      else {
        const kept = lines.filter((l) => o.proposal.lineIds.includes(l.id)),
          removed = lines.filter((l) => !o.proposal.lineIds.includes(l.id));
        assert(kept.length, 422, "LINES", "В предложении не осталось вещей");
        await releaseLines(
          c,
          o,
          removed,
          "Покупатель принял изменённый состав",
        );
        await c.query(
          "UPDATE orders SET total_minor=$2,proposal=$3 WHERE id=$1",
          [
            o.id,
            kept.reduce((a, l) => a + l.price_minor, 0),
            JSON.stringify({
              ...o.proposal,
              acceptedAt: (await now(c)).toISOString(),
            }),
          ],
        );
        await bump(c, o, "CHECKING");
        await setReservation(c, o, "VERIFYING");
        await audit(c, actor(r).id, "orders.proposal.accept", "order", o.id);
        await event(
          c,
          o,
          "CHANGE_ACCEPTED",
          "Изменение принято. Магазин завершает проверку",
        );
      }
      return readOrder(c, o.id, actor(r));
    });
  });
  app.get("/staff/queue", async (r) =>
    tx(async (c) => {
      const filter = (r.query as any).filter;
      const where =
        filter === "checking"
          ? "status IN ('CHECKING','AWAITING_CUSTOMER')"
          : filter === "pickup"
            ? "status IN ('READY_FOR_PICKUP','HANDOVER')"
            : filter === "shipping"
              ? "method<>'PICKUP' AND status NOT IN ('FULFILLED','CANCELLED','EXPIRED','CLOSED','RETURNED')"
              : filter === "problems"
                ? "exception=true"
                : "status NOT IN ('FULFILLED','CANCELLED','EXPIRED','CLOSED','RETURNED')";
      const rows = (
        await c.query(
          `SELECT * FROM orders WHERE ${where} ORDER BY COALESCE(pickup_deadline,dispatch_deadline,verify_by),id LIMIT 200 FOR UPDATE`,
        )
      ).rows;
      const orders = [];
      for (const o of rows) {
        await expireOrder(c, o);
        orders.push(await readOrder(c, o.id, actor(r)));
      }
      const issues = (
        await c.query(
          'SELECT id,entity_id AS "entityId",item_id AS "itemId",order_id AS "orderId",kind,message,assigned_to AS "assignedTo",created_at AS "createdAt" FROM operation_issues WHERE state=\'OPEN\' ORDER BY created_at LIMIT 200',
        )
      ).rows;
      return { orders, issues };
    }),
  );
  app.post("/staff/orders/:id/assign", async (r) => {
    const body = z.object({ version }).parse(r.body);
    return command(r, "orders.assign:" + id(r), body, async (c) => {
      const o = await lockedOrder(c, id(r), actor(r));
      expected(o, body.version);
      assert(
        !o.assigned_to ||
          o.assigned_to === actor(r).id ||
          actor(r).role === "OWNER",
        409,
        "ASSIGNED",
        "Обращение уже у другого сотрудника. Перехват доступен владельцу",
      );
      await c.query("UPDATE orders SET assigned_to=$2 WHERE id=$1", [
        o.id,
        actor(r).id,
      ]);
      await bump(c, o);
      await audit(c, actor(r).id, "orders.assign", "order", o.id);
      return readOrder(c, o.id, actor(r));
    });
  });
  app.post("/staff/orders/:id/verify", async (r) => {
    const body = z.object({ version, foundItemIds: ids }).parse(r.body);
    return command(r, "orders.verify:" + id(r), body, async (c) => {
      const o = await lockedOrder(c, id(r), actor(r));
      await expireOrder(c, o);
      expected(o, body.version);
      assert(
        o.status === "CHECKING",
        409,
        "STAGE",
        "Обращение уже обрабатывается на другом этапе",
      );
      const lines = (await orderLines(c, o.id)).filter(
        (l) => l.outcome === "RESERVED",
      );
      assert(
        body.foundItemIds.every((i) => lines.some((l) => l.item_id === i)),
        422,
        "LINES",
        "Вещь не входит в обращение",
      );
      await lockItems(c, body.foundItemIds);
      await c.query(
        "UPDATE order_lines SET checked=true WHERE order_id=$1 AND item_id=ANY($2::uuid[])",
        [o.id, body.foundItemIds],
      );
      await setPhysical(
        c,
        body.foundItemIds,
        "PICKED",
        actor(r).id,
        "Физически проверена и убрана в зону броней",
      );
      await bump(c, o);
      await audit(c, actor(r).id, "orders.verify", "order", o.id, {
        foundItemIds: body.foundItemIds,
      });
      return readOrder(c, o.id, actor(r));
    });
  });
  app.post("/staff/orders/:id/ready", async (r) => {
    const body = z.object({ version }).parse(r.body);
    return command(r, "orders.ready:" + id(r), body, async (c) => {
      const o = await lockedOrder(c, id(r), actor(r));
      await expireOrder(c, o);
      expected(o, body.version);
      await markReady(c, o, actor(r).id);
      return readOrder(c, o.id, actor(r));
    });
  });
  app.post("/staff/orders/:id/propose", async (r) => {
    const body = z
      .object({
        version,
        lineIds: ids,
        message: z.string().trim().min(3).max(1000),
        respondBy: z.string().datetime(),
      })
      .parse(r.body);
    return command(r, "orders.propose:" + id(r), body, async (c) => {
      const o = await lockedOrder(c, id(r), actor(r));
      await expireOrder(c, o);
      expected(o, body.version);
      assert(
        ["CHECKING", "PREPARING"].includes(o.status),
        409,
        "STAGE",
        "Изменение уже нельзя предложить на этом этапе",
      );
      const lines = (await orderLines(c, o.id)).filter(
        (l) => l.outcome === "RESERVED",
      );
      assert(
        body.lineIds.every((i) => lines.some((l) => l.id === i)),
        422,
        "LINES",
        "Неверный состав предложения",
      );
      assert(
        new Date(body.respondBy) > (await now(c)),
        422,
        "DEADLINE",
        "Срок ответа должен быть в будущем",
      );
      const retained = body.lineIds.map((i) => lines.find((l) => l.id === i));
      assert(
        retained.every((l) => l.checked),
        422,
        "NOT_VERIFIED",
        "Сначала проверьте наличие сохраняемых вещей",
      );
      const missing = lines.filter((l) => !body.lineIds.includes(l.id));
      await lockItems(
        c,
        lines.map((l) => l.item_id),
      );
      await setPhysical(
        c,
        missing.map((l) => l.item_id),
        "INSPECTION",
        actor(r).id,
        "Недостача или изменение состава",
      );
      for (const l of missing)
        await issue(
          c,
          l.item_id,
          "QUALITY_CHECK",
          "Недостача/несоответствие при сборке. Нужен осмотр",
          o.id,
          l.item_id,
        );
      await c.query("UPDATE orders SET proposal=$2 WHERE id=$1", [
        o.id,
        JSON.stringify({
          lineIds: body.lineIds,
          message: body.message,
          respondBy: body.respondBy,
          previousStatus: o.status,
        }),
      ]);
      await bump(c, o, "AWAITING_CUSTOMER");
      await setReservation(c, o, "CHANGE_PENDING");
      await event(
        c,
        o,
        "CHANGE_PROPOSED",
        "Магазин предложил изменение состава или условий. Откройте обращение",
      );
      await audit(c, actor(r).id, "orders.propose", "order", o.id, {
        lineIds: body.lineIds,
        respondBy: body.respondBy,
      });
      return readOrder(c, o.id, actor(r));
    });
  });
  app.post("/staff/orders/:id/change-request", async (r) => {
    const body = z
      .object({
        version,
        approve: z.boolean(),
        source: z.string().trim().min(3).max(500),
      })
      .parse(r.body);
    return command(r, "orders.change-request:" + id(r), body, async (c) => {
      const o = await lockedOrder(c, id(r), actor(r));
      expected(o, body.version);
      assert(o.cancel_requested, 409, "NO_REQUEST", "Нет ожидающего запроса");
      assert(
        ["PREPARING", "DISPATCH_READY"].includes(o.status),
        409,
        "STAGE",
        "После сдачи нужен фактический возврат",
      );
      const shipment = (
        await c.query(
          "SELECT id FROM shipments WHERE order_id=$1 AND status<>'CANCELLED'",
          [o.id],
        )
      ).rows[0];
      assert(
        !shipment,
        409,
        "CARRIER_CANCEL_REQUIRED",
        "Сначала подтвердите отмену оформленной заявки у перевозчика",
      );
      if (body.approve && o.cancel_requested.type === "CANCEL") {
        const lines = (await orderLines(c, o.id)).filter(
          (l) =>
            o.cancel_requested.lineIds.includes(l.id) &&
            l.outcome === "RESERVED",
        );
        await cancelDirect(c, o, lines, actor(r).id);
      } else {
        if (body.approve && o.cancel_requested.type === "RECIPIENT") {
          await c.query(
            "INSERT INTO recipient_history(order_id,version,value_enc) VALUES($1,$2,$3)",
            [o.id, o.version, o.recipient_enc],
          );
          await c.query("UPDATE orders SET recipient_enc=$2 WHERE id=$1", [
            o.id,
            o.cancel_requested.recipientEnc,
          ]);
        }
        await c.query(
          "UPDATE orders SET cancel_requested=NULL,exception=false WHERE id=$1",
          [o.id],
        );
        await bump(c, o);
        await event(
          c,
          o,
          "CHANGE_RESOLVED",
          body.approve
            ? "Запрошенное изменение принято"
            : "Изменение не принято. Свяжитесь с магазином",
        );
      }
      await c.query(
        "UPDATE operation_issues SET state='RESOLVED',resolution=$2,resolved_at=now() WHERE order_id=$1 AND kind='CHANGE_REQUEST' AND state='OPEN'",
        [o.id, body.source],
      );
      await audit(
        c,
        actor(r).id,
        "orders.change-request.resolve",
        "order",
        o.id,
        { approved: body.approve },
      );
      return readOrder(c, o.id, actor(r));
    });
  });
  app.post("/staff/orders/:id/note", async (r) => {
    const body = z
      .object({ version, note: z.string().trim().min(1).max(2000) })
      .parse(r.body);
    return command(r, "orders.note:" + id(r), body, async (c) => {
      const o = await lockedOrder(c, id(r), actor(r));
      expected(o, body.version);
      await c.query(
        "INSERT INTO contact_notes(order_id,actor_id,note_enc) VALUES($1,$2,$3)",
        [o.id, actor(r).id, encrypt(body.note)],
      );
      await bump(c, o);
      await audit(c, actor(r).id, "orders.note", "order", o.id);
      return readOrder(c, o.id, actor(r));
    });
  });
  app.post("/staff/orders/:id/handovers", async (r) => {
    const body = z
      .object({ version, code: z.string().regex(/^\d{6}$/) })
      .parse(r.body);
    const result = await command(
      r,
      "orders.handover:" + id(r),
      body,
      async (c) => {
        const o = await lockedOrder(c, id(r), actor(r));
        await expireOrder(c, o);
        expected(o, body.version);
        assert(
          o.method === "PICKUP" && o.status === "READY_FOR_PICKUP",
          409,
          "STAGE",
          "Выдача недоступна. Проверьте готовность и срок",
        );
        const lines = (await orderLines(c, o.id)).filter(
          (l) => l.outcome === "RESERVED",
        );
        await lockItems(
          c,
          lines.map((l) => l.item_id),
        );
        const at = await now(c);
        assert(
          o.pickup_deadline > at,
          410,
          "ORDER_EXPIRED",
          "Срок брони истёк",
        );
        const recent =
          o.code_window_at &&
          at.getTime() - o.code_window_at.getTime() < 900000;
        const attempts = recent ? o.code_attempts : 0;
        if (attempts >= 5)
          return {
            denied: true,
            rateLimited: true,
            message: "Слишком много попыток. Повторите через 15 минут",
          };
        if (!codeMatches(body.code, o.pickup_code_hash)) {
          await c.query(
            "UPDATE orders SET code_attempts=$2,code_window_at=$3 WHERE id=$1",
            [o.id, attempts + 1, recent ? o.code_window_at : at],
          );
          await audit(c, actor(r).id, "handover.invalid_code", "order", o.id);
          return { denied: true, message: "Код выдачи не подходит" };
        }
        const hid = randomUUID();
        await c.query(
          "INSERT INTO handovers(id,order_id,actor_id) VALUES($1,$2,$3)",
          [hid, o.id, actor(r).id],
        );
        await convertClaims(
          c,
          lines.map((l) => l.item_id),
          "RESERVATION",
          o.id,
          "HANDOVER",
          hid,
          null,
        );
        await setPhysical(
          c,
          lines.map((l) => l.item_id),
          "HANDOVER_PROCESSING",
          actor(r).id,
          "Начата физическая выдача",
        );
        await bump(c, o, "HANDOVER");
        await audit(c, actor(r).id, "handover.start", "order", o.id);
        return { id: hid, orderId: o.id };
      },
    );
    if (result.denied)
      throw new AppError(
        result.rateLimited ? 429 : 422,
        result.rateLimited ? "CODE_RATE_LIMIT" : "WRONG_CODE",
        result.message,
      );
    return result;
  });
  app.post("/staff/handovers/:id/complete", async (r) => {
    const body = z
      .object({
        acceptedLineIds: z
          .array(z.string().uuid())
          .refine((a) => new Set(a).size === a.length),
      })
      .parse(r.body);
    return command(r, "handover.complete:" + id(r), body, async (c) => {
      const h0 = (
        await c.query("SELECT order_id FROM handovers WHERE id=$1", [id(r)])
      ).rows[0];
      assert(h0, 404, "HANDOVER_NOT_FOUND", "Выдача не найдена");
      const o = await lockedOrder(c, h0.order_id, actor(r));
      const h = (
        await c.query("SELECT * FROM handovers WHERE id=$1 FOR UPDATE", [id(r)])
      ).rows[0];
      assert(
        h.state === "STARTED" && o.status === "HANDOVER",
        409,
        "HANDOVER_COMPLETED",
        "Выдача уже завершена. Проверьте историю",
      );
      const lines = (await orderLines(c, o.id)).filter(
        (l) => l.outcome === "RESERVED",
      );
      assert(
        body.acceptedLineIds.every((i) => lines.some((l) => l.id === i)),
        422,
        "LINES",
        "Выберите строки этой выдачи",
      );
      await lockItems(
        c,
        lines.map((l) => l.item_id),
      );
      const accepted = lines.filter((l) => body.acceptedLineIds.includes(l.id)),
        refused = lines.filter((l) => !body.acceptedLineIds.includes(l.id));
      await releaseClaims(
        c,
        lines.map((l) => l.item_id),
        "Выдача завершена",
      );
      await setPhysical(
        c,
        accepted.map((l) => l.item_id),
        "SOLD",
        actor(r).id,
        "Выдано покупателю",
      );
      await outcomes(c, accepted, "HANDED_OVER");
      await releaseLines(c, o, refused, "Отказ при примерке");
      await c.query(
        "UPDATE handovers SET state='COMPLETED',completed_at=now() WHERE id=$1",
        [h.id],
      );
      await c.query(
        "UPDATE orders SET pickup_code_hash=NULL,pickup_code_enc=NULL,completed_at=now(),total_minor=$2 WHERE id=$1",
        [o.id, accepted.reduce((a, l) => a + l.price_minor, 0)],
      );
      await bump(c, o, accepted.length ? "FULFILLED" : "CANCELLED");
      await setReservation(c, o, accepted.length ? "FULFILLED" : "CANCELLED");
      await event(
        c,
        o,
        "HANDED_OVER",
        `Выдано ${accepted.length}, отказ от ${refused.length}`,
      );
      await audit(c, actor(r).id, "handover.complete", "order", o.id, {
        acceptedLineIds: body.acceptedLineIds,
      });
      return readOrder(c, o.id, actor(r));
    });
  });
  app.post("/staff/availability-operations", async (r) => {
    const body = z.object({ itemIds: ids }).parse(r.body);
    return command(r, "counter.start", body, async (c) => {
      const items = await lockItems(c, body.itemIds);
      await assertAvailable(c, items);
      const op = randomUUID(),
        expiresAt = new Date((await now(c)).getTime() + 600000);
      await c.query(
        "INSERT INTO availability_operations(id,actor_id,item_ids,expires_at) VALUES($1,$2,$3,$4)",
        [op, actor(r).id, body.itemIds, expiresAt],
      );
      await claimItems(c, body.itemIds, "COUNTER_SALE", op, null, null);
      await setPhysical(
        c,
        body.itemIds,
        "COUNTER_PROCESSING",
        actor(r).id,
        "Закреплено у кассы до передачи",
      );
      await audit(c, actor(r).id, "counter.start", "availability", op, {
        itemIds: body.itemIds,
      });
      return {
        id: op,
        items: await Promise.all(items.map((i) => itemSnapshot(c, i))),
        expiresAt,
      };
    });
  });
  app.post("/staff/availability-operations/:id/complete", async (r) => {
    const body = z.object({ sold: z.boolean() }).parse(r.body);
    return command(r, "counter.complete:" + id(r), body, async (c) => {
      const op = (
        await c.query(
          "SELECT * FROM availability_operations WHERE id=$1 FOR UPDATE",
          [id(r)],
        )
      ).rows[0];
      assert(op, 404, "OPERATION_NOT_FOUND", "Операция не найдена");
      assert(
        op.state === "STARTED",
        409,
        "ALREADY_COMPLETED",
        "Факт продажи уже зафиксирован",
      );
      await lockItems(c, op.item_ids);
      const claims = (
        await c.query(
          "SELECT * FROM inventory_claim WHERE owner_id=$1 AND owner_type='COUNTER_SALE'",
          [op.id],
        )
      ).rows;
      assert(
        claims.length === op.item_ids.length,
        409,
        "CLAIM_LOST",
        "Нужна проверка фактического наличия",
      );
      await releaseClaims(c, op.item_ids, "Операция у кассы завершена");
      await setPhysical(
        c,
        op.item_ids,
        body.sold ? "SOLD" : "INSPECTION",
        actor(r).id,
        body.sold
          ? "Продано в торговом зале"
          : "Продажа отменена: вернуть после осмотра",
      );
      await c.query(
        "UPDATE availability_operations SET state=$2,completed_at=now() WHERE id=$1",
        [op.id, body.sold ? "SOLD" : "CANCELLED"],
      );
      if (!body.sold)
        for (const i of op.item_ids)
          await issue(
            c,
            i,
            "INSPECTION",
            "Проверьте вещь после отмены у кассы",
            null,
            i,
          );
      await audit(c, actor(r).id, "counter.complete", "availability", op.id, {
        sold: body.sold,
      });
      return {
        id: op.id,
        state: body.sold ? "SOLD" : "CANCELLED",
        itemIds: op.item_ids,
      };
    });
  });
  app.post("/staff/shipments", async (r) => {
    const body = z
      .object({
        orderId: z.string().uuid(),
        version,
        tracking: z
          .string()
          .trim()
          .min(3)
          .max(100)
          .regex(/^[\p{L}\p{N} _-]+$/u),
        source: z.string().trim().min(3).max(500),
      })
      .parse(r.body);
    return command(r, "shipment.register", body, async (c) => {
      const o = await lockedOrder(c, body.orderId, actor(r));
      expected(o, body.version);
      assert(
        o.method !== "PICKUP" && o.status === "PREPARING",
        409,
        "STAGE",
        "Сначала проверьте и подготовьте почтовую заявку",
      );
      assert(
        !o.cancel_requested,
        409,
        "DISPATCH_LOCK",
        "Сначала обработайте запрос покупателя",
      );
      const lines = (await orderLines(c, o.id)).filter(
        (l) => l.outcome === "RESERVED",
      );
      assert(
        lines.length && lines.every((l) => l.checked),
        422,
        "NOT_VERIFIED",
        "Проверьте каждую вещь",
      );
      await lockItems(
        c,
        lines.map((l) => l.item_id),
      );
      const sid = randomUUID();
      await c.query(
        "INSERT INTO shipments(id,order_id,carrier,tracking,source) VALUES($1,$2,$3,$4,$5)",
        [sid, o.id, o.method, body.tracking, body.source],
      );
      for (const l of lines)
        await c.query(
          "INSERT INTO shipment_lines(shipment_id,order_line_id) VALUES($1,$2)",
          [sid, l.id],
        );
      await c.query(
        "INSERT INTO shipment_events(shipment_id,status,source) VALUES($1,'REGISTERED',$2)",
        [sid, body.source],
      );
      await setPhysical(
        c,
        lines.map((l) => l.item_id),
        "PACKED",
        actor(r).id,
        "Посылка оформлена, ещё не сдана",
      );
      await bump(c, o, "DISPATCH_READY");
      await event(
        c,
        o,
        "SHIPMENT_REGISTERED",
        "Посылка оформлена, ещё не сдана перевозчику",
      );
      await audit(c, actor(r).id, "shipment.register", "shipment", sid, {
        tracking: body.tracking,
      });
      return readOrder(c, o.id, actor(r));
    });
  });
  app.post("/staff/shipments/:id/acceptance", async (r) => {
    const body = z
      .object({ version, source: z.string().trim().min(3).max(500) })
      .parse(r.body);
    return command(r, "shipment.acceptance:" + id(r), body, async (c) => {
      const { o, s } = await shipmentOrder(c, id(r), actor(r));
      expected(o, body.version);
      assert(
        s.status === "REGISTERED" && o.status === "DISPATCH_READY",
        409,
        "STAGE",
        "Передача уже подтверждена либо заявка отменена",
      );
      assert(
        !o.cancel_requested,
        409,
        "DISPATCH_LOCK",
        "Сдача заблокирована запросом покупателя",
      );
      const lines = (await orderLines(c, o.id)).filter(
        (l) => l.outcome === "RESERVED",
      );
      await lockItems(
        c,
        lines.map((l) => l.item_id),
      );
      await c.query(
        "UPDATE shipments SET status='ACCEPTED',accepted_at=clock_timestamp(),source=$2,version=version+1,updated_at=now() WHERE id=$1",
        [s.id, body.source],
      );
      await c.query(
        "INSERT INTO shipment_events(shipment_id,status,source) VALUES($1,'ACCEPTED',$2)",
        [s.id, body.source],
      );
      await setPhysical(
        c,
        lines.map((l) => l.item_id),
        "WITH_CARRIER",
        actor(r).id,
        "Подтверждена фактическая приёмка почтой",
      );
      await bump(c, o, "IN_FULFILLMENT");
      await setReservation(c, o, "FULFILLED");
      await event(
        c,
        o,
        "SHIPMENT_ACCEPTED",
        "Посылка сдана перевозчику. Трек доступен в обращении",
      );
      await audit(c, actor(r).id, "shipment.acceptance", "shipment", s.id);
      return readOrder(c, o.id, actor(r));
    });
  });
  app.post("/staff/shipments/:id/cancel", async (r) => {
    const body = z
      .object({ version, source: z.string().trim().min(3).max(500) })
      .parse(r.body);
    return command(r, "shipment.cancel:" + id(r), body, async (c) => {
      const { o, s } = await shipmentOrder(c, id(r), actor(r));
      expected(o, body.version);
      assert(
        s.status === "REGISTERED",
        409,
        "STAGE",
        "После сдачи возможен только возврат",
      );
      const lines = (await orderLines(c, o.id)).filter(
        (l) => l.outcome === "RESERVED",
      );
      await c.query(
        "UPDATE shipments SET status='CANCELLED',source=$2,version=version+1,updated_at=now() WHERE id=$1",
        [s.id, body.source],
      );
      await c.query(
        "INSERT INTO shipment_events(shipment_id,status,source) VALUES($1,'CANCELLED',$2)",
        [s.id, body.source],
      );
      await lockItems(
        c,
        lines.map((l) => l.item_id),
      );
      await setPhysical(
        c,
        lines.map((l) => l.item_id),
        "PICKED",
        actor(r).id,
        "Отмена почтовой заявки до сдачи подтверждена",
      );
      await bump(c, o, "PREPARING");
      await audit(c, actor(r).id, "shipment.cancel", "shipment", s.id);
      return readOrder(c, o.id, actor(r));
    });
  });
  app.post("/staff/shipments/:id/return-request", async (r) => {
    const body = z
      .object({ version, source: z.string().trim().min(3).max(500) })
      .parse(r.body);
    return command(r, "shipment.return-request:" + id(r), body, async (c) => {
      const { o, s } = await shipmentOrder(c, id(r), actor(r));
      expected(o, body.version);
      assert(
        ["ACCEPTED", "IN_TRANSIT", "AT_OFFICE", "LOST_OR_DAMAGED"].includes(
          s.status,
        ),
        409,
        "STAGE",
        "Возврат на этом этапе не запрашивается",
      );
      await c.query(
        "UPDATE shipments SET status='RETURN_REQUESTED',source=$2,version=version+1,updated_at=now() WHERE id=$1",
        [s.id, body.source],
      );
      await c.query(
        "INSERT INTO shipment_events(shipment_id,status,source) VALUES($1,'RETURN_REQUESTED',$2)",
        [s.id, body.source],
      );
      await c.query("UPDATE orders SET cancel_requested=NULL WHERE id=$1", [
        o.id,
      ]);
      await bump(c, o, "RETURNING");
      await event(
        c,
        o,
        "RETURN_REQUESTED",
        "Запрошен возврат посылки. Вещи ещё у перевозчика",
      );
      await audit(c, actor(r).id, "shipment.return-request", "shipment", s.id);
      return readOrder(c, o.id, actor(r));
    });
  });
  app.post("/staff/shipments/:id/events", async (r) => {
    const body = z
      .object({
        version,
        status: z.enum([
          "IN_TRANSIT",
          "AT_OFFICE",
          "DELIVERED",
          "RETURN_IN_TRANSIT",
          "RETURN_RECEIVED",
          "LOST_OR_DAMAGED",
        ]),
        source: z.string().trim().min(3).max(500),
        deliveredLineIds: z.array(z.string().uuid()).optional(),
      })
      .parse(r.body);
    return command(r, "shipment.event:" + id(r), body, async (c) => {
      const { o, s } = await shipmentOrder(c, id(r), actor(r));
      expected(o, body.version);
      const allowed: Record<string, string[]> = {
        ACCEPTED: [
          "IN_TRANSIT",
          "AT_OFFICE",
          "DELIVERED",
          "RETURN_IN_TRANSIT",
          "LOST_OR_DAMAGED",
        ],
        IN_TRANSIT: [
          "AT_OFFICE",
          "DELIVERED",
          "RETURN_IN_TRANSIT",
          "LOST_OR_DAMAGED",
        ],
        AT_OFFICE: ["DELIVERED", "RETURN_IN_TRANSIT", "LOST_OR_DAMAGED"],
        RETURN_REQUESTED: ["RETURN_IN_TRANSIT", "LOST_OR_DAMAGED"],
        RETURN_IN_TRANSIT: ["RETURN_RECEIVED", "LOST_OR_DAMAGED"],
        LOST_OR_DAMAGED: ["RETURN_IN_TRANSIT", "RETURN_RECEIVED"],
      };
      assert(
        allowed[s.status]?.includes(body.status),
        409,
        "SHIPMENT_SEQUENCE",
        "Событие не соответствует текущему этапу. Проверьте данные перевозчика",
      );
      const lines = (await orderLines(c, o.id)).filter((l) =>
        ["RESERVED", "RETURNING"].includes(l.outcome),
      );
      if (lines.length)
        await lockItems(
          c,
          lines.map((l) => l.item_id),
        );
      let shipmentStatus: string = body.status;
      if (body.status === "DELIVERED") {
        const delivered = body.deliveredLineIds
          ? lines.filter((l) => body.deliveredLineIds!.includes(l.id))
          : lines;
        assert(
          delivered.length &&
            (!body.deliveredLineIds ||
              delivered.length === new Set(body.deliveredLineIds).size),
          422,
          "LINES",
          "Проверьте выданные строки",
        );
        const returning = lines.filter(
          (l) => !delivered.some((d) => d.id === l.id),
        );
        if (returning.length) {
          const settings = await getSettings(c);
          assert(
            settings.carriers?.[o.method]?.partialDelivery === true,
            422,
            "PARTIAL_NOT_CONFIGURED",
            "Частичная выдача не подтверждена договором перевозчика",
          );
        }
        await releaseClaims(
          c,
          delivered.map((l) => l.item_id),
          "Вручено почтой",
        );
        await setPhysical(
          c,
          delivered.map((l) => l.item_id),
          "SOLD",
          actor(r).id,
          "Подтверждено вручение почтой",
        );
        await outcomes(c, delivered, "HANDED_OVER");
        await c.query(
          "UPDATE shipment_lines SET outcome='DELIVERED' WHERE shipment_id=$1 AND order_line_id=ANY($2::uuid[])",
          [s.id, delivered.map((l) => l.id)],
        );
        if (returning.length) {
          shipmentStatus = "RETURN_IN_TRANSIT";
          await setPhysical(
            c,
            returning.map((l) => l.item_id),
            "RETURN_IN_TRANSIT",
            actor(r).id,
            "Частичный отказ на почте",
          );
          await outcomes(c, returning, "RETURNING");
          await c.query(
            "UPDATE shipment_lines SET outcome='RETURNING' WHERE shipment_id=$1 AND order_line_id=ANY($2::uuid[])",
            [s.id, returning.map((l) => l.id)],
          );
          await bump(c, o, "RETURNING");
        } else {
          await c.query("UPDATE orders SET completed_at=now() WHERE id=$1", [
            o.id,
          ]);
          await bump(c, o, "FULFILLED");
        }
        await event(
          c,
          o,
          "DELIVERED",
          `Вручено ${delivered.length} вещей${returning.length ? ", часть возвращается" : ""}`,
        );
      } else if (body.status === "RETURN_IN_TRANSIT") {
        await setPhysical(
          c,
          lines.map((l) => l.item_id),
          "RETURN_IN_TRANSIT",
          actor(r).id,
          "Перевозчик начал возврат",
        );
        await outcomes(c, lines, "RETURNING");
        await bump(c, o, "RETURNING");
        await event(
          c,
          o,
          "RETURN_IN_TRANSIT",
          "Посылка возвращается в магазин",
        );
      } else if (body.status === "RETURN_RECEIVED") {
        await releaseLines(
          c,
          o,
          lines,
          "Фактически приняты возвращённые вещи",
          "RETURNED",
        );
        const rid = randomUUID();
        await c.query(
          "INSERT INTO return_cases(id,order_id,reason,status,created_by,received_at) VALUES($1,$2,'Возврат перевозчиком','RECEIVED',$3,now())",
          [rid, o.id, actor(r).id],
        );
        for (const l of lines)
          await c.query(
            "INSERT INTO return_lines(return_id,order_line_id) VALUES($1,$2)",
            [rid, l.id],
          );
        await bump(c, o, "RETURNED");
        await event(
          c,
          o,
          "RETURN_RECEIVED",
          "Возврат получен магазином. Вещи проходят осмотр",
        );
      } else if (body.status === "LOST_OR_DAMAGED") {
        await c.query("UPDATE orders SET exception=true WHERE id=$1", [o.id]);
        await issue(
          c,
          s.id,
          "CARRIER_PROBLEM",
          "Подтверждена потеря или повреждение посылки. Требуется разбор с перевозчиком",
          o.id,
        );
        await bump(c, o);
        await event(
          c,
          o,
          "CARRIER_PROBLEM",
          "Возникла проблема у перевозчика. Магазин уточняет результат",
        );
      } else {
        await bump(c, o);
        await event(
          c,
          o,
          body.status,
          body.status === "AT_OFFICE"
            ? "Посылка в отделении. Срок уточните у перевозчика"
            : "Посылка в пути",
        );
      }
      await c.query(
        "UPDATE shipments SET status=$2,source=$3,version=version+1,updated_at=now() WHERE id=$1",
        [s.id, shipmentStatus, body.source],
      );
      await c.query(
        "INSERT INTO shipment_events(shipment_id,status,source,raw) VALUES($1,$2,$3,$4)",
        [
          s.id,
          body.status,
          body.source,
          JSON.stringify({ deliveredLineIds: body.deliveredLineIds }),
        ],
      );
      await audit(c, actor(r).id, "shipment.event", "shipment", s.id, {
        status: body.status,
      });
      return readOrder(c, o.id, actor(r));
    });
  });
  app.post("/staff/returns", async (r) => {
    const body = z
      .object({
        orderId: z.string().uuid(),
        lineIds: ids,
        reason: z.string().trim().min(3).max(1000),
      })
      .parse(r.body);
    return command(r, "returns.create", body, async (c) => {
      const o = await lockedOrder(c, body.orderId, actor(r));
      const lines = (await orderLines(c, o.id)).filter((l) =>
        body.lineIds.includes(l.id),
      );
      assert(
        lines.length === body.lineIds.length &&
          lines.every((l) => l.outcome === "HANDED_OVER"),
        422,
        "RETURN_LINES",
        "Возврат создаётся для фактически выданных строк",
      );
      const open = (
        await c.query(
          "SELECT 1 FROM return_lines l JOIN return_cases r ON r.id=l.return_id WHERE l.order_line_id=ANY($1::uuid[]) AND r.status NOT IN ('CLOSED','REJECTED')",
          [body.lineIds],
        )
      ).rows;
      assert(
        !open.length,
        409,
        "RETURN_EXISTS",
        "По этим вещам уже рассматривается возврат",
      );
      const rid = randomUUID();
      await c.query(
        "INSERT INTO return_cases(id,order_id,reason,created_by) VALUES($1,$2,$3,$4)",
        [rid, o.id, body.reason, actor(r).id],
      );
      for (const l of lines)
        await c.query(
          "INSERT INTO return_lines(return_id,order_line_id) VALUES($1,$2)",
          [rid, l.id],
        );
      await audit(c, actor(r).id, "return.create", "return", rid, {
        orderId: o.id,
        lineIds: body.lineIds,
      });
      await bump(c, o);
      await event(
        c,
        o,
        "RETURN_OPENED",
        "Обращение о возврате зарегистрировано магазином",
      );
      return {
        id: rid,
        orderId: o.id,
        version: 1,
        status: "OPEN",
        lineIds: body.lineIds,
      };
    });
  });
  app.get("/staff/returns", async () =>
    tx(async (c) => {
      const rows = (
        await c.query(
          "SELECT r.*,o.number FROM return_cases r JOIN orders o ON o.id=r.order_id ORDER BY r.created_at DESC LIMIT 200",
        )
      ).rows;
      return {
        returns: await Promise.all(
          rows.map(async (r) => ({
            id: r.id,
            orderId: r.order_id,
            orderNumber: String(r.number),
            reason: r.reason,
            status: r.status,
            version: r.version,
            decision: r.decision,
            createdAt: r.created_at,
            receivedAt: r.received_at,
            lines: (
              await c.query(
                "SELECT l.*,ol.item_id,ol.snapshot FROM return_lines l JOIN order_lines ol ON ol.id=l.order_line_id WHERE return_id=$1",
                [r.id],
              )
            ).rows.map((l) => ({
              id: l.order_line_id,
              itemId: l.item_id,
              title: l.snapshot.title,
              sku: l.snapshot.sku,
              inspection: l.inspection,
            })),
          })),
        ),
      };
    }),
  );
  app.post("/staff/returns/:id/receive", async (r) => {
    const body = z.object({ version }).parse(r.body);
    return command(r, "returns.receive:" + id(r), body, async (c) => {
      const base = (
        await c.query("SELECT order_id FROM return_cases WHERE id=$1", [id(r)])
      ).rows[0];
      assert(base, 404, "RETURN_NOT_FOUND", "Возврат не найден");
      const o = await lockedOrder(c, base.order_id, actor(r));
      const ret = (
        await c.query("SELECT * FROM return_cases WHERE id=$1 FOR UPDATE", [
          id(r),
        ])
      ).rows[0];
      expected(ret, body.version);
      assert(
        ret.status === "OPEN",
        409,
        "RETURN_STAGE",
        "Возврат уже принят или закрыт",
      );
      const lines = (
        await c.query(
          "SELECT ol.* FROM return_lines rl JOIN order_lines ol ON ol.id=rl.order_line_id WHERE rl.return_id=$1",
          [ret.id],
        )
      ).rows;
      await lockItems(
        c,
        lines.map((l) => l.item_id),
      );
      await releaseClaims(
        c,
        lines.map((l) => l.item_id),
        "Принят возврат покупателя",
      );
      await setPhysical(
        c,
        lines.map((l) => l.item_id),
        "INSPECTION",
        actor(r).id,
        "Вещь физически принята на осмотр",
      );
      await outcomes(c, lines, "RETURNED");
      for (const l of lines)
        await issue(
          c,
          l.item_id,
          "RETURN_INSPECTION",
          "Возврат требует решения владельца и осмотра",
          o.id,
          l.item_id,
        );
      await c.query(
        "UPDATE return_cases SET status='RECEIVED',version=version+1,received_at=now() WHERE id=$1",
        [ret.id],
      );
      await bump(c, o);
      await event(
        c,
        o,
        "RETURN_RECEIVED",
        "Магазин принял вещи для рассмотрения возврата",
      );
      await audit(c, actor(r).id, "return.receive", "return", ret.id);
      return {
        id: ret.id,
        orderId: o.id,
        status: "RECEIVED",
        version: ret.version + 1,
      };
    });
  });
  app.post("/owner/returns/:id/resolve", async (r) => {
    const body = z
      .object({
        version,
        suitable: z.boolean(),
        note: z.string().trim().min(3).max(2000),
      })
      .parse(r.body);
    return command(r, "returns.resolve:" + id(r), body, async (c) => {
      const base = (
        await c.query("SELECT order_id FROM return_cases WHERE id=$1", [id(r)])
      ).rows[0];
      assert(base, 404, "RETURN_NOT_FOUND", "Возврат не найден");
      const o = await lockedOrder(c, base.order_id, actor(r));
      const ret = (
        await c.query("SELECT * FROM return_cases WHERE id=$1 FOR UPDATE", [
          id(r),
        ])
      ).rows[0];
      expected(ret, body.version);
      assert(
        ret.status === "RECEIVED",
        409,
        "RETURN_STAGE",
        "Решение принимается после физического получения и осмотра",
      );
      const lines = (
        await c.query(
          "SELECT ol.* FROM return_lines rl JOIN order_lines ol ON ol.id=rl.order_line_id WHERE rl.return_id=$1",
          [ret.id],
        )
      ).rows;
      await lockItems(
        c,
        lines.map((l) => l.item_id),
      );
      await c.query(
        "UPDATE return_cases SET status='CLOSED',decision=$2,version=version+1,closed_at=now() WHERE id=$1",
        [ret.id, body.note],
      );
      await c.query(
        "UPDATE return_lines SET inspection=$2 WHERE return_id=$1",
        [ret.id, body.suitable ? "SUITABLE" : "NOT_SUITABLE"],
      );
      await c.query(
        "UPDATE operation_issues SET state='RESOLVED',resolution='Решение владельца зафиксировано',resolved_at=now() WHERE item_id=ANY($1::uuid[]) AND kind='RETURN_INSPECTION' AND state='OPEN'",
        [lines.map((l) => l.item_id)],
      );
      if (!body.suitable) {
        await setPhysical(
          c,
          lines.map((l) => l.item_id),
          "WRITTEN_OFF",
          actor(r).id,
          "По осмотру нельзя повторно продавать как новую",
        );
        await c.query(
          "UPDATE items SET publication='HIDDEN' WHERE id=ANY($1::uuid[])",
          [lines.map((l) => l.item_id)],
        );
      } else
        for (const l of lines)
          await issue(
            c,
            l.item_id,
            "INSPECTION",
            "Проверьте маркировку и верните вещь в торговый зал отдельным действием",
            o.id,
            l.item_id,
          );
      await bump(c, o);
      await event(
        c,
        o,
        "RETURN_RESOLVED",
        "Решение по возврату принято. Подробности сообщит магазин",
      );
      await audit(c, actor(r).id, "return.resolve", "return", ret.id, {
        suitable: body.suitable,
      });
      return {
        id: ret.id,
        orderId: o.id,
        status: "CLOSED",
        version: ret.version + 1,
      };
    });
  });
  app.post("/staff/issues/:id/resolve", async (r) => {
    const body = z
      .object({ note: z.string().trim().min(3).max(1000) })
      .parse(r.body);
    return command(r, "issues.resolve:" + id(r), body, async (c) => {
      const row = (
        await c.query("SELECT * FROM operation_issues WHERE id=$1 FOR UPDATE", [
          id(r),
        ])
      ).rows[0];
      assert(row, 404, "ISSUE_NOT_FOUND", "Задача не найдена");
      assert(
        !["INSPECTION", "RETURN_INSPECTION", "QUALITY_CHECK"].includes(
          row.kind,
        ),
        409,
        "PHYSICAL_CHECK_REQUIRED",
        "Задача закроется после осмотра вещи через её карточку",
      );
      await c.query(
        "UPDATE operation_issues SET state='RESOLVED',resolution=$2,resolved_at=now() WHERE id=$1",
        [row.id, body.note],
      );
      await audit(c, actor(r).id, "issue.resolve", "issue", row.id);
      return { resolved: true };
    });
  });
  app.post("/staff/issues/:id/assign", async (r) =>
    command(r, "issues.assign:" + id(r), {}, async (c) => {
      const result = await c.query(
        "UPDATE operation_issues SET assigned_to=$2 WHERE id=$1 AND state='OPEN' RETURNING id",
        [id(r), actor(r).id],
      );
      assert(
        result.rowCount,
        404,
        "ISSUE_NOT_FOUND",
        "Открытая задача не найдена",
      );
      await audit(c, actor(r).id, "issue.assign", "issue", id(r));
      return { assigned: true };
    }),
  );
}
