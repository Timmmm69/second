import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { crc32 } from "node:zlib";
import sharp from "sharp";
import { processPhoto } from "../server/media.js";

test("photo processing rejects overlap and releases its slot after decode and write errors", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "media-slot-"));
  try {
    const input = await sharp({
      create: { width: 80, height: 120, channels: 3, background: "red" },
    }).png().toBuffer();
    const results = await Promise.allSettled(
      [0, 1, 2].map(n => processPhoto(input, path.join(dir, String(n)))),
    );
    assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
    for (const r of results.filter(r => r.status === "rejected"))
      assert.equal(r.reason.code, "IMAGE_BUSY");
    await assert.rejects(processPhoto(Buffer.from("broken"), path.join(dir, "bad")));
    // A file in place of the output directory forces a failure after encoding.
    await assert.rejects(processPhoto(input, path.join(dir, "0", "original.webp")));
    assert.deepEqual((await readdir(path.join(dir, "0"))).sort(),
      ["1600.webp", "240.webp", "480.webp", "960.webp", "original.webp"]);
    await processPhoto(input, path.join(dir, "retry"));
    assert.deepEqual((await readdir(dir)).sort(), ["0", "retry"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("photo processing preserves orientation, dimensions and variants; rejects excessive pixels", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "media-formats-"));
  try {
    for (const format of ["jpeg", "png", "webp"] as const) {
      const input = await sharp({
        create: { width: 600, height: 1000, channels: 4, background: "#c4b29b80" },
      }).toFormat(format).withMetadata({ orientation: 6 }).toBuffer();
      const target = path.join(dir, format);
      assert.deepEqual(await processPhoto(input, target),
        { width: 1000, height: 600, mime: "image/webp" });
      const original = path.join(target, "original.webp");
      const rotated = await processPhoto(original, target, 90);
      assert.deepEqual(rotated, { width: 600, height: 1000, mime: "image/webp" });
      for (const name of ["original", "240", "480", "960", "1600"]) {
        const meta = await sharp(path.join(target, name + ".webp")).metadata();
        const width = name === "original" ? 600 : Math.min(Number(name), 600);
        assert.equal(meta.width, width);
        assert.equal(meta.height, Math.round(width * 1000 / 600));
        assert.equal(meta.format, "webp");
        assert.equal(meta.exif, undefined);
      }
      assert.deepEqual(await processPhoto(original, target, 90),
        { width: 1000, height: 600, mime: "image/webp" });
    }
    const huge = await sharp({
      create: { width: 1, height: 1, channels: 3, background: "red" },
    }).png().toBuffer();
    // A valid PNG header above the 40 MP limit, without allocating a huge bitmap.
    huge.writeUInt32BE(40000001, 16);
    huge.writeUInt32BE(crc32(huge.subarray(12, 29)), 29);
    await assert.rejects(processPhoto(huge, path.join(dir, "huge")), { code: "IMAGE" });
    assert.deepEqual((await readdir(dir)).sort(), ["jpeg", "png", "webp"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
