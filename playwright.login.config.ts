import { defineConfig } from '@playwright/test';
import base from './playwright.v2.config';

// A separate service lifecycle keeps login-failure checks from exhausting the
// real per-IP login limit before the review suite. Production limits stay intact.
export default defineConfig({
  ...base,
  testDir: './tests/e2e-login',
  outputDir: 'test-results/login',
});
