/**
 * One Telegram initData is authenticated once per mounted app. Reusing the
 * pending result also survives StrictMode effect replay and late SDK readiness.
 * Ordinary browser session reads remain independent and server-authoritative.
 */
export function createAuthBootstrap<T>(
  telegramLogin: (initData: string) => Promise<{ user: T | null; dev: boolean }>,
  readSession: () => Promise<{ user: T | null; dev: boolean }>,
) {
  let last: { initData: string; result: Promise<{ user: T | null; dev: boolean }> } | null = null;
  return (initData: string | undefined) => {
    if (!initData) return readSession();
    if (!last || last.initData !== initData)
      last = { initData, result: telegramLogin(initData) };
    return last.result;
  };
}
