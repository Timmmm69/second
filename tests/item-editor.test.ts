import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { buildApp } from "../server/app.js";
import { config } from "../server/config.js";
import { pool } from "../server/db.js";
import { migrate } from "../server/migrate.js";

let app: Awaited<ReturnType<typeof buildApp>>, staff: string, buyer: string;
const inserted = new Set<string>();
const keys = () => ({ cookie: staff, "idempotency-key": randomUUID() });
const send = async (method: "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload: Record<string, unknown> = {}) =>
  await app.inject({ method, url: "/api" + url, headers: keys(), payload });
const createDraft = async (payload: Record<string, unknown> = {}) => {
  const response = await send("POST", "/staff/items/draft", payload);
  assert.equal(response.statusCode, 200, response.body);
  const item = response.json();
  inserted.add(item.id);
  return item;
};
const upload = async (id: string, buffer: Buffer, mime = "image/jpeg") => {
  const boundary = "image" + randomUUID();
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="itemId"\r\n\r\n${id}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="test.jpg"\r\nContent-Type: ${mime}\r\n\r\n`),
    buffer,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return app.inject({ method: "POST", url: "/api/staff/media/uploads",
    headers: { ...keys(), "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: body,
  });
};

before(async () => {
  assert.match(process.env.DATABASE_URL ?? "", /_test$/);
  await migrate();
  app = await buildApp({ staticFiles: false });
  const auth = async (role: "STAFF" | "BUYER") => {
    const response = await app.inject({ method: "POST", url: "/api/auth/dev", payload: { role } });
    assert.equal(response.statusCode, 200, response.body);
    return String(response.headers["set-cookie"]).split(";")[0];
  };
  staff = await auth("STAFF");
  buyer = await auth("BUYER");
});
after(async () => {
  try {
    if (inserted.size) {
      const ids = [...inserted];
      const media = (await pool.query("SELECT id FROM media_assets WHERE item_id=ANY($1::uuid[])", [ids])).rows;
      await pool.query("DELETE FROM media_assets WHERE item_id=ANY($1::uuid[])", [ids]);
      await pool.query("DELETE FROM items WHERE id=ANY($1::uuid[])", [ids]);
      for (const asset of media) await rm(path.join(config.mediaDir, asset.id), { recursive: true, force: true });
    }
  } finally {
    await app.close();
    await pool.end();
  }
});

test("blank drafts use true SQL nulls, survive reload and cannot be published or read publicly", async () => {
  const idemKey = randomUUID();
  const created = await app.inject({
    method: "POST", url: "/api/staff/items/draft",
    headers: { cookie: staff, "idempotency-key": idemKey }, payload: {},
  });
  assert.equal(created.statusCode, 200, created.body);
  const item = created.json();
  inserted.add(item.id);
  assert.equal(item.publication, "DRAFT");
  assert.equal(item.priceMissing, true);
  assert.equal(item.title, "");
  assert.equal(item.category, "");
  const repeated = await app.inject({
    method: "POST", url: "/api/staff/items/draft",
    headers: { cookie: staff, "idempotency-key": idemKey }, payload: {},
  });
  assert.equal(repeated.json().id, item.id, "dropped responses never duplicate drafts");
  const raw = (await pool.query("SELECT title,category,price_minor FROM items WHERE id=$1", [item.id])).rows[0];
  assert.deepEqual(raw, { title: null, category: null, price_minor: null });
  const restored = await app.inject({ url: "/api/staff/items/" + item.id, headers: { cookie: staff } });
  assert.equal(restored.json().id, item.id);
  assert.equal((await app.inject("/api/items/" + item.id)).statusCode, 404);
  assert.equal((await app.inject("/share/item/" + item.id)).statusCode, 404);
  assert.ok(!(await app.inject("/api/catalog?q=" + item.sku)).json().items.some((row: any) => row.id === item.id));
  assert.equal((await app.inject({ url: "/api/staff/items/" + item.id, headers: { cookie: buyer } })).statusCode, 403);
  assert.equal((await send("POST", `/staff/items/${item.id}/publish`, { version: item.version, checked: true })).statusCode, 422);
  const invalid = await send("PATCH", `/staff/items/${item.id}`, {
    version: item.version, title: "Футболка", category: "tops", priceMinor: null,
    measurements: { chestCircumference: -1 },
  });
  assert.equal(invalid.statusCode, 422);
});

test("draft fields can be independently updated, price 0 differs from missing, and publication validates only required data", async () => {
  const initial = await createDraft({ attributes: { brand: "Nike" }, measurements: {} });
  const first = await send("PATCH", `/staff/items/${initial.id}`, {
    version: initial.version, title: "Редактируемая вещь",
    attributes: { brand: "Nike", color: "Бордовый", origin: "Беларусь" },
    measurements: { chest: 420, chestCircumference: 840, hipCircumference: 930, outseam: 1005 },
  });
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().priceMissing, true);
  assert.equal(first.json().measurements.chest, 420);
  assert.equal(first.json().measurements.chestCircumference, 840);
  assert.equal(first.json().measurements.outseam, 1005);
  const incomplete = await send("POST", `/staff/items/${initial.id}/publish`, {
    version: first.json().version, checked: true,
  });
  assert.equal(incomplete.statusCode, 422);
  assert.ok(incomplete.json().fieldErrors.category);
  assert.ok(incomplete.json().fieldErrors.price);
  const fullyFilled = await send("PATCH", `/staff/items/${initial.id}`, {
    version: first.json().version, category: "outerwear", priceMinor: 0,
    measurements: { chest: 420, chestCircumference: 840, hipCircumference: 930, outseam: 1005 },
  });
  assert.equal(fullyFilled.statusCode, 200, fullyFilled.body);
  assert.equal(fullyFilled.json().priceMissing, undefined);
  assert.equal(fullyFilled.json().priceMinor, 0);
  assert.equal((await send("PATCH", `/staff/items/${initial.id}`, {
    version: first.json().version, title: "Старая версия",
  })).statusCode, 409, "concurrent editors are protected");
  const published = await send("POST", `/staff/items/${initial.id}/publish`, {
    version: fullyFilled.json().version, checked: true,
  });
  assert.equal(published.statusCode, 200, published.body);
  const publicItem = (await app.inject("/api/items/" + initial.id)).json();
  assert.equal(publicItem.title, "Редактируемая вещь");
  assert.equal(publicItem.priceMinor, 0);
  assert.equal(publicItem.measurements.chest, 420, "legacy half-circumference untouched");
  assert.equal(publicItem.measurements.chestCircumference, 840, "full circumference has its own key");
  assert.equal(publicItem.attributes.color, "Бордовый");
});

test("draft images upload sequentially, deduplicate retries, serialize order, and stay private until published", async () => {
  const item = await createDraft();
  const images: string[] = [];
  for (let n = 0; n < 6; n++) {
    const buffer = await sharp({ create: {
      width: 75, height: 96, channels: 3,
      background: { r: 20 + n * 25, g: 70, b: 140 },
    } }).jpeg().toBuffer();
    const response = await upload(item.id, buffer);
    assert.equal(response.statusCode, 200, response.body);
    images.push(response.json().id);
    if (n === 0) {
      const repeated = await upload(item.id, buffer);
      assert.equal(repeated.statusCode, 200, repeated.body);
      assert.equal(repeated.json().id, images[0], "image bytes are idempotent");
    }
  }
  assert.equal(new Set(images).size, 6);
  const before = (await app.inject({ url: "/api/staff/items/" + item.id, headers: { cookie: staff } })).json();
  assert.deepEqual(before.media.map((photo: any) => photo.id), images);
  assert.equal((await app.inject("/media/" + images[0] + "/480")).statusCode, 403);
  assert.equal((await app.inject({ url: "/media/" + images[0] + "/480", headers: { cookie: buyer } })).statusCode, 403);
  assert.equal((await app.inject({ url: "/media/" + images[0] + "/480", headers: { cookie: staff } })).statusCode, 200);
  // Changing roles on historical photographs must no longer change their order.
  await pool.query("UPDATE media_assets SET role='MEASUREMENT' WHERE id=$1", [images[5]]);
  const reordered = [images[5], ...images.slice(0, 5)];
  const moved = await send("PUT", `/staff/items/${item.id}/media-order`, {
    ids: reordered, expectedOrder: images,
  });
  assert.equal(moved.statusCode, 200, moved.body);
  assert.deepEqual(moved.json().ids, reordered);
  const retry = await send("PUT", `/staff/items/${item.id}/media-order`, {
    ids: reordered, expectedOrder: images,
  });
  assert.equal(retry.statusCode, 200, "repeat same intent succeeds safely");
  const conflicting = await send("PUT", `/staff/items/${item.id}/media-order`, {
    ids: images, expectedOrder: images,
  });
  assert.equal(conflicting.statusCode, 409, "stale editor cannot overwrite someone else's order");
  const afterMove = (await app.inject({ url: "/api/staff/items/" + item.id, headers: { cookie: staff } })).json();
  assert.deepEqual(afterMove.media.map((photo: any) => photo.id), reordered);
  assert.equal(afterMove.media[0].role, "MEASUREMENT");
  assert.deepEqual(afterMove.media.map((photo: any) => photo.position), [0, 1, 2, 3, 4, 5]);
  const invalidSet = await send("PUT", `/staff/items/${item.id}/media-order`, {
    ids: [images[0]], expectedOrder: reordered,
  });
  assert.equal(invalidSet.statusCode, 409);
  const full = await send("PATCH", `/staff/items/${item.id}`, {
    version: item.version, title: "Фото до текста", category: "tops", priceMinor: 2000,
  });
  assert.equal(full.statusCode, 200, full.body);
  const published = await send("POST", `/staff/items/${item.id}/publish`, {
    version: full.json().version, checked: true,
  });
  assert.equal(published.statusCode, 200, published.body);
  const visible = (await app.inject("/api/items/" + item.id)).json();
  assert.deepEqual(visible.media.map((photo: any) => photo.id), reordered);
  const shared = await app.inject("/share/item/" + item.id);
  assert.equal(shared.statusCode, 200, shared.body);
  assert.match(shared.body, new RegExp(images[5]), "share preview uses the manually chosen first photo");
  const retire = await send("DELETE", "/staff/media/" + images[2]);
  assert.equal(retire.statusCode, 200, retire.body);
  const afterDelete = (await app.inject({ url: "/api/staff/items/" + item.id, headers: { cookie: staff } })).json();
  assert.equal(afterDelete.media.length, 5);
  assert.ok(!afterDelete.media.some((photo: any) => photo.id === images[2]));
});

test("drafts are listed to staff even with no title, but never enter buyer availability", async () => {
  const draft = await createDraft({ measurements: { waistCircumference: 780, inseam: 765 } });
  const staffItems = await app.inject({ url: "/api/staff/items?state=DRAFT", headers: { cookie: staff } });
  assert.equal(staffItems.statusCode, 200, staffItems.body);
  assert.ok(staffItems.json().items.some((item: any) => item.id === draft.id));
  const available = await app.inject({
    method: "POST", url: "/api/catalog/availability", payload: { itemIds: [draft.id] },
  });
  assert.deepEqual(available.json().availableIds, []);
});
