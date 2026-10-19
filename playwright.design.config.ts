import { defineConfig } from '@playwright/test';
import base from './playwright.v2.config';
// Isolated synthetic records; never use the live teaching workspace for writes.
export default defineConfig({
  ...base,
  testDir: './tests/e2e-design',
  outputDir: 'test-results/design',
  timeout: 120000,
});
