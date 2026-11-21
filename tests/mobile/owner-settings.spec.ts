import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import type { Settings } from "../../client/types.js";
import { installMobileMocks } from "./helpers.js";

const fixture = JSON.parse(
  readFileSync(new URL("../../preview/catalog.json", import.meta.url), "utf8"),
) as { settings: Settings };

test("OWNER edits carrier settings without Telegram reauthorization or one-time code", async ({ page, browserName }) => {
  const mobile = await installMobileMocks(page, browserName);
  let stored = structuredClone(fixture.settings);
  let saveCalls = 0;
  let ownerCodeSent = false;

  await page.route("**/api/auth/me", (route) =>
    route.fulfill({
      json: { user: { id: "owner-test", telegramId: "991122334", role: "OWNER" }, dev: false },
    }),
  );
  await page.route("**/api/staff/categories", (route) =>
    route.fulfill({ json: [] }),
  );
  await page.route("**/api/owner/settings", (route) => {
    if (route.request().method() === "PATCH") {
      saveCalls++;
      ownerCodeSent ||= "x-owner-code" in route.request().headers();
      const input = route.request().postDataJSON() as Settings;
      stored = { ...input, version: input.version + 1 };
    }
    return route.fulfill({ json: stored });
  });
  await page.route("**/api/settings", (route) => route.fulfill({ json: stored }));

  await page.goto("/#/owner");
  await expect(page.getByRole("heading", { name: "Управление" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Подтверждение владельца" })).toHaveCount(0);
  await expect(page.getByLabel("Одноразовый код владельца")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Подтвердить авторизацию Telegram" })).toHaveCount(0);

  const carrierCheckboxes = page.getByRole("checkbox", { name: "Доступна покупателям" });
  await expect(carrierCheckboxes).toHaveCount(2);
  await carrierCheckboxes.first().check();
  await carrierCheckboxes.nth(1).check();
  await page.getByRole("button", { name: "Сохранить настройки" }).click();
  await expect(page.getByRole("status")).toContainText("Настройки сохранены");
  expect(saveCalls).toBe(1);
  expect(ownerCodeSent).toBe(false);

  await page.reload();
  const persistedCheckboxes = page.getByRole("checkbox", { name: "Доступна покупателям" });
  await expect(persistedCheckboxes.first()).toBeChecked();
  await expect(persistedCheckboxes.nth(1)).toBeChecked();
  expect(mobile.pageErrors).toEqual([]);
  expect(mobile.unexpectedRequests).toEqual([]);
});
