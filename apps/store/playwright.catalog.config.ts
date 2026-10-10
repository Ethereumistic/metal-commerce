import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/browser",
  testMatch: "catalog.spec.ts",
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://localhost:5187",
    headless: true,
    launchOptions: {
      executablePath:
        process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || "/usr/bin/chromium",
      args: ["--no-sandbox"],
    },
  },
  webServer: [
    {
      command: "node tests/support/catalog-gateway.mjs",
      url: "http://127.0.0.1:4319/control",
      reuseExistingServer: false,
    },
    {
      command:
        "pnpm build && CLOUDFLARE_ENV= pnpm preview -- --port 5187",
      url: "http://localhost:5187/en",
      env: { CLOUDFLARE_ENV: "catalog_test" },
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
