import { defineConfig } from '@playwright/test';

const apiPort = '3316';
const webPort = '5326';
const origin = `http://localhost:${webPort}`;
export default defineConfig({
  testDir: './tests/e2e-project-course',
  outputDir: 'test-results/project-course',
  workers: 1,
  timeout: 90000,
  use: {
    baseURL: origin,
    actionTimeout: 15000,
    viewport: { width: 1440, height: 1000 },
    channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'pnpm exec tsx scripts/e2e-v2-server.ts',
      url: `http://127.0.0.1:${apiPort}/api/v1/health`,
      env: { CODELAB_UI_FIXTURE: '1', API_PORT: apiPort, APP_ORIGIN: origin },
      reuseExistingServer: false,
      timeout: 60000,
    },
    {
      command: 'pnpm --filter @codelab/web dev --host localhost',
      url: origin,
      env: { WEB_PORT: webPort, API_PROXY_TARGET: `http://127.0.0.1:${apiPort}` },
      reuseExistingServer: false,
      timeout: 30000,
    },
  ],
});
