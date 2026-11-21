import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { buildApp } from "../server/app.js";
import { config } from "../server/config.js";
import { pool } from "../server/db.js";
import { migrate } from "../server/migrate.js";

let app: Awaited<ReturnType<typeof buildApp>>;
let staff: string;
let buyer: string;
const inserted = new Set<string>();

const post = async (url: string, body: Record<string, unknown> = {}, key = randomUUID(), cookie = staff) =>
  app.inject({
    method: "POST", url: "/api" + url,
    headers: { cookie, "idempotency-key": key },
    payload: body,
  });
const edit = async (url: string, body: Record<string, unknown>, method: "PATCH" | "PUT" | "DELETE" = "PATCH") =>
  app.inject({
    method, url: "/api" + url,
    headers: { cookie: staff, "idempotency-key": randomUUID() },
    payload: body,
  });
const createDraft = async (data: Record<string, unknown> = {}) => {
  const response = await post("/staff/items/draft", data);
  assert.equal(response.statusCode, 200, response.body);
  const result = response.json();
  inserted.add(result.id);
  return result;
};
const upload = async (id: string, buffer: Buffer) => {
  const boundary = "image" + randomUUID();
  const first = [
    "--" + boundary,
    'Content-Disposition: form-data; name="itemId"',
    "",
    id,
    "--" + boundary,
    'Content-Disposition: form-data; name="file"; filename="test.jpg"',
    "Content-Type: image/jpeg",
    "",
  ].join("\r\n") + "\r\n";
  const body = Buffer.concat([
    Buffer.from(first), buffer, Buffer.from("\r\n--" + boundary + "--\r\n"),
  ]);
  return app.inject({
    method: "POST", url: "/api/staff/media/uploads",
    headers: {
      cookie: staff, "idempotency-key": randomUUID(),
      "content-type": "multipart/form-data; boundary=" + boundary,
    },
    payload: body,
  });
};
const photo = async (red: number) =>
  sharp({ create: {
    width: 80, height: 120, channels: 3,
    background: { r: red, g: 70, b: 130 },
  } }).jpeg().toBuffer();
const digest = async (filename: string) =>
  createHash("sha256").update(await readFile(filename)).digest("hex");

before(async () => {
  assert.match(process.env.DATABASE_URL ?? "", /_test$/);
  await migrate();
  app = await buildApp({ staticFiles: false });
  const auth = async (role: "STAFF" | "BUYER") => {
    const response = await app.inject({
      method: "POST", url: "/api/auth/dev", payload: { role },
    });
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
      const photos = (await pool.query(
        "SELECT id FROM media_assets WHERE item_id=ANY($1::uuid[])", [ids],
      )).rows;
      await pool.query(
        "DELETE FROM media_assets WHERE item_id=ANY($1::uuid[])", [ids],
      );
      await pool.query(
        "DELETE FROM items WHERE id=ANY($1::uuid[])", [ids],
      );
      for (const media of photos)
        await rm(path.join(config.mediaDir, media.id), {
          recursive: true, force: true,
        });
    }
  } finally {
    await app.close();
    await pool.end();
  }
});

test("one action duplicates fields and photos but not SKU, stock, published snapshot or permissions", async () => {
  const source = await createDraft({
    title: "Футболка", category: "tops", priceMinor: 3500,
    description: "Хлопковая футболка", storageLocation: "Рейл 3",
    attributes: { brand: "Nike", color: "Чёрный", origin: "Беларусь", season: "Лето" },
    measurements: { chestCircumference: 940, waistCircumference: 900 },
    hasDefect: true, defectDescription: "Небольшая затяжка",
  });
  const images: string[] = [];
  for (const red of [30, 210]) {
    const result = await upload(source.id, await photo(red));
    assert.equal(result.statusCode, 200, result.body);
    images.push(result.json().id as string);
  }
  // Legacy photo roles do not change the explicit display order.
  await pool.query("UPDATE media_assets SET role='MEASUREMENT' WHERE id=$1", [images[1]]);
  const reordered = await edit("/staff/items/" + source.id + "/media-order", {
    ids: [images[1], images[0]], expectedOrder: images,
  }, "PUT");
  assert.equal(reordered.statusCode, 200, reordered.body);

  const publication = await post("/staff/items/" + source.id + "/publish", {
    version: source.version, checked: true,
  });
  assert.equal(publication.statusCode, 200, publication.body);
  const live = publication.json();
  assert.equal(live.publication, "PUBLISHED");

  const key = randomUUID();
  const first = await post("/staff/items/" + source.id + "/duplicate", {}, key);
  assert.equal(first.statusCode, 200, first.body);
  const copy = first.json();
  inserted.add(copy.id);

  const repeat = await post("/staff/items/" + source.id + "/duplicate", {}, key);
  assert.equal(repeat.statusCode, 200, repeat.body);
  assert.deepEqual(repeat.json(), copy, "a dropped response cannot create another item");
  assert.notEqual(copy.id, source.id);
  assert.notEqual(copy.sku, source.sku);
  assert.equal(copy.publication, "DRAFT");
  assert.equal(copy.physical, "INTAKE");
  assert.equal(copy.version, 1);
  assert.equal(copy.available, false);
  assert.equal(copy.priceMinor, 3500);
  assert.equal(copy.storageLocation, "Рейл 3");
  assert.equal(copy.hasDefect, true);
  assert.equal(copy.defectDescription, "Небольшая затяжка");
  assert.deepEqual(copy.attributes, source.attributes);
  assert.deepEqual(copy.measurements, source.measurements);
  assert.equal(copy.media.length, 2);
  assert.deepEqual(copy.media.map((p: any) => p.position), [0, 1]);
  assert.deepEqual(copy.media.map((p: any) => p.role), ["MEASUREMENT", "FRONT"]);
  assert.ok(copy.media.every((p: any) => !images.includes(p.id)), "cloned photos need distinct media IDs");
  assert.equal((await pool.query(
    "SELECT published_snapshot FROM items WHERE id=$1", [copy.id],
  )).rows[0].published_snapshot, null);
  assert.equal((await pool.query(
    "SELECT count(*)::int AS n FROM inventory_claim WHERE item_id=$1", [copy.id],
  )).rows[0].n, 0);
  assert.equal((await app.inject("/api/items/" + copy.id)).statusCode, 404);
  assert.equal((await app.inject({
    method: "GET", url: "/media/" + copy.media[0].id + "/480",
    headers: { cookie: buyer },
  })).statusCode, 403);
  assert.equal((await app.inject({
    method: "POST", url: "/api/staff/items/" + source.id + "/duplicate",
    headers: { cookie: buyer, "idempotency-key": randomUUID() },
    payload: {},
  })).statusCode, 403, "buyers cannot duplicate cards");

  const sourceFile = path.join(config.mediaDir, images[1], "480.webp");
  const copyFile = path.join(config.mediaDir, copy.media[0].id, "480.webp");
  const originalBefore = await digest(sourceFile);
  assert.equal(await digest(copyFile), originalBefore, "new IDs retain identical initial pixels");

  const rotation = await edit("/staff/media/" + copy.media[0].id, { rotation: 90 });
  assert.equal(rotation.statusCode, 200, rotation.body);
  assert.equal(await digest(sourceFile), originalBefore, "rotating a copy cannot mutate source bytes");
  assert.notEqual(await digest(copyFile), originalBefore, "only the cloned asset rotates");

  const changed = await edit("/staff/items/" + copy.id, {
    version: copy.version, title: "Футболка другого цвета",
    category: "tops", priceMinor: 3500,
    attributes: { ...copy.attributes, origin: "Турция" },
    measurements: copy.measurements,
    hasDefect: false, defectDescription: "",
  });
  assert.equal(changed.statusCode, 200, changed.body);
  const original = (await app.inject({
    url: "/api/staff/items/" + source.id, headers: { cookie: staff },
  })).json();
  assert.equal(original.attributes.origin, "Беларусь");
  assert.equal(original.hasDefect, true);
  assert.equal(original.publication, "PUBLISHED");

  const retired = await edit("/staff/media/" + copy.media[0].id, {}, "DELETE");
  assert.equal(retired.statusCode, 200, retired.body);
  const ready = await pool.query("SELECT state FROM media_assets WHERE id=$1", [images[1]]);
  assert.equal(ready.rows[0].state, "READY", "deleting a cloned photo cannot delete its original");

  const independent = await post("/staff/items/" + source.id + "/duplicate");
  assert.equal(independent.statusCode, 200, independent.body);
  inserted.add(independent.json().id);
  assert.notEqual(independent.json().id, copy.id, "a new user action creates a new physical item");
});

test("an incomplete draft is duplicated without inventing missing price or title", async () => {
  const source = await createDraft({
    measurements: { inseam: 763, outseam: 982 },
    attributes: { brand: "Adidas" },
  });
  const response = await post("/staff/items/" + source.id + "/duplicate");
  assert.equal(response.statusCode, 200, response.body);
  const copy = response.json();
  inserted.add(copy.id);
  assert.equal(copy.publication, "DRAFT");
  assert.equal(copy.title, "");
  assert.equal(copy.category, "");
  assert.equal(copy.priceMissing, true);
  assert.deepEqual(copy.measurements, source.measurements);
  const raw = (await pool.query(
    "SELECT title,category,price_minor FROM items WHERE id=$1", [copy.id],
  )).rows[0];
  assert.deepEqual(raw, { title: null, category: null, price_minor: null });
});

test("a missing source image aborts atomically without creating a broken draft", async () => {
  const source = await createDraft({ title: "Рубашка", category: "shirts", priceMinor: 1000 });
  const uploaded = await upload(source.id, await photo(115));
  assert.equal(uploaded.statusCode, 200, uploaded.body);
  const original = path.join(config.mediaDir, uploaded.json().id, "480.webp");
  const hidden = original + ".temporarily-hidden";
  const before = Number((await pool.query("SELECT count(*) AS n FROM items")).rows[0].n);
  await rename(original, hidden);
  try {
    const result = await post("/staff/items/" + source.id + "/duplicate");
    assert.equal(result.statusCode, 409, result.body);
    assert.equal(result.json().code, "SOURCE_MEDIA_MISSING");
    const afterCount = Number((await pool.query("SELECT count(*) AS n FROM items")).rows[0].n);
    assert.equal(afterCount, before, "transaction rolls back the item");
  } finally {
    await rename(hidden, original);
  }
});