import { defineConfig, devices } from "@playwright/test";

const PORT = 3100;
const CI = Boolean(process.env["CI"]);

/**
 * E2E smoke tests. /api/chat is faked in the browser (page.route), so no database, API keys
 * or test code in the app are needed. CI runs against the production build; locally the
 * webpack dev server is used (see CLAUDE.md: native SWC is blocked on the dev machine).
 */
export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  // The local dev server compiles each page on first request (slowly, with WASM SWC).
  timeout: CI ? 30_000 : 90_000,
  reporter: CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: CI ? `pnpm start --port ${PORT}` : `pnpm dev:webpack --port ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !CI,
    timeout: 180_000,
  },
});
