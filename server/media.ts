import type { FastifyInstance } from "fastify";
import { mkdir, writeFile, readFile, rm, rename } from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import sharp from "sharp";
import { z } from "zod";
import { pool, tx } from "./db.js";
import { config } from "./config.js";
import { assert, AppError } from "./errors.js";
import { audit } from "./inventory.js";
sharp.concurrency(1);
export const widths = [240, 480, 960, 1600];
export async function processPhoto(
  input: Buffer,
  target: string,
  rotation = 0,
) {
  let metadata: sharp.Metadata;
  try {
    metadata = await sharp(input, { limitInputPixels: 40000000 }).metadata();
  } catch {
    throw new AppError(
      422,
      "IMAGE",
      "Не удалось прочитать фото. Сохраните JPEG, PNG или WebP; для HEIC выберите JPEG в настройках камеры",
    );
  }
  assert(
    ["jpeg", "png", "webp"].includes(metadata.format ?? ""),
    422,
    "IMAGE_FORMAT",
    "Загрузите JPEG, PNG или WebP",
  );
  const stage = target + "-stage-" + randomUUID();
  await mkdir(stage, { recursive: true });
  try {
    let image = sharp(input, { limitInputPixels: 40000000 }).rotate();
    if (rotation) image = image.rotate(rotation);
    const clean = await image
      .toColorspace("srgb")
      .webp({ quality: 94 })
      .toBuffer();
    await writeFile(path.join(stage, "original.webp"), clean);
    const meta = await sharp(clean).metadata();
    for (const w of widths)
      await sharp(clean)
        .resize({ width: w, withoutEnlargement: true })
        .webp({ quality: w < 500 ? 80 : 88 })
        .toFile(path.join(stage, w + ".webp"));
    await mkdir(target, { recursive: true });
    for (const name of ["original.webp", ...widths.map((w) => w + ".webp")])
      await rename(path.join(stage, name), path.join(target, name));
    await rm(stage, { recursive: true, force: true });
    return { width: meta.width!, height: meta.height!, mime: "image/webp" };
  } catch (e) {
    await rm(stage, { recursive: true, force: true });
    throw e;
  }
}
const pId = z.object({ id: z.uuid() });
export async function registerMedia(app: FastifyInstance) {
  app.post(
    "/staff/media/uploads",
    { config: { rateLimit: { max: 24, timeWindow: "1 minute" } } },
    async (req) => {
      const file = await req.file({
        limits: { fileSize: 15 * 1024 * 1024, files: 1, fields: 2 },
      });
      assert(file, 422, "FILE", "Выберите фотографию");
      const field = file.fields.itemId as { value?: unknown } | undefined;
      const itemId = z.uuid().parse(field?.value);
      const buf = await file.toBuffer();
      assert(
        !file.file.truncated,
        413,
        "FILE_SIZE",
        "Размер фото — не более 15 МБ",
      );
      assert(
        ["image/jpeg", "image/png", "image/webp"].includes(file.mimetype),
        422,
        "IMAGE_MIME",
        "Поддерживаются JPEG, PNG и WebP",
      );
      const checksum = createHash("sha256").update(buf).digest("hex");
      const duplicate = (
        await pool.query(
          "SELECT * FROM media_assets WHERE item_id=$1 AND checksum=$2 AND state='READY'",
          [itemId, checksum],
        )
      ).rows[0];
      if (duplicate) return { ...duplicate, url: duplicate.variants["480"] };
      const id = randomUUID(),
        target = path.join(config.mediaDir, id),
        meta = await processPhoto(buf, target);
      try {
        const asset = await tx(async (c) => {
          await c.query("SELECT id FROM items WHERE id=$1 FOR UPDATE", [
            itemId,
          ]);
          const item = (
            await c.query("SELECT id FROM items WHERE id=$1", [itemId])
          ).rows[0];
          assert(item, 404, "ITEM", "Вещь не найдена");
          assert(
            !(
              await c.query("SELECT 1 FROM inventory_claim WHERE item_id=$1", [
                itemId,
              ])
            ).rowCount,
            409,
            "CLAIMED",
            "Нельзя менять фото закреплённой вещи",
          );
          const n = (
            await c.query(
              "SELECT count(*)::int AS n FROM media_assets WHERE item_id=$1 AND state='READY'",
              [itemId],
            )
          ).rows[0].n;
          assert(n < 12, 422, "PHOTO_COUNT", "Допускается до 12 фото вещи");
          const variants = Object.fromEntries(
            widths.map((w) => [w, `/media/${id}/${w}`]),
          );
          const row = (
            await c.query(
              "INSERT INTO media_assets(id,item_id,original_key,checksum,mime,width,height,variants,position) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *",
              [
                id,
                itemId,
                id + "/original.webp",
                checksum,
                meta.mime,
                meta.width,
                meta.height,
                variants,
                n,
              ],
            )
          ).rows[0];
          await audit(c, req.actor.id, "MEDIA_UPLOAD", "ITEM", itemId, {
            mediaId: id,
          });
          return row;
        });
        return { ...asset, url: asset.variants["480"] };
      } catch (e) {
        await rm(target, { recursive: true, force: true });
        throw e;
      }
    },
  );
  app.patch("/staff/media/:id", async (req) => {
    const { id } = pId.parse(req.params),
      body = z
        .object({
          role: z
            .enum(["FRONT", "BACK", "LABEL", "MEASUREMENT", "DETAIL"])
            .optional(),
          position: z.number().int().min(0).max(11).optional(),
          rotation: z
            .union([z.literal(90), z.literal(180), z.literal(270)])
            .optional(),
        })
        .parse(req.body);
    const asset = (
      await pool.query("SELECT * FROM media_assets WHERE id=$1", [id])
    ).rows[0];
    assert(asset, 404, "MEDIA", "Фото не найдено");
    // Serialize metadata and image transformation against other edits and item reservation.
    return tx(async (c) => {
      await c.query("SELECT id FROM items WHERE id=$1 FOR UPDATE", [
        asset.item_id,
      ]);
      assert(
        !(
          await c.query("SELECT 1 FROM inventory_claim WHERE item_id=$1", [
            asset.item_id,
          ])
        ).rowCount,
        409,
        "CLAIMED",
        "Нельзя менять фото закреплённой вещи",
      );
      let meta: { width: number; height: number } | undefined;
      if (body.rotation)
        meta = await processPhoto(
          await readFile(path.join(config.mediaDir, asset.original_key)),
          path.join(config.mediaDir, id),
          body.rotation,
        );
      if (body.position !== undefined) {
        const current = (
          await c.query(
            "SELECT id FROM media_assets WHERE item_id=$1 AND state='READY' ORDER BY position,created_at",
            [asset.item_id],
          )
        ).rows
          .map((r) => r.id)
          .filter((v) => v !== id);
        current.splice(Math.min(body.position, current.length), 0, id);
        for (let position = 0; position < current.length; position++)
          await c.query("UPDATE media_assets SET position=$2 WHERE id=$1", [
            current[position],
            position,
          ]);
        body.position = current.indexOf(id);
      }
      const row = (
        await c.query(
          "UPDATE media_assets SET role=coalesce($2,role),position=coalesce($3,position),width=coalesce($4,width),height=coalesce($5,height) WHERE id=$1 RETURNING *",
          [id, body.role, body.position, meta?.width, meta?.height],
        )
      ).rows[0];
      await audit(c, req.actor.id, "MEDIA_EDIT", "ITEM", asset.item_id, {
        mediaId: id,
      });
      return { ...row, url: row.variants["480"] };
    });
  });
  app.delete("/staff/media/:id", async (req) => {
    const { id } = pId.parse(req.params);
    return tx(async (c) => {
      const a = (await c.query("SELECT * FROM media_assets WHERE id=$1", [id]))
        .rows[0];
      assert(a, 404, "MEDIA", "Фото не найдено");
      await c.query("SELECT id FROM items WHERE id=$1 FOR UPDATE", [a.item_id]);
      assert(
        !(
          await c.query("SELECT 1 FROM inventory_claim WHERE item_id=$1", [
            a.item_id,
          ])
        ).rowCount,
        409,
        "CLAIMED",
        "Нельзя менять фото закреплённой вещи",
      );
      await c.query("UPDATE media_assets SET state='RETIRED' WHERE id=$1", [
        id,
      ]);
      await audit(c, req.actor.id, "MEDIA_RETIRE", "ITEM", a.item_id, {
        mediaId: id,
      });
      return { ok: true };
    });
  });
  app.get("/staff/media/:id/original", async (req, reply) => {
    const { id } = pId.parse(req.params);
    const a = (await pool.query("SELECT * FROM media_assets WHERE id=$1", [id]))
      .rows[0];
    assert(a, 404, "MEDIA", "Фото не найдено");
    reply.header("Cache-Control", "private, no-store").type("image/webp");
    return readFile(path.join(config.mediaDir, a.original_key));
  });
}
export async function serveMedia(app: FastifyInstance) {
  app.get("/media/:id/:width", async (req, reply) => {
    const { id, width } = z
      .object({ id: z.uuid(), width: z.enum(["240", "480", "960", "1600"]) })
      .parse(req.params);
    const a = (
      await pool.query(
        "SELECT m.*,i.publication,i.physical FROM media_assets m JOIN items i ON i.id=m.item_id WHERE m.id=$1",
        [id],
      )
    ).rows[0];
    assert(a, 404, "MEDIA", "Фото не найдено");
    const publicPhoto =
      a.state === "READY" &&
      a.publication === "PUBLISHED" &&
      ["AVAILABLE", "PICKED", "PACKED"].includes(a.physical);
    if (!publicPhoto) {
      const actor = req.actor;
      assert(actor, 403, "PRIVATE_MEDIA", "Фотография недоступна");
      if (actor.role === "BUYER") {
        assert(
          (
            await pool.query(
              "SELECT 1 FROM order_lines l JOIN orders o ON o.id=l.order_id WHERE l.item_id=$1 AND o.user_id=$2",
              [a.item_id, actor.id],
            )
          ).rowCount,
          403,
          "PRIVATE_MEDIA",
          "Фотография недоступна",
        );
      }
    }
    reply
      .header(
        "Cache-Control",
        publicPhoto ? "public, max-age=15" : "private, no-store",
      )
      .type("image/webp");
    try {
      return await readFile(path.join(config.mediaDir, id, width + ".webp"));
    } catch {
      throw new AppError(404, "MEDIA_MISSING", "Фото временно недоступно");
    }
  });
}
