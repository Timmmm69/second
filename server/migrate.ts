import { readFile, readdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { pool, tx } from "./db.js";
export async function migrate() {
  await tx(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(12002026)");
    await c.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    for (const name of (
      await readdir(new URL("./migrations/", import.meta.url))
    )
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      if (
        (await c.query("SELECT 1 FROM schema_migrations WHERE name=$1", [name]))
          .rowCount
      )
        continue;
      await c.query(
        await readFile(
          new URL("./migrations/" + name, import.meta.url),
          "utf8",
        ),
      );
      await c.query("INSERT INTO schema_migrations(name) VALUES($1)", [name]);
    }
  });
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  migrate()
    .then(() => console.log("Migrations complete"))
    .finally(() => pool.end());
}
