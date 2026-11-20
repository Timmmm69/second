import { test } from "node:test";
import assert from "node:assert/strict";
import { createCapture, postHogConfig, readCampaign } from "../shared/posthog.js";

const token = "phc_synthetic_not_real";
const config = { token, region: "eu" } as const;
const acceptedId = "f94d79db-f573-4de4-87cd-0a4a5d01814a";

function fixture() {
  const storage = new Map<string, string>();
  const requests: { url: string; request: RequestInit }[] = [];
  const deps = {
    storage: () => ({
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value); },
    }),
    randomId: () => acceptedId,
    search: () => "?utm_source=telegram&utm_medium=social&utm_campaign=minsk_mir&phone=555123&initData=invalid&search=coat",
    channel: () => "telegram" as "telegram" | "browser",
    disabledByUser: () => false,
    send: async (url: string, request: RequestInit) => { requests.push({ url, request }); },
  };
  return { storage, requests, deps };
}

test("PostHog is explicitly gated and accepts only supported cloud regions and public keys", () => {
  assert.equal(postHogConfig({ POSTHOG_PROJECT_TOKEN: token }), undefined);
  assert.equal(postHogConfig({ POSTHOG_ANALYTICS_ENABLED: "true", POSTHOG_PROJECT_TOKEN: token, POSTHOG_REGION: "invalid" }), undefined);
  assert.equal(postHogConfig({ POSTHOG_ANALYTICS_ENABLED: "true", POSTHOG_PROJECT_TOKEN: "phx_personal_not_project" }), undefined);
  assert.deepEqual(postHogConfig({ POSTHOG_ANALYTICS_ENABLED: "true", POSTHOG_PROJECT_TOKEN: token }), config);
});

test("only known campaign tuples are accepted; duplicated and free-form values are ignored", () => {
  const query = "?utm_source=telegram&utm_medium=social&utm_campaign=minsk_mir";
  assert.deepEqual(readCampaign(query), { utm_source: "telegram", utm_medium: "social", utm_campaign: "minsk_mir" });
  assert.deepEqual(readCampaign(query + "&utm_campaign=minsk_mir"), {});
  assert.deepEqual(readCampaign(query.replace("minsk_mir", "private-contact%40example.org")), {});
});

test("milestones are strictly allowlisted, once per visit even after recreation, and share a pseudonymous id", () => {
  const { deps, requests } = fixture();
  const capture = createCapture(deps);
  capture(config, "product_viewed");
  capture(config, "product_viewed");
  capture(config, "checkout_started");
  capture(config, "order_submitted");
  createCapture(deps)(config, "order_submitted");
  assert.equal(requests.length, 3);
  const first = requests[0];
  assert.equal(first.url, "https://eu.i.posthog.com/i/v0/e/");
  assert.equal(first.request.referrerPolicy, "no-referrer");
  assert.equal(first.request.credentials, "omit");
  assert.equal(first.request.redirect, "error");
  assert.deepEqual(JSON.parse(String(first.request.body)), {
    api_key: token, event: "product_viewed", properties: {
      distinct_id: acceptedId, $process_person_profile: false, $geoip_disable: true,
      channel: "telegram", utm_source: "telegram", utm_medium: "social", utm_campaign: "minsk_mir",
    },
  });
  assert.deepEqual(requests.map(({ request }) => JSON.parse(String(request.body)).event),
    ["product_viewed", "checkout_started", "order_submitted"]);
  assert.ok(requests.every(({ request }) => JSON.parse(String(request.body)).properties.distinct_id === acceptedId));
});

test("disabled, privacy-opted-out and storage-blocked visits neither send nor store anything", () => {
  const { deps, requests, storage } = fixture();
  createCapture(deps)(undefined, "product_viewed");
  createCapture({ ...deps, disabledByUser: () => true })(config, "product_viewed");
  createCapture({ ...deps, storage: () => { throw new Error("blocked"); } })(config, "product_viewed");
  assert.equal(requests.length, 0);
  assert.equal(storage.size, 0);
});

test("a network error does not throw or trigger replay and browser is distinguished", async () => {
  const { deps, requests } = fixture();
  const capture = createCapture({ ...deps, channel: () => "browser", send: async (url, request) => {
    await deps.send(url, request);
    throw new Error("blocked");
  } });
  const us = { ...config, region: "us" } as const;
  assert.doesNotThrow(() => capture(us, "order_submitted"));
  await Promise.resolve();
  capture(us, "order_submitted");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://us.i.posthog.com/i/v0/e/");
  assert.equal(JSON.parse(String(requests[0].request.body)).properties.channel, "browser");
});
