import path from "node:path";
export function loadConfig(env = process.env) {
  const production = env.NODE_ENV === "production";
  const localDev = env.APP_MODE === "local" && !production;
  if (production && env.APP_MODE === "local")
    throw new Error("Local authorization forbidden in production");
  if (
    production &&
    (!env.BOT_TOKEN ||
      !env.WEBHOOK_SECRET ||
      !env.DATA_KEY ||
      !env.APP_ORIGIN?.startsWith("https://"))
  )
    throw new Error(
      "Production requires BOT_TOKEN, WEBHOOK_SECRET, DATA_KEY and HTTPS APP_ORIGIN",
    );
  if (production && env.BOT_DELIVERY_MODE !== "live")
    throw new Error("Production requires explicit BOT_DELIVERY_MODE=live");
  if (
    production &&
    (!/^\d{5,}:[A-Za-z0-9_-]{30,}$/.test(env.BOT_TOKEN ?? "") ||
      (env.WEBHOOK_SECRET ?? "").length < 32)
  )
    throw new Error(
      "Production requires valid bot token format and strong webhook secret",
    );
  const key =
    env.DATA_KEY ??
    (localDev
      ? "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
      : "");
  if (
    production &&
    key === "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  )
    throw new Error("Development key forbidden in production");
  if (!/^[0-9a-f]{64}$/i.test(key))
    throw new Error("DATA_KEY must be 32 random bytes in hex");
  return {
    production,
    localDev,
    port: Number(env.PORT ?? 3000),
    host: env.HOST ?? "127.0.0.1",
    databaseUrl:
      env.DATABASE_URL ??
      "postgresql://veshi:veshi_local@127.0.0.1:5432/veshi_dev",
    origin: env.APP_ORIGIN ?? "http://localhost:5173",
    botToken: env.BOT_TOKEN ?? "",
    webhookSecret: env.WEBHOOK_SECRET ?? "",
    dataKey: key,
    mediaDir: path.resolve(env.MEDIA_DIR ?? "var/media"),
    botDeliveryMode: env.BOT_DELIVERY_MODE ?? "dry-run",
    sessionHours: 12,
  };
}
export const config = loadConfig();
