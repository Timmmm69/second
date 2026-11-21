import type { FastifyInstance } from "fastify";
import { copyFile, link, mkdir, open, rm, rename } from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import sharp, { type Metadata } from "sharp";
import { z } from "zod";
import { pool, tx } from "./db.js";
import { config } from "./config.js";
import { assert, AppError } from "./errors.js";
import { audit } from "./inventory.js";
import { authenticate } from "./auth.js";
sharp.concurrency(1);
// Files are replaced on rotation; don't retain native caches or stale file inputs.
sharp.cache(false);
export const widths = [240, 480, 960, 1600];

// Duplicating a card must never send its images back through Sharp. Image files
// are immutable after creation: rotation writes a new staged file and renames
// it over the edited asset only. Hard links therefore preserve independence
// while using no additional disk space until a photo is edited.
export async function cloneMediaFiles(sourceId: string, duplicateId: string) {
  const source = path.join(config.mediaDir, sourceId);
  const target = path.join(config.mediaDir, duplicateId);
  await mkdir(target);
  try {
    for (const filename of ["original.webp", ...widths.map((width) => width + ".webp")]) {
      const from = path.join(source, filename);
      const to = path.join(target, filename);
      try {
        await link(from, to);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (!["EXDEV", "EPERM", "ENOSYS", "EOPNOTSUPP", "ENOTSUP", "EMLINK"].includes(code ?? "")) throw error;
        await copyFile(from, to);
      }
    }
  } catch (error) {
    await rm(target, { recursive: true, force: true });
    throw error;
  }
}
let photoBusy = false;
// No waiting queue: acquire before reading an upload or opening a transaction.
async function withPhotoProcessing<T>(work: () => Promise<T>) {
  assert(
    !photoBusy,
    503,
    "IMAGE_BUSY",
    "Обрабатывается другое фото. Повторите через несколько секунд",
  );
  photoBusy = true;
  try {
    return await work();
  } finally {
    photoBusy = false;
  }
}
export async function processPhoto(
  input: Buffer | string,
  target: string,
  rotation = 0,
) {
  return withPhotoProcessing(() => writePhoto(input, target, rotation));
}
async function writePhoto(
  input: Buffer | string,
  target: string,
  rotation = 0,
) {
  let metadata: Metadata;
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
    const original = path.join(stage, "original.webp");
    const meta = await image
      .toColorspace("srgb")
      .webp({ quality: 94 })
      .toFile(original);
    for (const w of widths)
      await sharp(original)
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
async function openMedia(filename: string) {
  try {
    // The descriptor stays pinned to the file even while rotation replaces its path.
    return await open(filename, "r");
  } catch {
    throw new AppError(404, "MEDIA_MISSING", "Фото временно недоступно");
  }
}
async function mediaStream(filename: string) {
  return (await openMedia(filename)).createReadStream();
}
export async function registerMedia(app: FastifyInstance) {
  app.post(
    "/staff/media/uploads",
    { config: { rateLimit: { max: 24, timeWindow: "1 minute" } } },
    async (req) => withPhotoProcessing(async () => {
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
        target = path.join(config.mediaDir, id);
      try {
        const meta = await writePhoto(buf, target);
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
    }),
  );

  // Compare-and-swap full order. Serializing through the item row prevents a
  // delayed response or another employee's reorder silently winning.
  app.put("/staff/items/:id/media-order", async (req) => {
    const { id } = pId.parse(req.params);
    const body = z.object({
      ids: z.array(z.uuid()).max(12),
      expectedOrder: z.array(z.uuid()).max(12),
    }).strict().parse(req.body);
    assert(new Set(body.ids).size === body.ids.length, 422, "MEDIA_ORDER", "Фото не должны повторяться");
    return tx(async (c) => {
      const item = (await c.query("SELECT id FROM items WHERE id=$1 FOR UPDATE", [id])).rows[0];
      assert(item, 404, "ITEM", "Вещь не найдена");
      assert(!(await c.query("SELECT 1 FROM inventory_claim WHERE item_id=$1", [id])).rowCount,
        409, "CLAIMED", "Нельзя менять фото закреплённой вещи");
      const current = (await c.query(
        "SELECT id FROM media_assets WHERE item_id=$1 AND state='READY' ORDER BY position,created_at,id",
        [id],
      )).rows.map((row) => row.id as string);
      assert(current.length === body.ids.length &&
        body.ids.every((mediaId) => current.includes(mediaId)), 409,
        "MEDIA_ORDER", "Состав фотографий изменился. Обновите карточку");
      if (current.every((value, index) => value === body.ids[index]))
        return { ids: current };
      assert(current.every((value, index) => value === body.expectedOrder[index]),
        409, "MEDIA_ORDER", "Порядок фотографий изменился. Обновите карточку");
      await c.query(
        `UPDATE media_assets AS m SET position=ordered.ordinality-1
           FROM unnest($2::uuid[]) WITH ORDINALITY AS ordered(id,ordinality)
           WHERE m.item_id=$1 AND m.state='READY' AND m.id=ordered.id`,
        [id, body.ids],
      );
      await audit(c, req.actor.id, "MEDIA_REORDER", "ITEM", id, { ids: body.ids });
      return { ids: body.ids };
    });
  });
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
    const edit = async () => {
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
          meta = await writePhoto(
            path.join(config.mediaDir, asset.original_key),
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
    };
    return body.rotation ? withPhotoProcessing(edit) : edit();
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
    reply.header("Cache-Control", "private, no-store");
    const stream = await mediaStream(path.join(config.mediaDir, a.original_key));
    reply.type("image/webp");
    return stream;
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
      // Public photos need only the visibility lookup, not a session query.
      await authenticate(req);
      const actor = req.actor;
      assert(actor, 403, "PRIVATE_MEDIA", "Фотография недоступна");
      if (actor.role === "BUYER") {
        assert(a.publication !== "DRAFT", 403, "PRIVATE_MEDIA", "Фотография недоступна");
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
    reply.header(
      "Cache-Control",
      publicPhoto ? "public, max-age=15" : "private, no-store",
    );
    const file = await openMedia(path.join(config.mediaDir, id, width + ".webp"));
    try {
      if (publicPhoto) {
        // fstat the descriptor, not the pathname: validator and bytes refer to
        // the same inode even if a new version is atomically renamed over it.
        const stat = await file.stat({ bigint: true });
        const etag = '"' + createHash("sha256")
          .update([stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":"))
          .digest("base64url") + '"';
        reply.header("ETag", etag);
        const condition = req.headers["if-none-match"];
        if (typeof condition === "string" && condition.split(",").some((value) => {
          const tag = value.trim();
          return tag === "*" || tag === etag || tag === "W/" + etag;
        })) {
          await file.close();
          return reply.code(304).send();
        }
      }
      reply.type("image/webp");
      return file.createReadStream();
    } catch (error) {
      await file.close();
      throw error;
    }
  });
}
