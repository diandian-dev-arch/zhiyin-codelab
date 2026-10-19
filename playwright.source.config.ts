import { defineConfig } from '@playwright/test';
import base from './playwright.v2.config';

// Source analysis UI has its own service lifecycle so independent suites do not
// exhaust the production login rate limit. Model endpoints are never invoked.
export default defineConfig({
  ...base,
  testDir: './tests/e2e-source',
  outputDir: 'test-results/source',
});
