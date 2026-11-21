import { createCapture } from "../shared/posthog.js";
import { tg } from "./telegram";

export const trackShopMilestone = createCapture({
  storage: () => window.sessionStorage,
  randomId: () => crypto.randomUUID(),
  search: () => location.search,
  channel: () => tg()?.initData ? "telegram" : "browser",
  disabledByUser: () => {
    const browser = navigator as Navigator & { globalPrivacyControl?: boolean };
    return browser.globalPrivacyControl === true || browser.doNotTrack === "1";
  },
  send: (url, request) => fetch(url, request),
});
