import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { z } from "zod";
import { tx } from "./db.js";
import { encrypt, decrypt } from "./crypto.js";
import { assert } from "./errors.js";

// Incomplete drafts and recipient profiles use their own encrypted records, never order history.
export const draftFields = z.object({
  method: z.enum(["PICKUP", "BELPOST", "EUROPOST"]).optional(),
  phone: z.string().max(40).optional(),
  fullName: z.string().max(200).optional(),
  city: z.string().max(200).optional(),
  office: z.string().max(500).optional(),
  officeAddress: z.string().max(500).optional(),
  postalCode: z.string().max(20).optional(),
  comment: z.string().max(1000).optional(),
});
const profileFields = draftFields.omit({ comment: true });
const revision = z.number().int().min(0).max(2147483647);
export async function lockCheckoutUser(c: PoolClient, userId: string) {
  const user = (await c.query("SELECT * FROM users WHERE id=$1 FOR UPDATE", [userId])).rows[0];
  assert(user, 401, "AUTH_REQUIRED", "Переоткройте приложение через Telegram");
  return user;
}
export async function recipientProfile(c: PoolClient, userId: string) {
  const row = (await c.query("SELECT * FROM recipient_profiles WHERE user_id=$1", [userId])).rows[0];
  return {
    recipient: row?.value_enc ? decrypt<Record<string, string>>(row.value_enc) : null,
    enabled: row ? row.enabled : true,
    version: row?.version ?? 0,
  };
}
export async function invalidateCheckout(c: PoolClient, userId: string) {
  await c.query("DELETE FROM checkout_drafts WHERE user_id=$1", [userId]);
  const row = (await c.query("UPDATE users SET checkout_token=gen_random_uuid(),checkout_revision=0 WHERE id=$1 RETURNING checkout_token", [userId])).rows[0];
  return { draftToken: row.checkout_token, draftRevision: 0 };
}
async function assertProfileVersion(c: PoolClient, userId: string, version: number) {
  const old = await recipientProfile(c, userId);
  assert(old.version === version, 409, "PROFILE_CHANGED", "Сохранённые данные изменились. Обновите форму перед сохранением");
  return old;
}
export async function saveRecipientProfile(
  c: PoolClient, userId: string, version: number,
  recipient: unknown, enabled: boolean,
) {
  await assertProfileVersion(c, userId, version);
  // A comment may contain arbitrary contact details; it is never a reusable profile field.
  const data = profileFields.parse(recipient);
  const row = (await c.query(
    "INSERT INTO recipient_profiles(user_id,value_enc,enabled) VALUES($1,$2,$3) ON CONFLICT(user_id) DO UPDATE SET value_enc=excluded.value_enc,enabled=excluded.enabled,version=recipient_profiles.version+1,updated_at=now() RETURNING version",
    [userId, enabled ? encrypt(data) : null, enabled],
  )).rows[0];
  return row.version as number;
}
export async function registerCheckoutData(app: FastifyInstance) {
  app.get("/me/checkout-draft", req => tx(async c => {
    const user = await lockCheckoutUser(c, req.actor.id);
    const profile = await recipientProfile(c, req.actor.id);
    const draft = (await c.query("SELECT value_enc FROM checkout_drafts WHERE user_id=$1", [req.actor.id])).rows[0];
    const data = draft ? decrypt<Record<string, unknown>>(draft.value_enc) : {};
    return {
      ...(profile.enabled ? profile.recipient : {}),
      ...data,
      draftToken: user.checkout_token,
      draftRevision: user.checkout_revision,
      saveRecipient: typeof data.saveRecipient === "boolean" ? data.saveRecipient : profile.enabled,
      recipientVersion: profile.version,
    };
  }));
  app.patch("/me/checkout-draft", async req => {
    const body = draftFields.extend({
      draftToken: z.uuid(), draftRevision: revision,
      saveRecipient: z.boolean().optional(), recipientVersion: revision.optional(),
    }).strict().parse(req.body);
    return tx(async c => {
      const user = await lockCheckoutUser(c, req.actor.id);
      assert(body.draftToken === user.checkout_token, 409, "DRAFT_CLOSED", "Это оформление уже завершено или данные очищены. Откройте новую форму");
      assert(body.draftRevision >= user.checkout_revision, 409, "DRAFT_STALE", "Более свежие данные уже сохранены");
      const { draftToken, draftRevision, recipientVersion: _, ...data } = body;
      const old = (await c.query("SELECT value_enc FROM checkout_drafts WHERE user_id=$1", [req.actor.id])).rows[0];
      const previous = old ? decrypt<Record<string, unknown>>(old.value_enc) : {};
      if (draftRevision === user.checkout_revision) {
        assert(old && Object.entries(data).every(([key, value]) => previous[key] === value), 409, "DRAFT_STALE", "Эта версия уже сохранена с другими данными. Обновите форму");
      }
      if (draftRevision > user.checkout_revision) {
        await c.query(
          "INSERT INTO checkout_drafts(user_id,value_enc) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET value_enc=excluded.value_enc,updated_at=now()",
          [req.actor.id, encrypt({ ...previous, ...data })],
        );
        await c.query("UPDATE users SET checkout_revision=$2 WHERE id=$1", [req.actor.id, draftRevision]);
      }
      return { ok: true, draftToken, draftRevision };
    });
  });
  app.get("/me/recipient-profile", req => tx(async c => {
    await lockCheckoutUser(c, req.actor.id);
    return recipientProfile(c, req.actor.id);
  }));
  app.patch("/me/recipient-profile", async req => {
    const body = z.object({ recipient: profileFields, enabled: z.boolean(), version: revision }).strict().parse(req.body);
    return tx(async c => {
      await lockCheckoutUser(c, req.actor.id);
      const version = await saveRecipientProfile(c, req.actor.id, body.version, body.recipient, body.enabled);
      return { ok: true, version };
    });
  });
  app.delete("/me/recipient-profile", async req => {
    const { version } = z.object({ version: revision }).strict().parse(req.body);
    return tx(async c => {
      await lockCheckoutUser(c, req.actor.id);
      const nextVersion = await saveRecipientProfile(c, req.actor.id, version, {}, false);
      return { ok: true, version: nextVersion, ...(await invalidateCheckout(c, req.actor.id)) };
    });
  });
}
