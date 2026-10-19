import { defineConfig } from '@playwright/test';
import base from './playwright.v2.config';

const apiPort = '3361', webPort = '5361';
const origin = `http://localhost:${webPort}`;
export default defineConfig({
  ...base,
  testDir: './tests/e2e-session-hardening',
  outputDir: 'test-results/session-hardening',
  use: { ...base.use, baseURL: origin, channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' },
  webServer: [
    { command: 'pnpm exec tsx scripts/e2e-v2-server.ts',
      url: `http://127.0.0.1:${apiPort}/api/v1/health`,
      env: { CODELAB_UI_FIXTURE: '1', API_PORT: apiPort, APP_ORIGIN: origin },
      reuseExistingServer: false, timeout: 60000 },
    { command: 'pnpm --filter @codelab/web dev --host localhost', url: origin,
      env: { WEB_PORT: webPort, API_PROXY_TARGET: `http://127.0.0.1:${apiPort}` },
      reuseExistingServer: false, timeout: 30000 },
  ],
});
