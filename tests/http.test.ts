import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHmac } from "node:crypto";
import { mkdtemp, readFile, rm, mkdir, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { buildApp } from "../server/app.js";
import { pool } from "../server/db.js";
import { migrate } from "../server/migrate.js";
import { config } from "../server/config.js";
import { digest } from "../server/crypto.js";
import { sweepOrphanMedia } from "../server/media-maintenance.js";
import { processPhoto } from "../server/media.js";
let app: Awaited<ReturnType<typeof buildApp>>,
  owner: string,
  buyer: string,
  staff: string,
  buyerId: string,
  staffId: string;
const key = () => randomUUID();
const headers = (cookie: string) => ({ cookie, "idempotency-key": key() });
async function login(role: string) {
  const r = await app.inject({
    method: "POST",
    url: "/api/auth/dev",
    payload: { role },
  });
  assert.equal(r.statusCode, 200, r.body);
  return String(r.headers["set-cookie"]).split(";")[0];
}
before(async () => {
  assert.match(process.env.DATABASE_URL ?? "", /_test$/);
  await migrate();
  app = await buildApp({ staticFiles: false });
  app.addHook("onSend", async (req, _reply, payload) => {
    if (req.headers["x-test-drop-response"] === "1") req.raw.socket.destroy();
    return payload;
  });
  owner = await login("OWNER");
  buyer = await login("BUYER");
  staff = await login("STAFF");
  buyerId = (
    await app.inject({ url: "/api/auth/me", headers: { cookie: buyer } })
  ).json().user.id;
  staffId = (
    await app.inject({ url: "/api/auth/me", headers: { cookie: staff } })
  ).json().user.id;
});
after(async () => {
  await app.close();
  await pool.end();
});
test("B00 anonymous browse; protected routes deny anonymous and buyer admin", async () => {
  assert.equal((await app.inject("/api/catalog")).statusCode, 200);
  assert.equal((await app.inject("/api/auth/me")).json().user, null);
  assert.equal((await app.inject("/api/me/orders")).statusCode, 401);
  assert.equal(
    (
      await app.inject({
        url: "/api/owner/settings",
        headers: { cookie: buyer },
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (await app.inject({ url: "/api/staff/items", headers: { cookie: buyer } }))
      .statusCode,
    403,
  );
});
test("T19 signed replay stays tied to same session, other session rejected", async () => {
  config.botToken = "123:unit-only";
  const p = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id: 988877766, first_name: "Тест" }),
    query_id: key(),
  });
  const check = [...p]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  p.set(
    "hash",
    createHmac(
      "sha256",
      createHmac("sha256", "WebAppData").update(config.botToken).digest(),
    )
      .update(check)
      .digest("hex"),
  );
  const r = await app.inject({
    method: "POST",
    url: "/api/auth/telegram",
    payload: { initData: p.toString() },
  });
  assert.equal(r.statusCode, 200, r.body);
  const cookie = String(r.headers["set-cookie"]).split(";")[0];
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/auth/telegram",
        headers: { cookie },
        payload: { initData: p.toString() },
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/auth/telegram",
        payload: { initData: p.toString() },
      })
    ).statusCode,
    401,
  );
  const reordered = new URLSearchParams([...p.entries()].reverse()).toString();
  const duplicate = await app.inject({
    method: "POST",
    url: "/api/auth/telegram",
    payload: { initData: reordered },
  });
  assert.equal(
    duplicate.statusCode,
    401,
    "Equivalent parameter order must not create an independent session",
  );
});
test("CSRF wrong origin rejected, security headers allow Telegram embedding only", async () => {
  const r = await app.inject({
    method: "POST",
    url: "/api/auth/logout",
    headers: { cookie: buyer, origin: "https://other.invalid" },
  });
  assert.equal(r.statusCode, 403);
  const publicR = await app.inject("/api/settings");
  assert.match(
    String(publicR.headers["content-security-policy"]),
    /frame-ancestors.*web.telegram.org/,
  );
  assert.equal(publicR.headers["x-frame-options"], undefined);
  assert.equal(publicR.headers["cache-control"], "no-store");
});
test("D05 category validation, publish checklist and version conflicts", async () => {
  const data = {
    title: "Тестовая сумка <script>alert(1)</script>",
    category: "bags",
    priceMinor: 4567,
    storageLocation: "ТЕСТ",
    attributes: {
      material: "Ткань",
      care: "По ярлыку",
      manufacturer: "Тест",
      importer: "Тест",
      origin: "BY",
      documents: "Тестовый документ",
    },
    measurements: { width: 300, height: 240, depth: 80 },
  };
  const bad = await app.inject({
    method: "POST",
    url: "/api/staff/items",
    headers: headers(staff),
    payload: { ...data, category: "shoes" },
  });
  assert.equal(bad.statusCode, 422);
  const r = await app.inject({
    method: "POST",
    url: "/api/staff/items",
    headers: headers(staff),
    payload: data,
  });
  assert.equal(r.statusCode, 200, r.body);
  const i = r.json();
  const incomplete = await app.inject({
    method: "POST",
    url: `/api/staff/items/${i.id}/publish`,
    headers: headers(staff),
    payload: { version: i.version, checked: true },
  });
  assert.equal(incomplete.statusCode, 422, incomplete.body);
  const stale = await app.inject({
    method: "PATCH",
    url: `/api/staff/items/${i.id}`,
    headers: headers(staff),
    payload: { ...data, version: i.version + 1 },
  });
  assert.equal(stale.statusCode, 409);
});
test("T25/T35 upload signature decode, EXIF stripped variants, retry dedup and private originals", async () => {
  const i = (
    await pool.query(
      "SELECT id FROM items WHERE category='bags' ORDER BY created_at DESC LIMIT 1",
    )
  ).rows[0];
  const image = await sharp({
    create: { width: 700, height: 900, channels: 3, background: "#c4b29b" },
  })
    .jpeg()
    .withMetadata({ exif: { IFD0: { Artist: "Private metadata" } } })
    .toBuffer();
  const boundary = "b" + key();
  const body = (bytes: Buffer) =>
    Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="itemId"\r\n\r\n${i.id}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="test.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`,
      ),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
  const send = (b: Buffer) =>
    app.inject({
      method: "POST",
      url: "/api/staff/media/uploads",
      headers: {
        ...headers(staff),
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      payload: body(b),
    });
  const bad = await send(Buffer.from("<script>fake</script>"));
  assert.equal(bad.statusCode, 422, bad.body);
  const r = await send(image);
  assert.equal(r.statusCode, 200, r.body);
  const asset = r.json();
  assert.equal((await send(image)).json().id, asset.id);
  const clean = await sharp(
    await readFile(path.join(config.mediaDir, asset.original_key)),
  ).metadata();
  assert.equal(clean.exif, undefined);
  assert.equal(clean.format, "webp");
  for (const w of [240, 480, 960, 1600]) assert.ok(asset.variants[w]);
  assert.equal(
    (
      await app.inject({
        url: `/api/staff/media/${asset.id}/original`,
        headers: { cookie: buyer },
      })
    ).statusCode,
    403,
  );
  assert.equal((await app.inject(`/media/${asset.id}/480`)).statusCode, 403);
  const row = (
    await pool.query("SELECT version FROM items WHERE id=$1", [i.id])
  ).rows[0];
  const pub = await app.inject({
    method: "POST",
    url: `/api/staff/items/${i.id}/publish`,
    headers: headers(staff),
    payload: { version: row.version, checked: true },
  });
  assert.equal(pub.statusCode, 200, pub.body);
  assert.equal((await app.inject(`/media/${asset.id}/480`)).statusCode, 200);
});
test("B03 numeric/measurement/category search filters return real items, invalid range 422", async () => {
  const r = await app.inject(
    "/api/catalog?category=bags&minPrice=4500&maxPrice=4600&measurement=width&minMeasure=250",
  );
  assert.equal(r.statusCode, 200, r.body);
  assert.ok(r.json().items.length >= 1);
  assert.equal(
    (await app.inject("/api/catalog?minPrice=500&maxPrice=100")).statusCode,
    422,
  );
  assert.equal(
    (await app.inject("/api/catalog?minHeight=100")).statusCode,
    200,
  );
});
test("B07/B10 server draft encryption, selection persistence, phone request webhook verified identity", async () => {
  const i = (await pool.query("SELECT id FROM items LIMIT 1")).rows[0];
  const r = await app.inject({
    method: "PUT",
    url: "/api/me/selection",
    headers: headers(buyer),
    payload: { itemIds: [i.id] },
  });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(
    (
      await app.inject({ url: "/api/me/selection", headers: { cookie: buyer } })
    ).json().itemIds[0],
    i.id,
  );
  const meta = (await app.inject({ url: "/api/me/checkout-draft", headers: { cookie: buyer } })).json();
  const draft = {
    draftToken: meta.draftToken, draftRevision: meta.draftRevision + 1,
    phone: "+375291234567",
    fullName: "Тестовые Данные",
    method: "PICKUP",
  };
  assert.equal(
    (
      await app.inject({
        method: "PATCH",
        url: "/api/me/checkout-draft",
        headers: headers(buyer),
        payload: draft,
      })
    ).statusCode,
    200,
  );
  const db = (
    await pool.query("SELECT value_enc FROM checkout_drafts WHERE user_id=$1", [
      buyerId,
    ])
  ).rows[0];
  assert.ok(!db.value_enc.includes(draft.phone));
  assert.equal(
    (
      await app.inject({
        url: "/api/me/checkout-draft",
        headers: { cookie: buyer },
      })
    ).json().phone,
    draft.phone,
  );
  config.webhookSecret = "local-test-secret";
  const update = {
    update_id: 12333,
    message: {
      chat: { type: "private" },
      from: { id: 990000001 },
      contact: { user_id: 990000001, phone_number: "+375291111111" },
    },
  };
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/telegram/webhook",
        payload: update,
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/telegram/webhook",
        headers: { "x-telegram-bot-api-secret-token": config.webhookSecret },
        payload: update,
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await app.inject({ url: "/api/me/contact", headers: { cookie: buyer } })
    ).json().phone,
    "+375291111111",
  );
});
test("O08 owner cannot enable carrier with only a checkbox and no contract", async () => {
  const s = (
    await app.inject({ url: "/api/owner/settings", headers: { cookie: owner } })
  ).json();
  s.carriers.BELPOST.enabled = true;
  const r = await app.inject({
    method: "PATCH",
    url: "/api/owner/settings",
    headers: headers(owner),
    payload: s,
  });
  assert.equal(r.statusCode, 422, r.body);
  const pub = (await app.inject("/api/settings")).json();
  assert.equal(pub.carriers.BELPOST.contract, undefined);
});
test("T07 real HTTP disconnect after COMMIT restores exactly one order by original key", async () => {
  const fixture = (
    await pool.query(
      "INSERT INTO items(sku,title,category,price_minor,publication,physical) VALUES($1,'Тест потери ответа','tops',2500,'PUBLISHED','AVAILABLE') RETURNING id",
      ["HTTP-" + key()],
    )
  ).rows[0];
  await pool.query(
    "UPDATE store_settings SET value=jsonb_set(value,'{acceptingOrders}','true') WHERE id=true",
  );
  const lease = (
    await app.inject({
      method: "POST",
      url: "/api/checkout/leases",
      headers: headers(buyer),
      payload: { itemIds: [fixture.id] },
    })
  ).json();
  assert.ok(lease.id);
  const operation = key(),
    body = {
      leaseId: lease.id,
      method: "PICKUP",
      phone: "+375291234567",
      termsAccepted: true,
    };
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  await assert.rejects(
    fetch(address + "/api/orders", {
      method: "POST",
      headers: {
        cookie: buyer,
        "content-type": "application/json",
        "idempotency-key": operation,
        "x-test-drop-response": "1",
      },
      body: JSON.stringify(body),
    }),
  );
  const restored = await app.inject({
    url: "/api/operations/" + operation,
    headers: { cookie: buyer },
  });
  assert.equal(restored.statusCode, 200, restored.body);
  const repeated = await app.inject({
    method: "POST",
    url: "/api/orders",
    headers: { cookie: buyer, "idempotency-key": operation },
    payload: body,
  });
  assert.equal(repeated.json().id, restored.json().id);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM order_lines WHERE item_id=$1",
        [fixture.id],
      )
    ).rows[0].n,
    1,
  );
});
test("A02 bulk hiding never silently hides part; repeated command is idempotent", async () => {
  const itemIds: string[] = [];
  for (let n = 0; n < 2; n++)
    itemIds.push(
      (
        await pool.query(
          "INSERT INTO items(sku,title,category,price_minor,publication,physical) VALUES($1,'Тест массового снятия','tops',1000,'PUBLISHED','AVAILABLE') RETURNING id",
          ["BULK-" + key()],
        )
      ).rows[0].id,
    );
  const lease = (
    await app.inject({
      method: "POST",
      url: "/api/checkout/leases",
      headers: headers(buyer),
      payload: { itemIds: [itemIds[0]] },
    })
  ).json();
  const items = (
    await pool.query("SELECT id,version FROM items WHERE id=ANY($1::uuid[])", [
      itemIds,
    ])
  ).rows;
  const blocked = await app.inject({
    method: "POST",
    url: "/api/staff/items/bulk-hide",
    headers: headers(staff),
    payload: { items, confirmed: true },
  });
  assert.equal(blocked.statusCode, 409, blocked.body);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM items WHERE id=ANY($1::uuid[]) AND publication='PUBLISHED'",
        [itemIds],
      )
    ).rows[0].n,
    2,
  );
  const releaseKey = key();
  for (let attempt = 0; attempt < 2; attempt++)
    assert.equal(
      (
        await app.inject({
          method: "DELETE",
          url: "/api/checkout/leases/" + lease.id,
          headers: { cookie: buyer, "idempotency-key": releaseKey },
        })
      ).statusCode,
      200,
    );
  const operation = key();
  const first = await app.inject({
    method: "POST",
    url: "/api/staff/items/bulk-hide",
    headers: { cookie: staff, "idempotency-key": operation },
    payload: { items, confirmed: true },
  });
  assert.equal(first.statusCode, 200, first.body);
  const repeat = await app.inject({
    method: "POST",
    url: "/api/staff/items/bulk-hide",
    headers: { cookie: staff, "idempotency-key": operation },
    payload: { items, confirmed: true },
  });
  assert.deepEqual(repeat.json(), first.json());
});
test("A04 moving a photo to cover shifts all positions with no duplicate ordering", async () => {
  const i = (
    await pool.query(
      "SELECT id FROM items WHERE category='bags' ORDER BY created_at DESC LIMIT 1",
    )
  ).rows[0];
  const original = (
    await pool.query("SELECT * FROM media_assets WHERE item_id=$1 LIMIT 1", [
      i.id,
    ])
  ).rows[0];
  const id = key();
  await pool.query(
    "INSERT INTO media_assets(id,item_id,original_key,checksum,mime,width,height,variants,position) VALUES($1,$2,$3,$4,$5,20,20,$6,1)",
    [
      id,
      i.id,
      original.original_key,
      "reorder-test",
      "image/webp",
      original.variants,
    ],
  );
  const r = await app.inject({
    method: "PATCH",
    url: "/api/staff/media/" + id,
    headers: headers(staff),
    payload: { position: 0 },
  });
  assert.equal(r.statusCode, 200, r.body);
  const photos = (
    await pool.query(
      "SELECT id,position FROM media_assets WHERE item_id=$1 ORDER BY position",
      [i.id],
    )
  ).rows;
  assert.equal(photos[0].id, id);
  assert.deepEqual(
    photos.map((p) => p.position),
    [0, 1],
  );
});
test("D16 orphan photo sweep preserves referenced and fresh files, removes only old unreferenced UUID directory", async () => {
  const stale = key(),
    fresh = key();
  const old = new Date(Date.now() - 172800000);
  for (const id of [stale, fresh])
    await mkdir(path.join(config.mediaDir, id), { recursive: true });
  await utimes(path.join(config.mediaDir, stale), old, old);
  const referenced = (await pool.query("SELECT id FROM media_assets LIMIT 1"))
    .rows[0];
  await utimes(path.join(config.mediaDir, referenced.id), old, old);
  const result = await sweepOrphanMedia(true);
  assert.ok(result.removed >= 1);
  await assert.rejects(() =>
    readFile(path.join(config.mediaDir, stale, "missing")),
  );
  const { stat } = await import("node:fs/promises");
  await assert.rejects(() => stat(path.join(config.mediaDir, stale)));
  assert.ok((await stat(path.join(config.mediaDir, fresh))).isDirectory());
  assert.ok(
    (await stat(path.join(config.mediaDir, referenced.id))).isDirectory(),
  );
});
test("A03 create and edit commands recover their exact result after retry, changed body is rejected", async () => {
  const body = {
    title: "Тест идемпотентного редактора",
    category: "tops",
    priceMinor: 1100,
    attributes: {},
    measurements: {},
    storageLocation: "Тест",
  };
  const operation = key();
  const create = () =>
    app.inject({
      method: "POST",
      url: "/api/staff/items",
      headers: { cookie: staff, "idempotency-key": operation },
      payload: body,
    });
  const first = await create(),
    second = await create();
  assert.equal(first.statusCode, 200, first.body);
  assert.deepEqual(second.json(), first.json());
  const item = first.json(),
    editKey = key(),
    change = { ...body, title: body.title + " 2", version: item.version };
  const save = () =>
    app.inject({
      method: "PATCH",
      url: "/api/staff/items/" + item.id,
      headers: { cookie: staff, "idempotency-key": editKey },
      payload: change,
    });
  const saved = await save();
  assert.equal(saved.statusCode, 200, saved.body);
  assert.deepEqual((await save()).json(), saved.json());
  assert.equal(
    (
      await app.inject({
        method: "PATCH",
        url: "/api/staff/items/" + item.id,
        headers: { cookie: staff, "idempotency-key": editKey },
        payload: { ...change, priceMinor: 999 },
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/staff/items",
        headers: headers(staff),
        payload: { ...body, physical: "SOLD" },
      })
    ).statusCode,
    422,
  );
});
test("A17 operational issue assignment is real, protected and replayable", async () => {
  const issue = (
    await pool.query(
      "INSERT INTO operation_issues(entity_id,kind,message) VALUES($1,'WORKER_LAG','Тестовая проблема') RETURNING id",
      [key()],
    )
  ).rows[0];
  const operation = key();
  const run = () =>
    app.inject({
      method: "POST",
      url: "/api/staff/issues/" + issue.id + "/assign",
      headers: { cookie: staff, "idempotency-key": operation },
      payload: {},
    });
  const first = await run();
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().assigned, true);
  assert.deepEqual((await run()).json(), first.json());
  assert.equal(
    (
      await pool.query("SELECT assigned_to FROM operation_issues WHERE id=$1", [
        issue.id,
      ])
    ).rows[0].assigned_to,
    staffId,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/staff/issues/" + issue.id + "/assign",
        headers: headers(buyer),
        payload: {},
      })
    ).statusCode,
    403,
  );
});
test("T21 current staff session revoked immediately and invite bound to exact Telegram ID", async () => {
  const wrong = (
    await app.inject({
      method: "POST",
      url: "/api/owner/staff/invites",
      headers: headers(owner),
      payload: { telegramId: "555555555", role: "STAFF" },
    })
  ).json();
  const accept = await app.inject({
    method: "POST",
    url: "/api/me/staff-invite",
    headers: headers(buyer),
    payload: { token: wrong.token },
  });
  assert.equal(accept.statusCode, 403);
  const r = await app.inject({
    method: "DELETE",
    url: "/api/owner/staff/" + staffId,
    headers: headers(owner),
  });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(
    (await app.inject({ url: "/api/staff/items", headers: { cookie: staff } }))
      .statusCode,
    401,
  );
});
test("private session hashes and media processing pixel limits", async () => {
  const token = randomBytes(32).toString("hex");
  await pool.query(
    "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",
    [digest(token), buyerId],
  );
  assert.equal(
    (
      await app.inject({
        url: "/api/auth/me",
        headers: { cookie: "session=" + token },
      })
    ).json().user.id,
    buyerId,
  );
  const dir = await mkdtemp(path.join(os.tmpdir(), "photo-test-"));
  try {
    await assert.rejects(() => processPhoto(Buffer.from("fake"), dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
