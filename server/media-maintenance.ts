import { readdir, stat, rm } from "node:fs/promises";
import path from "node:path";
import { pool } from "./db.js";
import { config } from "./config.js";
export async function sweepOrphanMedia(force = false) {
  const previous = (
    await pool.query("SELECT last_run_at FROM jobs WHERE name='media-sweep'")
  ).rows[0];
  if (
    !force &&
    previous &&
    Date.now() - new Date(previous.last_run_at).getTime() < 3600000
  )
    return { removed: 0 };
  let removed = 0;
  for (const dir of await readdir(config.mediaDir, {
    withFileTypes: true,
  }).catch(() => [])) {
    if (
      !dir.isDirectory() ||
      !/^[-0-9a-f]{36}(?:-stage-[-0-9a-f]{36})?$/.test(dir.name)
    )
      continue;
    const target = path.join(config.mediaDir, dir.name);
    const metadata = await stat(target);
    if (Date.now() - metadata.mtimeMs < 86400000) continue;
    if (
      !dir.name.includes("-stage-") &&
      (await pool.query("SELECT 1 FROM media_assets WHERE id=$1", [dir.name]))
        .rowCount
    )
      continue;
    await rm(target, { recursive: true, force: true });
    removed++;
  }
  await pool.query(
    "INSERT INTO jobs(name,state) VALUES('media-sweep',$1) ON CONFLICT(name) DO UPDATE SET last_run_at=now(),state=excluded.state",
    [{ removed }],
  );
  return { removed };
}
