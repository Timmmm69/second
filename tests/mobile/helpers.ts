import { expect, test, type CDPSession, type Locator, type Page, type TestInfo } from "@playwright/test";
import { readFileSync } from "node:fs";
import type { Category, Item, Settings } from "../../client/types.js";

const source = JSON.parse(readFileSync(new URL("../../preview/catalog.json", import.meta.url), "utf8")) as {
  settings: Settings;
  categories: Category[];
  items: Item[];
};
export const sampleId = source.items[0].id;
export const sampleTitle = source.items[0].title;

export async function installMobileMocks(page: Page, browserName: string) {
  const viewport = page.viewportSize()!;
  const systemBottom = browserName === "webkit" ? 34 : 24;
  const systemTop = browserName === "webkit" ? 44 : 24;
  const apiRequests: string[] = [];
  const unexpectedRequests: string[] = [];
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.addInitScript(({ viewport, systemTop, systemBottom, browserName }) => {
    const listeners = new Map<string, Set<() => void>>();
    const emit = (name: string) => listeners.get(name)?.forEach((listener) => listener());
    const noOp = () => {};
    const physicalScreen = { ...viewport, type: "portrait-primary", angle: 0 };
    const app = {
      initData: "",
      platform: browserName === "webkit" ? "ios" : "android",
      version: "9.1",
      viewportHeight: viewport.height,
      viewportStableHeight: viewport.height,
      safeAreaInset: { top: systemTop, right: 0, bottom: systemBottom, left: 0 },
      contentSafeAreaInset: { top: 0, right: 0, bottom: 0, left: 0 },
      ready: noOp, expand: noOp,
      setHeaderColor: noOp, setBackgroundColor: noOp, setBottomBarColor: noOp,
      disableVerticalSwipes: noOp, enableVerticalSwipes: noOp,
      BackButton: { show: noOp, hide: noOp, onClick: noOp, offClick: noOp },
      HapticFeedback: { impactOccurred: noOp, notificationOccurred: noOp, selectionChanged: noOp },
      isVersionAtLeast: () => true,
      onEvent: (name: string, callback: () => void) => {
        if (!listeners.has(name)) listeners.set(name, new Set());
        listeners.get(name)!.add(callback);
      },
      offEvent: (name: string, callback: () => void) => listeners.get(name)?.delete(callback),
    };
    // A keyboard changes the available viewport, not the physical screen.
    Object.defineProperties(screen, {
      width: { configurable: true, get: () => physicalScreen.width },
      height: { configurable: true, get: () => physicalScreen.height },
    });
    if (screen.orientation) Object.defineProperties(screen.orientation, {
      type: { configurable: true, get: () => physicalScreen.type },
      angle: { configurable: true, get: () => physicalScreen.angle },
    });
    Object.defineProperty(window, "orientation", { configurable: true, get: () => physicalScreen.angle });
    Object.assign(window, {
      Telegram: { WebApp: app },
      __mobileScreenRotate: (size: { width: number; height: number }) => {
        Object.assign(physicalScreen, size, {
          type: size.width > size.height ? "landscape-primary" : "portrait-primary",
          angle: size.width > size.height ? 90 : 0,
        });
        screen.orientation?.dispatchEvent(new Event("change"));
        window.dispatchEvent(new Event("orientationchange"));
      },
      __mobileTelegramUpdate: (change: { height?: number; bottom?: number }) => {
        if (change.height !== undefined) {
          app.viewportHeight = change.height;
          app.viewportStableHeight = change.height;
          emit("viewportChanged");
        }
        if (change.bottom !== undefined) {
          app.safeAreaInset.bottom = change.bottom;
          emit("safeAreaChanged");
          emit("contentSafeAreaChanged");
        }
      },
    });
  }, { viewport, systemTop, systemBottom, browserName });

  const items = structuredClone(source.items).map((item, index) => ({
    ...item,
    physical: "AVAILABLE",
    available: true,
    description: index === 0 ? "Тестовая вещь для проверки мобильного интерфейса. Все действия выполняются локально на синтетических данных." : "",
    media: index === 0 ? [item.media[0], ...[1, 2].map((number) => ({
      ...item.media[0],
      id: `mobile-photo-${number}`,
      variants: undefined,
      role: "DETAIL",
      url: `/media/mobile-photo-${number}.svg`,
    }))] : item.media,
  }));
  const categories = [...source.categories, ...Array.from({ length: 30 }, (_, index) => ({
    id: `mobile-category-${index}`, name: `Тестовая категория ${index + 1}`,
    sortOrder: 100 + index, version: 1, archived: false,
  }))];
  const options = {
    sizeLabel: ["XS", "S", "M", "L", "XL", ...Array.from({ length: 30 }, (_, index) => String(40 + index))],
    brand: ["Линия", "Север", ...Array.from({ length: 40 }, (_, index) => `Марка ${index + 1}`)],
    color: ["Белый", "Чёрный", "Серый", "Синий", "Красный", "Зелёный", "Коричневый", "Бежевый"],
    material: ["Хлопок", "Шерсть", "Вискоза", "Лён", "Полиэстер", "Шёлк", "Кожа", "Экокожа"],
    season: ["Лето", "Зима", "Демисезон", "Всесезон"],
  };
  let selection: string[] = [];
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.hostname === "telegram.org") {
      await route.fulfill({ contentType: "application/javascript", body: "/* Telegram bridge is mocked by the mobile test. */" });
      return;
    }
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
      unexpectedRequests.push(request.url());
      await route.abort();
      return;
    }
    if (url.pathname.startsWith("/media/")) {
      const fill = url.pathname.includes("mobile-photo-1") ? "#9bbaa5" : url.pathname.includes("mobile-photo-2") ? "#b9a5c3" : "#c5b6a6";
      await route.fulfill({
        contentType: "image/svg+xml",
        body: `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="640" viewBox="0 0 480 640"><rect width="480" height="640" fill="#f3f0ec"/><path d="M170 90 100 138 65 265 133 285 155 210 130 548H350L325 210 347 285 415 265 380 138 310 90 277 115H203Z" fill="${fill}"/><path d="M203 115Q240 160 277 115" fill="none" stroke="#837c73" stroke-width="5"/></svg>`,
      });
      return;
    }
    if (!url.pathname.startsWith("/api/")) {
      await route.continue();
      return;
    }
    const path = url.pathname.slice(4);
    apiRequests.push(`${request.method()} ${path}${url.search}`);
    let result: unknown;
    if (path === "/auth/me") result = { user: null, dev: false };
    else if (path === "/settings") result = { ...source.settings, acceptingOrders: true };
    else if (path === "/categories") result = categories;
    else if (path === "/catalog/options") result = options;
    else if (path === "/catalog/availability") result = { availableIds: items.map((item) => item.id) };
    else if (path === "/catalog") result = { items, nextCursor: null };
    else if (path.startsWith("/items/")) result = items.find((item) => item.id === path.split("/")[2]);
    else if (path === "/me/selection") {
      if (request.method() === "PUT") selection = request.postDataJSON().itemIds;
      result = { itemIds: selection, items: items.filter((item) => selection.includes(item.id)) };
    } else {
      unexpectedRequests.push(`${request.method()} ${url.pathname}`);
      await route.fulfill({ status: 501, json: { message: "Unmocked mobile-test request" } });
      return;
    }
    await route.fulfill({ json: result });
  });
  return { apiRequests, unexpectedRequests, pageErrors, systemBottom, systemTop };
}

export async function updateTelegram(page: Page, change: { height?: number; bottom?: number }) {
  await page.evaluate((value) => {
    (window as unknown as { __mobileTelegramUpdate: (change: typeof value) => void }).__mobileTelegramUpdate(value);
  }, change);
  await layoutFrames(page);
}

export async function rotateScreen(page: Page, size: { width: number; height: number }) {
  await page.evaluate((value) => {
    (window as unknown as { __mobileScreenRotate: (size: typeof value) => void }).__mobileScreenRotate(value);
  }, size);
  await layoutFrames(page);
}

export async function layoutFrames(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

export async function screenshot(page: Page, info: TestInfo, name: string) {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: false, animations: "disabled" });
  await info.attach(name, { path, contentType: "image/png" });
}

export function filterHeader(page: Page, label: string) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return page.getByRole("dialog", { name: "Фильтры и сортировка" })
    .getByRole("button", { name: new RegExp(`^${escaped}(?:\\s|$)`) });
}

/** Geometry and hit testing are deliberately measured before any click/scroll. */
export async function visibleTapTarget(locator: Locator) {
  const geometry = await locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const bounds = (rect: DOMRect) => ({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height });
    const describe = (node: Element | null) => node ? {
      tag: node.tagName, id: node.id, className: node.className,
      label: node.getAttribute("aria-label") || node.textContent?.trim().slice(0, 100),
      bounds: bounds(node.getBoundingClientRect()),
    } : null;
    const sheet = element.closest(".sheet");
    const sheetBounds = sheet?.getBoundingClientRect();
    const header = sheet?.querySelector(".sheet-header")?.getBoundingClientRect();
    const viewport = window.visualViewport;
    const top = Math.max(viewport?.offsetTop ?? 0, header?.bottom ?? 0, sheetBounds?.top ?? 0);
    const bottom = Math.min((viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight), sheetBounds?.bottom ?? Infinity);
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const points = [y, rect.top + 3, rect.bottom - 3];
    const hitPoints = points.map((point) => {
      const hit = document.elementFromPoint(x, point);
      return { x, y: point, hit: describe(hit), matches: hit === element || (hit !== null && element.contains(hit)) };
    });
    const clippingAncestors = [];
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const css = getComputedStyle(parent);
      if (/(auto|scroll|hidden|clip)/.test(`${css.overflowX} ${css.overflowY}`)) clippingAncestors.push({
        ...describe(parent), overflowX: css.overflowX, overflowY: css.overflowY,
        scrollTop: parent.scrollTop, scrollHeight: parent.scrollHeight, clientHeight: parent.clientHeight,
        paddingTop: css.paddingTop, paddingBottom: css.paddingBottom, maxHeight: css.maxHeight,
      });
    }
    return {
      x, y, width: rect.width, height: rect.height,
      top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right,
      viewportWidth: window.innerWidth, allowedTop: top, allowedBottom: bottom,
      hit: hitPoints.every((point) => point.matches),
      target: describe(element), hitPoints, clippingAncestors,
      activeElement: describe(document.activeElement),
      sheet: describe(sheet), stickyHeader: header ? bounds(header) : null,
      viewport: viewport ? { width: viewport.width, height: viewport.height, offsetTop: viewport.offsetTop, offsetLeft: viewport.offsetLeft, scale: viewport.scale } : null,
      documentScroll: { x: window.scrollX, y: window.scrollY },
    };
  });
  const diagnostic = `${locator.toString()}\n${JSON.stringify(geometry, null, 2)}`;
  try {
    expect(geometry.width, diagnostic).toBeGreaterThan(0);
    expect(geometry.height, diagnostic).toBeGreaterThanOrEqual(44);
    expect(geometry.left, diagnostic).toBeGreaterThanOrEqual(-1);
    expect(geometry.right, diagnostic).toBeLessThanOrEqual(geometry.viewportWidth + 1);
    expect(geometry.top, `Target must already be below the sticky sheet header\n${diagnostic}`).toBeGreaterThanOrEqual(geometry.allowedTop - 1);
    expect(geometry.bottom, `Next target must already fit without a user scroll\n${diagnostic}`).toBeLessThanOrEqual(geometry.allowedBottom + 1);
    expect(geometry.hit, `Target must receive taps, not only exist in the DOM\n${diagnostic}`).toBe(true);
  } catch (error) {
    await test.info().attach("tap-target-diagnostics", {
      body: JSON.stringify({ locator: locator.toString(), ...geometry }, null, 2),
      contentType: "application/json",
    });
    throw error;
  }
  return geometry;
}

export async function tapVisible(page: Page, locator: Locator) {
  const { x, y } = await visibleTapTarget(locator);
  await page.touchscreen.tap(x, y);
  await layoutFrames(page);
}

export async function openFilters(page: Page) {
  await page.goto("/#/catalog");
  await expect(page.locator(".product-card").first()).toBeVisible();
  await page.getByRole("button", { name: /^Фильтры(?:,|$)/ }).click();
  await expect(page.getByRole("dialog", { name: "Фильтры и сортировка" })).toBeVisible();
  await layoutFrames(page);
}

export async function touchDrag(page: Page, client: CDPSession, start: { x: number; y: number }, end: { x: number; y: number }) {
  await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...start, id: 1 }] });
  for (let step = 1; step <= 8; step++) {
    await client.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{
      x: start.x + (end.x - start.x) * step / 8,
      y: start.y + (end.y - start.y) * step / 8,
      id: 1,
    }] });
    await page.waitForTimeout(16);
  }
  await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await layoutFrames(page);
}

/** Tests event arbitration only; it cannot establish native WebKit scrolling. */
export async function syntheticDrag(locator: Locator, dx: number, dy: number, mode: "end" | "cancel" | "multitouch" = "end") {
  return locator.evaluate((element, { dx, dy, mode }) => {
    const bounds = element.getBoundingClientRect();
    const start = { identifier: 1, target: element, clientX: bounds.left + bounds.width / 2, clientY: bounds.top + bounds.height / 2 };
    const point = (fraction: number) => ({ ...start, clientX: start.clientX + dx * fraction, clientY: start.clientY + dy * fraction });
    const dispatch = (type: string, touches: typeof start[], changedTouches = touches) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, { touches: { value: touches }, changedTouches: { value: changedTouches } });
      element.dispatchEvent(event);
      return event.defaultPrevented;
    };
    dispatch("touchstart", [start]);
    const firstPrevented = dispatch("touchmove", [point(0.25)]);
    if (mode === "multitouch") dispatch("touchstart", [point(0.25), { ...point(0.25), identifier: 2 }]);
    const lastPrevented = dispatch("touchmove", mode === "multitouch" ? [point(1), { ...point(1), identifier: 2 }] : [point(1)]);
    dispatch(mode === "cancel" ? "touchcancel" : "touchend", [], [point(1)]);
    return { firstPrevented, lastPrevented };
  }, { dx, dy, mode });
}
