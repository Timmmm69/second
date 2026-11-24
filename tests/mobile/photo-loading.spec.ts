import { expect, test as base, type Locator, type Page } from "@playwright/test";
import sharp from "sharp";
import type { Media } from "../../client/types.js";
import { installMobileMocks, layoutFrames, sampleId, syntheticDrag } from "./helpers.js";

// Every source candidate has the same distinct colour for its photo. Checking
// decoded pixels and the compositor catches a changed counter with an old image.
const colours = ["#d43e34", "#24864a", "#355ac8", "#bc7a19", "#904eaf"];
const rgb = (index: number) => colours[index].slice(1).match(/../g)!.map((value) => parseInt(value, 16));
const widths = [240, 480, 960, 1600];

async function installPhotoMocks(page: Page, browserName: string) {
  const mobile = await installMobileMocks(page, browserName);
  mobile.items.forEach((item, itemIndex) => {
    item.media = colours.map((_, photo): Media => {
      const id = `photo-loading-${itemIndex}-${photo}`;
      return {
        id, width: 1600, height: 2134, role: photo === 0 ? "COVER" : "DETAIL", position: photo,
        url: `/media/${id}/480`,
        variants: Object.fromEntries(widths.map((width) => [String(width), `/media/${id}/${width}`])),
      };
    });
  });
  const requests: { item: number; photo: number; width: number; finished: boolean }[] = [];
  const pending = new Map<number, Promise<void>>();
  const releases: (() => void)[] = [];
  const failed = new Set<number>();
  await page.route(/\/media\/photo-loading-\d+-\d+\/\d+$/, async (route) => {
    const [, item, photo, width] = new URL(route.request().url()).pathname.match(/photo-loading-(\d+)-(\d+)\/(\d+)$/)!;
    const request = { item: Number(item), photo: Number(photo), width: Number(width), finished: false };
    requests.push(request);
    // Tiny thumbnails stay usable while the full photo is delayed or fails.
    if (request.item === 0 && request.width > 240) {
      await pending.get(request.photo);
      if (failed.has(request.photo)) {
        await route.fulfill({ status: 503, headers: { "cache-control": "no-store" }, body: "Synthetic image failure" });
        request.finished = true;
        return;
      }
    }
    await route.fulfill({
      contentType: "image/svg+xml",
      headers: { "cache-control": "public, max-age=15" },
      body: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${Number(width) * 4 / 3}" viewBox="0 0 3 4"><path fill="${colours[request.photo]}" d="M0 0h3v4H0z"/></svg>`,
    });
    request.finished = true;
  });
  return {
    ...mobile, requests, failed,
    hold(photo: number) {
      let release!: () => void;
      pending.set(photo, new Promise<void>((resolve) => { release = resolve; }));
      const resume = () => { pending.delete(photo); release(); };
      releases.push(resume);
      return resume;
    },
    releaseAll: () => releases.forEach((release) => release()),
  };
}

type PhotoMocks = Awaited<ReturnType<typeof installPhotoMocks>>;
const test = base.extend<{ photos: PhotoMocks }>({
  photos: [async ({ page, browserName }, use) => {
    const photos = await installPhotoMocks(page, browserName);
    try {
      await use(photos);
      expect(photos.pageErrors, "No uncaught browser errors").toEqual([]);
      expect(photos.unexpectedRequests, "Only synthetic local requests are allowed").toEqual([]);
    } finally {
      photos.releaseAll();
      await page.unrouteAll({ behavior: "wait" });
    }
  }, { auto: true }],
});

async function openItem(page: Page) {
  // A deliberately pending eager image must not hold up test navigation.
  await page.goto(`/#/items/${sampleId}`, { waitUntil: "domcontentloaded" });
  await expect(page.locator(".gallery-cover")).toBeVisible();
}

async function decodedColour(image: Locator) {
  return image.evaluate(async (element) => {
    const image = element as HTMLImageElement;
    if (!image.complete || image.naturalWidth === 0) return null;
    try { await image.decode(); } catch { return null; }
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0, 1, 1);
    return Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3);
  });
}

async function centrePixel(locator: Locator) {
  const screenshot = await locator.screenshot({ animations: "disabled" });
  const { width, height } = await sharp(screenshot).metadata();
  const data = await sharp(screenshot).extract({ left: Math.floor(width! / 2), top: Math.floor(height! / 2), width: 1, height: 1 })
    .removeAlpha().raw().toBuffer();
  return Array.from(data).slice(0, 3);
}

async function expectPhoto(container: Locator, photo: number) {
  const image = container.locator("img");
  await expect(image).toHaveCount(1);
  await expect.poll(() => decodedColour(image), { message: `The decoded image must be photo ${photo + 1}` }).toEqual(rgb(photo));
  await expect(image).toBeVisible();
  await expect(container.locator(".photo-loading")).toHaveCount(0);
  expect(await centrePixel(image), "The painted image must match the selected photo").toEqual(rgb(photo));
}

test("a slow chosen photo shows loading instead of the previous image, then paints the selected pixels", async ({ page, photos }, info) => {
  const release = photos.hold(1);
  await openItem(page);
  const cover = page.locator(".gallery-cover");
  await expectPhoto(cover, 0);
  await page.getByRole("button", { name: "Фото 2", exact: true }).click();
  await expect(cover.locator(".photo-counter")).toHaveText("2 / 5");
  await expect(cover.locator(".photo-loading")).toBeVisible();
  await expect.poll(() => photos.requests.some((request) => request.photo === 1 && request.width > 240)).toBe(true);
  expect(await centrePixel(cover), "A pending second photo must not keep painting the first").not.toEqual(rgb(0));
  await info.attach("selected-photo-loading", { body: await cover.screenshot(), contentType: "image/png" });
  const releasedAt = Date.now();
  release();
  await expectPhoto(cover, 1);
  await info.attach("selected-photo-ready", { body: await cover.screenshot(), contentType: "image/png" });
  await info.attach("controlled-image-load", { body: JSON.stringify({ releasedResponseToVerifiedPixelsMs: Date.now() - releasedAt }), contentType: "application/json" });
});

test("rapid gallery choices keep the latest photo after an older slow response completes", async ({ page, photos }) => {
  const release = photos.hold(1);
  await openItem(page);
  await expectPhoto(page.locator(".gallery-cover"), 0);
  await page.locator(".gallery-cover").click();
  const dialog = page.getByRole("dialog");
  const gallery = dialog.locator(".gallery-view");
  await expectPhoto(gallery, 0);
  await dialog.getByRole("button", { name: "Следующее фото", exact: true }).click();
  await expect(dialog).toHaveAccessibleName("Фото 2 из 5");
  expect(await centrePixel(gallery), "Gallery must not present the old frame as the newly selected one").not.toEqual(rgb(0));
  await expect(gallery.locator(".photo-loading")).toBeVisible();
  await dialog.getByRole("button", { name: "Следующее фото", exact: true }).click();
  await expectPhoto(gallery, 2);
  release();
  await expect.poll(() => photos.requests.some((request) => request.photo === 1 && request.width > 240 && request.finished)).toBe(true);
  await layoutFrames(page);
  await expectPhoto(gallery, 2);
  await expect(dialog).toHaveAccessibleName("Фото 3 из 5");
});

test("a failed gallery image does not poison the next photo and can be retried", async ({ page, photos }) => {
  photos.failed.add(1);
  await openItem(page);
  await expectPhoto(page.locator(".gallery-cover"), 0);
  await page.locator(".gallery-cover").click();
  const dialog = page.getByRole("dialog");
  const gallery = dialog.locator(".gallery-view");
  await dialog.getByRole("button", { name: "Следующее фото", exact: true }).click();
  await expect(gallery.locator(".photo-retry")).toBeVisible();
  await dialog.getByRole("button", { name: "Следующее фото", exact: true }).click();
  await expectPhoto(gallery, 2);
  await dialog.getByRole("button", { name: "Предыдущее фото", exact: true }).click();
  await expect(gallery.locator(".photo-retry")).toBeVisible();
  photos.failed.delete(1);
  await gallery.locator(".photo-retry").click();
  await expectPhoto(gallery, 1);
  await expect(dialog).toHaveAccessibleName("Фото 2 из 5");
});

test("a failed cover can be retried without opening the gallery and another thumbnail remains usable", async ({ page, photos }) => {
  photos.failed.add(0);
  await openItem(page);
  const cover = page.locator(".gallery-cover");
  await expect(cover.locator(".photo-retry")).toBeVisible();
  photos.failed.delete(0);
  await cover.locator(".photo-retry").click();
  await expectPhoto(cover, 0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Фото 2", exact: true }).click();
  await expectPhoto(cover, 1);
});

test("a failed zoom source does not poison the normal source of the same photo", async ({ page }) => {
  await page.route("**/media/photo-loading-0-0/1600", (route) => route.fulfill({
    status: 503, headers: { "cache-control": "no-store" }, body: "Synthetic full-resolution failure",
  }));
  await openItem(page);
  await expectPhoto(page.locator(".gallery-cover"), 0);
  await page.locator(".gallery-cover").click();
  const dialog = page.getByRole("dialog");
  const gallery = dialog.locator(".gallery-view");
  await expectPhoto(gallery, 0);
  const normalSource = await gallery.locator("img").evaluate((image) => (image as HTMLImageElement).currentSrc);
  expect(normalSource).not.toMatch(/\/1600$/);
  const zoom = dialog.getByRole("slider", { name: "Масштаб" });
  await zoom.press("ArrowRight");
  await expect(zoom).toHaveValue("1.25");
  await expect(gallery.locator(".photo-retry")).toBeVisible();
  await zoom.press("ArrowLeft");
  await expect(zoom).toHaveValue("1");
  await expectPhoto(gallery, 0);
  expect(await gallery.locator("img").evaluate((image) => (image as HTMLImageElement).currentSrc)).toBe(normalSource);
  await expect(dialog).toHaveAccessibleName("Фото 1 из 5");
});

test("catalog photo choices load eagerly in both directions without preloading the whole catalog", async ({ page, photos }) => {
  await page.goto("/#/catalog");
  const card = page.locator(".product-card").nth(5);
  const target = card.locator(".product-image-button");
  await target.scrollIntoViewIfNeeded();
  await expectPhoto(target, 0);
  await expect(target.locator("img")).toHaveAttribute("loading", "lazy");
  expect(photos.requests.every((request) => request.photo === 0), "Opening a catalog must load only its cover images").toBe(true);
  await syntheticDrag(target, -90, 0);
  await expect(target.locator("img")).toHaveAttribute("loading", "eager");
  await expectPhoto(target, 1);
  await syntheticDrag(target, 90, 0);
  await expect(target.locator("img")).toHaveAttribute("loading", "eager");
  await expectPhoto(target, 0);
  expect(photos.requests.every((request) => request.photo === 0 || request.item === 5), "Only the explicitly selected catalog card may request another image").toBe(true);
  expect(photos.apiRequests.some((request) => /^GET \/items\//.test(request))).toBe(false);
});

test.describe("responsive photos on dense screens", () => {
  test.use({ deviceScaleFactor: 3 });

  test("tiny thumbnails use the small variant and only neighbors of a ready photo are prefetched", async ({ page, photos }) => {
    const release = photos.hold(0);
    await openItem(page);
    const cover = page.locator(".gallery-cover");
    await expect(cover.locator(".photo-loading")).toBeVisible();
    await expect.poll(() => photos.requests.some((request) => request.photo === 0 && request.width > 240)).toBe(true);
    await layoutFrames(page);
    expect(photos.requests.filter((request) => request.width > 240).every((request) => request.photo === 0), "Neighbors must not compete with a still-loading selected photo").toBe(true);
    release();
    await expectPhoto(cover, 0);
    const selectedWidth = await cover.locator("img").evaluate((image) => Number((image as HTMLImageElement).currentSrc.split("/").at(-1)));
    await expect.poll(() => photos.requests.some((request) => request.photo === 1 && request.width === selectedWidth)).toBe(true);
    expect(photos.requests.filter((request) => request.width > 240).every((request) => request.photo <= 1), "The first photo may prefetch only its next neighbor").toBe(true);

    const lastThumb = page.getByRole("button", { name: "Фото 5", exact: true });
    await lastThumb.scrollIntoViewIfNeeded();
    await expect.poll(() => decodedColour(lastThumb.locator("img"))).toEqual(rgb(4));
    await expect(lastThumb.locator("img")).toHaveAttribute("sizes", "56px");
    expect(await page.evaluate(() => devicePixelRatio)).toBe(3);
    expect(await lastThumb.locator("img").evaluate((image) => (image as HTMLImageElement).currentSrc)).toMatch(/\/240$/);

    await page.getByRole("button", { name: "Фото 3", exact: true }).click();
    await expectPhoto(cover, 2);
    await expect.poll(() => photos.requests.some((request) => request.photo === 3 && request.width === selectedWidth)).toBe(true);
    expect(photos.requests.filter((request) => request.width > 240).every((request) => request.item === 0 && request.photo <= 3), "Prefetch stays within the active item and its immediate neighbors").toBe(true);
  });
});
