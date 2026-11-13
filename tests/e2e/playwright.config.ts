import { defineConfig, devices } from "@playwright/test";

// Shared across projects/workers so the mobile project can sign in with the account desktop created.
process.env.E2E_EMAIL ||= `e2e-${Date.now()}@example.com`;

export default defineConfig({
  testDir: ".",
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: process.env.E2E_BASE_URL || "http://localhost:3000", trace: "off", screenshot: "only-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], launchOptions: process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {} } },
    { name: "mobile", use: { ...devices["Pixel 7"], launchOptions: process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {} }, grep: /@mobile/, dependencies: ["desktop"] },
  ],
});
