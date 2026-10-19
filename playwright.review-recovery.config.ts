import { defineConfig } from '@playwright/test';
import base from './playwright.v2.config';

// Separate service lifecycle preserves production login limits as suites grow.
export default defineConfig({
  ...base,
  testDir: './tests/e2e-review-recovery',
  outputDir: 'test-results/review-recovery',
});
