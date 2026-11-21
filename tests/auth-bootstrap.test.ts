import { test } from "node:test";
import assert from "node:assert/strict";
import { createAuthBootstrap } from "../client/auth-bootstrap.js";

test("Telegram success uses the POST result without an extra session GET", async () => {
  let telegramCalls = 0, sessionCalls = 0;
  const bootstrap = createAuthBootstrap(
    async (data) => { telegramCalls++; return { user: { id: data, role: "STAFF" }, dev: false }; },
    async () => { sessionCalls++; return { user: null, dev: false }; },
  );
  const [one, two] = await Promise.all([bootstrap("signed-data"), bootstrap("signed-data")]);
  assert.deepEqual(one, two);
  assert.equal(one.user?.role, "STAFF");
  assert.equal(telegramCalls, 1);
  assert.equal(sessionCalls, 0);
  assert.deepEqual(await bootstrap("signed-data"), one, "StrictMode replay cannot reauthorize");
  assert.equal(telegramCalls, 1);
  assert.equal(sessionCalls, 0);
  assert.equal((await bootstrap(undefined)).user, null, "ordinary browser still checks session");
  assert.equal(sessionCalls, 1);
  assert.equal((await bootstrap("another-signed-payload")).user?.id, "another-signed-payload");
  assert.equal(telegramCalls, 2);
});

test("invalid initData fails closed and does not trigger auth/me fallback", async () => {
  let fallback = 0, logins = 0;
  const bootstrap = createAuthBootstrap(
    async () => { logins++; throw new Error("AUTH_REPLAY"); },
    async () => { fallback++; return { user: null, dev: false }; },
  );
  await assert.rejects(bootstrap("invalid"), /AUTH_REPLAY/);
  await assert.rejects(bootstrap("invalid"), /AUTH_REPLAY/);
  assert.equal(logins, 1);
  assert.equal(fallback, 0);
});

test("late Telegram SDK calls auth exactly once after browser fallback", async () => {
  let get = 0, post = 0;
  const bootstrap = createAuthBootstrap(
    async () => { post++; return { user: { role: "OWNER" }, dev: false }; },
    async () => { get++; return { user: null, dev: false }; },
  );
  assert.equal((await bootstrap(undefined)).user, null);
  assert.equal((await bootstrap("late-initData")).user?.role, "OWNER");
  assert.equal((await bootstrap("late-initData")).user?.role, "OWNER");
  assert.equal(get, 1);
  assert.equal(post, 1);
});
