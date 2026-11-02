import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { pool } from "../server/db.js";
import { migrate } from "../server/migrate.js";
import { buildApp } from "../server/app.js";
import { createLease, confirmOrder } from "../server/orders.js";
import { tick } from "../server/jobs.js";
import { digest } from "../server/crypto.js";
import type { Actor } from "../server/types.js";
// Opt-in only: this test controls a dedicated local PostgreSQL cluster, never a live or shared service.
test(
  "T33 PostgreSQL restart on the same disk preserves order, claim, outbox and idempotent result",
  { skip: process.env.RUN_DB_RESTART_TEST !== "1" },
  async () => {
    assert.match(process.env.DATABASE_URL ?? "", /_test$/);
    assert.ok(process.env.PG_TEST_DATA);
    assert.ok(process.env.PG_TEST_CTL);
    await migrate();
    const actor: Actor = {
      id: randomUUID(),
      telegramId: "991123450",
      role: "BUYER",
    };
    await pool.query("INSERT INTO users(id,telegram_id) VALUES($1,$2)", [
      actor.id,
      actor.telegramId,
    ]);
    await pool.query(
      "UPDATE store_settings SET value=jsonb_set(value,'{acceptingOrders}','true') WHERE id=true",
    );
    const itemId = randomUUID();
    await pool.query(
      "INSERT INTO items(id,sku,title,category,price_minor,publication,physical) VALUES($1,$2,'Тест перезапуска','tops',2500,'PUBLISHED','AVAILABLE')",
      [itemId, "RESTART-" + itemId],
    );
    const lease = await createLease(actor, randomUUID(), { itemIds: [itemId] });
    const operation = randomUUID();
    const body = {
      leaseId: lease.id,
      method: "PICKUP",
      phone: "+375291234567",
      termsAccepted: true,
    };
    const order = await confirmOrder(actor, operation, body);
    const token = randomUUID();
    await pool.query(
      "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",
      [digest(token), actor.id],
    );
    const app = await buildApp({ staticFiles: false });
    const cookie = "session=" + token;
    const env = {
      ...process.env,
      LD_PRELOAD: process.env.PG_TEST_LD_PRELOAD ?? "",
    };
    try {
      execFileSync(
        process.env.PG_TEST_CTL!,
        ["-D", process.env.PG_TEST_DATA!, "stop", "-m", "fast"],
        { env, stdio: "pipe" },
      );
      const offline = await app.inject({
        url: "/api/orders/" + order.id,
        headers: { cookie },
      });
      assert.equal(offline.statusCode, 503, offline.body);
      assert.equal((await app.inject("/health/ready")).statusCode, 503);
      execFileSync(
        process.env.PG_TEST_CTL!,
        [
          "-D",
          process.env.PG_TEST_DATA!,
          "-l",
          process.env.PG_TEST_DATA! + "/restart.log",
          "-o",
          process.env.PG_TEST_SERVER_OPTIONS ?? "",
          "start",
        ],
        { env, stdio: "pipe" },
      );
      const recovered = await app.inject({
        url: "/api/operations/" + operation,
        headers: { cookie },
      });
      assert.equal(recovered.statusCode, 200, recovered.body);
      assert.equal(recovered.json().id, order.id);
      const repeated = await confirmOrder(actor, operation, body);
      assert.equal(repeated.id, order.id);
      assert.equal(
        (
          await pool.query(
            "SELECT owner_id FROM inventory_claim WHERE item_id=$1",
            [itemId],
          )
        ).rows[0].owner_id,
        order.id,
      );
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int n FROM outbox_events WHERE entity_id=$1",
            [order.id],
          )
        ).rows[0].n,
        1,
      );
      await tick({ skipOutbox: true });
      assert.equal((await app.inject("/health/ready")).statusCode, 200);
    } finally {
      await app.close();
      await pool.end();
    }
  },
);
