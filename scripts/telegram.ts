/** No Telegram request is sent without --apply AND exact origin confirmation. */
export async function configureTelegram(
  argv = process.argv.slice(2),
  env = process.env,
) {
  const origin = env.APP_ORIGIN?.replace(/\/$/, "");
  if (!origin || !origin.startsWith("https://"))
    throw new Error("APP_ORIGIN должен быть вашим HTTPS-доменом.");
  const parsed = new URL(origin);
  if (
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    parsed.username ||
    parsed.password
  )
    throw new Error("APP_ORIGIN должен содержать только HTTPS origin.");
  const webhookUrl = origin + "/api/telegram/webhook";
  const apply = argv.includes("--apply");
  const confirm = argv.indexOf("--confirm-origin");
  if (!apply) {
    console.log(
      JSON.stringify(
        {
          mode: "dry-run",
          networkRequests: 0,
          planned: [
            {
              method: "setWebhook",
              url: webhookUrl,
              allowed_updates: ["message"],
            },
            { method: "setChatMenuButton", web_app: origin },
          ],
        },
        null,
        2,
      ),
    );
    return;
  }
  if (confirm < 0 || argv[confirm + 1] !== origin)
    throw new Error(
      "Для изменения рабочего бота подтвердите точный домен: --apply --confirm-origin " +
        origin,
    );
  if (
    !env.BOT_TOKEN ||
    !env.WEBHOOK_SECRET ||
    !/^[A-Za-z0-9_-]{32,256}$/.test(env.WEBHOOK_SECRET)
  )
    throw new Error(
      "Нужны BOT_TOKEN и WEBHOOK_SECRET (32–256 разрешённых символов) из защищённой конфигурации.",
    );
  const requests: [string, unknown][] = [
    [
      "setWebhook",
      {
        url: webhookUrl,
        secret_token: env.WEBHOOK_SECRET,
        allowed_updates: ["message"],
        drop_pending_updates: false,
      },
    ],
    [
      "setChatMenuButton",
      {
        menu_button: {
          type: "web_app",
          text: "Открыть магазин",
          web_app: { url: origin },
        },
      },
    ],
  ];
  for (const [method, body] of requests) {
    let response: Response;
    try {
      response = await fetch(
        `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15000),
        },
      );
    } catch {
      throw new Error(
        method +
          ": запрос не завершён. Сверьте фактические настройки бота; не повторяйте вслепую.",
      );
    }
    const result = (await response.json()) as {
      ok?: boolean;
      error_code?: number;
    };
    if (!response.ok || !result.ok)
      throw new Error(
        `${method}: Telegram отклонил запрос (${result.error_code ?? response.status}). Секреты и ответ Telegram не выводятся.`,
      );
    console.log(method + ": подтверждено Telegram.");
  }
  console.log(
    "Настройки применены. Main Mini App задайте в BotFather; скрипт не меняет профиль или описание бота.",
  );
}
if (process.argv[1] && /(?:^|\/)telegram\.(?:ts|js)$/.test(process.argv[1]))
  configureTelegram().catch((error) => {
    console.error(
      error instanceof Error
        ? error.message
        : "Настройка Telegram не завершена.",
    );
    process.exitCode = 1;
  });
