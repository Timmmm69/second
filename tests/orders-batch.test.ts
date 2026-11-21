import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import Fastify from "fastify";
import { pool, tx } from "../server/db.js";
import { migrate } from "../server/migrate.js";
import { encrypt } from "../server/crypto.js";
import { readOrder, readOrders, expireOrder, registerOrders } from "../server/orders.js";
import type { Actor } from "../server/types.js";

if (!process.env.DATABASE_URL?.match(/\/[^/]*_test(?:\?|$)/))
  throw new Error("Order batch benchmark requires an isolated *_test database");

const app = Fastify();
const buyer: Actor = { id: randomUUID(), telegramId: "982000001", role: "BUYER" };
const staff: Actor = { id: randomUUID(), telegramId: "982000002", role: "STAFF" };
const other: Actor = { id: randomUUID(), telegramId: "982000003", role: "BUYER" };
const ids: string[] = [];
let itemIndex = 0;
app.addHook("preHandler", (req, _reply, done) => {
  req.actor = req.headers["x-test-actor"] === "staff" ? staff :
    req.headers["x-test-actor"] === "other" ? other : buyer;
  done();
});
app.setErrorHandler((error: any, _req, reply) => reply.code(error.status ?? 500).send({ code: error.code ?? "TEST_ERROR" }));

function currentActor(req: { actor?: Actor | null }) { return req.actor!; }
const listRows = (c: any, userId: string) =>
  c.query("SELECT * FROM orders WHERE user_id=$1 ORDER BY created_at DESC LIMIT 200 FOR UPDATE", [userId]);
const queueRows = (c: any) => c.query(
  "SELECT * FROM orders WHERE status IN ('CHECKING','AWAITING_CUSTOMER') ORDER BY COALESCE(pickup_deadline,dispatch_deadline,verify_by),id LIMIT 200 FOR UPDATE",
);

async function seed(n: number) {
  while (ids.length < n) {
    itemIndex++;
    const itemId = randomUUID();
    await pool.query(
      "INSERT INTO items(id,sku,title,category,price_minor,publication,physical,storage_location) VALUES($1,$2,$3,'tops',1000,'PUBLISHED','AVAILABLE','Shelf A')",
      [itemId, "BATCH-" + itemId, "Fixture " + itemIndex],
    );
    const id = randomUUID();
    const method = itemIndex % 3 === 0 ? "EUROPOST" : "PICKUP";
    await pool.query(
      "INSERT INTO orders(id,user_id,method,status,total_minor,rule_snapshot,verify_by,cancel_by,created_at,recipient_enc,buyer_snapshot_enc) VALUES($1,$2,$3,'CHECKING',1000,$4,now()+interval '7 days',now()+interval '7 days',clock_timestamp()+$5*interval '1 second',$6,$7)",
      [id, buyer.id, method,
        { carriers: { EUROPOST: { enabled: true, terms: "Public terms", contract: "Private contract" } } },
        itemIndex,
        encrypt({ phone: "+375291234567", fullName: "Fixture" }),
        encrypt({ displayName: "Original buyer" })],
    );
    await pool.query("INSERT INTO reservations(order_id,user_id,status) VALUES($1,$2,'VERIFYING')", [id, buyer.id]);
    await pool.query(
      "INSERT INTO order_lines(order_id,item_id,snapshot,price_minor) VALUES($1,$2,$3,1000)",
      [id, itemId, { id: itemId, title: "Fixture", media: [{ url: "/media/fixture/480" }], attributes: {} }],
    );
    if (itemIndex === 1) {
      await pool.query(
        "INSERT INTO contact_notes(order_id,actor_id,note_enc) VALUES($1,$2,$3)",
        [id, staff.id, encrypt("Private employee note")],
      );
      await pool.query("INSERT INTO return_cases(order_id,reason,status) VALUES($1,'Fixture','CLOSED')", [id]);
      await pool.query("INSERT INTO handovers(order_id,actor_id,state) VALUES($1,$2,'STARTED')", [id, staff.id]);
      await pool.query(
        "INSERT INTO shipments(order_id,carrier,tracking,status,version,source) VALUES($1,'EUROPOST',$2,'REGISTERED',1,'MANUAL')",
        [id, "BENCH-" + id],
      );
      await pool.query("INSERT INTO operation_issues(entity_id,item_id,order_id,kind,message) VALUES($1,$2,$3,'TEST_ISSUE','Fixture issue')", [id,itemId,id]);
    }
    ids.push(id);
  }
}

async function measure(url: string) {
  let queries = 0;
  const connect = pool.connect;
  const originalConnect = pool.connect.bind(pool);
  pool.connect = (async () => {
    const c = await originalConnect();
    const mutable = c as any;
    const query = mutable.query;
    const release = mutable.release;
    mutable.query = function (...args: any[]) {
      queries++;
      return query.apply(c, args);
    };
    mutable.release = function (...args: any[]) {
      mutable.query = query;
      mutable.release = release;
      return release.apply(c, args);
    };
    return c;
  }) as typeof pool.connect;
  try {
    const start = performance.now();
    const result = await app.inject({ url, headers: { "x-test-actor": url.includes("/staff/") ? "staff" : "buyer" } });
    const millis = performance.now() - start;
    assert.equal(result.statusCode, 200, result.body);
    return { data: result.json(), queries, millis: +millis.toFixed(3) };
  } finally {
    pool.connect = connect;
  }
}

before(async () => {
  await migrate();
  // All fixtures are confined to the dedicated test database, never production.
  await pool.query("TRUNCATE users,items RESTART IDENTITY CASCADE");
  for (const actor of [buyer, staff, other])
    await pool.query(
      "INSERT INTO users(id,telegram_id,role,display_name,username) VALUES($1,$2,$3,$4,$5)",
      [actor.id, actor.telegramId, actor.role, actor === buyer ? "Current buyer" : "Fixture user", "fixture"],
    );
  await registerOrders(app);
  app.get("/baseline/me/orders", async (r) => tx(async c => {
    const { rows } = await listRows(c, currentActor(r).id);
    const orders = [];
    for (const o of rows) {
      await expireOrder(c, o);
      orders.push(await readOrder(c, o.id, currentActor(r)));
    }
    return { orders };
  }));
  app.get("/baseline/staff/queue", async (r) => tx(async c => {
    const { rows } = await queueRows(c);
    const orders = [];
    for (const o of rows) {
      await expireOrder(c, o);
      orders.push(await readOrder(c, o.id, currentActor(r)));
    }
    const issues = (await c.query(
      'SELECT id,entity_id AS "entityId",item_id AS "itemId",order_id AS "orderId",kind,message,assigned_to AS "assignedTo",created_at AS "createdAt" FROM operation_issues WHERE state=\'OPEN\' ORDER BY created_at LIMIT 200',
    )).rows;
    return { orders, issues };
  }));
  await app.ready();
});
after(async () => {
  await app.close();
  await pool.end();
});

test("buyer/staff lists: baseline and batched responses equivalent for 1, 10, 50, 100 orders", { timeout: 180000 }, async () => {
  for (const n of [1, 10, 50, 100]) {
    await seed(n);
    for (const [kind, oldUrl, newUrl] of [
      ["buyer", "/baseline/me/orders", "/me/orders"],
      ["staff", "/baseline/staff/queue", "/staff/queue?filter=checking"],
    ] as const) {
      const beforeAudit = kind === "staff" ? Number((await pool.query(
        "SELECT count(*)::int AS n FROM access_events WHERE actor_id=$1 AND action='order.read'", [staff.id],
      )).rows[0].n) : 0;
      const baseline = await measure(oldUrl);
      const batched = await measure(newUrl);
      assert.deepEqual(batched.data, baseline.data, "API contract/order order must match for " + kind + " n=" + n);
      assert.equal(batched.data.orders.length, n);
      if (kind === "staff") {
        const afterAudit = Number((await pool.query(
          "SELECT count(*)::int AS n FROM access_events WHERE actor_id=$1 AND action='order.read'", [staff.id],
        )).rows[0].n);
        assert.equal(afterAudit - beforeAudit, n * 2, "one audit event per viewed order on each path");
      }
      if (n > 1) assert.ok(batched.queries < baseline.queries);
      console.log(JSON.stringify({
        metric: "orders-list", kind, orders: n,
        beforeSql: baseline.queries, afterSql: batched.queries,
        beforeMs: baseline.millis, afterMs: batched.millis,
        includesBeginCommit: true, singleRun: true,
      }));
      if (n === 1 && kind === "buyer") {
        assert.equal(batched.data.orders[0].buyer, undefined);
        assert.equal(batched.data.orders[0].notes, undefined);
        assert.equal(batched.data.orders[0].handover, undefined);
        assert.equal(batched.data.orders[0].ruleSnapshot.carriers.EUROPOST.contract, undefined);
        assert.equal(batched.data.orders[0].lines[0].storageLocation, undefined);
      }
      if (n === 1 && kind === "staff") {
        assert.equal(batched.data.orders[0].buyer.telegramId, buyer.telegramId);
        assert.equal(batched.data.orders[0].buyer.atCheckout.displayName, "Original buyer");
        assert.equal(batched.data.orders[0].notes[0].note, "Private employee note");
        assert.ok(batched.data.orders[0].handover?.id);
        assert.equal(batched.data.orders[0].shipment?.tracking, "BENCH-" + ids[0]);
        assert.equal(batched.data.orders[0].returnCases[0].decision, "Решение принято; подробности сообщит магазин");
      }
    }
  }
});

test("batch read denies other buyers before leaking relationships", async () => {
  const beforeAudit = Number((await pool.query("SELECT count(*)::int AS n FROM access_events")).rows[0].n);
  await assert.rejects(tx(c => readOrders(c, [ids[0]], other)), (e: any) => e.code === "FORBIDDEN");
  const hidden = await app.inject({ url: "/me/orders", headers: { "x-test-actor": "other" } });
  assert.equal(hidden.statusCode, 200);
  assert.deepEqual(hidden.json().orders, []);
  assert.equal(Number((await pool.query("SELECT count(*)::int AS n FROM access_events")).rows[0].n), beforeAudit);
});

test("problems filter returns flagged orders alongside open issues", async () => {
  await seed(2);
  const flaggedOrderId = ids[1];
  await pool.query("UPDATE orders SET exception=true WHERE id=$1", [flaggedOrderId]);

  const { data } = await measure("/staff/queue?filter=problems");
  const order = await tx(c => readOrder(c, flaggedOrderId, staff));
  assert.deepEqual(data.orders, JSON.parse(JSON.stringify([order])));
  assert.deepEqual(data.issues.map((issue: { orderId: string }) => issue.orderId), [ids[0]]);
});

test("expired orders still use existing expiry transitions and protection", async () => {
  const id = ids[0];
  const itemId = (await pool.query("SELECT item_id FROM order_lines WHERE order_id=$1", [id])).rows[0].item_id;
  await pool.query(
    "UPDATE orders SET cancel_by=clock_timestamp()-interval '1 minute' WHERE id=$1",
    [id],
  );
  const view = await app.inject({ url: "/me/orders", headers: { "x-test-actor": "buyer" } });
  assert.equal(view.statusCode, 200, view.body);
  assert.equal(view.json().orders.find((o: any) => o.id === id).status, "EXPIRED");
  assert.equal((await pool.query("SELECT physical FROM items WHERE id=$1", [itemId])).rows[0].physical, "INSPECTION");
  assert.equal((await pool.query("SELECT outcome FROM order_lines WHERE order_id=$1", [id])).rows[0].outcome, "EXPIRED");
  assert.equal((await pool.query("SELECT status FROM reservations WHERE order_id=$1", [id])).rows[0].status, "EXPIRED");
  assert.equal(Number((await pool.query("SELECT count(*)::int AS n FROM audit_events WHERE entity_id=$1 AND command='orders.expire'", [id])).rows[0].n), 1);
});
