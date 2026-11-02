import { sweepOrphanMedia } from "./media-maintenance.js";
import type { PoolClient } from "pg";
import { tx } from "./db.js";
import { config } from "./config.js";
import { expireOrder, getSettings } from "./orders.js";
import { lockItems, releaseClaims, issue, event, audit } from "./inventory.js";
import { localDate, hoursFor, atLocal } from "./calendar.js";
import { decrypt } from "./crypto.js";
export type DeliveryResult = {
  ok: boolean;
  status?: number;
  retryAfter?: number;
  error?: string;
};
export type Delivery = (
  chatId: string,
  message: string,
  url: string,
) => Promise<DeliveryResult>;
export async function telegramDelivery(
  chatId: string,
  message: string,
  url: string,
): Promise<DeliveryResult> {
  if (config.botDeliveryMode === "dry-run") return { ok: true };
  if (!config.botToken)
    return { ok: false, status: 403, error: "BOT_NOT_CONFIGURED" };
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${config.botToken}/sendMessage`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: message,
          reply_markup: {
            inline_keyboard: [
              [{ text: "Открыть обращение", web_app: { url } }],
            ],
          },
        }),
        signal: AbortSignal.timeout(15000),
      },
    );
    const body = (await response.json()) as any;
    return body.ok
      ? { ok: true }
      : {
          ok: false,
          status: body.error_code ?? response.status,
          retryAfter: body.parameters?.retry_after,
          error:
            body.error_code === 403
              ? "BOT_BLOCKED"
              : "TELEGRAM_" + (body.error_code ?? response.status),
        };
  } catch {
    return { ok: false, error: "TELEGRAM_NETWORK" };
  }
}
async function expireLeases(c: PoolClient) {
  const leases = (
    await c.query(
      "SELECT * FROM leases WHERE state='ACTIVE' AND expires_at<=clock_timestamp() ORDER BY expires_at,id LIMIT 100 FOR UPDATE SKIP LOCKED",
    )
  ).rows;
  for (const lease of leases) {
    const ls = (
      await c.query(
        "SELECT item_id FROM lease_lines WHERE lease_id=$1 ORDER BY item_id",
        [lease.id],
      )
    ).rows;
    if (ls.length)
      await lockItems(
        c,
        ls.map((l) => l.item_id),
      );
    const claims = (
      await c.query(
        "SELECT item_id FROM inventory_claim WHERE owner_type='CHECKOUT' AND owner_id=$1 AND expires_at<=clock_timestamp()",
        [lease.id],
      )
    ).rows;
    await releaseClaims(
      c,
      claims.map((cl) => cl.item_id),
      "Короткое удержание истекло",
    );
    await c.query("UPDATE leases SET state='EXPIRED' WHERE id=$1", [lease.id]);
  }
}
async function processOrders(c: PoolClient) {
  const rows = (
    await c.query(
      "SELECT * FROM orders WHERE status IN ('CHECKING','AWAITING_CUSTOMER','READY_FOR_PICKUP','PREPARING','DISPATCH_READY','HANDOVER','IN_FULFILLMENT') ORDER BY id FOR UPDATE SKIP LOCKED",
    )
  ).rows;
  const at = (await c.query("SELECT clock_timestamp() AS at")).rows[0]
      .at as Date,
    settings = await getSettings(c);
  for (const o of rows) {
    if (await expireOrder(c, o, at)) continue;
    if (o.status === "CHECKING" && o.verify_by <= at) {
      const exists = (
        await c.query(
          "SELECT 1 FROM operation_issues WHERE entity_id=$1 AND kind='VERIFY_OVERDUE'",
          [o.id],
        )
      ).rowCount;
      if (!exists) {
        await issue(
          c,
          o.id,
          "VERIFY_OVERDUE",
          "Проверка просрочена: обработайте до автоматической отмены",
          o.id,
        );
        await c.query(
          "UPDATE orders SET exception=true,version=version+1 WHERE id=$1",
          [o.id],
        );
        o.version++;
        await event(
          c,
          o,
          "VERIFY_OVERDUE",
          "Проверка задерживается. Магазин получил напоминание",
        );
      }
    }
    if (
      ["PREPARING", "DISPATCH_READY"].includes(o.status) &&
      o.dispatch_deadline &&
      o.dispatch_deadline <= at
    )
      await issue(
        c,
        o.id,
        "DISPATCH_OVERDUE",
        "Срок сдачи посылки нарушен. Свяжитесь с покупателем; закрепление сохранено",
        o.id,
      );
    if (o.status === "HANDOVER") {
      const h = (
        await c.query(
          "SELECT id FROM handovers WHERE order_id=$1 AND state='STARTED' AND created_at<clock_timestamp()-interval '15 minutes'",
          [o.id],
        )
      ).rows[0];
      if (h)
        await issue(
          c,
          h.id,
          "HANDOVER_STALE",
          "Установите фактический результат выдачи. Автоосвобождение запрещено",
          o.id,
        );
    }
    if (
      o.status === "READY_FOR_PICKUP" &&
      o.pickup_deadline &&
      localDate(at) === localDate(o.pickup_deadline)
    ) {
      const day = localDate(at),
        hours = hoursFor(day, settings.calendar);
      if (!hours) continue;
      const earliest = atLocal(day, hours[0] < "09:00" ? "09:00" : hours[0]),
        quiet = atLocal(day, "21:00");
      if (at >= earliest && at < quiet && o.pickup_deadline > at) {
        const type = "PICKUP_REMINDER_" + day;
        const exists = (
          await c.query(
            "SELECT 1 FROM outbox_events WHERE entity_id=$1 AND event_type=$2",
            [o.id, type],
          )
        ).rowCount;
        if (!exists)
          await event(
            c,
            o,
            type,
            "Сегодня последний день хранения. Заберите до " +
              o.pickup_deadline.toLocaleTimeString("ru-RU", {
                timeZone: "Europe/Minsk",
                hour: "2-digit",
                minute: "2-digit",
              }),
          );
      }
    }
    if (o.status === "IN_FULFILLMENT") {
      const shipments = (
        await c.query(
          "SELECT id FROM shipments WHERE order_id=$1 AND status NOT IN ('DELIVERED','CANCELLED','RETURN_RECEIVED') AND updated_at<clock_timestamp()-interval '48 hours'",
          [o.id],
        )
      ).rows;
      for (const sh of shipments)
        await issue(
          c,
          sh.id,
          "TRACKING_STALE",
          "Подтвердите актуальный статус по официальным данным перевозчика",
          o.id,
        );
    }
  }
  const counter = (
    await c.query(
      "SELECT * FROM availability_operations WHERE state='STARTED' AND created_at<clock_timestamp()-interval '15 minutes' FOR UPDATE SKIP LOCKED",
    )
  ).rows;
  for (const op of counter)
    await issue(
      c,
      op.id,
      "COUNTER_STALE",
      "Уточните фактическую выдачу у кассы. Вещи не освобождаются автоматически",
    );
}
async function retention(c: PoolClient) {
  await c.query(
    "DELETE FROM checkout_drafts WHERE updated_at<clock_timestamp()-interval '7 days'",
  );
  await c.query(
    "DELETE FROM selections WHERE updated_at<clock_timestamp()-interval '30 days'",
  );
  const rows = (
    await c.query(
      "SELECT o.* FROM orders o WHERE o.recipient_enc IS NOT NULL AND o.completed_at<clock_timestamp()-interval '90 days' AND NOT EXISTS(SELECT 1 FROM return_cases r WHERE r.order_id=o.id AND r.status NOT IN ('CLOSED','REJECTED')) ORDER BY o.id LIMIT 100 FOR UPDATE SKIP LOCKED",
    )
  ).rows;
  for (const o of rows) {
    await c.query("UPDATE orders SET recipient_enc=NULL WHERE id=$1", [o.id]);
    await c.query("DELETE FROM recipient_history WHERE order_id=$1", [o.id]);
    await c.query("DELETE FROM contact_notes WHERE order_id=$1", [o.id]);
    await scrubOperationContacts(c, [o.id]);
    await c.query(
      "INSERT INTO deletion_ledger(user_id,scope,reason) VALUES($1,$2,'Завершено исполнение + 90 дней; нет открытого возврата')",
      [o.user_id, "order:" + o.id],
    );
  }
  const requests = (
    await c.query(
      "SELECT * FROM deletion_requests WHERE status IN ('PENDING','RESTRICTED') ORDER BY created_at LIMIT 30 FOR UPDATE SKIP LOCKED",
    )
  ).rows;
  for (const request of requests) {
    const hasOpen = (
      await c.query(
        "SELECT 1 FROM orders o WHERE user_id=$1 AND (o.status NOT IN ('CLOSED','FULFILLED','CANCELLED','EXPIRED','RETURNED') OR EXISTS(SELECT 1 FROM return_cases r WHERE r.order_id=o.id AND r.status NOT IN ('CLOSED','REJECTED'))) LIMIT 1",
        [request.user_id],
      )
    ).rowCount;
    await c.query("DELETE FROM checkout_drafts WHERE user_id=$1", [
      request.user_id,
    ]);
    await c.query("DELETE FROM selections WHERE user_id=$1", [request.user_id]);
    if (hasOpen) {
      await c.query(
        "UPDATE deletion_requests SET status='RESTRICTED',reason='Сохраняются данные, необходимые для открытого исполнения/возврата; черновики удалены' WHERE id=$1",
        [request.id],
      );
      continue;
    }
    const orders = (
      await c.query("SELECT id FROM orders WHERE user_id=$1 FOR UPDATE", [
        request.user_id,
      ])
    ).rows;
    await c.query("UPDATE orders SET recipient_enc=NULL WHERE user_id=$1", [
      request.user_id,
    ]);
    await c.query(
      "DELETE FROM recipient_history WHERE order_id=ANY($1::uuid[])",
      [orders.map((o) => o.id)],
    );
    await c.query("DELETE FROM contact_notes WHERE order_id=ANY($1::uuid[])", [
      orders.map((o) => o.id),
    ]);
    await scrubOperationContacts(
      c,
      orders.map((o) => o.id),
      request.user_id,
    );
    await c.query(
      "UPDATE users SET display_name='',username=NULL,allow_bot=false,updated_at=now() WHERE id=$1",
      [request.user_id],
    );
    await c.query(
      "UPDATE deletion_requests SET status='COMPLETED',reason='Оперативные контакты удалены. История исполнения без контактов сохранена',completed_at=now() WHERE id=$1",
      [request.id],
    );
    await c.query(
      "INSERT INTO deletion_ledger(user_id,scope,reason) VALUES($1,'operational_contacts','Запрос пользователя; нет открытого исполнения/претензии')",
      [request.user_id],
    );
  }
  await c.query(
    "DELETE FROM access_events WHERE created_at<clock_timestamp()-interval '12 months'",
  );
}
function redactContacts(value: any): any {
  if (Array.isArray(value)) return value.map(redactContacts);
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (
      [
        "recipient",
        "recipientEnc",
        "pickupCode",
        "phone",
        "fullName",
        "postalCode",
        "office",
        "city",
        "comment",
        "phoneSource",
        "note",
      ].includes(key)
    )
      continue;
    result[key] = redactContacts(entry);
  }
  return result;
}
async function scrubOperationContacts(
  c: PoolClient,
  orderIds: string[],
  userId: string | null = null,
) {
  const results = (
    await c.query(
      "SELECT actor_id,key,response FROM idempotency_records WHERE entity_id=ANY($1::uuid[]) OR ($2::uuid IS NOT NULL AND actor_id=$2)",
      [orderIds, userId],
    )
  ).rows;
  for (const result of results) {
    const value = decrypt<any>(result.response.encrypted);
    await c.query(
      "UPDATE idempotency_records SET response=$3 WHERE actor_id=$1 AND key=$2",
      [
        result.actor_id,
        result.key,
        JSON.stringify({
          redacted: true,
          encrypted: encryptResult(redactContacts(value)),
        }),
      ],
    );
  }
}
import { encrypt as encryptResult } from "./crypto.js";
export async function processOutbox(deliver: Delivery = telegramDelivery) {
  for (let i = 0; i < 40; i++) {
    const row = await tx(async (c) => {
      const value = (
        await c.query(
          "SELECT e.*,u.telegram_id,u.allow_bot FROM outbox_events e JOIN users u ON u.id=e.recipient_id WHERE (e.state='PENDING' AND e.available_at<=clock_timestamp()) OR (e.state='PROCESSING' AND e.locked_until<=clock_timestamp()) ORDER BY e.available_at,e.id LIMIT 1 FOR UPDATE OF e SKIP LOCKED",
        )
      ).rows[0];
      if (!value) return null;
      if (value.event_type === "READY") {
        const order = (
          await c.query(
            "SELECT status,pickup_deadline,version FROM orders WHERE id=$1",
            [value.entity_id],
          )
        ).rows[0];
        const at = (await c.query("SELECT clock_timestamp() AS at")).rows[0]
          .at as Date;
        if (
          !order ||
          order.status !== "READY_FOR_PICKUP" ||
          order.pickup_deadline <= at ||
          order.version !== value.entity_version
        ) {
          await c.query(
            "UPDATE outbox_events SET state='SKIPPED',last_error='STALE_INVITATION' WHERE id=$1",
            [value.id],
          );
          return { skip: true };
        }
      }
      if (value.event_type.startsWith("PICKUP_REMINDER_")) {
        const o = (
          await c.query(
            "SELECT status,pickup_deadline FROM orders WHERE id=$1",
            [value.entity_id],
          )
        ).rows[0];
        const at = (await c.query("SELECT clock_timestamp() AS at")).rows[0]
          .at as Date;
        const day = localDate(at),
          time = at.toLocaleTimeString("sv-SE", {
            timeZone: "Europe/Minsk",
            hour: "2-digit",
            minute: "2-digit",
          });
        if (
          !o ||
          o.status !== "READY_FOR_PICKUP" ||
          o.pickup_deadline <= at ||
          localDate(o.pickup_deadline) !== day ||
          time < "09:00" ||
          time >= "21:00"
        ) {
          await c.query(
            "UPDATE outbox_events SET state='SKIPPED',last_error='STALE_REMINDER' WHERE id=$1",
            [value.id],
          );
          return { skip: true };
        }
      }
      if (!value.allow_bot) {
        await c.query(
          "UPDATE outbox_events SET state='SKIPPED',last_error='CONTACT_PERMISSION_MISSING' WHERE id=$1",
          [value.id],
        );
        return { skip: true };
      }
      await c.query(
        "UPDATE outbox_events SET state='PROCESSING',locked_until=clock_timestamp()+interval '2 minutes' WHERE id=$1",
        [value.id],
      );
      return value;
    });
    if (!row) break;
    if (row.skip) continue;
    const result = await deliver(
      String(row.telegram_id),
      row.message,
      row.event_type === "OWNER_ISSUE" ? `${config.origin}/#staff/issues` : ["OWNER_ORDER_REQUEST", "SHIPMENT_REQUEST"].includes(row.event_type) ? `${config.origin}/#staff/orders/${row.entity_id}` : `${config.origin}/#orders/${row.entity_id}`,
    );
    await tx(async (c) => {
      const current = (
        await c.query("SELECT * FROM outbox_events WHERE id=$1 FOR UPDATE", [
          row.id,
        ])
      ).rows[0];
      if (current.state !== "PROCESSING") return;
      const attempts = current.attempts + 1;
      await c.query(
        "INSERT INTO delivery_attempts(event_id,result) VALUES($1,$2)",
        [
          row.id,
          result.ok
            ? "OK"
            : String(result.error ?? result.status ?? "NETWORK_ERROR"),
        ],
      );
      if (result.ok) {
        await c.query(
          "UPDATE outbox_events SET state='SENT',attempts=$2,sent_at=now(),locked_until=NULL,last_error=NULL WHERE id=$1",
          [row.id, attempts],
        );
        return;
      }
      const permanent =
        result.status === 403 || result.status === 400 || attempts >= 20;
      const minutes = [1, 5, 15, 60][Math.min(attempts - 1, 3)],
        retrySeconds = Math.max(result.retryAfter ?? 0, minutes * 60);
      await c.query(
        "UPDATE outbox_events SET state=$2,attempts=$3,available_at=clock_timestamp()+$4*interval '1 second',locked_until=NULL,last_error=$5 WHERE id=$1",
        [
          row.id,
          permanent ? "FAILED" : "PENDING",
          attempts,
          retrySeconds,
          result.error ?? "TELEGRAM_ERROR",
        ],
      );
      if (permanent)
        await issue(
          c,
          row.id,
          "NOTIFICATION_FAILED",
          "Служебное сообщение не доставлено. Проверьте канал связи",
          row.entity_id,
        );
    });
  }
}
export async function tick(
  options: { deliver?: Delivery; skipOutbox?: boolean } = {},
) {
  await tx(async (c) => {
    const lock = (
      await c.query("SELECT pg_try_advisory_xact_lock(15012) AS acquired")
    ).rows[0].acquired;
    if (!lock) return;
    const previous = (
      await c.query(
        "SELECT last_run_at FROM jobs WHERE name='maintenance' FOR UPDATE",
      )
    ).rows[0];
    if (previous && Date.now() - previous.last_run_at.getTime() > 120000) {
      const owners = (await c.query("SELECT id FROM users WHERE role='OWNER'"))
        .rows;
      for (const owner of owners)
        await issue(
          c,
          owner.id,
          "WORKER_LAG",
          "Планировщик простаивал более 2 минут. Просроченные сроки обработаны по исходным обещаниям",
        );
    }
    await expireLeases(c);
    await processOrders(c);
    await retention(c);
    await c.query(
      "INSERT INTO jobs(name,last_run_at) VALUES('maintenance',clock_timestamp()) ON CONFLICT(name) DO UPDATE SET last_run_at=clock_timestamp()",
    );
    await audit(c, null, "worker.tick", "job", "maintenance");
  });
  await sweepOrphanMedia();
  if (!options.skipOutbox) await processOutbox(options.deliver);
}
