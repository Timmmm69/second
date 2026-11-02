import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { buildApp } from "../server/app.js";
import { pool } from "../server/db.js";
import { migrate } from "../server/migrate.js";
import { digest, decrypt, encrypt } from "../server/crypto.js";
import { tick } from "../server/jobs.js";

if (!process.env.DATABASE_URL?.match(/\/[^/]*_test(?:\?|$)/)) throw new Error("Recipient integration tests require an isolated *_test database");
let app: Awaited<ReturnType<typeof buildApp>>;
let buyer: { id: string; cookie: string }, other: typeof buyer, staff: typeof buyer;
const fields = { method: "EUROPOST", phone: "+375290000011", fullName: "Синтетический Получатель", city: "Минск", office: "Пункт 7", officeAddress: "Тестовая улица, 9", postalCode: "", comment: "Только для текущего обращения" };
async function user(role: string, telegramId: number, username?: string) {
  const id = randomUUID(), token = randomUUID();
  await pool.query("INSERT INTO users(id,telegram_id,role,display_name,username) VALUES($1,$2,$3,'Владелец аккаунта',$4)", [id, telegramId, role, username ?? null]);
  await pool.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')", [digest(token), id]);
  return { id, cookie: `session=${token}` };
}
async function call(u: typeof buyer, method: any, path: string, payload?: any, key = randomUUID()) {
  return app.inject({ method, url: `/api${path}`, headers: { cookie: u.cookie, "idempotency-key": key }, payload });
}
async function draft(u = buyer) { return (await call(u, "GET", "/me/checkout-draft")).json(); }
async function item() {
  const id = randomUUID();
  await pool.query("INSERT INTO items(id,sku,title,category,price_minor,publication,physical) VALUES($1,$2,'Синтетическая вещь','outerwear',2900,'PUBLISHED','AVAILABLE')", [id, `RECIPIENT-${id}`]);
  return id;
}
async function checkout(u = buyer, extra: any = {}) {
  const meta = await draft(u), itemId = await item();
  const lease = await call(u, "POST", "/checkout/leases", { itemIds: [itemId] });
  assert.equal(lease.statusCode, 200, lease.body);
  const key = randomUUID();
  const payload = { ...fields, draftToken: meta.draftToken, recipientVersion: meta.recipientVersion, saveRecipient: true, termsAccepted: true, leaseId: lease.json().id, ...extra };
  const response = await call(u, "POST", "/orders", payload, key);
  assert.equal(response.statusCode, 200, response.body);
  return { order: response.json(), payload, key };
}
before(async () => {
  await migrate();
  app = await buildApp({ staticFiles: false });
  buyer = await user("BUYER", 88001001);
  other = await user("BUYER", 88001002);
  staff = await user("STAFF", 88001003);
  await pool.query("UPDATE store_settings SET value=jsonb_set(jsonb_set(value,'{acceptingOrders}','true'),'{carriers,EUROPOST,enabled}','true') WHERE id=true");
});
after(async () => { await app.close(); await pool.end(); });

test("recipient profile is encrypted, scoped to the verified account and seeds the next form after commit", async () => {
  const { order } = await checkout();
  const next = await draft();
  assert.equal(next.phone, fields.phone);
  assert.equal(next.fullName, fields.fullName);
  assert.equal(next.comment, undefined, "An order comment is never the reusable profile");
  assert.notEqual(next.fullName, "Владелец аккаунта", "Telegram identity is not the recipient's legal name");
  const stored = (await pool.query("SELECT value_enc FROM recipient_profiles WHERE user_id=$1", [buyer.id])).rows[0];
  assert.ok(!stored.value_enc.includes(fields.phone));
  assert.equal(decrypt<any>(stored.value_enc).officeAddress, fields.officeAddress);
  assert.equal((await pool.query("SELECT 1 FROM checkout_drafts WHERE user_id=$1", [buyer.id])).rowCount, 0);
  assert.equal((await draft(other)).phone, undefined);
  assert.equal((await call(other, "GET", `/orders/${order.id}`)).statusCode, 403);
  const forged = await call(other, "PATCH", "/me/recipient-profile", { recipient: fields, enabled: true, version: 0, userId: buyer.id });
  assert.equal(forged.statusCode, 422);
});

test("out-of-order autosaves cannot overwrite newer values and repeated flushes are harmless", async () => {
  const meta = await draft();
  const newer = await call(buyer, "PATCH", "/me/checkout-draft", { ...fields, phone: "+375290000022", draftToken: meta.draftToken, draftRevision: meta.draftRevision + 2 });
  assert.equal(newer.statusCode, 200, newer.body);
  const late = await call(buyer, "PATCH", "/me/checkout-draft", { ...fields, draftToken: meta.draftToken, draftRevision: meta.draftRevision + 1 });
  assert.equal(late.statusCode, 409);
  assert.equal(late.json().code, "DRAFT_STALE");
  const duplicate = await call(buyer, "PATCH", "/me/checkout-draft", { ...fields, phone: "+375290000022", draftToken: meta.draftToken, draftRevision: meta.draftRevision + 2 });
  assert.equal(duplicate.statusCode, 200);
  assert.equal((await draft()).phone, "+375290000022");
});

test("completion fences delayed autosaves, keeps exactly one order, and preserves immutable recipient/account snapshots", async () => {
  const meta = await draft();
  const { order, payload, key } = await checkout();
  const delayed = await call(buyer, "PATCH", "/me/checkout-draft", { ...fields, draftToken: meta.draftToken, draftRevision: 999 });
  assert.equal(delayed.statusCode, 409);
  assert.equal(delayed.json().code, "DRAFT_CLOSED");
  const repeat = await call(buyer, "POST", "/orders", payload, key);
  assert.equal(repeat.statusCode, 200, repeat.body);
  assert.equal(repeat.json().id, order.id);
  await pool.query("UPDATE users SET display_name='Новое имя',username='changed_test_user' WHERE id=$1", [buyer.id]);
  const profile = (await call(buyer, "GET", "/me/recipient-profile")).json();
  const edit = await call(buyer, "PATCH", "/me/recipient-profile", { recipient: { ...fields, fullName: "Другой Получатель" }, enabled: true, version: profile.version });
  assert.equal(edit.statusCode, 200, edit.body);
  const manager = (await call(staff, "GET", `/orders/${order.id}`)).json();
  assert.equal(manager.buyer.telegramId, "88001001");
  assert.equal(manager.buyer.displayName, "Новое имя");
  assert.equal(manager.buyer.username, "changed_test_user");
  assert.equal(manager.buyer.atCheckout.displayName, "Владелец аккаунта");
  assert.equal(manager.buyer.atCheckout.username, undefined);
  assert.equal(manager.recipient.fullName, fields.fullName);
  const own = (await call(buyer, "GET", `/orders/${order.id}`)).json();
  assert.equal(own.buyer, undefined, "Staff contact block is not published to buyers");
  assert.equal((await call(buyer, "GET", "/staff/items")).statusCode, 403);
});

test("clearing saved details disables reuse, discards draft and rejects delayed profile/order saves", async () => {
  const meta = await draft();
  const saved = await call(buyer, "PATCH", "/me/checkout-draft", { ...fields, draftToken: meta.draftToken, draftRevision: meta.draftRevision + 1 });
  assert.equal(saved.statusCode, 200);
  const lease = await call(buyer, "POST", "/checkout/leases", { itemIds: [await item()] });
  assert.equal(lease.statusCode, 200, lease.body);
  const cleared = await call(buyer, "DELETE", "/me/recipient-profile", { version: meta.recipientVersion });
  assert.equal(cleared.statusCode, 200, cleared.body);
  assert.notEqual(cleared.json().draftToken, meta.draftToken);
  const next = await draft();
  assert.equal(next.phone, undefined);
  assert.equal(next.saveRecipient, false);
  const stale = await call(buyer, "PATCH", "/me/recipient-profile", { recipient: fields, enabled: true, version: meta.recipientVersion });
  assert.equal(stale.statusCode, 409);
  const late = await call(buyer, "PATCH", "/me/checkout-draft", { ...fields, draftToken: meta.draftToken, draftRevision: 2000 });
  assert.equal(late.statusCode, 409);
  const delayedOrder = await call(buyer, "POST", "/orders", { ...fields, leaseId: lease.json().id, termsAccepted: true, draftToken: meta.draftToken, saveRecipient: true, recipientVersion: meta.recipientVersion });
  assert.equal(delayedOrder.statusCode, 409, delayedOrder.body);
  assert.equal(delayedOrder.json().code, "DRAFT_CLOSED");
  const db = (await pool.query("SELECT value_enc,enabled FROM recipient_profiles WHERE user_id=$1", [buyer.id])).rows[0];
  assert.equal(db.value_enc, null);
  assert.equal(db.enabled, false);
});

test("deletion request purges saved recipient/draft/contact handoff while retaining necessary active-order snapshots", async () => {
  const { order } = await checkout(other);
  const meta = await draft(other);
  assert.equal((await call(other, "PATCH", "/me/checkout-draft", { ...fields, draftToken: meta.draftToken, draftRevision: meta.draftRevision + 1 })).statusCode, 200);
  await pool.query("UPDATE users SET contact_phone_enc=$2,contact_phone_at=now() WHERE id=$1", [other.id, encrypt(fields.phone)]);
  await call(other, "POST", "/me/deletion-request", {});
  await tick();
  const clean = await draft(other);
  assert.equal(clean.phone, undefined);
  assert.equal(clean.saveRecipient, false);
  assert.notEqual(clean.draftToken, meta.draftToken);
  assert.equal((await call(other, "GET", "/me/contact")).json().phone, undefined);
  const active = (await call(staff, "GET", `/orders/${order.id}`)).json();
  assert.equal(active.recipient.phone, fields.phone);
  const pending = (await pool.query("SELECT status FROM deletion_requests WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1", [other.id])).rows[0];
  assert.equal(pending.status, "RESTRICTED");
  await pool.query("UPDATE orders SET status='CLOSED',completed_at=now() WHERE id=$1", [order.id]);
  await tick();
  const finished = (await pool.query("SELECT recipient_enc,buyer_snapshot_enc FROM orders WHERE id=$1", [order.id])).rows[0];
  assert.equal(finished.recipient_enc, null);
  assert.equal(finished.buyer_snapshot_enc, null);
});

test("concurrent PostgreSQL autosaves converge on the newest revision without acknowledging competing content", async () => {
  const meta = await draft(buyer);
  const replies = await Promise.all([
    call(buyer, "PATCH", "/me/checkout-draft", { ...fields, phone: "+375290000033", draftToken: meta.draftToken, draftRevision: meta.draftRevision + 1 }),
    call(buyer, "PATCH", "/me/checkout-draft", { ...fields, phone: "+375290000044", draftToken: meta.draftToken, draftRevision: meta.draftRevision + 2 }),
  ]);
  assert.equal(replies[1].statusCode, 200, replies[1].body);
  assert.ok([200, 409].includes(replies[0].statusCode), replies[0].body);
  const restored = await draft(buyer);
  assert.equal(restored.phone, "+375290000044");
  const competing = await call(buyer, "PATCH", "/me/checkout-draft", { ...fields, phone: "+375290000055", draftToken: meta.draftToken, draftRevision: meta.draftRevision + 2 });
  assert.equal(competing.statusCode, 409);
  assert.equal(competing.json().code, "DRAFT_STALE");
  assert.equal((await draft(buyer)).phone, "+375290000044");
});
