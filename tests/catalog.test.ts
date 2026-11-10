import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { buildApp } from "../server/app.js";
import { readItems } from "../server/catalog.js";
import { pool } from "../server/db.js";
import { migrate } from "../server/migrate.js";

let app: Awaited<ReturnType<typeof buildApp>>, cookie: string;
const marker = randomUUID(), itemIds = Array.from({ length: 42 }, () => randomUUID());
const mediaIds = Array.from({ length: 4 }, () => randomUUID());
before(async () => {
  assert.match(process.env.DATABASE_URL ?? "", /_test$/);
  await migrate();
  app = await buildApp({ staticFiles: false });
  const login = await app.inject({ method: "POST", url: "/api/auth/dev", payload: { role: "STAFF" } });
  assert.equal(login.statusCode, 200, login.body);
  cookie = String(login.headers["set-cookie"]).split(";")[0];
  await pool.query(
    `INSERT INTO items(id,sku,title,category,price_minor,publication,physical,has_defect,defect_description,storage_location,created_at)
     SELECT id, $2||n, $2||n, 'accessories', n*100, CASE WHEN n=42 THEN 'HIDDEN' ELSE 'PUBLISHED' END,
       'AVAILABLE', n=1, CASE WHEN n=1 THEN 'Затяжка' ELSE '' END, 'Полка', now()+n*interval '1 second'
     FROM unnest($1::uuid[]) WITH ORDINALITY AS t(id,n)`,
    [itemIds, marker],
  );
  // Insert out of display order; equal positions must retain created_at ordering.
  for (const [i, position, created, state, variants] of [
    [0, 2, 1, "READY", { "480": "/last.webp", "240": "/small.webp" }],
    [1, 1, 2, "READY", { "240": "/fallback.webp" }],
    [2, 1, 1, "READY", { "480": "/first.webp" }],
    [3, 0, 0, "DELETED", { "480": "/excluded.webp" }],
  ] as const) {
    await pool.query(
      `INSERT INTO media_assets(id,item_id,original_key,checksum,mime,width,height,variants,role,position,state,created_at)
       VALUES($1,$2,'test','test','image/webp',480,640,$3,'FRONT',$4,$5,'2026-01-01'::timestamptz+$6*interval '1 second')`,
      [mediaIds[i], itemIds[0], variants, position, state, created],
    );
  }
  // Another item's photo must never leak into this item's media array.
  await pool.query(
    "INSERT INTO media_assets(item_id,original_key,checksum,mime,width,height,variants) VALUES($1,'other','test','image/webp',240,320,'{}')",
    [itemIds[1]],
  );
});
after(async () => {
  await pool.query("DELETE FROM media_assets WHERE item_id=ANY($1::uuid[])", [itemIds]);
  await pool.query("DELETE FROM items WHERE id=ANY($1::uuid[])", [itemIds]);
  await app.close();
  await pool.end();
});

test("readItems batches real SQL, preserves response/media/order and reads current availability", async (t) => {
  const spy = t.mock.method(pool, "query"); // Calls the real PostgreSQL driver.
  const requested = [itemIds[2], itemIds[0], randomUUID(), itemIds[0]];
  const items = await readItems(requested);
  assert.equal(spy.mock.callCount(), 2);
  assert.deepEqual(items.map(i => i!.id), [itemIds[2], itemIds[0], itemIds[0]]);
  assert.deepEqual(items[0]!.media, []);
  assert.deepEqual(JSON.parse(JSON.stringify(items[1])), {
    id: itemIds[0], sku: marker + "1", title: marker + "1", category: "accessories",
    priceMinor: 100, publication: "PUBLISHED", version: 1, hasDefect: true,
    defectDescription: "Затяжка", attributes: {}, measurements: {}, available: true,
    media: [
      { id: mediaIds[2], width: 480, height: 640, variants: { "480": "/first.webp" }, role: "FRONT", position: 1, url: "/first.webp" },
      { id: mediaIds[1], width: 480, height: 640, variants: { "240": "/fallback.webp" }, role: "FRONT", position: 1, url: "/fallback.webp" },
      { id: mediaIds[0], width: 480, height: 640, variants: { "480": "/last.webp", "240": "/small.webp" }, role: "FRONT", position: 2, url: "/last.webp" },
    ],
  });
  spy.mock.resetCalls();
  assert.deepEqual(await readItems([]), []);
  assert.equal(spy.mock.callCount(), 0);
  assert.deepEqual(await readItems([randomUUID()]), []);
  assert.equal(spy.mock.callCount(), 1);
  await pool.query("UPDATE items SET physical='INSPECTION' WHERE id=$1", [itemIds[0]]);
  assert.equal((await readItems([itemIds[0]]))[0]!.available, false);
  await pool.query("UPDATE items SET physical='AVAILABLE' WHERE id=$1", [itemIds[0]]);
});

test("catalog pagination/filters and staff visibility use one item and one media query", async (t) => {
  const spy = t.mock.method(pool, "query");
  async function list(url: string, staff = false) {
    spy.mock.resetCalls();
    const response = await app.inject({ url, headers: staff ? { cookie } : {} });
    assert.equal(response.statusCode, 200, response.body);
    const queries = spy.mock.calls.map(call => String(call.arguments[0]));
    assert.equal(queries.filter(sql => /FROM items i\b/.test(sql)).length, 1);
    assert.equal(queries.filter(sql => /FROM media_assets\b/.test(sql)).length, 1);
    return response.json();
  }
  const page = await list(`/api/catalog?q=${marker}&sort=price_asc`);
  assert.deepEqual(page.items.map((i: any) => i.id), itemIds.slice(0, 40));
  assert.equal(page.nextCursor, Buffer.from("40").toString("base64url"));
  assert.equal(page.items[0].hasDefect, true);
  assert.deepEqual(page.items[0].media.map((m: any) => m.id), [mediaIds[2], mediaIds[1], mediaIds[0]]);
  assert.equal(page.items[0].physical, undefined);
  assert.equal(page.items[0].storageLocation, undefined);
  const next = await list(`/api/catalog?q=${marker}&sort=price_asc&cursor=${page.nextCursor}`);
  assert.deepEqual(next.items.map((i: any) => i.id), [itemIds[40]]);
  assert.equal(next.nextCursor, null);
  const filtered = await list(`/api/catalog?q=${marker}&category=accessories&minPrice=200&maxPrice=300&sort=price_desc`);
  assert.deepEqual(filtered.items.map((i: any) => i.id), [itemIds[2], itemIds[1]]);
  const staff = await list(`/api/staff/items?q=${marker}`, true);
  assert.deepEqual(staff.items.map((i: any) => i.id), [...itemIds].reverse());
  assert.equal(staff.items[0].publication, "HIDDEN");
  assert.equal(staff.items[0].available, false);
  assert.equal(staff.items[0].physical, "AVAILABLE");
  assert.equal(staff.items[0].storageLocation, "Полка");
  const last = staff.items.at(-1);
  assert.deepEqual(last, { ...page.items[0], physical: "AVAILABLE", storageLocation: "Полка" });
  const hidden = await list(`/api/staff/items?q=${marker}&state=HIDDEN`, true);
  assert.deepEqual(hidden.items.map((i: any) => i.id), [itemIds[41]]);
  await pool.query("UPDATE items SET attributes=$2 WHERE id=$1", [
    itemIds[0], { sizeSystem: "INT", sizeLabel: "XL" },
  ]);
  const sized = await list(`/api/catalog?q=${marker}&sizeLabel=xl`);
  assert.deepEqual(sized.items.map((i: any) => i.id), [itemIds[0]]);
  await pool.query("UPDATE items SET attributes=$2 WHERE id=$1", [
    itemIds[1], { brand: marker, material: "Хлопок", sizeSystem: "INT", sizeLabel: "M" },
  ]);
  await pool.query("UPDATE items SET attributes=$2 WHERE id=$1", [
    itemIds[41], { brand: marker + "-hidden" },
  ]);
  const multiple = await list(`/api/catalog?q=${marker}&sizeLabel=xl&sizeLabel=m&sort=price_asc`);
  assert.deepEqual(multiple.items.map((i: any) => i.id), itemIds.slice(0, 2));
  const intersected = await list(`/api/catalog?q=${marker}&sizeLabel=XL&sizeLabel=M&brand=${marker}`);
  assert.deepEqual(intersected.items.map((i: any) => i.id), [itemIds[1]]);
  const options = await app.inject("/api/catalog/options");
  assert.equal(options.statusCode, 200, options.body);
  assert.ok(options.json().brand.includes(marker));
  assert.ok(!options.json().brand.includes(marker + "-hidden"));
});
