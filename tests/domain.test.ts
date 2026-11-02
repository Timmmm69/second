import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import Fastify from "fastify";
import { pool, tx } from "../server/db.js";
import { migrate } from "../server/migrate.js";
import {
  registerOrders,
  createLease,
  confirmOrder,
  reflowCalendar,
  lockedOrder,
  expireOrder,
} from "../server/orders.js";
import {
  setPhysical,
  lockItems,
  claimItems,
  idem,
} from "../server/inventory.js";
import { processOutbox, tick } from "../server/jobs.js";
import type { Calendar } from "../server/calendar.js";
import { decrypt } from "../server/crypto.js";
import type { Actor } from "../server/types.js";
if (!process.env.DATABASE_URL?.match(/\/[^/]*_test(?:\?|$)/))
  throw new Error(
    "Domain integration tests require explicit isolated *_test PostgreSQL database",
  );
const users: Actor[] = [],
  app = Fastify();
const calendar: Calendar = {
  week: {
    "0": ["00:00", "23:59"],
    "1": ["00:00", "23:59"],
    "2": ["00:00", "23:59"],
    "3": ["00:00", "23:59"],
    "4": ["00:00", "23:59"],
    "5": ["00:00", "23:59"],
    "6": ["00:00", "23:59"],
  },
  exceptions: {},
};
let buyer: Actor, staff: Actor, owner: Actor;
app.addHook("preHandler", async (r) => {
  r.actor = users.find((u) => u.id === r.headers["x-test-actor"])!;
});
app.setErrorHandler((e: any, _, reply) =>
  reply
    .code(e.status ?? e.statusCode ?? 500)
    .send({ code: e.code, message: e.message }),
);
async function api(
  actor: Actor,
  method: any,
  url: string,
  body?: unknown,
  key = randomUUID(),
) {
  const res = await app.inject({
    method,
    url,
    headers: { "x-test-actor": actor.id, "idempotency-key": key },
    payload: body as any,
  });
  return { status: res.statusCode, body: res.json() };
}
async function item() {
  const id = randomUUID();
  await pool.query(
    "INSERT INTO items(id,sku,title,category,price_minor,publication) VALUES($1,$2,'Тестовая новая вещь','outerwear',4500,'PUBLISHED')",
    [id, "T-" + id],
  );
  await tx((c) => setPhysical(c, [id], "AVAILABLE", staff.id, "test fixture"));
  return id;
}
async function newOrder(method = "PICKUP", count = 1) {
  const itemIds = await Promise.all(
    Array.from({ length: count }, () => item()),
  );
  const lease = await createLease(buyer, randomUUID(), { itemIds });
  const o: any = await confirmOrder(buyer, randomUUID(), {
    leaseId: lease.id,
    method,
    phone: "+375291234567",
    fullName: "Тест Получатель",
    city: "Минск",
    office: "Отделение 1, тестовый адрес",
    officeAddress: "Синтетическая улица, 1",
    postalCode: "220000",
    termsAccepted: true,
  });
  return { o, itemIds };
}
async function verified(o: any, itemIds: string[]) {
  let res = await api(staff, "POST", `/staff/orders/${o.id}/verify`, {
    version: o.version,
    foundItemIds: itemIds,
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  o = res.body;
  res = await api(staff, "POST", `/staff/orders/${o.id}/ready`, {
    version: o.version,
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
}
before(async () => {
  await migrate();
  await pool.query("TRUNCATE users,items RESTART IDENTITY CASCADE");
  for (let n = 0; n < 104; n++) {
    const role = n === 0 ? "OWNER" : n === 1 ? "STAFF" : "BUYER",
      id = randomUUID(),
      telegramId = String(9000000 + n);
    await pool.query(
      "INSERT INTO users(id,telegram_id,role,allow_bot) VALUES($1,$2,$3,true)",
      [id, telegramId, role],
    );
    users.push({ id, telegramId, role });
  }
  owner = users[0];
  staff = users[1];
  buyer = users[2];
  const settings = (await pool.query("SELECT value FROM store_settings"))
    .rows[0].value;
  settings.acceptingOrders = true;
  settings.calendar = calendar;
  for (const carrier of Object.values(settings.carriers) as any[]) {
    carrier.enabled = true;
    carrier.contract = "TEST ONLY";
    carrier.terms = "TEST ONLY";
  }
  await pool.query("UPDATE store_settings SET value=$1", [settings]);
  await registerOrders(app);
  await app.ready();
});
after(async () => {
  await app.close();
  await pool.end();
});
test("T03 real PostgreSQL: 100 buyers race one SKU, exactly one claim", async () => {
  const id = await item();
  const results = await Promise.allSettled(
    users
      .slice(4, 104)
      .map((actor) => createLease(actor, randomUUID(), { itemIds: [id] })),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM inventory_claim WHERE item_id=$1",
        [id],
      )
    ).rows[0].n,
    1,
  );
  assert(
    results
      .filter((r) => r.status === "rejected")
      .every((r: any) => r.reason.status === 409),
  );
});
test("T04 intersecting sets reserve atomically", async () => {
  const a = await item(),
    b = await item(),
    c = await item();
  const results = await Promise.allSettled([
    createLease(users[3], randomUUID(), { itemIds: [a, b] }),
    createLease(users[4], randomUUID(), { itemIds: [b, c] }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM inventory_claim WHERE item_id=ANY($1::uuid[])",
        [[a, b, c]],
      )
    ).rows[0].n,
    2,
  );
});
test("T05 counter sale and buyer lease share one inventory lock", async () => {
  const id = await item();
  const result = await Promise.allSettled([
    createLease(buyer, randomUUID(), { itemIds: [id] }),
    api(staff, "POST", "/staff/availability-operations", { itemIds: [id] }),
  ]);
  const successes = result.filter(
    (r) =>
      r.status === "fulfilled" &&
      (!("status" in r.value) || (r.value as any).status === 200),
  );
  assert.equal(successes.length, 1);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM inventory_claim WHERE item_id=$1",
        [id],
      )
    ).rows[0].n,
    1,
  );
});
test("T06/T07 same key ten concurrent confirms, result recovery and mismatch", async () => {
  const id = await item(),
    lease = await createLease(buyer, randomUUID(), { itemIds: [id] }),
    key = randomUUID(),
    body = {
      leaseId: lease.id,
      method: "PICKUP",
      phone: "+375291234567",
      termsAccepted: true,
    };
  const results = await Promise.all(
    Array.from({ length: 10 }, () => confirmOrder(buyer, key, body)),
  );
  assert.equal(new Set(results.map((r: any) => r.id)).size, 1);
  const stored = await api(buyer, "GET", "/operations/" + key);
  assert.equal(stored.status, 200);
  assert.equal(stored.body.id, results[0].id);
  await assert.rejects(
    confirmOrder(buyer, key, { ...body, phone: "+375299999999" }),
    (e: any) => e.code === "IDEMPOTENCY_MISMATCH",
  );
  const encrypted = (
    await pool.query(
      "SELECT response FROM idempotency_records WHERE actor_id=$1 AND key=$2",
      [buyer.id, key],
    )
  ).rows[0].response;
  assert(!JSON.stringify(encrypted).includes("375291234567"));
});
test("T08 transaction error rolls back partial claims/audit/outbox", async () => {
  const id = await item(),
    key = randomUUID();
  await assert.rejects(
    idem(buyer, key, "test.rollback", {}, async (c) => {
      await lockItems(c, [id]);
      await claimItems(c, [id], "COUNTER_SALE", randomUUID(), buyer.id, null);
      await c.query(
        "INSERT INTO user_events(user_id,type,message) VALUES($1,'TEST','rollback')",
        [buyer.id],
      );
      throw new Error("forced rollback");
    }),
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM inventory_claim WHERE item_id=$1",
        [id],
      )
    ).rows[0].n,
    0,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM idempotency_records WHERE key=$1",
        [key],
      )
    ).rows[0].n,
    0,
  );
});
test("T09 lease expires while waiting for item lock; confirmation rejected", async () => {
  const id = await item(),
    lease = await createLease(buyer, randomUUID(), { itemIds: [id] });
  await pool.query(
    "UPDATE leases SET expires_at=clock_timestamp()+interval '120 milliseconds' WHERE id=$1",
    [lease.id],
  );
  await pool.query(
    "UPDATE inventory_claim SET expires_at=clock_timestamp()+interval '120 milliseconds' WHERE owner_id=$1",
    [lease.id],
  );
  const c = await pool.connect();
  await c.query("BEGIN");
  await c.query("SELECT id FROM items WHERE id=$1 FOR UPDATE", [id]);
  const pending = confirmOrder(buyer, randomUUID(), {
    leaseId: lease.id,
    method: "PICKUP",
    phone: "+375291234567",
    termsAccepted: true,
  });
  const rejection = assert.rejects(pending, (e: any) => e.status === 410);
  await new Promise((resolve) => setTimeout(resolve, 220));
  await c.query("COMMIT");
  c.release();
  await rejection;
});
test("T01/T15 pickup partial handover with idempotent lost-response retry", async () => {
  const { o, itemIds } = await newOrder("PICKUP", 3);
  const ready = await verified(o, itemIds);
  const own = (await api(buyer, "GET", `/orders/${o.id}`)).body;
  assert.match(own.pickupCode, /^\d{6}$/);
  const start = await api(staff, "POST", `/staff/orders/${o.id}/handovers`, {
    version: ready.version,
    code: own.pickupCode,
  });
  assert.equal(start.status, 200);
  const key = randomUUID(),
    accepted = own.lines.slice(0, 2).map((l: any) => l.id),
    body = { acceptedLineIds: accepted };
  const complete = await api(
    staff,
    "POST",
    `/staff/handovers/${start.body.id}/complete`,
    body,
    key,
  );
  assert.equal(complete.status, 200, JSON.stringify(complete.body));
  const retry = await api(
    staff,
    "POST",
    `/staff/handovers/${start.body.id}/complete`,
    body,
    key,
  );
  assert.equal(retry.body.id, o.id);
  assert.equal(retry.body.status, "FULFILLED");
  const physical = (
    await pool.query(
      "SELECT physical,count(*)::int AS n FROM items WHERE id=ANY($1::uuid[]) GROUP BY physical",
      [itemIds],
    )
  ).rows;
  assert.equal(physical.find((r) => r.physical === "SOLD").n, 2);
  assert.equal(physical.find((r) => r.physical === "INSPECTION").n, 1);
  assert.equal(
    (await api(buyer, "GET", `/orders/${o.id}`)).body.pickupCode,
    undefined,
  );
});
test("T22 phone mandatory, code attempt limiter persists after rejection", async () => {
  const id = await item(),
    lease = await createLease(buyer, randomUUID(), { itemIds: [id] });
  await assert.rejects(
    confirmOrder(buyer, randomUUID(), {
      leaseId: lease.id,
      method: "PICKUP",
      termsAccepted: true,
    }),
  );
  const { o, itemIds } = await newOrder();
  const ready = await verified(o, itemIds);
  for (let i = 0; i < 5; i++)
    assert.equal(
      (
        await api(staff, "POST", `/staff/orders/${o.id}/handovers`, {
          version: ready.version,
          code: "000000",
        })
      ).status,
      422,
    );
  assert.equal(
    (
      await api(staff, "POST", `/staff/orders/${o.id}/handovers`, {
        version: ready.version,
        code: "000000",
      })
    ).status,
    429,
  );
});
for (const method of ["BELPOST", "EUROPOST"])
  test(
    "T02 " + method + " manual registration -> acceptance -> delivery",
    async () => {
      const { o, itemIds } = await newOrder(method);
      let current = await verified(o, itemIds);
      assert.equal(current.status, "PREPARING");
      let res = await api(staff, "POST", "/staff/shipments", {
        orderId: o.id,
        version: current.version,
        tracking: "TEST-" + randomUUID(),
        source: "Тест: зарегистрировано в кабинете",
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      current = res.body;
      assert.equal(current.shipment.status, "REGISTERED");
      assert.equal(
        (
          await pool.query("SELECT physical FROM items WHERE id=$1", [
            itemIds[0],
          ])
        ).rows[0].physical,
        "PACKED",
      );
      res = await api(
        staff,
        "POST",
        `/staff/shipments/${current.shipment.id}/acceptance`,
        { version: current.version, source: "Тест: квитанция приёмки" },
      );
      assert.equal(res.status, 200);
      current = res.body;
      res = await api(
        staff,
        "POST",
        `/staff/shipments/${current.shipment.id}/events`,
        {
          version: current.version,
          status: "DELIVERED",
          source: "Тест: официальное отслеживание",
        },
      );
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.status, "FULFILLED");
      assert.equal(
        (
          await pool.query("SELECT physical FROM items WHERE id=$1", [
            itemIds[0],
          ])
        ).rows[0].physical,
        "SOLD",
      );
    },
  );
test("T17/T18 preparing changes are versioned requests; dispatch blocked until carrier cancel", async () => {
  const { o, itemIds } = await newOrder("EUROPOST");
  let current = await verified(o, itemIds);
  current = (
    await api(staff, "POST", "/staff/shipments", {
      orderId: o.id,
      version: current.version,
      tracking: "TEST-" + randomUUID(),
      source: "Тест кабинет",
    })
  ).body;
  const stale = current.version;
  const request = await api(buyer, "POST", `/orders/${o.id}/cancel`, {
    version: current.version,
  });
  assert.equal(request.status, 200);
  current = request.body;
  assert.equal(current.cancelRequested.type, "CANCEL");
  assert.equal(
    (
      await api(
        staff,
        "POST",
        `/staff/shipments/${current.shipment.id}/acceptance`,
        { version: current.version, source: "Тест приёмка" },
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await api(buyer, "PATCH", `/orders/${o.id}/recipient`, {
        version: stale,
        phone: "+375291234567",
        fullName: "Тест",
        city: "Минск",
        office: "1",
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM inventory_claim WHERE item_id=$1",
        [itemIds[0]],
      )
    ).rows[0].n,
    1,
  );
  current = (
    await api(staff, "POST", `/staff/shipments/${current.shipment.id}/cancel`, {
      version: current.version,
      source: "Тест: отмена в кабинете подтверждена",
    })
  ).body;
  const resolved = await api(
    staff,
    "POST",
    `/staff/orders/${o.id}/change-request`,
    {
      version: current.version,
      approve: true,
      source: "Согласовано с покупателем",
    },
  );
  assert.equal(resolved.status, 200);
  assert.equal(resolved.body.status, "CANCELLED");
  assert.equal(
    (await pool.query("SELECT physical FROM items WHERE id=$1", [itemIds[0]]))
      .rows[0].physical,
    "INSPECTION",
  );
});
test("T20 buyer cannot read another order or operation", async () => {
  const { o } = await newOrder();
  const other = users[3];
  assert.equal((await api(other, "GET", `/orders/${o.id}`)).status, 403);
  assert.equal(
    (await api(other, "GET", "/operations/" + randomUUID())).status,
    404,
  );
});
test("T11 changed calendar extends existing promise and never shortens", async () => {
  const { o, itemIds } = await newOrder();
  await verified(o, itemIds);
  const before = (await pool.query("SELECT * FROM orders WHERE id=$1", [o.id]))
    .rows[0];
  const deadlineDay = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Minsk",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(before.pickup_deadline);
  await tx((c) =>
    reflowCalendar(c, { ...calendar, exceptions: { [deadlineDay]: null } }, 2),
  );
  let after = (
    await pool.query("SELECT pickup_deadline FROM orders WHERE id=$1", [o.id])
  ).rows[0];
  assert(after.pickup_deadline > before.pickup_deadline);
  const extended = after.pickup_deadline.getTime();
  await tx((c) => reflowCalendar(c, calendar, 3));
  after = (
    await pool.query("SELECT pickup_deadline FROM orders WHERE id=$1", [o.id])
  ).rows[0];
  assert.equal(after.pickup_deadline.getTime(), extended);
});
test("T13/T14 worker overdue verification and pickup expiry -> inspection, no sanctions", async () => {
  const { o, itemIds } = await newOrder();
  await pool.query(
    "UPDATE orders SET verify_by=clock_timestamp()-interval '1 hour',cancel_by=clock_timestamp()-interval '1 minute' WHERE id=$1",
    [o.id],
  );
  await tick({ skipOutbox: true });
  assert.equal(
    (await pool.query("SELECT status FROM orders WHERE id=$1", [o.id])).rows[0]
      .status,
    "EXPIRED",
  );
  assert.equal(
    (await pool.query("SELECT physical FROM items WHERE id=$1", [itemIds[0]]))
      .rows[0].physical,
    "INSPECTION",
  );
  const again = await newOrder();
  assert(again.o.id);
});
test("T27 returned parcel remains unavailable through physical reception", async () => {
  const { o, itemIds } = await newOrder("BELPOST");
  let current = await verified(o, itemIds);
  current = (
    await api(staff, "POST", "/staff/shipments", {
      orderId: o.id,
      version: current.version,
      tracking: "TEST-" + randomUUID(),
      source: "Тест кабинет",
    })
  ).body;
  current = (
    await api(
      staff,
      "POST",
      `/staff/shipments/${current.shipment.id}/acceptance`,
      { version: current.version, source: "Тест квитанция" },
    )
  ).body;
  current = (
    await api(
      staff,
      "POST",
      `/staff/shipments/${current.shipment.id}/return-request`,
      { version: current.version, source: "Не востребовано, запрос владельца" },
    )
  ).body;
  current = (
    await api(staff, "POST", `/staff/shipments/${current.shipment.id}/events`, {
      version: current.version,
      status: "RETURN_IN_TRANSIT",
      source: "Тест данные почты",
    })
  ).body;
  assert.equal(
    (await pool.query("SELECT physical FROM items WHERE id=$1", [itemIds[0]]))
      .rows[0].physical,
    "RETURN_IN_TRANSIT",
  );
  const received = await api(
    staff,
    "POST",
    `/staff/shipments/${current.shipment.id}/events`,
    {
      version: current.version,
      status: "RETURN_RECEIVED",
      source: "Тест: физически сверены вложения",
    },
  );
  assert.equal(received.status, 200, JSON.stringify(received.body));
  assert.equal(
    (await pool.query("SELECT physical FROM items WHERE id=$1", [itemIds[0]]))
      .rows[0].physical,
    "INSPECTION",
  );
});
test("T30 outbox respects 429 Retry-After and 403 creates visible issue", async () => {
  await pool.query(
    "UPDATE outbox_events SET state='SKIPPED' WHERE state IN ('PENDING','PROCESSING')",
  );
  const { o } = await newOrder();
  await processOutbox(async () => ({
    ok: false,
    status: 429,
    retryAfter: 300,
    error: "RATE_LIMIT",
  }));
  let e = (
    await pool.query(
      "SELECT * FROM outbox_events WHERE entity_id=$1 ORDER BY created_at LIMIT 1",
      [o.id],
    )
  ).rows[0];
  assert.equal(e.state, "PENDING");
  assert(e.available_at.getTime() - Date.now() > 290000);
  await pool.query("UPDATE outbox_events SET available_at=now() WHERE id=$1", [
    e.id,
  ]);
  await processOutbox(async () => ({
    ok: false,
    status: 403,
    error: "BOT_BLOCKED",
  }));
  e = (await pool.query("SELECT * FROM outbox_events WHERE id=$1", [e.id]))
    .rows[0];
  assert.equal(e.state, "FAILED");
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM operation_issues WHERE entity_id=$1 AND kind='NOTIFICATION_FAILED'",
        [e.id],
      )
    ).rows[0].n,
    1,
  );
  assert.equal(
    (await pool.query("SELECT status FROM orders WHERE id=$1", [o.id])).rows[0]
      .status,
    "CHECKING",
  );
});
test("T36 no five-item/two-order business limits", async () => {
  const created = await newOrder("PICKUP", 6);
  assert.equal(created.o.lines.length, 6);
  const more = await Promise.all([newOrder(), newOrder(), newOrder()]);
  assert.equal(more.length, 3);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM inventory_claim WHERE item_id=ANY($1::uuid[])",
        [created.itemIds],
      )
    ).rows[0].n,
    6,
  );
});
test("T12/T37 no extension or payment route exists", async () => {
  assert.equal(
    (await api(buyer, "POST", "/orders/" + randomUUID() + "/extend", {}))
      .status,
    404,
  );
  assert.equal((await api(buyer, "POST", "/payments", {})).status, 404);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public' AND (table_name LIKE 'payment%' OR table_name LIKE '%ledger%' AND table_name<>'deletion_ledger')",
      )
    ).rows[0].n,
    0,
  );
});
test("T26 owner notification has number/channel but never recipient PII", async () => {
  const { o } = await newOrder("EUROPOST");
  const events = (
    await pool.query(
      "SELECT message,payload,recipient_id FROM outbox_events WHERE entity_id=$1 AND event_type='SHIPMENT_REQUEST'",
      [o.id],
    )
  ).rows;
  assert.equal(events.length, 1);
  assert.equal(events[0].recipient_id, owner.id);
  assert(events[0].message.includes(String(o.number)));
  assert(!JSON.stringify(events[0]).includes("375291234567"));
  assert(!JSON.stringify(events[0]).includes("Тест Получатель"));
  assert(!JSON.stringify(events[0]).includes("220000"));
});
test("T28 customer return keeps sale history, requires owner decision and separate republish", async () => {
  const { o, itemIds } = await newOrder();
  const ready = await verified(o, itemIds),
    own = (await api(buyer, "GET", `/orders/${o.id}`)).body;
  const h = await api(staff, "POST", `/staff/orders/${o.id}/handovers`, {
    version: ready.version,
    code: own.pickupCode,
  });
  const sale = await api(
    staff,
    "POST",
    `/staff/handovers/${h.body.id}/complete`,
    { acceptedLineIds: own.lines.map((l: any) => l.id) },
  );
  assert.equal(sale.body.status, "FULFILLED");
  const ret = await api(staff, "POST", "/staff/returns", {
    orderId: o.id,
    lineIds: own.lines.map((l: any) => l.id),
    reason: "Покупатель обратился о возврате новой вещи",
  });
  assert.equal(ret.status, 200);
  const received = await api(
    staff,
    "POST",
    `/staff/returns/${ret.body.id}/receive`,
    { version: 1 },
  );
  assert.equal(received.status, 200);
  const resolved = await api(
    owner,
    "POST",
    `/owner/returns/${ret.body.id}/resolve`,
    {
      version: 2,
      suitable: true,
      note: "Осмотр: вещь соответствует сведениям и может быть возвращена в зал",
    },
  );
  assert.equal(resolved.status, 200, JSON.stringify(resolved.body));
  assert.equal(
    (await pool.query("SELECT physical FROM items WHERE id=$1", [itemIds[0]]))
      .rows[0].physical,
    "INSPECTION",
  );
  assert.equal(
    (await pool.query("SELECT status FROM orders WHERE id=$1", [o.id])).rows[0]
      .status,
    "FULFILLED",
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM audit_events WHERE entity_id=$1 AND command='handover.complete'",
        [o.id],
      )
    ).rows[0].n,
    1,
  );
});
test("T29 partial carrier delivery preserves delivered and specific returning lines", async () => {
  const settings = (await pool.query("SELECT value FROM store_settings"))
    .rows[0].value;
  settings.carriers.EUROPOST.partialDelivery = true;
  await pool.query("UPDATE store_settings SET value=$1", [settings]);
  const { o, itemIds } = await newOrder("EUROPOST", 2);
  let current = await verified(o, itemIds);
  current = (
    await api(staff, "POST", "/staff/shipments", {
      orderId: o.id,
      version: current.version,
      tracking: "TEST-" + randomUUID(),
      source: "Тест кабинет",
    })
  ).body;
  current = (
    await api(
      staff,
      "POST",
      `/staff/shipments/${current.shipment.id}/acceptance`,
      { version: current.version, source: "Тест квитанция" },
    )
  ).body;
  const partial = await api(
    staff,
    "POST",
    `/staff/shipments/${current.shipment.id}/events`,
    {
      version: current.version,
      status: "DELIVERED",
      source: "Тест данные частичной выдачи",
      deliveredLineIds: [current.lines[0].id],
    },
  );
  assert.equal(partial.status, 200, JSON.stringify(partial.body));
  assert.equal(partial.body.status, "RETURNING");
  assert.equal(
    partial.body.lines.filter((l: any) => l.outcome === "HANDED_OVER").length,
    1,
  );
  assert.equal(
    partial.body.lines.filter((l: any) => l.outcome === "RETURNING").length,
    1,
  );
  const states = (
    await pool.query("SELECT physical FROM items WHERE id=ANY($1::uuid[])", [
      itemIds,
    ])
  ).rows
    .map((r) => r.physical)
    .sort();
  assert.deepEqual(states, ["RETURN_IN_TRANSIT", "SOLD"]);
});
test("T31 delayed outbox skips stale pickup reminders after expiry", async () => {
  await pool.query(
    "UPDATE outbox_events SET state='SKIPPED' WHERE state IN ('PENDING','PROCESSING')",
  );
  const { o, itemIds } = await newOrder();
  await verified(o, itemIds);
  const current = (await pool.query("SELECT * FROM orders WHERE id=$1", [o.id]))
    .rows[0];
  await pool.query(
    "INSERT INTO outbox_events(entity_id,entity_version,event_type,recipient_id,message) VALUES($1,$2,'PICKUP_REMINDER_TEST',$3,'Заберите сегодня')",
    [o.id, current.version, buyer.id],
  );
  await pool.query(
    "UPDATE orders SET pickup_deadline=clock_timestamp()-interval '1 minute' WHERE id=$1",
    [o.id],
  );
  let staleDelivered = false;
  await tick({
    deliver: async (_chat, message) => {
      if (message === "Заберите сегодня") staleDelivered = true;
      return { ok: true };
    },
  });
  assert.equal(staleDelivered, false);
  assert.equal(
    (
      await pool.query(
        "SELECT state FROM outbox_events WHERE entity_id=$1 AND event_type='PICKUP_REMINDER_TEST'",
        [o.id],
      )
    ).rows[0].state,
    "SKIPPED",
  );
});
test("T32 deletion request defers necessary data until open return closes", async () => {
  const customer = users[103],
    id = await item(),
    lease = await createLease(customer, randomUUID(), { itemIds: [id] });
  const o: any = await confirmOrder(customer, randomUUID(), {
    leaseId: lease.id,
    method: "PICKUP",
    phone: "+375299876543",
    termsAccepted: true,
  });
  const req = randomUUID();
  await pool.query("INSERT INTO deletion_requests(id,user_id) VALUES($1,$2)", [
    req,
    customer.id,
  ]);
  await tick({ skipOutbox: true });
  assert.equal(
    (
      await pool.query("SELECT status FROM deletion_requests WHERE id=$1", [
        req,
      ])
    ).rows[0].status,
    "RESTRICTED",
  );
  assert(
    (await pool.query("SELECT recipient_enc FROM orders WHERE id=$1", [o.id]))
      .rows[0].recipient_enc,
  );
  const cancelled = await api(customer, "POST", `/orders/${o.id}/cancel`, {
    version: o.version,
  });
  assert.equal(cancelled.status, 200);
  await tick({ skipOutbox: true });
  assert.equal(
    (
      await pool.query("SELECT status FROM deletion_requests WHERE id=$1", [
        req,
      ])
    ).rows[0].status,
    "COMPLETED",
  );
  assert.equal(
    (await pool.query("SELECT recipient_enc FROM orders WHERE id=$1", [o.id]))
      .rows[0].recipient_enc,
    null,
  );
});
test("T08 abrupt process termination before COMMIT leaves no partial claim or event", async () => {
  const id = await item(),
    marker = "PROCESS_CRASH_" + randomUUID();
  const child = `import pg from 'pg'; const c=new pg.Client({connectionString:process.env.DATABASE_URL});await c.connect();await c.query('BEGIN');await c.query('SELECT id FROM items WHERE id=$1 FOR UPDATE',[process.argv[1]]);await c.query("INSERT INTO inventory_claim(item_id,owner_type,owner_id,user_id) VALUES($1,'COUNTER_SALE',gen_random_uuid(),$2)",[process.argv[1],process.argv[2]]);await c.query("INSERT INTO user_events(user_id,type,message) VALUES($1,'PROCESS_CRASH',$2)",[process.argv[2],process.argv[3]]);process.exit(33);`;
  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        ["--input-type=module", "-e", child, id, buyer.id, marker],
        { stdio: "pipe" },
      ),
    (e: any) => e.status === 33,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM inventory_claim WHERE item_id=$1",
        [id],
      )
    ).rows[0].n,
    0,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM user_events WHERE message=$1",
        [marker],
      )
    ).rows[0].n,
    0,
  );
});
test("T35 service inventory issue blocks reserve despite stale AVAILABLE state", async () => {
  const id = await item();
  await pool.query(
    "INSERT INTO operation_issues(entity_id,item_id,kind,message) VALUES($1,$1,'NOT_FOUND','Физическая недостача')",
    [id],
  );
  await assert.rejects(
    createLease(buyer, randomUUID(), { itemIds: [id] }),
    (e: any) => e.status === 409,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM inventory_claim WHERE item_id=$1",
        [id],
      )
    ).rows[0].n,
    0,
  );
});
test("T20 buyer rule snapshot hides internal carrier contract and schemes", async () => {
  const settings = (await pool.query("SELECT value FROM store_settings"))
    .rows[0].value;
  settings.carriers.BELPOST.contract = "INTERNAL_CONTRACT_TEST";
  settings.carriers.BELPOST.paymentScheme = "INTERNAL_SETTLEMENT_TEST";
  await pool.query("UPDATE store_settings SET value=$1", [settings]);
  const { o } = await newOrder("BELPOST");
  const buyerView = await api(buyer, "GET", `/orders/${o.id}`);
  assert(!JSON.stringify(buyerView.body).includes("INTERNAL_CONTRACT_TEST"));
  assert(!JSON.stringify(buyerView.body).includes("INTERNAL_SETTLEMENT_TEST"));
  const staffView = await api(staff, "GET", `/orders/${o.id}`);
  assert.equal(
    staffView.body.ruleSnapshot.carriers.BELPOST.contract,
    "INTERNAL_CONTRACT_TEST",
  );
});
test("T32 ninety-day cleanup scrubs buyer and staff idempotent contacts, preserves outcome", async () => {
  const { o, itemIds } = await newOrder();
  const ready = await verified(o, itemIds);
  const own = (await api(buyer, "GET", `/orders/${o.id}`)).body;
  const h = await api(staff, "POST", `/staff/orders/${o.id}/handovers`, {
    version: ready.version,
    code: own.pickupCode,
  });
  const key = randomUUID();
  const complete = await api(
    staff,
    "POST",
    `/staff/handovers/${h.body.id}/complete`,
    { acceptedLineIds: own.lines.map((l: any) => l.id) },
    key,
  );
  assert.equal(complete.status, 200);
  await pool.query(
    "UPDATE orders SET completed_at=clock_timestamp()-interval '91 days' WHERE id=$1",
    [o.id],
  );
  await tick({ skipOutbox: true });
  const record = (
    await pool.query(
      "SELECT response,entity_id FROM idempotency_records WHERE actor_id=$1 AND key=$2",
      [staff.id, key],
    )
  ).rows[0];
  assert.equal(record.entity_id, o.id);
  const replay = decrypt<any>(record.response.encrypted);
  assert.equal(replay.id, o.id);
  assert.equal(replay.status, "FULFILLED");
  assert.equal(replay.recipient, undefined);
  assert(!JSON.stringify(replay).includes("375291234567"));
  assert.equal(
    (await pool.query("SELECT recipient_enc FROM orders WHERE id=$1", [o.id]))
      .rows[0].recipient_enc,
    null,
  );
});
test("T21 former staff cannot replay private customer command results as buyer", async () => {
  const { o } = await newOrder();
  const key = randomUUID(),
    body = { version: o.version };
  const cancelled = await api(
    staff,
    "POST",
    `/orders/${o.id}/cancel`,
    body,
    key,
  );
  assert.equal(cancelled.status, 200);
  staff.role = "BUYER";
  try {
    assert.equal((await api(staff, "GET", "/operations/" + key)).status, 403);
    assert.equal(
      (await api(staff, "POST", `/orders/${o.id}/cancel`, body, key)).status,
      403,
    );
  } finally {
    staff.role = "STAFF";
  }
});
test("T31 queued readiness invitation is skipped when expiry occurred during worker downtime", async () => {
  await pool.query(
    "UPDATE outbox_events SET state='SKIPPED' WHERE state IN ('PENDING','PROCESSING')",
  );
  const { o, itemIds } = await newOrder();
  await verified(o, itemIds);
  await pool.query(
    "UPDATE outbox_events SET state='SKIPPED' WHERE entity_id=$1 AND event_type<>'READY'",
    [o.id],
  );
  await pool.query(
    "UPDATE orders SET pickup_deadline=clock_timestamp()-interval '1 minute' WHERE id=$1",
    [o.id],
  );
  let invalidInvitation = false;
  await tick({
    deliver: async (_chat, message) => {
      if (message.includes("Можно забирать")) invalidInvitation = true;
      return { ok: true };
    },
  });
  assert.equal(invalidInvitation, false);
  assert.equal(
    (
      await pool.query(
        "SELECT state FROM outbox_events WHERE entity_id=$1 AND event_type='READY'",
        [o.id],
      )
    ).rows[0].state,
    "SKIPPED",
  );
});
test("T11 calendar closure extends CHECKING four/eight open-hour deadlines and prevents closed-day expiry", async () => {
  const { o } = await newOrder();
  const created = new Date("2026-11-02T08:00:00Z"),
    initialVerify = new Date("2026-11-02T12:00:00Z"),
    initialCancel = new Date("2026-11-02T16:00:00Z");
  await pool.query(
    "UPDATE orders SET created_at=$2,verify_by=$3,cancel_by=$4 WHERE id=$1",
    [o.id, created, initialVerify, initialCancel],
  );
  const changed: Calendar = {
    week: {
      "1": ["10:00", "20:00"],
      "2": ["10:00", "20:00"],
      "3": ["10:00", "20:00"],
      "4": ["10:00", "20:00"],
      "5": ["10:00", "20:00"],
      "6": ["10:00", "18:00"],
    },
    exceptions: { "2026-11-02": null, "2026-11-03": null },
  };
  await tx((c) => reflowCalendar(c, changed, 20));
  let row = (await pool.query("SELECT * FROM orders WHERE id=$1", [o.id]))
    .rows[0];
  assert.equal(row.verify_by.toISOString(), "2026-11-04T11:00:00.000Z");
  assert.equal(row.cancel_by.toISOString(), "2026-11-04T15:00:00.000Z");
  const expired = await tx(async (c) =>
    expireOrder(
      c,
      await lockedOrder(c, o.id),
      new Date("2026-11-03T17:00:00Z"),
    ),
  );
  assert.equal(expired, false);
  assert.equal(
    (await pool.query("SELECT status FROM orders WHERE id=$1", [o.id])).rows[0]
      .status,
    "CHECKING",
  );
  const verify = row.verify_by.getTime(),
    cancel = row.cancel_by.getTime();
  await tx((c) => reflowCalendar(c, calendar, 21));
  row = (await pool.query("SELECT * FROM orders WHERE id=$1", [o.id])).rows[0];
  assert.equal(row.verify_by.getTime(), verify);
  assert.equal(row.cancel_by.getTime(), cancel);
});
test("T11 mail dispatch reflow uses evidenced verification instant and only extends promises", async () => {
  for (const registered of [false, true]) {
    const { o, itemIds } = await newOrder("EUROPOST");
    let current = await verified(o, itemIds);
    let row = (
      await pool.query(
        "SELECT verified_at,dispatch_deadline,created_at FROM orders WHERE id=$1",
        [o.id],
      )
    ).rows[0];
    assert(row.verified_at instanceof Date);
    assert(row.verified_at >= row.created_at);
    const checkedAt = new Date("2026-11-07T12:00:00Z"),
      oldDeadline = new Date("2026-11-09T17:00:00Z");
    await pool.query(
      "UPDATE orders SET verified_at=$2,dispatch_deadline=$3 WHERE id=$1",
      [o.id, checkedAt, oldDeadline],
    );
    if (registered) {
      current = (
        await api(staff, "POST", "/staff/shipments", {
          orderId: o.id,
          version: current.version,
          tracking: "REFLOW-" + randomUUID(),
          source: "Тест кабинет",
        })
      ).body;
      assert.equal(current.status, "DISPATCH_READY");
    }
    const changed: Calendar = {
      week: {
        "1": ["10:00", "20:00"],
        "2": ["10:00", "20:00"],
        "3": ["10:00", "20:00"],
        "4": ["10:00", "20:00"],
        "5": ["10:00", "20:00"],
        "6": ["10:00", "18:00"],
      },
      exceptions: { "2026-11-09": null },
    };
    await tx((c) => reflowCalendar(c, changed, 30));
    row = (
      await pool.query(
        "SELECT verified_at,dispatch_deadline FROM orders WHERE id=$1",
        [o.id],
      )
    ).rows[0];
    assert.equal(row.verified_at.toISOString(), checkedAt.toISOString());
    assert.equal(
      row.dispatch_deadline.toISOString(),
      "2026-11-10T17:00:00.000Z",
    );
    const promised = row.dispatch_deadline.getTime();
    await tx((c) => reflowCalendar(c, { ...changed, exceptions: {} }, 31));
    row = (
      await pool.query("SELECT dispatch_deadline FROM orders WHERE id=$1", [
        o.id,
      ])
    ).rows[0];
    assert.equal(row.dispatch_deadline.getTime(), promised);
  }
});

test("T17 concurrent recipient edit versus preparation preserves exactly one versioned change", async () => {
  const { o, itemIds } = await newOrder("BELPOST");
  const checked = await api(staff, "POST", `/staff/orders/${o.id}/verify`, {
    version: o.version,
    foundItemIds: itemIds,
  });
  const version = checked.body.version;
  const results = await Promise.all([
    api(staff, "POST", `/staff/orders/${o.id}/ready`, { version }),
    api(buyer, "PATCH", `/orders/${o.id}/recipient`, {
      version,
      phone: "+375291234567",
      fullName: "Тест Изменённый",
      city: "Минск",
      office: "Отделение 2, тестовый адрес",
      postalCode: "220000",
    }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  const current = (await api(buyer, "GET", `/orders/${o.id}`)).body;
  assert.equal(current.version, version + 1);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM inventory_claim WHERE owner_id=$1",
        [o.id],
      )
    ).rows[0].n,
    1,
  );
  if (results[0].status === 200) assert.equal(current.status, "PREPARING");
  else assert.equal(current.recipient.office, "Отделение 2, тестовый адрес");
});
test("T18 concurrent cancellation versus carrier acceptance never releases dispatched stock", async () => {
  const { o, itemIds } = await newOrder("EUROPOST");
  let current = await verified(o, itemIds);
  current = (
    await api(staff, "POST", "/staff/shipments", {
      orderId: o.id,
      version: current.version,
      tracking: "RACE-" + randomUUID(),
      source: "Тест: создан ярлык",
    })
  ).body;
  const results = await Promise.all([
    api(buyer, "POST", `/orders/${o.id}/cancel`, { version: current.version }),
    api(staff, "POST", `/staff/shipments/${current.shipment.id}/acceptance`, {
      version: current.version,
      source: "Тест: квитанция фактической приёмки",
    }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  const updated = (await api(buyer, "GET", `/orders/${o.id}`)).body;
  const physical = (
    await pool.query("SELECT physical FROM items WHERE id=$1", [itemIds[0]])
  ).rows[0].physical;
  assert.notEqual(physical, "AVAILABLE");
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM inventory_claim WHERE item_id=$1",
        [itemIds[0]],
      )
    ).rows[0].n,
    1,
  );
  if (results[0].status === 200) {
    assert.ok(updated.cancelRequested);
    assert.equal(updated.shipment.status, "REGISTERED");
  } else {
    assert.equal(updated.status, "IN_FULFILLMENT");
    assert.equal(physical, "WITH_CARRIER");
  }
});
