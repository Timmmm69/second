import { expect, test, type Page, type Route } from "@playwright/test";
import { installMobileMocks, updateTelegram, sampleId } from "./helpers.js";
import type { Item, Media } from "../../client/types.js";

async function editorFixture(page: Page, browserName: string, firstUpload?: Promise<void>) {
  const mobile = await installMobileMocks(page, browserName);
  const categories = [
    { id: "tops", name: "Футболки и топы", measurements: ["chest", "length"], sortOrder: 10, version: 1, archived: false },
    { id: "trousers", name: "Брюки и джинсы", measurements: ["waist", "inseam"], sortOrder: 20, version: 1, archived: false },
    { id: "dresses", name: "Платья и юбки", measurements: ["chest", "waist", "length"], sortOrder: 30, version: 1, archived: false },
    { id: "accessories", name: "Спортивная одежда", measurements: ["length", "width"], sortOrder: 40, version: 1, archived: false },
  ];
  let saved: Item | null = null;
  let uploaded = 0;
  let draftCreates = 0;
  let savedOrder: string[] = [];
  const respond = (route: Route, data: unknown) => route.fulfill({ json: data });
  await page.route("**/api/auth/me", (route) => respond(route, {
    user: { id: "staff-editor-mobile", telegramId: "990000002", role: "STAFF" }, dev: false,
  }));
  await page.route("**/api/staff/categories", (route) => respond(route, categories));
  await page.route("**/api/staff/items/draft", async (route) => {
    draftCreates++;
    const body = route.request().postDataJSON();
    saved = { id: sampleId, sku: "V-MOBILE", title: body.title ?? "",
      category: body.category ?? "", priceMinor: body.priceMinor ?? 0,
      priceMissing: body.priceMinor == null, publication: "DRAFT",
      physical: "INTAKE", version: 1, hasDefect: body.hasDefect ?? false,
      description: body.description ?? "", defectDescription: body.defectDescription ?? "",
      attributes: body.attributes ?? {}, measurements: body.measurements ?? {},
      storageLocation: body.storageLocation ?? "", available: false, media: [] };
    await respond(route, saved);
  });
  await page.route("**/api/staff/media/uploads", async (route) => {
    if (uploaded === 0) await firstUpload;
    uploaded++;
    const media: Media = { id: `mobile-photo-${uploaded}`, url: `/media/mobile-photo-${uploaded}.svg`,
      position: uploaded - 1, role: "DETAIL" };
    if (!saved) throw new Error("Photo must have a draft");
    saved.media = [...saved.media, media];
    await respond(route, media);
  });
  await page.route(/\/api\/staff\/items\/[a-f0-9-]+\/media-order$/, async (route) => {
    const body = route.request().postDataJSON();
    if (!saved) throw new Error("Missing draft");
    savedOrder = [...body.ids];
    saved.media = savedOrder.map((id: string, index: number) => ({
      ...saved!.media.find((media) => media.id === id)!, position: index,
    }));
    await respond(route, { ids: savedOrder });
  });
  await page.route(/\/api\/staff\/items\/[a-f0-9-]+$/, async (route) => {
    if (!saved) { await route.fulfill({ status: 404, json: { message: "Не найдено" } }); return; }
    if (route.request().method() === "PATCH") {
      const change = route.request().postDataJSON();
      saved = { ...saved, ...change, title: change.title ?? "", category: change.category ?? "",
        priceMinor: change.priceMinor ?? 0, priceMissing: change.priceMinor == null,
        version: saved.version + 1 };
    }
    await respond(route, saved);
  });
  return {
    mobile,
    get draftCreates() { return draftCreates; },
    get uploaded() { return uploaded; },
    get attributes() { return saved?.attributes; },
    get savedOrder() { return savedOrder; },
  };
}

test("staff can select six photos first on iOS/Android and reorder without disrupting text input", async ({ page, browserName }) => {
  let releaseUpload!: () => void;
  const activeUpload = new Promise<void>((resolve) => { releaseUpload = resolve; });
  const mock = await editorFixture(page, browserName, activeUpload);
  await page.goto("/#/staff/items/new");
  const uploader = page.getByRole("button", { name: "Выбрать фотографии", exact: true });
  await expect(uploader).toBeVisible();
  const title = page.getByLabel("Название *");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO8B4goAAAAASUVORK5CYII=", "base64");
  await page.locator('input[type="file"]').setInputFiles(
    Array.from({ length: 6 }, (_, i) => ({ name: `photo-${i + 1}.png`, mimeType: "image/png", buffer: png })),
  );
  try {
    await expect(page.getByText("Загружаем фото 1 из 6…")).toBeVisible();
    await title.fill("Не потерять текст");
    await page.getByLabel("Описание").fill("Введено во время загрузки");
    await page.getByLabel("Цена, BYN *").fill("12,50");
    await page.getByRole("button", { name: /Категория/ }).click();
    await page.getByRole("option", { name: "Спортивная одежда" }).click();
    await page.getByLabel("Размер", { exact: true }).fill("s / m");
  } finally {
    releaseUpload();
  }
  await expect(page.getByText("6/12")).toBeVisible();
  expect(mock.draftCreates).toBe(1);
  expect(mock.uploaded).toBe(6);
  await expect(page.getByRole("heading", { name: "Карточка вещи" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Восстановить ввод" })).toHaveCount(0);
  await expect(title).toHaveValue("Не потерять текст");
  await expect(page.getByLabel("Описание")).toHaveValue("Введено во время загрузки");
  await expect(page.getByLabel("Цена, BYN *")).toHaveValue("12,50");
  const size = page.getByLabel("Размер", { exact: true });
  await expect(size).toHaveValue("s / m");
  await page.getByRole("button", { name: "Фото 2: раньше" }).click();
  await expect.poll(() => mock.savedOrder[0]).toBe("mobile-photo-2");
  await expect(page.locator(".media-tile").first()).toContainText("Основное · 1");
  await page.getByRole("button", { name: "Сохранить черновик" }).click();
  await expect.poll(() => mock.attributes).toMatchObject({ sizeSystem: "INT", sizeLabel: "S/M" });
  await expect(size).toHaveValue("S/M");
  await size.fill("110,5 см");
  await page.getByRole("button", { name: "Сохранить черновик" }).click();
  await expect.poll(() => mock.attributes).toMatchObject({ sizeSystem: "CM", sizeLabel: "110,5" });
  await page.reload();
  await expect(size).toHaveValue("110,5 см");
  expect(mock.mobile.pageErrors).toEqual([]);
  expect(mock.mobile.unexpectedRequests.filter((url) => !url.startsWith("blob:"))).toEqual([]);
});

test("empty draft can be saved and measured; color accepts free text and keyboard does not switch routes", async ({ page, browserName }) => {
  const mock = await editorFixture(page, browserName);
  await page.goto("/#/staff/items/new");
  await page.getByRole("button", { name: "Сохранить черновик" }).click();
  await expect(page.getByRole("heading", { name: "Карточка вещи" })).toBeVisible();
  expect(mock.draftCreates).toBe(1);
  const price = page.getByLabel("Цена, BYN *");
  await price.click();
  const hash = await page.evaluate(() => location.hash);
  await updateTelegram(page, { height: 330 });
  await expect(price).toBeFocused();
  expect(await page.evaluate(() => location.hash)).toBe(hash);
  await price.fill("12,50");
  await page.getByRole("button", { name: "Сохранить черновик" }).click();
  await expect(page.getByText(/Черновик сохранён/)).toBeVisible();
  const color = page.getByRole("button", { name: /Цвет/ });
  await color.click();
  const search = page.getByRole("combobox", { name: /Найти или указать цвет/ });
  await search.fill("Мятный");
  await page.getByRole("option", { name: "Добавить «Мятный»" }).click();
  await expect(color).toContainText("Мятный");
  expect(mock.mobile.pageErrors).toEqual([]);
  expect(mock.mobile.unexpectedRequests.filter((url) => !url.startsWith("blob:"))).toEqual([]);
});
