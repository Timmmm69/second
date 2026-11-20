import Fastify from "fastify";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import staticPlugin from "@fastify/static";
import { z, ZodError } from "zod";
z.config(z.locales.ru());
import { randomUUID } from "node:crypto";
import path from "node:path";
import { access, mkdir } from "node:fs/promises";
import { config } from "./config.js";
import { pool } from "./db.js";
import { AppError, assert } from "./errors.js";
import { authenticate, registerAuth } from "./auth.js";
import { readItems, registerCatalog } from "./catalog.js";
import { registerCategories } from "./categories.js";
import { registerSettings } from "./settings.js";
import { registerMedia, serveMedia } from "./media.js";
import { registerOrders } from "./orders.js";
import { registerCheckoutData } from "./checkout-data.js";
export async function buildApp({ staticFiles = true } = {}) {
  const app = Fastify({
    logger: false,
    bodyLimit: 128 * 1024,
    requestIdHeader: false,
    genReqId: () => randomUUID(),
    trustProxy: config.production ? true : false,
  });
  app.decorateRequest("actor", null as any);
  await app.register(cookie);
  await app.register(helmet, {
    frameguard: false,
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "https://telegram.org"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        frameAncestors: [
          "'self'",
          "https://web.telegram.org",
          "https://*.telegram.org",
        ],
        upgradeInsecureRequests: config.production ? [] : null,
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    hsts: config.production
      ? { maxAge: 31536000, includeSubDomains: true }
      : false,
  });
  await app.register(rateLimit, {
    max: 120,
    timeWindow: "1 minute",
    errorResponseBuilder: () => ({
      code: "RATE_LIMIT",
      message: "Слишком много запросов. Повторите через минуту",
    }),
  });
  await app.register(multipart, {
    limits: { files: 1, fields: 4, fileSize: 15 * 1024 * 1024 },
  });
  app.addHook("preHandler", async (req) => {
    const webhook = req.url.split("?")[0] === "/api/telegram/webhook";
    if (!webhook && !["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      const origin = req.headers.origin;
      if (config.production)
        assert(
          origin === config.origin,
          403,
          "ORIGIN",
          "Откройте приложение с адреса магазина",
        );
      else if (origin)
        assert(
          [
            config.origin,
            "http://localhost:5173",
            "http://127.0.0.1:5173",
          ].includes(origin) || req.headers.host === new URL(origin).host,
          403,
          "ORIGIN",
          "Запрос с другого сайта запрещён",
        );
    }
    if (req.url.startsWith("/api/") || req.url.startsWith("/media/"))
      await authenticate(req);
  });
  app.addHook("onSend", async (req, reply, payload) => {
    if (req.url.startsWith("/api/")) reply.header("Cache-Control", "no-store");
    reply.header("X-Request-Id", req.id);
    return payload;
  });
  app.setErrorHandler((error: any, req, reply) => {
    if (error instanceof ZodError) {
      reply.code(422).send({
        code: "VALIDATION",
        message: "Проверьте заполненные поля",
        fieldErrors: Object.fromEntries(
          error.issues.map((i) => [i.path.join("."), i.message]),
        ),
        correlationId: req.id,
      });
      return;
    }
    if (error instanceof AppError) {
      reply.code(error.status).send({
        code: error.code,
        message: error.message,
        fieldErrors: error.fields,
        conflicts: error.conflicts,
        correlationId: req.id,
      });
      return;
    }
    if (error.code === "23505") {
      reply.code(409).send({
        code: "CONFLICT",
        message: "Такая запись уже существует. Обновите данные",
        correlationId: req.id,
      });
      return;
    }
    if (
      ["ECONNREFUSED", "ECONNRESET", "57P01", "53300", "08006", "08001"].includes(error.code)
    ) {
      reply.code(503).send({
        code: "DATABASE_UNAVAILABLE",
        message:
          "Сервис временно недоступен. Оформление и выдача закрыты. Повторите позже",
        correlationId: req.id,
      });
      return;
    }
    const status =
      error.statusCode && error.statusCode < 500 ? error.statusCode : 500;
    if (status >= 500)
      console.error(
        JSON.stringify({
          level: "error",
          correlationId: req.id,
          code: error.code ?? "INTERNAL",
        }),
      );
    reply.code(status).send({
      code:
        status === 413 ? "FILE_SIZE" : status >= 500 ? "INTERNAL" : "REQUEST",
      message:
        status === 413
          ? "Файл слишком большой"
          : status >= 500
            ? "Не удалось выполнить действие. Проверьте результат и повторите попытку"
            : "Проверьте запрос",
      correlationId: req.id,
    });
  });
  app.get("/api/health", async (_req, reply) => {
    try {
      await pool.query("SELECT 1 FROM store_settings WHERE id=true");
      return { ok: true };
    } catch {
      reply.code(503);
      return { ok: false };
    }
  });
  app.get("/health/live", async () => ({ ok: true }));
  app.get("/health/ready", async (_req, reply) => {
    try {
      await pool.query("SELECT 1 FROM store_settings WHERE id=true");
      return { ok: true };
    } catch {
      reply.code(503);
      return { ok: false };
    }
  });
  await app.register(
    async (api) => {
      await registerAuth(api);
      await registerCategories(api);
      await registerCatalog(api);
      await registerCheckoutData(api);
      await registerSettings(api);
      await registerMedia(api);
      await registerOrders(api);
    },
    { prefix: "/api" },
  );
  await serveMedia(app);

  // Public item preview for Telegram: one DB lookup when link is opened/unfurled,
  // no additional requests for customers browsing the catalog.
  app.get("/share/item/:id", async (req, reply) => {
    const parsed = z.object({ id: z.uuid() }).safeParse(req.params);
    if (!parsed.success) return reply.code(404).send("Not found");
    const item = (await readItems([parsed.data.id]))[0];
    if (!item || item.publication !== "PUBLISHED") return reply.code(404).send("Not found");
    const escape = (text: string) => text.replace(/[&<>"']/g, (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] || char);
    const title = escape(item.title);
    const description = escape(`${item.title} · ${(item.priceMinor / 100).toFixed(2)} BYN · секонд-хенд «Лучок»`);
    const photo = item.media.find((asset: { role?: string }) => asset.role !== "MEASUREMENT");
    const picture = photo?.variants?.["960"] || photo?.url;
    const image = picture && /^\/media\/[0-9a-fA-F-]{36}\/(240|480|960|1600)$/ ? config.origin + picture : null;
    const page = `${config.origin}/share/item/${parsed.data.id}`;
    const destination = `${config.origin}/#/items/${parsed.data.id}`;
    reply.header("Cache-Control", "public, max-age=60");
    reply.type("text/html; charset=utf-8");
    return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="robots" content="noindex"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · Лучок</title>
<meta property="og:type" content="product"><meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:url" content="${escape(page)}">
${image ? `<meta property="og:image" content="${escape(image)}">` : ""}
<meta http-equiv="refresh" content="0;url=${escape(destination)}">
</head><body><p><a href="${escape(destination)}">Открыть ${title} в «Лучке»</a></p></body></html>`;
  });
  await mkdir(config.mediaDir, { recursive: true });
  let hasStatic = false;
  if (staticFiles) {
    const root = path.resolve("dist");
    try {
      await access(path.join(root, "index.html"));
      await app.register(staticPlugin, { root, prefix: "/", wildcard: true });
      hasStatic = true;
    } catch {
      /* npm run build creates the UI */
    }
  }
  app.setNotFoundHandler((req, reply) => {
    if (
      hasStatic &&
      !req.url.startsWith("/api/") &&
      !req.url.startsWith("/media/") &&
      req.method === "GET"
    )
      return reply.sendFile("index.html");
    return reply
      .code(404)
      .send({ code: "NOT_FOUND", message: "Маршрут не найден" });
  });
  return app;
}
