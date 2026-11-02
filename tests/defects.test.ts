import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { buildApp } from "../server/app.js";
import { migrate } from "../server/migrate.js";
import { pool, tx } from "../server/db.js";
import { itemSnapshot } from "../server/inventory.js";

let app: Awaited<ReturnType<typeof buildApp>>, cookie: string;
const data = { title: "Дефектная тестовая вещь", category: "accessories", priceMinor: 1000 };
before(async () => {
  assert.match(process.env.DATABASE_URL ?? "", /_test$/);
  await migrate(); app = await buildApp({ staticFiles: false });
  const r = await app.inject({ method: "POST", url: "/api/auth/dev", payload: { role: "STAFF" } });
  cookie = String(r.headers["set-cookie"]).split(";")[0];
});
after(async () => { await app.close(); await pool.end(); });
const send = (method: "POST" | "PATCH", url: string, payload: Record<string, unknown>) => app.inject({ method, url: "/api" + url, payload, headers: { cookie, "idempotency-key": randomUUID() } });

test("ordinary items default to no defect; active defects require meaningful description", async () => {
  const ordinary = await send("POST", "/staff/items", data);
  assert.equal(ordinary.statusCode, 200, ordinary.body);
  assert.equal(ordinary.json().hasDefect, false);
  assert.equal(ordinary.json().defectDescription, "");
  for (const defectDescription of ["", "  \n "]) {
    const bad = await send("POST", "/staff/items", { ...data, hasDefect: true, defectDescription });
    assert.equal(bad.statusCode, 422, bad.body);
  }
});

test("defect persists through API, snapshot is immutable, switching off clears description", async () => {
  const r = await send("POST", "/staff/items", { ...data, hasDefect: true, defectDescription: "  Небольшая затяжка на рукаве  " });
  assert.equal(r.statusCode, 200, r.body);
  const i = r.json();
  assert.equal(i.defectDescription, "Небольшая затяжка на рукаве");
  assert.equal((await app.inject("/api/items/" + i.id)).json().hasDefect, true);
  const snapshot = await tx(async c => itemSnapshot(c, (await c.query("SELECT * FROM items WHERE id=$1", [i.id])).rows[0]));
  assert.equal(snapshot.hasDefect, true);
  const edited = await send("PATCH", "/staff/items/" + i.id, { ...data, version: i.version, hasDefect: false, defectDescription: "Старый текст" });
  assert.equal(edited.statusCode, 200, edited.body);
  assert.equal(edited.json().defectDescription, "");
  assert.equal((await app.inject("/api/items/" + i.id)).json().defectDescription, "");
  assert.equal(snapshot.defectDescription, "Небольшая затяжка на рукаве");
  assert.equal((await pool.query("SELECT defect_description FROM items WHERE id=$1", [i.id])).rows[0].defect_description, "");
});
