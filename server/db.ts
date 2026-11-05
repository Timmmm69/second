import pg from "pg";
import { config } from "./config.js";
export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: config.databasePoolMax,
  connectionTimeoutMillis: 5000,
  statement_timeout: 15000,
});
pool.on("error", () =>
  console.error(
    JSON.stringify({ level: "error", code: "DATABASE_CONNECTION_LOST" }),
  ),
);
export const query = (text: string, params?: any[]) => pool.query(text, params);
export async function tx<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const result = await fn(c);
      await c.query("COMMIT");
      return result;
    } catch (e) {
      await c.query("ROLLBACK");
      if (["40P01", "40001"].includes((e as any).code) && attempt < 2) continue;
      throw e;
    } finally {
      c.release();
    }
  }
}
