import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { pool, tx } from "./db.js";
import { config } from "./config.js";
import { assert, AppError } from "./errors.js";
import { digest, encrypt, decrypt } from "./crypto.js";
import type { Actor } from "./types.js";
export function validateInitData(
  raw: string,
  botToken: string,
  now = Date.now(),
) {
  assert(
    raw.length > 0 && raw.length < 16384 && !!botToken,
    401,
    "INIT_DATA",
    "Откройте приложение заново через Telegram",
  );
  assert(
    !/%(?![\da-f]{2})/i.test(raw),
    401,
    "INIT_DATA",
    "Некорректное кодирование",
  );
  const p = new URLSearchParams(raw),
    seen = new Set<string>();
  for (const [k, v] of p) {
    assert(
      !seen.has(k) && !v.includes("\ufffd"),
      401,
      "INIT_DATA",
      "Некорректные параметры",
    );
    seen.add(k);
  }
  const hash = p.get("hash") ?? "";
  assert(
    /^[0-9a-f]{64}$/i.test(hash),
    401,
    "SIGNATURE",
    "Неверная подпись Telegram",
  );
  p.delete("hash");
  // HMAC path signs all fields other than hash, including signature. Ed25519 rules differ.
  const check = [...p]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const expected = createHmac(
    "sha256",
    createHmac("sha256", "WebAppData").update(botToken).digest(),
  )
    .update(check)
    .digest();
  assert(
    timingSafeEqual(expected, Buffer.from(hash, "hex")),
    401,
    "SIGNATURE",
    "Неверная подпись Telegram",
  );
  const date = Number(p.get("auth_date")),
    age = now / 1000 - date;
  assert(
    Number.isInteger(date) && age >= -30 && age <= 300,
    401,
    "AUTH_EXPIRED",
    "Переоткройте приложение через Telegram",
  );
  let u: any;
  try {
    u = JSON.parse(p.get("user") ?? "null");
  } catch {
    throw new AppError(401, "INIT_DATA", "Нет данных пользователя");
  }
  assert(
    u && Number.isSafeInteger(u.id) && u.id > 0 && !u.is_bot,
    401,
    "INIT_DATA",
    "Неверный пользователь",
  );
  return u as {
    id: number;
    first_name?: string;
    last_name?: string;
    username?: string;
    allows_write_to_pm?: boolean;
  };
}
function base32(secret: string) {
  let bits = "";
  for (const c of secret.toUpperCase().replace(/=+$/, "")) {
    const n = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(c);
    if (n < 0) throw new Error("Invalid TOTP secret");
    bits += n.toString(2).padStart(5, "0");
  }
  return Buffer.from((bits.match(/.{8}/g) ?? []).map((b) => parseInt(b, 2)));
}
export function totp(secret: string, now = Date.now(), digits = 6) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(Math.floor(now / 30000)));
  const h = createHmac("sha1", base32(secret)).update(b).digest(),
    o = h[19] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 10 ** digits).padStart(
    digits,
    "0",
  );
}
export function verifyTotp(secret: string, code: string, now = Date.now()) {
  if (!secret || !/^\d{6}$/.test(code)) return false;
  return [-1, 0, 1].some((i) =>
    timingSafeEqual(
      Buffer.from(totp(secret, now + i * 30000)),
      Buffer.from(code),
    ),
  );
}
export function totpStep(secret: string, code: string, now = Date.now()): number | null {
  if (!secret || !/^\d{6}$/.test(code)) return null;
  for (const offset of [-1, 0, 1]) {
    const at = now + offset * 30000;
    if (timingSafeEqual(Buffer.from(totp(secret, at)), Buffer.from(code)))
      return Math.floor(at / 30000);
  }
  return null;
}
export async function ownerStepUp(req: FastifyRequest) {
  if (!config.production) return;
  assert(
    req.authAt && Date.now() - req.authAt.getTime() < 5 * 60000,
    401,
    "REAUTH_REQUIRED",
    "Переоткройте приложение для подтверждения доступа владельца",
  );
  assert(req.actor?.role === "OWNER" && req.sessionId, 403, "FORBIDDEN", "Доступ только владельцу");
  await tx(async c => {
    const credential = (await c.query("SELECT * FROM owner_credentials WHERE user_id=$1 FOR UPDATE", [req.actor.id])).rows[0];
    assert(credential, 403, "TOTP_ENROLLMENT_REQUIRED", "Подключите личный второй фактор через защищённый CLI сервера");
    const session = (await c.query("SELECT owner_step_up_at FROM sessions WHERE id=$1 AND revoked_at IS NULL", [req.sessionId])).rows[0];
    assert(session, 401, "AUTH_REQUIRED", "Переоткройте приложение");
    if (session.owner_step_up_at && Date.now() - session.owner_step_up_at.getTime() < 5 * 60000) return;
    const step = totpStep(decrypt<string>(credential.secret_enc), String(req.headers["x-owner-code"] ?? ""));
    assert(step !== null && step > Number(credential.last_step), 403, "TOTP_REQUIRED", "Введите новый текущий код вашего личного второго фактора");
    await c.query("UPDATE owner_credentials SET last_step=$2 WHERE user_id=$1", [req.actor.id, step]);
    await c.query("UPDATE sessions SET owner_step_up_at=clock_timestamp() WHERE id=$1", [req.sessionId]);
  });
}
export async function authenticate(req: FastifyRequest) {
  const token = req.cookies.session;
  if (token) {
    const { rows } = await pool.query(
      "SELECT u.*,s.id AS session_id,s.auth_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()",
      [digest(token)],
    );
    if (rows[0]) {
      const u = rows[0];
      req.actor = { id: u.id, telegramId: String(u.telegram_id), role: u.role };
      req.sessionId = u.session_id;
      req.authAt = u.auth_at;
    }
  }
  const path = req.url.split("?")[0].replace(/^\/api/, "");
  const needs = /^\/(me|checkout|orders|operations|staff|owner)(\/|$)/.test(
    path,
  );
  if (needs)
    assert(
      req.actor,
      401,
      "AUTH_REQUIRED",
      "Откройте приложение через Telegram",
    );
  if (/^\/(staff|owner)(\/|$)/.test(path))
    assert(
      req.actor?.role === "STAFF" || req.actor?.role === "OWNER",
      403,
      "FORBIDDEN",
      "Доступ только сотрудникам магазина",
    );
  if (/^\/owner(\/|$)/.test(path))
    assert(
      req.actor?.role === "OWNER",
      403,
      "FORBIDDEN",
      "Доступ только владельцу",
    );
  if (config.production && req.method !== "GET" && path.startsWith("/owner/"))
    await ownerStepUp(req);
}
function setCookie(reply: FastifyReply, token: string) {
  reply.setCookie("session", token, {
    httpOnly: true,
    secure: config.production,
    sameSite: "strict",
    path: "/",
    maxAge: config.sessionHours * 3600,
  });
}
async function makeSession(c: any, userId: string, initDigest?: string) {
  const token = randomBytes(32).toString("base64url");
  const { rows } = await c.query(
    "INSERT INTO sessions(token_hash,user_id,expires_at,init_digest) VALUES($1,$2,clock_timestamp()+interval '12 hours',$3) RETURNING id",
    [digest(token), userId, initDigest ?? null],
  );
  return { token, id: rows[0].id };
}
export async function registerAuth(app: FastifyInstance) {
  app.get("/auth/me", async (req) => ({
    user: req.actor ?? null,
    dev: config.localDev,
    serverNow: new Date().toISOString(),
  }));
  app.post(
    "/auth/telegram",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const { initData } = z.object({ initData: z.string() }).parse(req.body),
        u = validateInitData(initData, config.botToken),
        d = digest(
          JSON.stringify(
            [...new URLSearchParams(initData)]
              .map(([key, value]) => [
                key,
                key === "hash" ? value.toLowerCase() : value,
              ])
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
          ),
        );
      const result = await tx(async (c) => {
        await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          d,
        ]);
        const old = (
          await c.query("SELECT * FROM auth_replays WHERE digest=$1", [d])
        ).rows[0];
        if (old) {
          assert(
            req.sessionId === old.session_id,
            401,
            "AUTH_REPLAY",
            "Откройте приложение заново через Telegram",
          );
          await c.query(
            "UPDATE sessions SET auth_at=clock_timestamp() WHERE id=$1",
            [req.sessionId],
          );
          return { user: req.actor };
        }
        const row = (
          await c.query(
            "INSERT INTO users(telegram_id,display_name,username,allow_bot,telegram_verified_at) VALUES($1,$2,$3,$4,clock_timestamp()) ON CONFLICT(telegram_id) DO UPDATE SET username=excluded.username,display_name=excluded.display_name,updated_at=now(),telegram_verified_at=clock_timestamp() RETURNING *",
            [
              u.id,
              [u.first_name, u.last_name].filter(Boolean).join(" "),
              u.username ?? null,
              !!u.allows_write_to_pm,
            ],
          )
        ).rows[0];
        const s = await makeSession(c, row.id, d);
        await c.query(
          "INSERT INTO auth_replays(digest,user_id,session_id) VALUES($1,$2,$3)",
          [d, row.id, s.id],
        );
        return {
          token: s.token,
          user: {
            id: row.id,
            telegramId: String(row.telegram_id),
            role: row.role,
          } as Actor,
        };
      });
      if (result.token) setCookie(reply, result.token);
      return { user: result.user, dev: config.localDev };
    },
  );
  if (config.localDev)
    app.post("/auth/dev", async (req, reply) => {
      const { role } = z
        .object({ role: z.enum(["BUYER", "STAFF", "OWNER"]) })
        .parse(req.body);
      const id = { BUYER: 990000001, STAFF: 990000002, OWNER: 990000003 }[role];
      const s = await tx(async (c) => {
        const u = (
          await c.query(
            "INSERT INTO users(telegram_id,role,display_name) VALUES($1,$2,$3) ON CONFLICT(telegram_id) DO UPDATE SET role=excluded.role RETURNING *",
            [id, role, "Локальная проверка"],
          )
        ).rows[0];
        return {
          ...(await makeSession(c, u.id)),
          user: { id: u.id, telegramId: String(u.telegram_id), role },
        };
      });
      setCookie(reply, s.token);
      return { user: s.user, dev: true };
    });
  app.post("/auth/logout", async (req, reply) => {
    if (req.sessionId)
      await pool.query("UPDATE sessions SET revoked_at=now() WHERE id=$1", [
        req.sessionId,
      ]);
    reply.clearCookie("session", { path: "/" });
    return { ok: true };
  });
  app.post("/me/staff-invite", async (req) => {
    const { token } = z.object({ token: z.string().min(20) }).parse(req.body);
    return tx(async (c) => {
      const i = (
        await c.query(
          "SELECT * FROM staff_invites WHERE token_hash=$1 FOR UPDATE",
          [digest(token)],
        )
      ).rows[0];
      assert(
        i &&
          !i.used_at &&
          new Date(i.expires_at) > new Date() &&
          String(i.telegram_id) === req.actor.telegramId,
        403,
        "INVITE_INVALID",
        "Приглашение недействительно или предназначено другому пользователю",
      );
      await c.query(
        "UPDATE users SET role='STAFF',auth_version=auth_version+1 WHERE id=$1 AND role<>'OWNER'",
        [req.actor.id],
      );
      await c.query("UPDATE staff_invites SET used_at=now() WHERE id=$1", [
        i.id,
      ]);
      await c.query(
        "INSERT INTO audit_events(actor_id,command,entity_type,entity_id) VALUES($1,'STAFF_INVITE_ACCEPT','USER',$1)",
        [req.actor.id],
      );
      return { ok: true };
    });
  });
  app.patch("/me/contact-preference", async (req) => {
    const b = z.object({ allowBot: z.boolean() }).parse(req.body);
    await pool.query("UPDATE users SET allow_bot=$2 WHERE id=$1", [
      req.actor.id,
      b.allowBot,
    ]);
    return { ok: true };
  });
  app.get("/me/contact", async (req) => {
    const d = (
      await pool.query(
        "SELECT value_enc FROM checkout_drafts WHERE user_id=$1",
        [req.actor.id],
      )
    ).rows[0];
    return d ? decrypt(d.value_enc) : {};
  });
  app.post("/me/deletion-request", async (req) => {
    const row = (
      await pool.query(
        "INSERT INTO deletion_requests(user_id) VALUES($1) RETURNING id,status",
        [req.actor.id],
      )
    ).rows[0];
    return row;
  });
  app.post("/telegram/webhook", async (req) => {
    const received = String(
      req.headers["x-telegram-bot-api-secret-token"] ?? "",
    );
    assert(
      config.webhookSecret &&
        received.length === config.webhookSecret.length &&
        timingSafeEqual(
          Buffer.from(received),
          Buffer.from(config.webhookSecret),
        ),
      403,
      "WEBHOOK_SECRET",
      "Доступ запрещён",
    );
    const body = z
      .object({ update_id: z.number().int(), message: z.any().optional() })
      .parse(req.body);
    await tx(async (c) => {
      const inserted = await c.query(
        "INSERT INTO telegram_updates(update_id) VALUES($1) ON CONFLICT DO NOTHING RETURNING update_id",
        [body.update_id],
      );
      if (!inserted.rowCount) return;
      const m = body.message;
      if (
        m?.chat?.type === "private" &&
        m.contact &&
        m.from?.id === m.contact.user_id
      ) {
        const u = (
          await c.query("SELECT id FROM users WHERE telegram_id=$1", [
            m.from.id,
          ])
        ).rows[0];
        if (u) {
          const old = (
            await c.query(
              "SELECT value_enc FROM checkout_drafts WHERE user_id=$1 FOR UPDATE",
              [u.id],
            )
          ).rows[0];
          const data = old ? decrypt(old.value_enc) : {};
          await c.query(
            "INSERT INTO checkout_drafts(user_id,value_enc) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET value_enc=excluded.value_enc,updated_at=now()",
            [
              u.id,
              encrypt({
                ...data,
                phone: m.contact.phone_number,
                phoneSource: "TELEGRAM",
              }),
            ],
          );
        }
      }
    });
    return { ok: true };
  });
}
