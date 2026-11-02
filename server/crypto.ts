import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHash,
} from "node:crypto";
import { config } from "./config.js";
export function encrypt(value: unknown): string {
  const iv = randomBytes(12);
  const c = createCipheriv(
    "aes-256-gcm",
    Buffer.from(config.dataKey, "hex"),
    iv,
  );
  const data = Buffer.concat([
    c.update(JSON.stringify(value), "utf8"),
    c.final(),
  ]);
  return [iv, c.getAuthTag(), data]
    .map((v) => v.toString("base64url"))
    .join(".");
}
export function decrypt<T = any>(value: string): T {
  const [iv, tag, data] = value
    .split(".")
    .map((s) => Buffer.from(s, "base64url"));
  const c = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(config.dataKey, "hex"),
    iv,
  );
  c.setAuthTag(tag);
  return JSON.parse(Buffer.concat([c.update(data), c.final()]).toString());
}
export const digest = (s: string) =>
  createHash("sha256").update(s).digest("hex");
