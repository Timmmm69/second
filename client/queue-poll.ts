/**
 * Refresh staff queues while visible; immediately catch up after switching back.
 * Focus and visibility events for the same return must cause one refresh.
 */
export function startVisibleQueuePolling(
  refresh: () => void,
  env: {
    page: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;
    browser: Pick<Window, "addEventListener" | "removeEventListener">;
    schedule: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
    cancel: (handle: ReturnType<typeof setInterval>) => void;
    now: () => number;
  } = {
    page: document,
    browser: window,
    schedule: setInterval,
    cancel: clearInterval,
    now: Date.now,
  },
) {
  let background = env.page.visibilityState !== "visible";
  let lastRefresh = -Infinity;
  const refreshVisible = () => {
    if (env.page.visibilityState !== "visible") {
      background = true;
      return;
    }
    const time = env.now();
    // A timer can coincide with focus + visibilitychange; avoid the burst.
    if (time - lastRefresh < 1000) return;
    lastRefresh = time;
    refresh();
  };
  const onReturn = () => {
    if (env.page.visibilityState !== "visible") {
      background = true;
      return;
    }
    if (background) {
      background = false;
      refreshVisible();
    }
  };
  const onBlur = () => { background = true; };
  const timer = env.schedule(refreshVisible, 30000);
  env.page.addEventListener("visibilitychange", onReturn);
  env.browser.addEventListener("focus", onReturn);
  env.browser.addEventListener("blur", onBlur);
  return () => {
    env.cancel(timer);
    env.page.removeEventListener("visibilitychange", onReturn);
    env.browser.removeEventListener("focus", onReturn);
    env.browser.removeEventListener("blur", onBlur);
  };
}
