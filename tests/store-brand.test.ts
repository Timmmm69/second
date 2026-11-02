import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { PoolClient } from "pg";
import { pool } from "../server/db.js";
import { migrate } from "../server/migrate.js";

let sql: string;
before(async () => {
  assert.match(process.env.DATABASE_URL ?? "", /_test$/);
  await migrate();
  sql = await readFile(
    new URL("../server/migrations/004.sql", import.meta.url),
    "utf8",
  );
});
after(() => pool.end());

async function isolated(run: (c: PoolClient) => Promise<void>) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await run(c);
  } finally {
    await c.query("ROLLBACK");
    c.release();
  }
}

test("store rename preserves contacts, launch flags and previous settings", () =>
  isolated(async (c) => {
    const original = (
      await c.query("SELECT value, version FROM store_settings WHERE id=true")
    ).rows[0];
    const value = {
      ...original.value,
      name: "Вещи",
      address: "Адрес, введённый владельцем",
      telegramUsername: "store_support",
      acceptingOrders: false,
    };
    await c.query("UPDATE store_settings SET value=$1 WHERE id=true", [value]);
    const history = Number(
      (await c.query("SELECT count(*) FROM rule_versions")).rows[0].count,
    );
    await c.query(sql);
    const renamed = (
      await c.query("SELECT value, version FROM store_settings WHERE id=true")
    ).rows[0];
    assert.deepEqual(renamed.value, { ...value, name: "Лучок" });
    assert.equal(renamed.version, original.version + 1);
    assert.deepEqual(
      (
        await c.query("SELECT value FROM rule_versions ORDER BY id DESC LIMIT 1")
      ).rows[0].value,
      value,
    );
    await c.query(sql);
    assert.deepEqual(
      (await c.query("SELECT value, version FROM store_settings WHERE id=true"))
        .rows[0],
      renamed,
    );
    assert.equal(
      Number((await c.query("SELECT count(*) FROM rule_versions")).rows[0].count),
      history + 1,
    );
  }));

test("store rename leaves an owner-entered name and version untouched", () =>
  isolated(async (c) => {
    await c.query(
      "UPDATE store_settings SET value=jsonb_set(value,'{name}',$1::jsonb) WHERE id=true",
      [JSON.stringify("Лучок · название владельца")],
    );
    const before = (await c.query("SELECT * FROM store_settings WHERE id=true"))
      .rows[0];
    await c.query(sql);
    assert.deepEqual(
      (await c.query("SELECT * FROM store_settings WHERE id=true")).rows[0],
      before,
    );
  }));
