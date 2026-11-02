import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { validateInitData, totp, verifyTotp } from "../server/auth.js";
import { notificationUrl } from "../server/jobs.js";
import { loadConfig } from "../server/config.js";
const token = "123:local-test-secret",
  now = Date.now();
function signed(extra: Record<string, string> = {}) {
  const p = new URLSearchParams({
    auth_date: String(Math.floor(now / 1000)),
    user: JSON.stringify({ id: 123456, first_name: "Покупатель" }),
    signature: "signed-field",
    ...extra,
  });
  const data = [...p.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  p.set(
    "hash",
    createHmac(
      "sha256",
      createHmac("sha256", "WebAppData").update(token).digest(),
    )
      .update(data)
      .digest("hex"),
  );
  return p.toString();
}
test("T19 validates HMAC including signature using bot token path", () =>
  assert.equal(validateInitData(signed(), token, now).id, 123456));
test("T19 rejects invalid, duplicate, old, future, malformed and other bot", () => {
  for (const value of [
    signed() + "&user=x",
    signed({ auth_date: "1" }),
    signed({ auth_date: String(Math.floor(now / 1000) + 60) }),
    signed().replace("hash=", "hash=f"),
    signed() + "&a=%GG",
  ])
    assert.throws(() => validateInitData(value, token, now));
  assert.throws(() => validateInitData(signed(), "wrong", now));
});
test("production prohibits local login and missing production secrets", () => {
  assert.throws(() =>
    loadConfig({ NODE_ENV: "production", APP_MODE: "local" }),
  );
  assert.throws(() => loadConfig({ NODE_ENV: "production" }));
});
test("TOTP RFC6238 vector and window", () => {
  const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  assert.equal(totp(secret, 59000, 8), "94287082");
  assert.ok(verifyTotp(secret, totp(secret, now), now));
  assert.equal(verifyTotp(secret, "invalid", now), false);
});


test("notification links match buyer, staff order and problems routes",()=>{
  const id="11111111-1111-4111-8111-111111111111";
  assert.equal(new URL(notificationUrl("ORDER_CREATED",id)).hash,`#/orders/${id}`);
  for(const type of ["SHIPMENT_REQUEST","OWNER_ORDER_REQUEST"])
    assert.equal(new URL(notificationUrl(type,id)).hash,`#/staff/orders/${id}`);
  assert.equal(new URL(notificationUrl("OWNER_ISSUE",id)).hash,"#/staff/issues");
});
