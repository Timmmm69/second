import pg from "pg";

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
  if (
    !env.OWNER_TOTP_SECRET ||
    !/^[A-Z2-7]{32,}$/i.test(env.OWNER_TOTP_SECRET)
  ) {
    throw new Error(
      "Сначала сохраните отдельный секрет OWNER_TOTP_SECRET (Base32, от 32 символов) в защищённой конфигурации и подключите его к приложению аутентификации. CLI не печатает секрет.",
    );
  }
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
    if (existing.rowCount)
      throw new Error(
        "Первый владелец уже назначен. Повторная выдача владельца этим CLI запрещена.",
      );
    const candidate = await c.query(
      "SELECT id,role FROM users WHERE telegram_id=$1 FOR UPDATE",
      [telegramId],
    );
    if (!candidate.rowCount)
      throw new Error(
        "Пользователь ещё не прошёл проверенный Telegram-вход. Откройте Mini App с нужного аккаунта, затем повторите CLI.",
      );
    const id = candidate.rows[0].id as string;
    await c.query(
      "UPDATE users SET role='OWNER',auth_version=auth_version+1,updated_at=now() WHERE id=$1",
      [id],
    );
    await c.query(
      "UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL",
      [id],
    );
    await c.query(
      "INSERT INTO audit_events(actor_id,command,entity_type,entity_id,details) VALUES($1,'FIRST_OWNER_SERVER_CLI','User',$2,$3)",
      [
        id,
        id,
        {
          previousRole: candidate.rows[0].role,
          newRole: "OWNER",
          source: "out-of-band CLI",
        },
      ],
    );
    await c.query("COMMIT");
    console.log(
      "Первый владелец назначен. Предыдущие сессии отозваны; переоткройте Mini App.",
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
