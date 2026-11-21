export const postHogOrigins = {
  eu: "https://eu.i.posthog.com",
  us: "https://us.i.posthog.com",
} as const;
type PostHogRegion = keyof typeof postHogOrigins;
export type PublicPostHog = { token: string; region: PostHogRegion };
export type FunnelEvent = "product_viewed" | "checkout_started" | "order_submitted";
export type AnalyticsChannel = "browser" | "telegram";

export function postHogConfig(env: Record<string, string | undefined>): PublicPostHog | undefined {
  const token = env.POSTHOG_PROJECT_TOKEN;
  const region = env.POSTHOG_REGION ?? "eu";
  if (env.POSTHOG_ANALYTICS_ENABLED !== "true" || !token ||
      !/^phc_[A-Za-z0-9_-]{12,120}$/.test(token) || (region !== "eu" && region !== "us")) return;
  return { token, region };
}

const campaignTuples = [
  ["telegram", "social", "minsk_mir"],
  ["telegram", "social", "new_arrivals"],
  ["instagram", "social", "profile"],
  ["offline", "qr", "shop"],
] as const;

export function readCampaign(search: string) {
  const query = new URLSearchParams(search);
  const fields = ["utm_source", "utm_medium", "utm_campaign"] as const;
  const values = fields.map(field => query.getAll(field));
  const tuple = campaignTuples.find(parts => parts.every((part, i) =>
    values[i].length === 1 && values[i][0] === part));
  return tuple ? { utm_source: tuple[0], utm_medium: tuple[1], utm_campaign: tuple[2] } : {};
}

type AnalyticsStorage = Pick<Storage, "getItem" | "setItem">;
export type CaptureDependencies = {
  storage: () => AnalyticsStorage;
  randomId: () => string;
  search: () => string;
  channel: () => AnalyticsChannel;
  disabledByUser: () => boolean;
  send: (url: string, request: RequestInit) => Promise<unknown>;
};

const visitKey = "luchok:analytics-visit-v1";
const validVisitId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const milestones: readonly FunnelEvent[] = ["product_viewed", "checkout_started", "order_submitted"];

export function createCapture(deps: CaptureDependencies) {
  const seen = new Set<FunnelEvent>();
  return (config: PublicPostHog | undefined, event: FunnelEvent) => {
    try {
      if (!config || deps.disabledByUser() || !milestones.includes(event) || seen.has(event)) return;
      const verified = postHogConfig({ POSTHOG_ANALYTICS_ENABLED: "true", POSTHOG_PROJECT_TOKEN: config.token, POSTHOG_REGION: config.region });
      if (!verified) return;
      const storage = deps.storage();
      const stored = storage.getItem(visitKey);
      const visitId = stored && validVisitId.test(stored) ? stored : deps.randomId();
      if (!validVisitId.test(visitId)) return;
      const sentKey = `${visitKey}:${event}`;
      if (stored === visitId && storage.getItem(sentKey) === visitId) return;
      storage.setItem(visitKey, visitId);
      storage.setItem(sentKey, visitId);
      seen.add(event);

      // Explicit milestones only: never include page URLs, referrers or customer/order fields.
      const body = JSON.stringify({
        api_key: verified.token,
        event,
        properties: {
          distinct_id: visitId,
          $process_person_profile: false,
          $geoip_disable: true,
          channel: deps.channel(),
          ...readCampaign(deps.search()),
        },
      });
      void deps.send(`${postHogOrigins[verified.region]}/i/v0/e/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        credentials: "omit",
        referrerPolicy: "no-referrer",
        redirect: "error",
        keepalive: true,
      }).catch(() => {}); // Never block the shop, retry or replay analytics.
    } catch {
      // If storage or randomness is unavailable, omit analytics.
    }
  };
}
