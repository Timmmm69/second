import { expect, test, type Page } from "@playwright/test";
import { installMobileMocks } from "./helpers.js";

async function mockEmployee(page: Page, browserName: string) {
  const mobile = await installMobileMocks(page, browserName);
  // Override only the authorization and staff routes; all buyer mocks remain
  // identical to the standard mobile regression suite.
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({
      json: { user: { id: "staff-test", telegramId: "990000002", role: "STAFF" }, dev: false },
    }),
  );
  await page.route("**/api/staff/categories", (route) =>
    route.fulfill({ json: [] }),
  );
  await page.route(/\/api\/staff\/queue(?:\?.*)?$/, (route) =>
    route.fulfill({ json: { orders: [], issues: [] } }),
  );
  return mobile;
}

test("staff mode opens from the buyer menu without a blank screen", async ({ page, browserName }) => {
  const mobile = await mockEmployee(page, browserName);
  await page.goto("/#/catalog");
  await page.getByRole("button", { name: "Меню магазина" }).click();
  await page.getByRole("button", { name: "Режим сотрудника" }).click();
  await expect(page.getByRole("heading", { name: "Очередь" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Проверить" })).toBeVisible();
  expect(mobile.pageErrors).toEqual([]);
  expect(mobile.unexpectedRequests).toEqual([]);
});

test("failed lazy employee module shows a recovery screen instead of blanking", async ({ page, browserName }) => {
  await mockEmployee(page, browserName);
  await page.route("**/client/staff.tsx*", (route) => route.abort());
  await page.goto("/#/catalog");
  await page.getByRole("button", { name: "Меню магазина" }).click();
  await page.getByRole("button", { name: "Режим сотрудника" }).click();
  await expect(page.getByRole("heading", { name: "Не удалось открыть раздел" })).toBeVisible();
  await page.getByRole("button", { name: "В каталог" }).click();
  await expect(page.locator(".product-card").first()).toBeVisible();
});
