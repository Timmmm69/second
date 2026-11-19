import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { buildApp } from "../server/app.js";
import { pool, tx } from "../server/db.js";
import { backfillLegacyCompositions, parseLegacyComposition } from "../server/materials.js";
import { migrate } from "../server/migrate.js";

let app: Awaited<ReturnType<typeof buildApp>>;
let cookie = "";
const created: string[] = [];
const legacy: string[] = [];
let customId = "";

before(async () => {
  assert.match(process.env.DATABASE_URL ?? "", /_test$/);
  await migrate();
  app = await buildApp({ staticFiles: false });
  const login = await app.inject({ method: "POST", url: "/api/auth/dev", payload: { role: "STAFF" } });
  assert.equal(login.statusCode, 200, login.body);
  cookie = String(login.headers["set-cookie"]).split(";")[0];
});
after(async () => {
  if (created.length || legacy.length)
    await pool.query("DELETE FROM items WHERE id=ANY($1::uuid[])", [[...created, ...legacy]]);
  if (customId) await pool.query("DELETE FROM material_types WHERE id=$1", [customId]);
  await app.close();
  await pool.end();
});

async function send(method: "GET" | "POST" | "PATCH", url: string, payload?: unknown, authorized = true) {
  return app.inject({
    method, url, payload: payload as Record<string, unknown> | undefined,
    headers: {
      ...(authorized ? { cookie } : {}),
      ...(method !== "GET" ? { "idempotency-key": randomUUID() } : {}),
    },
  });
}

test("material dictionary uses aliases, prevents duplicates and protects writes", async () => {
  assert.equal((await send("GET", "/api/staff/materials", undefined, false)).statusCode, 401);
  const list = await send("GET", "/api/staff/materials");
  assert.equal(list.statusCode, 200, list.body);
  const all = list.json();
  assert.ok(all.some((material: any) => material.name === "Полиэстер"));
  assert.ok(all.some((material: any) => material.name === "Эластан"));
  const alias = await send("POST", "/api/staff/materials", { name: " ЛАЙКРА " });
  assert.equal(alias.statusCode, 200, alias.body);
  assert.equal(alias.json().name, "Эластан");
  const newName = "Бамбуковое волокно " + randomUUID().slice(0, 8);
  const added = await send("POST", "/api/staff/materials", { name: newName });
  assert.equal(added.statusCode, 200, added.body);
  customId = added.json().id;
  const same = await send("POST", "/api/staff/materials", { name: newName.toUpperCase() });
  assert.equal(same.statusCode, 200, same.body);
  assert.equal(same.json().id, customId);
  assert.equal((await send("POST", "/api/staff/materials", { name: "" })).statusCode, 422);
});

test("indexed catalog filters match a component, threshold, and OR alternatives", async () => {
  const defs = (await send("GET", "/api/staff/materials")).json();
  const id = (name: string) => defs.find((material: any) => material.name === name).id;
  const polyester = id("Полиэстер"), elastane = id("Эластан");
  const cotton = id("Хлопок"), wool = id("Шерсть");
  const title = "Состав-материалы-" + randomUUID().slice(0, 8);
  async function add(composition: { materialId: string; percent: number | null }[]) {
    const response = await send("POST", "/api/staff/items", {
      title, category: "accessories", priceMinor: 1000, attributes: { material: "оригинальная запись" }, composition,
    });
    assert.equal(response.statusCode, 200, response.body);
    const item = response.json();
    created.push(item.id);
    await pool.query("UPDATE items SET publication='PUBLISHED',physical='AVAILABLE' WHERE id=$1", [item.id]);
    return item;
  }
  const mixed = await add([{ materialId: polyester, percent: 92 }, { materialId: elastane, percent: 8 }]);
  assert.equal(mixed.attributes.material, "92% полиэстер, 8% эластан");
  assert.equal(mixed.composition[0].name, "Полиэстер");
  const pure = await add([{ materialId: cotton, percent: 100 }]);
  const unknown = await add([{ materialId: wool, percent: null }]);
  assert.equal(unknown.composition[0].percent, null);

  async function search(params: [string, string][]) {
    const query = new URLSearchParams([["q", title], ...params]);
    const response = await send("GET", "/api/catalog?" + query);
    assert.equal(response.statusCode, 200, response.body);
    return response.json().items.map((item: any) => item.id);
  }
  assert.deepEqual(await search([["material", polyester], ["minPercent", "90"]]), [mixed.id]);
  assert.deepEqual(await search([["material", polyester], ["minPercent", "93"]]), []);
  assert.deepEqual(await search([["material", cotton], ["minPercent", "100"]]), [pure.id]);
  assert.deepEqual(await search([["material", wool]]), [unknown.id]);
  assert.deepEqual(await search([["material", wool], ["minPercent", "1"]]), []);
  assert.deepEqual(await search([["material", polyester], ["material", cotton], ["minPercent", "90"]]),
    [pure.id, mixed.id].sort((a, b) => created.indexOf(b) - created.indexOf(a)));

  const facet = await send("GET", "/api/catalog/options");
  assert.equal(facet.statusCode, 200, facet.body);
  assert.ok(facet.json().materials.some((m: any) => m.id === polyester));
  assert.ok(facet.json().materials.some((m: any) => m.id === cotton));
  const index = await pool.query("SELECT indexdef FROM pg_indexes WHERE indexname='items_composition_gin'");
  assert.match(index.rows[0].indexdef, /jsonb_path_ops/);
});

test("invalid composition is rejected without writing an item", async () => {
  const defs = (await send("GET", "/api/staff/materials")).json();
  const cotton = defs.find((m: any) => m.name === "Хлопок").id;
  const polyester = defs.find((m: any) => m.name === "Полиэстер").id;
  const make = (composition: unknown) => send("POST", "/api/staff/items", {
    title: "Проверка процентов", category: "accessories", priceMinor: 500, composition,
  });
  for (const composition of [
    [{ materialId: cotton, percent: 70 }, { materialId: polyester, percent: 40 }],
    [{ materialId: cotton, percent: 90 }, { materialId: cotton, percent: 10 }],
    [{ materialId: randomUUID(), percent: 80 }],
    [{ materialId: cotton, percent: 0 }],
    [{ materialId: cotton, percent: 100 }, { materialId: polyester, percent: null }],
  ]) {
    const response = await make(composition);
    assert.equal(response.statusCode, 422, response.body);
  }
  const uppercase = await make([{ materialId: cotton.toUpperCase(), percent: 100 }]);
  assert.equal(uppercase.statusCode, 200, uppercase.body);
  assert.equal(uppercase.json().composition[0].materialId, cotton);
  created.push(uppercase.json().id);
  const duplicateCase = await make([
    { materialId: cotton, percent: 50 },
    { materialId: cotton.toUpperCase(), percent: 50 },
  ]);
  assert.equal(duplicateCase.statusCode, 422, duplicateCase.body);
  const badPercent = await send("GET", "/api/catalog?material=" + cotton + "&minPercent=101");
  assert.equal(badPercent.statusCode, 422);
});

test("conservative legacy backfill keeps unknown strings intact and remains idempotent", async () => {
  const defs = (await send("GET", "/api/staff/materials")).json();
  assert.equal(parseLegacyComposition("92% полиэстер, 8% эластан", defs)?.length, 2);
  assert.equal(parseLegacyComposition("92% полиэстер, 12% эластан", defs), null);
  assert.equal(parseLegacyComposition("какой-то неизвестный материал", defs), null);
  const legacyId = randomUUID(), ambiguousId = randomUUID();
  legacy.push(legacyId, ambiguousId);
  await pool.query(
    `INSERT INTO items(id,sku,title,category,price_minor,attributes)
     VALUES($1,$2,'Старая бирка','accessories',1000,$3),
           ($4,$5,'Неизвестная бирка','accessories',1000,$6)`,
    [legacyId, randomUUID(), {material:"92% полиэстер, 8% эластан"},
      ambiguousId, randomUUID(), {material:"Альпака + смесь неизвестна"}],
  );
  await tx(backfillLegacyCompositions);
  await tx(backfillLegacyCompositions);
  const { rows } = await pool.query("SELECT id,composition,attributes->>'material' AS raw FROM items WHERE id=ANY($1::uuid[]) ORDER BY id", [legacy]);
  const known = rows.find(row => row.id === legacyId);
  const unknown = rows.find(row => row.id === ambiguousId);
  assert.equal(known.composition.length, 2);
  assert.equal(known.raw, "92% полиэстер, 8% эластан");
  assert.deepEqual(unknown.composition, []);
  assert.equal(unknown.raw, "Альпака + смесь неизвестна");
});
