import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../server/app.js";
import { config } from "../server/config.js";
import type { PublicPostHog } from "../shared/posthog.js";

test("fingerprinted assets are immutable, HTML revalidates, and API stays private", async () => {
  const originalCwd = process.cwd();
  const originalPostHog = config.posthog;
  const root = await mkdtemp(path.join(os.tmpdir(), "luchok-static-"));
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    await mkdir(path.join(root, "dist", "assets"), { recursive: true });
    await writeFile(path.join(root, "dist", "index.html"), "<!doctype html><title>Mini App</title>");
    await writeFile(path.join(root, "dist", "assets", "index-Ab12cd34.js"), "export const version = 1;");
    await writeFile(path.join(root, "dist", "assets", "index-Ab12cd34.css"), "body{margin:0}");
    await writeFile(path.join(root, "dist", "assets", "plain.js"), "console.log(1)");
    process.chdir(root);
    const testSettings: (PublicPostHog | undefined)[] = [undefined, { region: "eu", token: "phc_synthetic_static_test" }];
    for (const posthog of testSettings) {
      config.posthog = posthog;
      app = await buildApp();
      for (const url of ["/", "/index.html", "/deep/catalog/route"]) {
        const response: { statusCode: number; body: string; headers: Record<string, unknown> } = await app.inject(url);
        assert.equal(response.statusCode, 200, url + ": " + response.body);
        assert.match(response.body, /Mini App/);
        assert.equal(response.headers["cache-control"], "no-cache");
        const csp = String(response.headers["content-security-policy"]);
        const connectSrc = csp.split(";").find((directive) => directive.trim().startsWith("connect-src "))?.trim();
        assert.equal(connectSrc, posthog ? "connect-src 'self' https://eu.i.posthog.com" : "connect-src 'self'");
      }
      for (const extension of ["js", "css"]) {
        const response: { statusCode: number; body: string; headers: Record<string, unknown> } = await app.inject("/assets/index-Ab12cd34." + extension);
        assert.equal(response.statusCode, 200, response.body);
        assert.equal(response.headers["cache-control"], "public, max-age=31536000, immutable");
      }
      const plain = await app.inject("/assets/plain.js");
      assert.equal(plain.statusCode, 200);
      assert.doesNotMatch(String(plain.headers["cache-control"]), /immutable/);
      const api = await app.inject("/api/auth/me");
      assert.equal(api.statusCode, 200, api.body);
      assert.equal(api.headers["cache-control"], "no-store");
      await app.close();
      app = undefined;
    }
  } finally {
    config.posthog = originalPostHog;
    if (app) await app.close();
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  }
});
