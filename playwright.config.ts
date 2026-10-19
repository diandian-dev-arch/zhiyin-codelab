import { defineConfig } from "@playwright/test";
// Isolated ports keep the user's local preview and its persistent database untouched.
const apiPort = process.env.E2E_API_PORT ?? "3310";
const webPort = process.env.E2E_WEB_PORT ?? "5317";
const origin = `http://localhost:${webPort}`;
export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: "test-results/v1",
  workers: 1,
  timeout: 60000,
  use: {
    channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
    baseURL: origin,
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "pnpm exec tsx scripts/e2e-server.ts",
      url: `http://127.0.0.1:${apiPort}/api/v1/health`,
      env: { API_PORT: apiPort, APP_ORIGIN: origin },
      reuseExistingServer: false,
      timeout: 60000,
    },
    {
      command: "pnpm --filter @codelab/web dev --host localhost",
      url: origin,
      env: {
        WEB_PORT: webPort,
        API_PROXY_TARGET: `http://127.0.0.1:${apiPort}`,
      },
      reuseExistingServer: false,
      timeout: 30000,
    },
  ],
});
