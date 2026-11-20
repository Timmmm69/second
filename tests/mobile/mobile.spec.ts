import { expect, test as base, type Page } from "@playwright/test";
import {
  filterHeader, installMobileMocks, layoutFrames, openFilters, sampleId, sampleTitle,
  screenshot, syntheticDrag, tapVisible, touchDrag, updateTelegram, visibleTapTarget,
} from "./helpers.js";

type MobileMocks = Awaited<ReturnType<typeof installMobileMocks>>;
const test = base.extend<{ mobile: MobileMocks }>({
  mobile: [async ({ page, browserName }, use) => {
    const mobile = await installMobileMocks(page, browserName);
    await use(mobile);
    expect(mobile.pageErrors, "No uncaught browser errors").toEqual([]);
    expect(mobile.unexpectedRequests, "Every request must stay within the local test fixture").toEqual([]);
  }, { auto: true }],
});

async function oneOpen(page: Page, label: string) {
  await expect(page.locator('.catalog-filter-trigger[aria-expanded="true"]')).toHaveCount(1);
  await expect(filterHeader(page, label)).toHaveAttribute("aria-expanded", "true");
  await layoutFrames(page);
}

test("the first, middle and last filters leave the next control visible and tappable", async ({ page }, info) => {
  await page.goto("/#/catalog");
  await expect(page.locator(".product-card").first()).toBeVisible();
  const catalogLayout = await page.evaluate(() => {
    const [audience, category] = document.querySelectorAll<HTMLElement>(".catalog-page > .chips");
    const gap = () => category.querySelector("button")!.getBoundingClientRect().top - audience.querySelector("button")!.getBoundingClientRect().bottom;
    const actualGap = gap();
    const audienceStyle = audience.getAttribute("style");
    const categoryStyle = category.getAttribute("style");
    let previousGap: number;
    try {
      audience.style.marginBottom = "8px";
      category.style.marginTop = "8px";
      previousGap = gap();
    } finally {
      if (audienceStyle === null) audience.removeAttribute("style"); else audience.setAttribute("style", audienceStyle);
      if (categoryStyle === null) category.removeAttribute("style"); else category.setAttribute("style", categoryStyle);
    }
    const heading = document.querySelector<HTMLElement>(".catalog-page > .section-heading")!;
    const headingStyle = getComputedStyle(heading);
    return {
      actualGap, previousGap,
      border: parseFloat(headingStyle.borderBottomWidth), borderStyle: headingStyle.borderBottomStyle,
      catalogGap: document.querySelector(".product-grid")!.getBoundingClientRect().top - heading.getBoundingClientRect().bottom,
    };
  });
  expect(catalogLayout.previousGap - catalogLayout.actualGap).toBeCloseTo(2, 1);
  expect(catalogLayout.border).toBe(1);
  expect(catalogLayout.borderStyle).toBe("solid");
  expect(catalogLayout.catalogGap).toBeGreaterThanOrEqual(8);
  await screenshot(page, info, "closed");
  await page.getByRole("button", { name: /^Фильтры(?:,|$)/ }).click();
  await expect(page.locator(".catalog-filter-trigger")).toHaveCount(8);
  await screenshot(page, info, "filters-collapsed");

  await tapVisible(page, filterHeader(page, "Сначала показывать"));
  await oneOpen(page, "Сначала показывать");
  await visibleTapTarget(filterHeader(page, "Назначение"));
  await screenshot(page, info, "sort");

  // There is deliberately no locator.click or scrollIntoView on the next header.
  await tapVisible(page, filterHeader(page, "Назначение"));
  await oneOpen(page, "Назначение");
  await visibleTapTarget(filterHeader(page, "Категория"));
  await screenshot(page, info, "audience");

  await tapVisible(page, filterHeader(page, "Категория"));
  await oneOpen(page, "Категория");
  const categoryOptions = filterHeader(page, "Категория").locator("..").locator(".catalog-filter-options");
  expect(await categoryOptions.evaluate((element) => element.scrollHeight > element.clientHeight + 100)).toBe(true);
  await visibleTapTarget(page.getByLabel("Цена от, BYN").locator(".."));
  await screenshot(page, info, "category");
  const outerScroll = await page.locator(".sheet").evaluate((element) => element.scrollTop);
  await categoryOptions.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await layoutFrames(page);
  expect(await page.locator(".sheet").evaluate((element) => element.scrollTop)).toBeCloseTo(outerScroll, 0);
  await visibleTapTarget(page.getByLabel("Цена от, BYN").locator(".."));
  await screenshot(page, info, "category-list-end");

  // Scrolling to a not-yet-active middle section is allowed. Its NEXT section
  // must already fit as soon as this one opens, before the test interacts again.
  await filterHeader(page, "Размер").click();
  await oneOpen(page, "Размер");
  await visibleTapTarget(filterHeader(page, "Бренд"));
  await tapVisible(page, filterHeader(page, "Бренд"));
  await oneOpen(page, "Бренд");
  await visibleTapTarget(filterHeader(page, "Цвет"));
  await screenshot(page, info, "middle-long-list");
  await tapVisible(page, filterHeader(page, "Цвет"));
  await oneOpen(page, "Цвет");
  await visibleTapTarget(filterHeader(page, "Материал"));
  await tapVisible(page, filterHeader(page, "Материал"));
  await oneOpen(page, "Материал");
  await visibleTapTarget(filterHeader(page, "Сезон"));
  await tapVisible(page, filterHeader(page, "Сезон"));
  await oneOpen(page, "Сезон");
  await visibleTapTarget(page.getByRole("button", { name: "Показать вещи", exact: true }));
  await screenshot(page, info, "last");
  await tapVisible(page, filterHeader(page, "Сезон"));
  await expect(page.locator('.catalog-filter-trigger[aria-expanded="true"]')).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Готово", exact: true })).toHaveCount(0);
});

test("multiselection survives accordion switching, closing and applying without extra catalog requests", async ({ page, mobile }, info) => {
  await openFilters(page);
  const catalogRequests = () => mobile.apiRequests.filter((request) => /^GET \/catalog(?:\?|$)/.test(request)).length;
  const before = catalogRequests();
  const audience = filterHeader(page, "Назначение");
  await audience.click();
  await oneOpen(page, "Назначение");
  const audienceChecks = audience.locator("..").getByRole("checkbox");
  await audienceChecks.nth(0).check();
  await audienceChecks.nth(1).check();
  await expect(audience).toContainText("Назначение · 2");
  await visibleTapTarget(filterHeader(page, "Категория"));
  await screenshot(page, info, "multiselect");
  await tapVisible(page, audience);
  await expect(audience).toHaveAttribute("aria-expanded", "false");
  await tapVisible(page, audience);
  await expect(audienceChecks.nth(0)).toBeChecked();
  await expect(audienceChecks.nth(1)).toBeChecked();

  await tapVisible(page, filterHeader(page, "Категория"));
  const category = filterHeader(page, "Категория");
  const categoryChecks = category.locator("..").getByRole("checkbox");
  await categoryChecks.nth(0).check();
  await categoryChecks.nth(1).check();
  await expect(category).toContainText("Категория · 2");
  await visibleTapTarget(page.getByLabel("Цена от, BYN").locator(".."));
  expect(catalogRequests(), "Changing the draft must not fetch catalog data").toBe(before);
  await page.getByRole("button", { name: "Показать вещи", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(catalogRequests).toBe(before + 1);
  await page.getByRole("button", { name: /^Фильтры,/ }).click();
  await expect(audience).toContainText("Назначение · 2");
  await expect(category).toContainText("Категория · 2");
  await category.click();
  await expect(categoryChecks.nth(0)).toBeChecked();
  await expect(categoryChecks.nth(1)).toBeChecked();
  await screenshot(page, info, "multiselect-reopened");
});

test("focusing price and shrinking the keyboard viewport preserves the route, focus and document scroll", async ({ page }, info) => {
  await openFilters(page);
  await filterHeader(page, "Категория").click();
  await oneOpen(page, "Категория");
  const price = page.getByLabel("Цена от, BYN");
  await visibleTapTarget(price.locator(".."));
  const before = await page.evaluate(() => ({ hash: location.hash, scrollY, screenHeight: screen.height }));
  await tapVisible(page, price);
  await expect(price).toBeFocused();
  await expect(page.locator('.catalog-filter-trigger[aria-expanded="true"]')).toHaveCount(0);
  const viewport = page.viewportSize()!;
  await page.setViewportSize({ width: viewport.width, height: 330 });
  await updateTelegram(page, { height: 330 });
  await expect(price).toBeFocused();
  await page.keyboard.insertText("35");
  await expect(price).toHaveValue("35");
  const after = await page.evaluate(() => ({
    hash: location.hash, scrollY, screenHeight: screen.height,
    compact: Boolean(document.querySelector(".compact-landscape")),
    headerPosition: getComputedStyle(document.querySelector(".app-header")!).position,
    sheetAlignment: getComputedStyle(document.querySelector(".sheet-backdrop")!).alignItems,
  }));
  expect(after.hash).toBe(before.hash);
  expect(Math.abs(after.scrollY - before.scrollY)).toBeLessThanOrEqual(1);
  expect(after.screenHeight).toBe(before.screenHeight);
  expect(after.compact).toBe(false);
  expect(after.headerPosition).toBe("sticky");
  expect(after.sheetAlignment).toBe("flex-end");
  await visibleTapTarget(price);
  await screenshot(page, info, "price-keyboard");
  await page.setViewportSize(viewport);
  await updateTelegram(page, { height: viewport.height });
  await expect(price).toHaveValue("35");
  await expect(price).toBeFocused();
  // Android Back can dismiss its keyboard while keeping the DOM input focused.
  await expect(page.locator(".bottom-nav")).toBeVisible();
  await expect(page.locator("body")).not.toHaveClass(/keyboard-open/);
  await screenshot(page, info, "price-keyboard-dismissed-with-focus");
});

test("search on a short keyboard viewport leaves a result and the next filter usable", async ({ page }, info) => {
  await openFilters(page);
  const viewport = page.viewportSize()!;
  for (const [label, searchLabel, next] of [
    ["Категория", "Найти категорию", "price"],
    ["Бренд", "Найти или добавить бренд", "Цвет"],
  ]) {
    await filterHeader(page, label).click();
    await oneOpen(page, label);
    const input = page.getByRole("searchbox", { name: searchLabel });
    await input.click();
    await page.setViewportSize({ width: viewport.width, height: 330 });
    await updateTelegram(page, { height: 330 });
    await expect(input).toBeFocused();
    await visibleTapTarget(input);
    const option = filterHeader(page, label).locator("..").locator(".catalog-filter-option").first();
    await visibleTapTarget(option);
    await visibleTapTarget(next === "price" ? page.getByLabel("Цена от, BYN").locator("..") : filterHeader(page, next));
    await screenshot(page, info, `${label === "Категория" ? "category" : "brand"}-search-keyboard`);
    await page.setViewportSize(viewport);
    await updateTelegram(page, { height: viewport.height });
  }
});

async function purchaseGeometry(page: Page) {
  return page.evaluate(() => {
    const nav = document.querySelector<HTMLElement>(".bottom-nav")!;
    const bar = document.querySelector<HTMLElement>(".purchase-bar")!;
    const button = bar.querySelector<HTMLElement>("button")!;
    const navRect = nav.getBoundingClientRect();
    const barRect = bar.getBoundingClientRect();
    const rect = button.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return {
      navTop: navRect.top, navHeight: navRect.height, navBottom: navRect.bottom,
      barBottom: barRect.bottom, barTop: barRect.top,
      buttonBottom: rect.bottom, hit: hit === button || Boolean(hit && button.contains(hit)),
      navButtonsBottom: Math.max(...Array.from(nav.querySelectorAll("button")).map((element) => element.getBoundingClientRect().bottom)),
      viewportHeight: window.innerHeight,
    };
  });
}

async function inlinePurchaseGeometry(page: Page) {
  return page.locator(".item-cta").evaluate((cta) => {
    const nav = document.querySelector(".bottom-nav")!.getBoundingClientRect();
    const note = cta.querySelector(":scope > small:last-child")!.getBoundingClientRect();
    const button = cta.querySelector("button")!.getBoundingClientRect();
    const hit = document.elementFromPoint(button.left + button.width / 2, button.top + button.height / 2);
    return { gap: nav.top - note.bottom, buttonBottom: button.bottom, navTop: nav.top,
      hit: hit === cta.querySelector("button") || Boolean(hit && cta.querySelector("button")!.contains(hit)) };
  });
}

test("purchase action follows safe-area updates and the product has at most 40px of spare bottom space", async ({ page, mobile }, info) => {
  await page.goto(`/#/items/${sampleId}`);
  await expect(page.getByRole("heading", { name: sampleTitle, exact: true })).toBeVisible();
  await expect(page.locator(".purchase-bar")).toBeVisible();
  await layoutFrames(page);
  const initial = await purchaseGeometry(page);
  expect(Math.abs(initial.barBottom - initial.navTop)).toBeLessThanOrEqual(1);
  expect(initial.navButtonsBottom).toBeLessThanOrEqual(initial.viewportHeight - mobile.systemBottom + 1);
  expect(initial.buttonBottom).toBeLessThan(initial.navTop);
  expect(initial.barTop).toBeGreaterThanOrEqual(0);
  expect(initial.hit).toBe(true);
  await screenshot(page, info, "item-top");

  const increasedInset = mobile.systemBottom + 20;
  await updateTelegram(page, { bottom: increasedInset });
  await expect.poll(async () => (await purchaseGeometry(page)).navHeight).toBeGreaterThan(initial.navHeight + 15);
  const changed = await purchaseGeometry(page);
  expect(Math.abs(changed.barBottom - changed.navTop)).toBeLessThanOrEqual(1);
  expect(changed.navButtonsBottom).toBeLessThanOrEqual(changed.viewportHeight - increasedInset + 1);
  expect(changed.hit).toBe(true);
  await screenshot(page, info, "item-increased-safe-area");

  const viewport = page.viewportSize()!;
  const telegramHeight = viewport.height - 90;
  // Some Telegram clients report a smaller visible area without resizing the
  // browser layout viewport. This must actually exercise --app-bottom-offset.
  await updateTelegram(page, { height: telegramHeight });
  expect(page.viewportSize()).toEqual(viewport);
  await expect.poll(() => page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--app-bottom-offset")))).toBeGreaterThanOrEqual(89);
  const bridgeOnly = await purchaseGeometry(page);
  expect(bridgeOnly.navBottom).toBeLessThanOrEqual(telegramHeight + 1);
  expect(Math.abs(bridgeOnly.barBottom - bridgeOnly.navTop)).toBeLessThanOrEqual(1);
  expect(bridgeOnly.hit).toBe(true);
  await screenshot(page, info, "item-telegram-viewport-only");

  await page.locator(".item-cta > .button").evaluate((button) => {
    const navTop = document.querySelector(".bottom-nav")!.getBoundingClientRect().top;
    window.scrollBy({ top: button.getBoundingClientRect().top - navTop - 8, behavior: "instant" });
  });
  await layoutFrames(page);
  await layoutFrames(page);
  await expect(page.locator(".purchase-bar")).toBeVisible();
  await expect(page.locator(".item-cta")).toHaveAttribute("data-floating", "true");
  await screenshot(page, info, "item-inline-under-navigation");
  await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" }));
  await expect(page.locator(".purchase-bar")).toHaveCount(0);
  const bridgeBottom = await inlinePurchaseGeometry(page);
  expect(bridgeBottom.hit).toBe(true);
  expect(bridgeBottom.buttonBottom).toBeLessThan(bridgeBottom.navTop);
  expect(bridgeBottom.gap).toBeGreaterThanOrEqual(-1);
  expect(bridgeBottom.gap).toBeLessThanOrEqual(40);
  await screenshot(page, info, "item-bottom-telegram-viewport-only");

  await updateTelegram(page, { height: viewport.height });
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await expect(page.locator(".purchase-bar")).toBeVisible();
  await page.setViewportSize({ width: viewport.width, height: viewport.height - 90 });
  await updateTelegram(page, { height: viewport.height - 90 });
  await expect(page.locator(".purchase-bar")).toBeVisible();
  const shortened = await purchaseGeometry(page);
  expect(Math.abs(shortened.barBottom - shortened.navTop)).toBeLessThanOrEqual(1);
  expect(shortened.navBottom).toBeLessThanOrEqual(shortened.viewportHeight + 1);
  expect(shortened.hit).toBe(true);
  await screenshot(page, info, "item-short-viewport");

  await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" }));
  await expect(page.locator(".purchase-bar")).toHaveCount(0);
  await layoutFrames(page);
  const bottom = await inlinePurchaseGeometry(page);
  expect(bottom.gap, "Content must not run underneath navigation").toBeGreaterThanOrEqual(-1);
  expect(bottom.gap, "At most 40px remains from the former 104px reserved padding").toBeLessThanOrEqual(40);
  expect(bottom.buttonBottom).toBeLessThan(bottom.navTop);
  expect(bottom.hit).toBe(true);
  await screenshot(page, info, "item-bottom");
  await info.attach("bottom-spacing", { body: JSON.stringify({ initial, changed, bridgeOnly, bridgeBottom, shortened, bottom }, null, 2), contentType: "application/json" });
});

test("trusted horizontal drags change the photo without scrolling; vertical drags scroll the catalog", async ({ page, browserName, mobile }, info) => {
  test.skip(browserName !== "chromium", "Trusted CDP input is Chromium-only; WebKit event arbitration is covered separately.");
  await page.goto("/#/catalog");
  const photo = page.locator(".product-image-button").first();
  await expect(photo).toBeVisible();
  await photo.evaluate((element) => {
    const headerBottom = document.querySelector(".app-header")!.getBoundingClientRect().bottom;
    window.scrollBy({ top: element.getBoundingClientRect().top - headerBottom - 18, behavior: "instant" });
  });
  await layoutFrames(page);
  const before = await page.evaluate(() => ({ y: scrollY, hash: location.hash }));
  const box = (await photo.boundingBox())!;
  const client = await page.context().newCDPSession(page);
  const counter = page.locator(".product-card").first().locator(".catalog-photo-nav span");
  await touchDrag(page, client,
    { x: box.x + box.width * 0.85, y: box.y + box.height * 0.4 },
    { x: box.x + box.width * 0.15, y: box.y + box.height * 0.4 + 5 });
  await expect(counter).toHaveText("2 / 3");
  expect(Math.abs(await page.evaluate(() => scrollY) - before.y)).toBeLessThanOrEqual(1);
  expect(await page.evaluate(() => location.hash)).toBe(before.hash);
  expect(mobile.apiRequests.some((request) => /^GET \/items\//.test(request))).toBe(false);
  await screenshot(page, info, "catalog-after-horizontal-swipe");

  await touchDrag(page, client,
    { x: box.x + box.width * 0.5, y: box.y + box.height * 0.8 },
    { x: box.x + box.width * 0.5 + 5, y: box.y + box.height * 0.8 - 110 });
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(before.y + 20);
  await expect(counter).toHaveText("2 / 3");
  expect(await page.evaluate(() => location.hash)).toBe(before.hash);
  await client.detach();
});

test("gesture arbitration rejects vertical, cancelled and multi-touch gallery drags and respects zoom", async ({ page }, info) => {
  await page.goto("/#/catalog");
  const photo = page.locator(".product-image-button").first();
  await expect(photo).toBeVisible();
  const counter = page.locator(".product-card").first().locator(".catalog-photo-nav span");
  const horizontal = await syntheticDrag(photo, -90, 3);
  expect(horizontal.firstPrevented).toBe(true);
  expect(horizontal.lastPrevented).toBe(true);
  await expect(counter).toHaveText("2 / 3");
  expect(await photo.evaluate((element) => element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 })))).toBe(false);
  expect(await page.evaluate(() => location.hash)).toBe("#/catalog");
  // A fresh intentional tap must not remain blocked after the previous drag.
  await photo.tap();
  await expect(page.getByRole("heading", { name: sampleTitle, exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Открыть фотогалерею", exact: true }).click();
  const gallery = page.locator(".gallery-view");
  const title = page.locator(".sheet-header h2");
  await expect(title).toHaveText("Фото 1 из 3");
  const vertical = await syntheticDrag(gallery, 3, -100);
  expect(vertical.firstPrevented).toBe(false);
  expect(vertical.lastPrevented).toBe(false);
  await expect(title).toHaveText("Фото 1 из 3");
  await syntheticDrag(gallery, -90, 3, "cancel");
  await expect(title).toHaveText("Фото 1 из 3");
  await syntheticDrag(gallery, -90, 3, "multitouch");
  await expect(title).toHaveText("Фото 1 из 3");
  await syntheticDrag(gallery, -90, 3);
  await expect(title).toHaveText("Фото 2 из 3");
  await screenshot(page, info, "gallery-after-swipe");

  await page.getByRole("slider", { name: "Масштаб" }).focus();
  await page.keyboard.press("End");
  await expect(page.getByRole("slider", { name: "Масштаб" })).toHaveValue("3");
  const zoomed = await syntheticDrag(gallery, -90, 3);
  expect(zoomed.firstPrevented).toBe(false);
  expect(zoomed.lastPrevented).toBe(false);
  await expect(title).toHaveText("Фото 2 из 3");
  // Chromium serializes this exact combination as its equivalent keyword.
  expect(["manipulation", "pan-x pan-y pinch-zoom"])
    .toContain(await gallery.evaluate((element) => getComputedStyle(element).touchAction));
});
