import pg from "pg";
import { verifyTotp, totpStep } from "../server/auth.js";
import { encrypt } from "../server/crypto.js";

/** Deliberately an out-of-band server CLI, never an HTTP bootstrap route. */
export async function createFirstOwner(
  argv = process.argv.slice(2),
  env = process.env,
) {
  const option = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const telegramId = option("--telegram-id");
  const confirmId = option("--confirm-telegram-id");
  if (
    !telegramId ||
    !/^[1-9]\d{4,18}$/.test(telegramId) ||
    telegramId !== confirmId
  ) {
    throw new Error(
      "Укажите проверенный Telegram ID дважды: --telegram-id ID --confirm-telegram-id ID. Имя пользователя не подходит.",
    );
  }
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL не задан.");
  const secret = env.OWNER_PERSONAL_TOTP_SECRET ?? "";
  const code = env.OWNER_PERSONAL_TOTP_CODE ?? "";
  if (!/^[A-Z2-7]{32,}$/i.test(secret) || !verifyTotp(secret, code))
    throw new Error("Нужен личный Base32-секрет (32+ символа) и текущий код из аутентификатора в защищённых OWNER_PERSONAL_TOTP_SECRET/OWNER_PERSONAL_TOTP_CODE. Секрет не печатается.");
  const enroll = argv.includes("--enroll-totp");
  const add = argv.includes("--add-owner");
  if (enroll && add) throw new Error("Выберите одну операцию: назначение или подключение фактора.");
  const pool = new pg.Pool({
    connectionString: env.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
  });
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT pg_advisory_xact_lock(12002027)");
    const existing = await c.query(
      "SELECT id FROM users WHERE role='OWNER' FOR UPDATE",
    );
    if (existing.rowCount && !add && !enroll)
      throw new Error(
        "Первый владелец уже назначен. Повторная выдача владельца этим CLI запрещена.",
      );
    const candidate = await c.query(
      "SELECT id,role,telegram_verified_at FROM users WHERE telegram_id=$1 FOR UPDATE",
      [telegramId],
    );
    if (!candidate.rowCount || !candidate.rows[0].telegram_verified_at)
      throw new Error(
        "Пользователь ещё не прошёл проверенный Telegram-вход. Откройте Mini App с нужного аккаунта, затем повторите CLI.",
      );
    const id = candidate.rows[0].id as string;
    if (enroll && candidate.rows[0].role !== "OWNER") throw new Error("Подключение фактора не меняет роль. Нужен существующий владелец.");
    if (add) {
      const authorizer = option("--authorizing-telegram-id");
      const owner = (await c.query("SELECT id FROM users WHERE telegram_id=$1 AND role='OWNER'", [authorizer ?? "0"])).rows[0];
      if (!owner || !existing.rowCount || candidate.rows[0].role === "OWNER") throw new Error("Для второго владельца нужен текущий владелец --authorizing-telegram-id и другой проверенный аккаунт.");
    }
    if ((await c.query("SELECT 1 FROM owner_credentials WHERE user_id=$1", [id])).rowCount && !argv.includes("--confirm-factor-reset"))
      throw new Error("Фактор уже подключён. Для восстановления нужен явный --confirm-factor-reset; все сессии будут отозваны.");
    await c.query("INSERT INTO owner_credentials(user_id,secret_enc,last_step) VALUES($1,$2,$3) ON CONFLICT(user_id) DO UPDATE SET secret_enc=excluded.secret_enc,last_step=excluded.last_step,updated_at=now()", [id, encrypt(secret), totpStep(secret, code)]);
    await c.query(
      "UPDATE users SET role='OWNER',auth_version=auth_version+1,updated_at=now() WHERE id=$1",
      [id],
    );
    await c.query(
      "UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL",
      [id],
    );
    await c.query(
      "INSERT INTO audit_events(actor_id,command,entity_type,entity_id,details) VALUES($1,$4,'User',$2,$3)",
      [
        id,
        id,
        {
          previousRole: candidate.rows[0].role,
          newRole: "OWNER",
          source: "out-of-band CLI",
          authorizingTelegramId: option("--authorizing-telegram-id") ?? null,
        },
        enroll ? "OWNER_TOTP_SERVER_CLI" : add ? "ADD_OWNER_SERVER_CLI" : "FIRST_OWNER_SERVER_CLI",
      ],
    );
    await c.query("COMMIT");
    console.log(
      "Операция владельца выполнена, личный фактор подключён. Предыдущие сессии отозваны; переоткройте Mini App.",
    );
  } catch (error) {
    await c.query("ROLLBACK");
    throw error;
  } finally {
    c.release();
    await pool.end();
  }
}
if (process.argv[1] && /(?:^|\/)owner\.(?:ts|js)$/.test(process.argv[1])) {
  createFirstOwner().catch((error) => {
    console.error(
      error instanceof Error && !("code" in error)
        ? error.message
        : "Назначение владельца не выполнено; проверьте защищённую конфигурацию и БД.",
    );
    process.exitCode = 1;
  });
}
