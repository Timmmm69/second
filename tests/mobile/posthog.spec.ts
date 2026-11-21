import { expect, test, type Page } from "@playwright/test";
import { installMobileMocks, sampleId, sampleTitle, syntheticOrder, testAnalyticsToken } from "./helpers.js";

const card = "/#/items/" + sampleId;
const campaign = "/?utm_source=telegram&utm_medium=social&utm_campaign=minsk_mir&unlisted=synthetic-secret";
const captureMarker = "luchok:analytics-visit-v1";

async function checkout(page: Page) {
  await page.getByRole("navigation", { name: "Навигация покупателя" }).getByRole("button", { name: /Корзина/ }).click();
  await page.getByRole("button", { name: "Перейти к оформлению", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Оформление заявки" })).toBeVisible();
  await page.getByRole("button", { name: "Отправить заявку", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Бронь №" + syntheticOrder.number })).toBeVisible();
}

test("full card to saved order is private and deduplicated after reload", async ({ page, browserName }) => {
  const mocks = await installMobileMocks(page, browserName, { buyer: true, settings: true });
  await page.goto(campaign + card.slice(1));
  const add = page.getByRole("button", { name: "В корзину", exact: true }).first();
  await expect(add).toBeVisible();
  await expect.poll(() => mocks.capturedEvents.length).toBe(1);
  await add.click();
  await page.getByRole("button", { name: "Перейти в корзину", exact: true }).first().click();
  await page.getByRole("button", { name: "Перейти к оформлению", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Оформление заявки" })).toBeVisible();
  await expect.poll(() => mocks.capturedEvents.length).toBe(2);
  await page.getByRole("button", { name: "Отправить заявку", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Бронь №" + syntheticOrder.number })).toBeVisible();
  await expect.poll(() => mocks.capturedEvents.length).toBe(3);
  const distinct = await page.evaluate((key) => sessionStorage.getItem(key), captureMarker);
  expect(distinct).toMatch(/^[0-9a-f-]{36}$/);
  expect(mocks.capturedEvents.map(({body}) => body)).toEqual(
    ["product_viewed", "checkout_started", "order_submitted"].map((event) => ({
      api_key: testAnalyticsToken, event,
      properties: { distinct_id: distinct, channel: "telegram", $process_person_profile: false,
        $geoip_disable: true, utm_source: "telegram", utm_medium: "social", utm_campaign: "minsk_mir" },
    })),
  );
  for (const { headers } of mocks.capturedEvents) {
    expect(headers.referer).toBeUndefined();
    expect(headers.cookie).toBeUndefined();
  }
  await page.waitForLoadState("networkidle");
  // Keep the same document and campaign URL until the card is fully rendered.
  await page.evaluate((id) => { location.hash = "/items/" + id; }, sampleId);
  await expect(add).toBeVisible();
  await page.waitForLoadState("networkidle");
  await page.reload();
  await expect(add).toBeVisible();
  await page.waitForLoadState("networkidle");
  await expect.poll(() => mocks.apiRequests.filter((request) => request === "GET /items/" + sampleId).length).toBeGreaterThanOrEqual(2);
  expect(mocks.capturedEvents).toHaveLength(3);
  expect(mocks.unexpectedRequests).toEqual([]);
  expect(mocks.pageErrors).toEqual([]);
});

test("quick-add saves even when the mocked collector rejects", async ({ page, browserName }) => {
  const mocks = await installMobileMocks(page, browserName, { buyer: true, settings: true, failCapture: true });
  const selectionLoaded = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/me/selection" && response.ok());
  await page.goto("/#/catalog");
  await selectionLoaded;
  await page.getByRole("button", { name: "Добавить " + sampleTitle + " в корзину", exact: true }).click();
  await expect(page.getByRole("button", { name: "Убрать " + sampleTitle + " из корзины", exact: true })).toBeVisible();
  await checkout(page);
  await expect.poll(() => mocks.capturedEvents.map(({body}) => (body as {event: string}).event)).toEqual(["checkout_started", "order_submitted"]);
  expect(mocks.unexpectedRequests).toEqual([]);
  expect(mocks.pageErrors).toEqual([]);
});

test("fresh disabled visit renders item without writing analytics state", async ({ page, browserName }) => {
  const mocks = await installMobileMocks(page, browserName, { settings: false });
  await page.goto(card);
  await expect(page.getByRole("heading", { name: sampleTitle, exact: true })).toBeVisible();
  await expect.poll(() => mocks.apiRequests.includes("GET /settings")).toBe(true);
  expect(await page.evaluate((key) => sessionStorage.getItem(key), captureMarker)).toBeNull();
  expect(mocks.capturedEvents).toEqual([]);
  expect(mocks.unexpectedRequests).toEqual([]);
  expect(mocks.pageErrors).toEqual([]);
});

test("disabling settings after a tab is open suppresses a new checkout milestone on reload", async ({ page, browserName }) => {
  const settings = { buyer: true, settings: true };
  const mocks = await installMobileMocks(page, browserName, settings);
  await page.goto(card);
  await expect.poll(() => mocks.capturedEvents.length).toBe(1);
  expect(mocks.capturedEvents[0].body).toMatchObject({ event: "product_viewed" });
  await page.getByRole("button", { name: "В корзину", exact: true }).first().click();
  await expect(page.getByRole("button", { name: "Перейти в корзину", exact: true }).first()).toBeVisible();

  await page.waitForLoadState("networkidle");
  settings.settings = false;
  const refreshedSettings = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/settings" && response.ok());
  await page.reload();
  expect(await (await refreshedSettings).json()).not.toHaveProperty("posthog");
  await page.getByRole("button", { name: "Перейти в корзину", exact: true }).first().click();
  await page.getByRole("button", { name: "Перейти к оформлению", exact: true }).click();
  await expect(page.getByRole("button", { name: "Отправить заявку", exact: true })).toBeEnabled();
  expect(await page.evaluate((key) => sessionStorage.getItem(key + ":checkout_started"), captureMarker)).toBeNull();
  expect(mocks.capturedEvents).toHaveLength(1);
  expect(mocks.unexpectedRequests).toEqual([]);
  expect(mocks.pageErrors).toEqual([]);
});
