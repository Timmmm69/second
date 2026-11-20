import { defineConfig, type Project } from "@playwright/test";
import { fileURLToPath } from "node:url";

const sizes = [
  { width: 320, height: 568 },
  { width: 375, height: 667 },
  { width: 390, height: 844 },
  { width: 430, height: 932 },
];
const projects: Project[] = (["chromium", "webkit"] as const).flatMap((browserName) =>
  sizes.map((viewport) => ({
    name: `${browserName}-${viewport.width}x${viewport.height}`,
    use: {
      browserName,
      viewport,
      screen: viewport,
      hasTouch: true,
      isMobile: true,
      deviceScaleFactor: 1,
      userAgent: browserName === "webkit"
        ? "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1"
        : "Mozilla/5.0 (Linux; Android 15; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
    },
  })),
);

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  timeout: 45_000,
  expect: { timeout: 6_000 },
  outputDir: "../../test-results/mobile",
  reporter: [
    ["list"],
    ["html", { outputFolder: fileURLToPath(new URL("../../playwright-report/mobile", import.meta.url)), open: "never" }],
  ],
  use: {
    baseURL: "http://127.0.0.1:5173",
    locale: "ru-RU",
    timezoneId: "Europe/Minsk",
    contextOptions: { reducedMotion: "reduce" },
    actionTimeout: 8_000,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    serviceWorkers: "block",
  },
  projects,
  webServer: {
    command: "npm exec vite -- --host 127.0.0.1 --port 5173 --strictPort",
    url: "http://127.0.0.1:5173",
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    reuseExistingServer: !process.env.CI,
    env: { VITE_PUBLIC_DEMO: "0" },
  },
});
