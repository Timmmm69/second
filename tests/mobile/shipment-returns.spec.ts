import { expect, test, type Page } from "@playwright/test";
import { installMobileMocks } from "./helpers.js";
import type { Order } from "../../client/types.js";

async function setup(page: Page, browserName: string, role: "OWNER" | "STAFF") {
  const mobile = await installMobileMocks(page, browserName);
  const item = mobile.items[0];
  const order: Order = {
    id: "shipment-test", number: 1300, method: "BELPOST", status: "IN_FULFILLMENT",
    reservationStatus: "FULFILLED", version: 4, totalMinor: item.priceMinor,
    createdAt: "2026-11-25T10:00:00Z", verifyBy: "2026-11-25T14:00:00Z",
    recipient: { method: "BELPOST", phone: "+375291234567", fullName: "Тестовый покупатель", city: "Минск", office: "Тестовое отделение", postalCode: "220000", comment: "" },
    lines: [{ id: "line-test", itemId: item.id, title: item.title, sku: item.sku, priceMinor: item.priceMinor, outcome: "RESERVED", checked: true, attributes: item.attributes, media: item.media }],
    shipment: { id: "parcel-test", tracking: "TEST-TRACK", status: "ACCEPTED", source: "Тестовая приёмка", updatedAt: "2026-11-25T10:00:00Z" },
  };
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  await page.route("**/api/auth/me", route => route.fulfill({ json: { user: { id: "owner-test", telegramId: "990000001", role }, dev: false } }));
  await page.route("**/api/staff/categories", route => route.fulfill({ json: [] }));
  await page.route("**/api/orders/shipment-test", route => route.fulfill({ json: order }));
  await page.route("**/api/staff/shipments/parcel-test/*", async route => {
    const body = route.request().postDataJSON();
    const path = new URL(route.request().url()).pathname.split("/").at(-1)!;
    requests.push({ path, body });
    if (body.mode === "undo") {
      order.status = "DISPATCH_READY"; order.reservationStatus = "ACTIVE"; order.shipment!.status = "REGISTERED";
    } else if (body.mode === "cancel") {
      order.status = "CANCELLED"; order.reservationStatus = "CANCELLED"; order.shipment = undefined;
      order.lines[0].outcome = "CANCELLED";
    } else {
      order.status = "RETURNED"; order.shipment!.status = "RETURN_RECEIVED"; order.lines[0].outcome = "RETURNED";
    }
    order.version++;
    await route.fulfill({ json: order });
  });
  await page.goto("/#/staff/orders/shipment-test");
  await expect(page.getByRole("button", { name: "Посылка вернулась в магазин" })).toBeVisible();
  return { requests, mobile };
}

test("owner receives and restores stock with a single confirmed request", async ({ page, browserName }) => {
  const { requests, mobile } = await setup(page, browserName, "OWNER");
  await page.getByRole("button", { name: "Посылка вернулась в магазин" }).click();
  const dialog = page.getByRole("dialog", { name: "Получение возврата" });
  await expect(dialog.getByRole("button", { name: "Подтвердить получение" })).toBeDisabled();
  await dialog.getByRole("checkbox", { name: "Все перечисленные вещи физически получены магазином" }).check();
  await dialog.getByRole("checkbox", { name: "Все вещи осмотрены, пригодны и возвращены в зал" }).check();
  await dialog.getByRole("button", { name: "Получить и вернуть в продажу" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Посылка · Возврат получен" })).toBeVisible();
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ path: "events", body: { version: 4, status: "RETURN_RECEIVED", confirmedReceipt: true, restoreToSale: true } });
  expect(mobile.pageErrors).toEqual([]);
});

test("erroneous shipment confirmation can be undone, then the order cancelled without false carrier events", async ({ page, browserName }) => {
  const { requests, mobile } = await setup(page, browserName, "OWNER");
  await page.getByRole("button", { name: "Отправку подтвердили по ошибке" }).click();
  const correction = page.getByRole("dialog", { name: "Исправить отправку" });
  await expect(correction.getByRole("button", { name: "Отменить отметку об отправке" })).toBeDisabled();
  await correction.getByRole("checkbox", { name: "Посылка не была сдана почте, все вещи в магазине" }).check();
  await correction.getByRole("button", { name: "Отменить отметку об отправке" }).click();
  await expect(correction).toHaveCount(0);
  await page.getByRole("button", { name: "Отменить заказ и освободить вещи" }).click();
  const cancellation = page.getByRole("dialog", { name: "Отменить заказ" });
  await cancellation.getByRole("checkbox", { name: "Посылка не была сдана почте, все вещи в магазине" }).check();
  await expect(cancellation.getByRole("button", { name: "Отменить заказ", exact: true })).toBeDisabled();
  await cancellation.getByRole("checkbox", { name: "Оформление отменено у перевозчика" }).check();
  await cancellation.getByRole("checkbox", { name: "Все вещи осмотрены, пригодны и возвращены в зал" }).check();
  await cancellation.getByRole("button", { name: "Отменить и вернуть в продажу" }).click();
  await expect(cancellation).toHaveCount(0);
  expect(requests).toHaveLength(2);
  expect(requests[0]).toMatchObject({ path: "correct", body: { version: 4, mode: "undo", inStore: true } });
  expect(requests[1]).toMatchObject({ path: "correct", body: { version: 5, mode: "cancel", carrierCancelled: true, restoreToSale: true } });
  expect(mobile.pageErrors).toEqual([]);
});

test("employee can receive a physical parcel but cannot release stock or correct acceptance", async ({ page, browserName }) => {
  const { requests } = await setup(page, browserName, "STAFF");
  await expect(page.getByRole("button", { name: "Отправку подтвердили по ошибке" })).toHaveCount(0);
  await page.getByRole("button", { name: "Посылка вернулась в магазин" }).click();
  const dialog = page.getByRole("dialog", { name: "Получение возврата" });
  await expect(dialog.getByRole("checkbox", { name: "Все вещи осмотрены, пригодны и возвращены в зал" })).toHaveCount(0);
  await dialog.getByRole("checkbox", { name: "Все перечисленные вещи физически получены магазином" }).check();
  await dialog.getByRole("button", { name: "Подтвердить получение" }).click();
  await expect(dialog).toHaveCount(0);
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ path: "events", body: { confirmedReceipt: true, restoreToSale: false } });
});
