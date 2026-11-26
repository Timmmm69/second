import { expect, test as base, type Page } from "@playwright/test";
import {
  filterHeader, installMobileMocks, layoutFrames, openFilters, rotateScreen, sampleId, sampleTitle,
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

test("catalog renders in stages while Telegram authentication is pending", async ({ page, mobile }) => {
  let releaseCatalog!: () => void;
  let releaseAuth!: () => void;
  const catalogPending = new Promise<void>((resolve) => { releaseCatalog = resolve; });
  const authPending = new Promise<void>((resolve) => { releaseAuth = resolve; });
  const items = mobile.items.slice(0, 2);
  items[0].attributes = { ...items[0].attributes, sizeSystem: "CM", sizeLabel: "110,5" };
  items[1].attributes = { ...items[1].attributes, sizeSystem: "INT", sizeLabel: "S/M" };
  await page.route(/\/api\/catalog(?:\?.*)?$/, async (route) => {
    await catalogPending;
    await route.fulfill({ json: { items, nextCursor: null } });
  });
  await page.route("**/api/auth/me", async (route) => {
    await authPending;
    await route.fulfill({ json: { user: null, dev: false } });
  });
  try {
    await page.goto("/#/catalog");
    const brand = page.getByRole("button", { name: /— главная/ }).locator("img");
    await expect.poll(() => brand.evaluate((image: HTMLImageElement) => image.naturalWidth / image.clientWidth)).toBeGreaterThanOrEqual(3);
    await expect(page.getByRole("heading", { name: "Доступные вещи" })).toBeVisible();
    await expect(page.locator(".skeleton-grid")).toBeVisible();
    releaseCatalog();
    const cards = page.locator(".product-card");
    await expect(cards.first()).toContainText("на 110,5 см");
    await expect(cards.nth(1)).toContainText("S/M");
    const add = cards.first().getByRole("button", { name: /Добавить .* в корзину/ });
    await expect(add).toBeDisabled();
    releaseAuth();
    await expect(add).toBeEnabled();
    await cards.first().getByRole("button", { name: `Открыть ${items[0].title}` }).click();
    await expect(page.getByText("на 110,5 см", { exact: true }).first()).toBeVisible();
  } finally {
    releaseCatalog();
    releaseAuth();
  }
});

test("card opens from catalog immediately and quick navigation reuses fetched data", async ({ page, mobile }) => {
  let release!: () => void;
  let detailRequests = 0;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await page.route(`**/api/items/${sampleId}`, async (route) => {
    detailRequests++;
    await pending;
    await route.fallback();
  });
  await page.goto("/#/catalog");
  const open = page.getByRole("button", { name: `Открыть ${sampleTitle}` });
  const purchase = page.getByRole("button", { name: "В корзину", exact: true });
  try {
    await open.click();
    await expect(page.getByRole("heading", { name: sampleTitle, level: 1 })).toBeVisible();
    await expect(purchase).toBeDisabled();
    await expect.poll(() => detailRequests).toBe(1);
  } finally {
    release();
  }
  await expect(page.getByRole("heading", { name: "Описание" })).toBeVisible();
  await expect(purchase).toBeEnabled();
  await page.getByRole("button", { name: "Назад", exact: true }).click();
  await open.click();
  await expect(purchase).toBeEnabled();
  expect(detailRequests).toBe(1);
  expect(mobile.apiRequests.filter((request) => /^GET \/catalog\?/.test(request))).toHaveLength(1);
  expect(mobile.apiRequests.filter((request) => request === "GET /categories")).toHaveLength(1);
  expect(mobile.apiRequests.filter((request) => request === "GET /settings")).toHaveLength(1);
});

test("Telegram confirms closing and prevents content swipes from minimizing", async ({ page, mobile }) => {
  await page.goto("/#/catalog");
  await expect(page.locator(".product-card").first()).toBeVisible();
  const appState = await page.evaluate(() => {
    const bridge = (window as Window & { Telegram?: { WebApp: {
      isClosingConfirmationEnabled?: boolean;
      isVerticalSwipesEnabled?: boolean;
    } } }).Telegram?.WebApp;
    return {
      closingConfirmation: bridge?.isClosingConfirmationEnabled,
      verticalSwipesEnabled: bridge?.isVerticalSwipesEnabled,
    };
  });
  expect(appState.closingConfirmation).toBe(true);
  expect(appState.verticalSwipesEnabled).toBe(false);
  expect(mobile.pageErrors).toEqual([]);
});

test("the first, middle and last filters leave the next control visible and tappable", async ({ page }, info) => {
  await page.goto("/#/catalog");
  await expect(page.locator(".product-card").first()).toBeVisible();
  const catalogLayout = await page.evaluate(() => {
    const [audience, category] = document.querySelectorAll<HTMLElement>(".catalog-page > .chips");
    const actualGap = category.querySelector("button")!.getBoundingClientRect().top -
      audience.querySelector("button")!.getBoundingClientRect().bottom;
    const heading = document.querySelector<HTMLElement>(".catalog-page > .section-heading")!;
    const headingStyle = getComputedStyle(heading);
    return {
      actualGap,
      border: parseFloat(headingStyle.borderBottomWidth), borderStyle: headingStyle.borderBottomStyle,
      catalogGap: document.querySelector(".product-grid")!.getBoundingClientRect().top - heading.getBoundingClientRect().bottom,
    };
  });
  expect(catalogLayout.actualGap).toBeCloseTo(5.5, 1);
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
  // Telegram can report keyboard space while the browser viewport stays full.
  await updateTelegram(page, { height: 330 });
  expect(page.viewportSize()).toEqual(viewport);
  await expect(page.locator("body")).toHaveClass(/keyboard-open/);
  await expect(page.locator(".bottom-nav")).toBeHidden();
  await expect(price).toBeFocused();
  const bridgePrice = await visibleTapTarget(price);
  expect(bridgePrice.bottom).toBeLessThanOrEqual(331);
  expect(await page.evaluate(() => location.hash)).toBe(before.hash);
  expect(Math.abs(await page.evaluate(() => scrollY) - before.scrollY)).toBeLessThanOrEqual(1);
  await screenshot(page, info, "price-telegram-keyboard-only");
  await updateTelegram(page, { height: viewport.height });
  await expect(price).toBeFocused();
  await expect(page.locator("body")).not.toHaveClass(/keyboard-open/);
  await expect(page.locator(".bottom-nav")).toBeVisible();

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

test("catalog search outside a sheet keeps its route, focus and scroll through keyboard and Enter", async ({ page, mobile }, info) => {
  await page.goto("/#/catalog");
  await expect(page.locator(".product-card").first()).toBeVisible();
  const input = page.getByRole("searchbox", { name: "Что ищем?" });
  const viewport = page.viewportSize()!;
  const before = await page.evaluate(() => ({ hash: location.hash, y: scrollY }));
  const catalogRequests = () => mobile.apiRequests.filter((request) => /^GET \/catalog(?:\?|$)/.test(request)).length;
  const requestsBefore = catalogRequests();
  await input.tap();
  await page.keyboard.insertText("Линия");
  await page.setViewportSize({ width: viewport.width, height: 330 });
  await updateTelegram(page, { height: 330 });
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("Линия");
  await expect(page.locator("body")).toHaveClass(/keyboard-open/);
  await expect(page.locator("body")).not.toHaveClass(/compact-landscape/);
  await expect(page.locator(".bottom-nav")).toBeHidden();
  await visibleTapTarget(page.locator(".search-pill"));
  await expect(input).toBeInViewport({ ratio: 1 });
  expect(await page.evaluate(() => location.hash)).toBe(before.hash);
  expect(Math.abs(await page.evaluate(() => scrollY) - before.y)).toBeLessThanOrEqual(1);
  await screenshot(page, info, "catalog-search-keyboard");
  await expect.poll(catalogRequests).toBe(requestsBefore + 1);
  const navigations: string[] = [];
  page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) navigations.push(frame.url()); });
  await page.keyboard.press("Enter");
  // Observe one full debounce period: an accidental repeat request is delayed.
  await page.waitForTimeout(800);
  expect(catalogRequests()).toBe(requestsBefore + 1);
  expect(navigations).toEqual([]);
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("Линия");
  await page.setViewportSize(viewport);
  await updateTelegram(page, { height: viewport.height });
  await expect(page.locator(".bottom-nav")).toBeVisible();
  await expect(page.locator("body")).not.toHaveClass(/keyboard-open/);
  await expect(input).toBeFocused();
  expect(Math.abs(await page.evaluate(() => scrollY) - before.y)).toBeLessThanOrEqual(1);
  await screenshot(page, info, "catalog-search-keyboard-dismissed");
});

test("physical rotation preserves an open keyboard in either event order and restores navigation on dismissal", async ({ page }, info) => {
  const portrait = page.viewportSize()!;
  const landscape = { width: portrait.height, height: portrait.width };
  const portraitKeyboard = { width: portrait.width, height: 330 };
  const landscapeKeyboard = { width: landscape.width, height: landscape.height - 140 };
  const resize = async (size: { width: number; height: number }) => {
    await page.setViewportSize(size);
    await updateTelegram(page, { height: size.height });
  };

  for (const order of ["orientation-first", "resize-first"] as const) {
    await page.goto("/#/catalog");
    await expect(page.locator(".product-card").first()).toBeVisible();
    const input = page.getByRole("searchbox", { name: "Что ищем?" });
    await input.tap();
    await resize(portraitKeyboard);
    await expect(page.locator("body")).toHaveClass(/keyboard-open/);
    const rotate = async (screen: { width: number; height: number }, viewport: { width: number; height: number }) => {
      if (order === "orientation-first") {
        await rotateScreen(page, screen);
        await resize(viewport);
      } else {
        await resize(viewport);
        await rotateScreen(page, screen);
      }
    };
    await rotate(landscape, landscapeKeyboard);
    await expect(input).toBeFocused();
    await expect(page.locator("body")).toHaveClass(/keyboard-open/);
    await expect(page.locator(".bottom-nav")).toBeHidden();
    expect(await page.evaluate(() => location.hash)).toBe("#/catalog");
    await screenshot(page, info, `landscape-keyboard-${order}`);

    // Closing the keyboard in the new physical orientation retains DOM focus.
    await resize(landscape);
    await expect(input).toBeFocused();
    await expect(page.locator("body")).not.toHaveClass(/keyboard-open/);
    await expect(page.locator(".bottom-nav")).toBeVisible();
    await screenshot(page, info, `landscape-keyboard-dismissed-${order}`);

    // Turning back grows the keyboard viewport. Growth alone is not dismissal.
    await resize(landscapeKeyboard);
    await expect(page.locator("body")).toHaveClass(/keyboard-open/);
    await rotate(portrait, portraitKeyboard);
    await expect(input).toBeFocused();
    await expect(page.locator("body")).toHaveClass(/keyboard-open/);
    await expect(page.locator(".bottom-nav")).toBeHidden();
    await expect(page.locator("body")).not.toHaveClass(/compact-landscape/);
    await screenshot(page, info, `portrait-keyboard-after-rotation-${order}`);
    await resize(portrait);
    await expect(input).toBeFocused();
    await expect(page.locator("body")).not.toHaveClass(/keyboard-open/);
    await expect(page.locator(".bottom-nav")).toBeVisible();

    // A retained DOM focus after Android Back does not mean a keyboard is open.
    // A subsequent real rotation must not compare landscape height with an old
    // portrait baseline and hide navigation again.
    await rotate(landscape, landscape);
    await expect(input).toBeFocused();
    await expect(page.locator("body")).not.toHaveClass(/keyboard-open/);
    await expect(page.locator(".bottom-nav")).toBeVisible();
    await screenshot(page, info, `landscape-retained-focus-without-keyboard-${order}`);
    await rotate(portrait, portrait);
    await expect(input).toBeFocused();
    await expect(page.locator("body")).not.toHaveClass(/keyboard-open/);
    await expect(page.locator(".bottom-nav")).toBeVisible();
  }
});

test("rotation that dismisses the keyboard restores navigation with search still focused", async ({ page }) => {
  const portrait = page.viewportSize()!;
  const landscape = { width: portrait.height, height: portrait.width };
  await page.goto("/#/catalog");
  const input = page.getByRole("searchbox", { name: "Что ищем?" });
  await input.tap();
  const resize = async (size: { width: number; height: number }) => {
    await page.setViewportSize(size);
    await updateTelegram(page, { height: size.height });
  };

  await resize({ ...portrait, height: 330 });
  await expect(page.locator(".bottom-nav")).toBeHidden();
  await rotateScreen(page, landscape);
  await resize(landscape);
  await expect(input).toBeFocused();
  await expect(page.locator(".bottom-nav")).toBeVisible();

  await resize({ ...landscape, height: landscape.height - 140 });
  await expect(page.locator(".bottom-nav")).toBeHidden();
  // Report the resized viewport first and leave room for native chrome.
  await resize({ ...portrait, height: portrait.height - 32 });
  await rotateScreen(page, portrait);
  await expect(input).toBeFocused();
  await expect(page.locator(".bottom-nav")).toBeVisible();
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

function compactBottomSpace(gap: number) {
  expect(gap, "Content must not run underneath navigation").toBeGreaterThanOrEqual(-1);
  // Fractional line boxes and integer-rounded scrollY can differ by <1 CSS px.
  expect(gap, "40px spacing target with at most 1 CSS px of rounding tolerance").toBeLessThanOrEqual(41);
  expect(gap / 104, "The remaining gap must still be less than 40% of the former 104px reserve").toBeLessThan(0.4);
}

test("purchase action follows safe-area updates and targets 40px of spare bottom space", async ({ page, mobile }, info) => {
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
  // A bridge-only viewport report must not lift the navigation above the actual
  // browser viewport: the stable Telegram height may lag after expansion.
  await updateTelegram(page, { height: telegramHeight });
  expect(page.viewportSize()).toEqual(viewport);
  await expect.poll(() => page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--app-bottom-offset")))).toBeLessThanOrEqual(1);
  const bridgeOnly = await purchaseGeometry(page);
  expect(Math.abs(bridgeOnly.navBottom - viewport.height)).toBeLessThanOrEqual(1);
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
  compactBottomSpace(bridgeBottom.gap);
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
  compactBottomSpace(bottom.gap);
  expect(bottom.buttonBottom).toBeLessThan(bottom.navTop);
  expect(bottom.hit).toBe(true);
  await screenshot(page, info, "item-bottom");
  await info.attach("bottom-spacing", { body: JSON.stringify({ initial, changed, bridgeOnly, bridgeBottom, shortened, bottom }, null, 2), contentType: "application/json" });
});


test("catalog pull reveals the hidden hint late and leaves bottom navigation fixed", async ({ page }) => {
  await page.goto("/#/catalog");
  await expect(page.locator(".product-card").first()).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  const result = await page.locator(".app-header").evaluate((header) => {
    const nav = document.querySelector<HTMLElement>(".bottom-nav")!;
    const hint = document.querySelector<HTMLElement>(".pull-secret")!;
    const initialNavBottom = nav.getBoundingClientRect().bottom;
    const initialHeaderTop = header.getBoundingClientRect().top;
    const start = { identifier: 1, clientX: 160, clientY: 45, target: header };
    const fire = (type: string, distance: number) => {
      const point = { ...start, clientY: start.clientY + distance };
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, {
        touches: { value: type === "touchend" ? [] : [point] },
        changedTouches: { value: [point] },
      });
      header.dispatchEvent(event);
      return event.defaultPrevented;
    };
    fire("touchstart", 0);
    const shortPrevented = fire("touchmove", 55);
    const shortOpacity = Number(getComputedStyle(hint).opacity);
    const deepPrevented = fire("touchmove", 175);
    const deepOpacity = Number(getComputedStyle(hint).opacity);
    const pulledHeader = header.getBoundingClientRect().top;
    const pulledNavBottom = nav.getBoundingClientRect().bottom;
    fire("touchend", 175);
    return { shortPrevented, shortOpacity, deepPrevented, deepOpacity,
      initialNavBottom, initialHeaderTop, pulledHeader, pulledNavBottom };
  });
  expect(result.shortPrevented).toBe(true);
  expect(result.shortOpacity).toBe(0);
  expect(result.deepPrevented).toBe(true);
  expect(result.deepOpacity).toBeGreaterThan(0.9);
  expect(result.pulledHeader).toBeGreaterThan(result.initialHeaderTop + 70);
  expect(Math.abs(result.pulledNavBottom - result.initialNavBottom)).toBeLessThanOrEqual(1);
  await expect(page.locator(".app-shell")).not.toHaveClass(/is-pulling|pull-settling/);
  await expect(page.locator(".pull-secret")).toHaveCSS("opacity", "0");
});

test("catalog photo overlay is a small counter on touch screens", async ({ page }) => {
  await page.goto("/#/catalog");
  const photo = page.locator(".product-card").first();
  await expect(photo).toBeVisible();
  const controls = photo.locator(".catalog-photo-nav");
  await expect(controls.locator("span")).toHaveText("1 / 3");
  await expect(controls.locator("button:visible")).toHaveCount(0);
  const geometry = await controls.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const image = element.parentElement!.getBoundingClientRect();
    return { width: rect.width, rightGap: image.right - rect.right, bottomGap: image.bottom - rect.bottom };
  });
  expect(geometry.width).toBeLessThanOrEqual(55);
  expect(geometry.rightGap).toBeGreaterThanOrEqual(7);
  expect(geometry.bottomGap).toBeGreaterThanOrEqual(7);
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

test("item cover swipes change photos without opening the gallery", async ({ page }) => {
  await page.goto(`/#/items/${sampleId}`);
  const cover = page.getByRole("button", { name: "Открыть фотогалерею", exact: true });
  const counter = cover.locator(".photo-counter");
  await expect(counter).toHaveText("1 / 3");
  await syntheticDrag(cover, 90, 3);
  await expect(counter).toHaveText("1 / 3");
  const horizontal = await syntheticDrag(cover, -90, 3);
  expect(horizontal.firstPrevented).toBe(true);
  expect(horizontal.lastPrevented).toBe(true);
  await expect(counter).toHaveText("2 / 3");
  await expect(page.getByRole("button", { name: "Фото 2", exact: true })).toHaveClass("selected");
  expect(await cover.evaluate((element) => element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 })))).toBe(false);
  await expect(page.locator(".gallery-view")).toHaveCount(0);
  const vertical = await syntheticDrag(cover, 3, -100);
  expect(vertical.firstPrevented).toBe(false);
  expect(vertical.lastPrevented).toBe(false);
  await expect(counter).toHaveText("2 / 3");
  await syntheticDrag(cover, -90, 3);
  await expect(counter).toHaveText("3 / 3");
  await syntheticDrag(cover, -90, 3);
  await expect(counter).toHaveText("3 / 3");
  await syntheticDrag(cover, 90, 3);
  await expect(counter).toHaveText("2 / 3");
  await cover.tap();
  await expect(page.locator(".sheet-header h2")).toHaveText("Фото 2 из 3");
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
