import { randomBytes } from "node:crypto";
import { statfs } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, tx } from "./db.js";
import { assert } from "./errors.js";
import { digest, decrypt } from "./crypto.js";
import { config } from "./config.js";
import { audit } from "./inventory.js";
import { reflowCalendar, readOrder } from "./orders.js";
import { readItems } from "./catalog.js";
const times = z
  .tuple([
    z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  ])
  .refine((t) => t[0] < t[1], "Время закрытия должно быть позже открытия")
  .nullable();
const calendar = z
  .object({
    week: z.record(z.string().regex(/^[0-6]$/), times),
    exceptions: z.record(z.string().regex(/^\d{4}-\d{2}-\d{2}$/), times),
  })
  .refine(
    (c) => Object.values(c.week).some(Boolean),
    "Нужен хотя бы один рабочий день",
  );
const carrier = z.object({
  enabled: z.boolean(),
  codConfirmed: z.boolean().default(false),
  returnsConfirmed: z.boolean().default(false),
  terms: z.string().max(6000),
  contract: z.string().max(1000),
  paymentScheme: z.string().max(3000).optional(),
  returnsScheme: z.string().max(3000).optional(),
  verifiedAt: z.string().optional(),
  partialDelivery: z.boolean().optional(),
});
const settingsSchema = z.object({
  version: z.number().int(),
  name: z.string().trim().min(1).max(100),
  address: z.string().max(1000),
  phone: z.string().max(80),
  telegramUsername: z.string().regex(/^@?[a-zA-Z0-9_]{0,32}$/),
  seller: z.string().max(4000),
  documents: z.object({
    privacy: z.string().max(12000),
    reservation: z.string().max(12000),
    shipping: z.string().max(12000),
    returns: z.string().max(12000),
  }),
  calendar,
  carriers: z.object({ BELPOST: carrier, EUROPOST: carrier }),
  acceptingOrders: z.boolean(),
});
export async function settings() {
  const r = (
    await pool.query("SELECT value,version FROM store_settings WHERE id=true")
  ).rows[0];
  return { ...r.value, version: r.version };
}
export async function registerSettings(app: FastifyInstance) {
  app.get("/settings", async () => {
    const s = await settings();
    return {
      ...s,
      carriers: Object.fromEntries(
        Object.entries(s.carriers as Record<string, any>).map(([k, v]) => [
          k,
          { enabled: v.enabled, terms: v.terms },
        ]),
      ),
    };
  });
  app.get("/delivery/options", async () => {
    const s = await settings();
    return {
      options: [
        { id: "PICKUP", name: "Самовывоз", enabled: s.acceptingOrders },
        ...Object.entries(s.carriers as Record<string, any>).map(([id, v]) => ({
          id,
          enabled: v.enabled,
          terms: v.terms,
        })),
      ],
    };
  });
  app.get("/delivery/offices", async () => ({
    offices: [],
    manualEntry: true,
    message:
      "Укажите номер/индекс и адрес отделения. Сотрудник сверит их на официальном сайте почты.",
  }));
  app.get("/owner/settings", settings);
  app.patch("/owner/settings", async (req) => {
    const next = settingsSchema.parse(req.body);
    for (const [id, c] of Object.entries(next.carriers))
      if (c.enabled)
        assert(
          c.codConfirmed &&
            c.returnsConfirmed &&
            c.contract.trim().length >= 5 &&
            c.terms.trim().length >= 20 &&
            (c.paymentScheme ?? "").trim().length >= 20 &&
            (c.returnsScheme ?? "").trim().length >= 20 &&
            !!c.verifiedAt,
          422,
          "CARRIER_CONTRACT",
          `Для ${id} нужны реквизиты действующего договора, проверенные условия оплаты, возврата и дата сверки`,
        );
    if (next.acceptingOrders)
      assert(
        next.address.trim() &&
          next.phone.trim() &&
          next.seller.trim() &&
          next.telegramUsername.trim() &&
          Object.values(next.documents).every((v) => v.trim().length >= 20),
        422,
        "LAUNCH_SETTINGS",
        "Заполните реквизиты, адрес, контакты и проверенные документы магазина",
      );
    return tx(async (c) => {
      const old = (
        await c.query("SELECT * FROM store_settings WHERE id=true FOR UPDATE")
      ).rows[0];
      assert(
        old.version === next.version,
        409,
        "VERSION",
        "Настройки изменены. Обновите страницу",
      );
      const value = { ...next };
      delete (value as any).version;
      const version = old.version + 1;
      await c.query(
        "INSERT INTO rule_versions(settings_version,value) VALUES($1,$2)",
        [old.version, old.value],
      );
      await c.query(
        "UPDATE store_settings SET value=$1,version=$2,updated_at=now() WHERE id=true",
        [value, version],
      );
      await reflowCalendar(c, next.calendar, version);
      await audit(c, req.actor.id, "SETTINGS_EDIT", "STORE", "true", {
        previousVersion: old.version,
        version,
      });
      return { ...value, version };
    });
  });
  app.get("/owner/staff", async () => ({
    staff: (
      await pool.query(
        "SELECT id,telegram_id::text AS \"telegramId\",display_name AS \"displayName\",role FROM users WHERE role IN ('STAFF','OWNER') ORDER BY created_at",
      )
    ).rows,
  }));
  app.post("/owner/staff/invites", async (req) => {
    const b = z
      .object({
        telegramId: z.string().regex(/^\d{5,16}$/),
        role: z.literal("STAFF"),
      })
      .parse(req.body);
    return tx(async (c) => {
      const token = randomBytes(32).toString("base64url");
      const row = (
        await c.query(
          "INSERT INTO staff_invites(token_hash,telegram_id,created_by,expires_at) VALUES($1,$2,$3,now()+interval '24 hours') RETURNING expires_at",
          [digest(token), b.telegramId, req.actor.id],
        )
      ).rows[0];
      await audit(c, req.actor.id, "STAFF_INVITE", "USER", b.telegramId, {});
      return { token, expiresAt: row.expires_at };
    });
  });
  app.delete("/owner/staff/:id", async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    assert(
      id !== req.actor.id,
      409,
      "SELF_REVOKE",
      "Нельзя отозвать собственную роль владельца",
    );
    return tx(async (c) => {
      const user = (
        await c.query("SELECT * FROM users WHERE id=$1 FOR UPDATE", [id])
      ).rows[0];
      assert(
        user && user.role !== "OWNER",
        403,
        "OWNER_PROTECTED",
        "Роль владельца меняется только администратором сервера",
      );
      await c.query(
        "UPDATE users SET role='BUYER',auth_version=auth_version+1 WHERE id=$1",
        [id],
      );
      await c.query(
        "UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL",
        [id],
      );
      await audit(c, req.actor.id, "STAFF_REVOKE", "USER", id, {});
      return { ok: true };
    });
  });
  app.get("/owner/audit", async (req) => {
    const q = z
      .object({
        actor: z.string().optional(),
        entity: z.string().optional(),
        before: z.string().optional(),
        from: z.string().optional(),
      })
      .parse(req.query);
    return {
      events: (
        await pool.query(
          'SELECT id,actor_id AS "actorId",command,entity_type AS "entityType",entity_id AS "entityId",details,created_at AS "createdAt" FROM audit_events WHERE ($1::text IS NULL OR actor_id::text=$1) AND ($2::text IS NULL OR entity_id=$2) AND ($3::bigint IS NULL OR id<$3) AND ($4::timestamptz IS NULL OR created_at>=$4) ORDER BY id DESC LIMIT 100',
          [q.actor ?? null, q.entity ?? null, q.before ?? null, q.from ?? null],
        )
      ).rows,
    };
  });
  app.get("/owner/operations", async () => {
    let disk = null;
    try {
      const d = await statfs(config.mediaDir);
      disk = { freeBytes: d.bavail * d.bsize, totalBytes: d.blocks * d.bsize };
    } catch {
      /* initial empty storage */
    }
    return {
      outbox: (
        await pool.query(
          "SELECT id,event_type AS \"eventType\",state,attempts,last_error AS \"lastError\",created_at AS \"createdAt\" FROM outbox_events WHERE state NOT IN ('SENT','DRY_RUN','SKIPPED') ORDER BY created_at LIMIT 100",
        )
      ).rows,
      issues: (
        await pool.query(
          "SELECT * FROM operation_issues WHERE state='OPEN' ORDER BY created_at LIMIT 100",
        )
      ).rows,
      worker:
        (await pool.query("SELECT * FROM jobs WHERE name='maintenance'"))
          .rows[0] ?? null,
      disk,
    };
  });
  app.post("/owner/outbox/:id/retry", async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    await pool.query(
      "UPDATE outbox_events SET state='PENDING',available_at=now(),locked_until=NULL,last_error=NULL WHERE id=$1 AND state IN ('FAILED','BLOCKED')",
      [id],
    );
    return { ok: true };
  });
  app.get(
    "/staff/search",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (req) => {
      const { q } = z
        .object({ q: z.string().trim().min(2).max(100) })
        .parse(req.query);
      const matching = (
        await pool.query(
          "SELECT id FROM items WHERE title ILIKE $1 OR sku ILIKE $1 ORDER BY created_at DESC LIMIT 50",
          ["%" + q + "%"],
        )
      ).rows;
      const ids: string[] = [];
      let before: Date | null = null;
      for (let page = 0; page < 200; page++) {
        const rows: any[] = (
          await pool.query(
            "SELECT id,number,recipient_enc,created_at FROM orders WHERE ($1::timestamptz IS NULL OR created_at<$1) ORDER BY created_at DESC LIMIT 250",
            [before],
          )
        ).rows;
        if (!rows.length) break;
        for (const row of rows) {
          const r = row.recipient_enc ? decrypt(row.recipient_enc) : {};
          if (
            String(row.number).includes(q) ||
            [r.phone, r.fullName].some((v) =>
              String(v ?? "")
                .toLowerCase()
                .includes(q.toLowerCase()),
            )
          )
            ids.push(row.id);
          if (ids.length >= 50) break;
        }
        if (ids.length >= 50 || rows.length < 250) break;
        before = rows.at(-1).created_at;
      }
      await pool.query(
        "INSERT INTO access_events(actor_id,action) VALUES($1,'STAFF_SEARCH')",
        [req.actor.id],
      );
      const orders = await tx(async (c) => {
        const out = [];
        for (const id of ids) out.push(await readOrder(c, id, req.actor));
        return out;
      });
      return {
        items: await readItems(
          matching.map((x) => x.id),
          true,
        ),
        orders,
      };
    },
  );
}
