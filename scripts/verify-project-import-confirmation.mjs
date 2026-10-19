import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { zipSync, strToU8 } from 'fflate';

// All writes are intercepted synthetic responses; never reach the real API.
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  for (const primary of [true, false]) {
    const page = await browser.newPage({ reducedMotion: 'reduce', viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const writes = [];
    await page.route('**/api/**', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.method() !== 'GET') {
        writes.push({ path: url.pathname, analyze: url.searchParams.get('analyze') });
        assert.equal(url.pathname, '/api/v2/projects');
        assert.equal(url.searchParams.get('analyze'), 'false', 'Saving must never launch analysis');
        return route.fulfill({ json: { projectId: 'saved-fixture', analysisDisposition: 'not_requested' } });
      }
      const json = url.pathname === '/api/v1/session'
        ? { user: { id: 'import-test', name: 'Import test', email: 'fixture@example.test', role: 'teacher' }, csrf: 'fixture', businessVersion: 2, executionApproved: false }
        : url.pathname === '/api/v2/projects/saved-fixture'
          ? { id: 'saved-fixture', name: 'saved.zip', available: false, files: [{ path: 'main.py', lines: 1 }], omitted: [], analyses: [] }
        : url.pathname === '/api/v2/model-settings'
          ? { enabled: true, configured: false, active: false, settings: null }
        : { projects: [], tasks: [], available: false };
      await route.fulfill({ json });
    });
    await page.goto(`${process.env.PICKER_TEST_ORIGIN || 'http://127.0.0.1:5175'}/projects`);
    const chooserPromise = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: '选择 ZIP', exact: true }).click();
    const chooser = await chooserPromise;
    await chooser.setFiles({ name: 'save-only-fixture.zip', mimeType: 'application/zip', buffer: Buffer.from(zipSync({ 'main.py': strToU8('print(1)') })) });
    await page.getByRole('button', { name: primary ? '保存并继续' : '仅保存源码', exact: true }).click();
    await expect(page).toHaveURL(/\/projects\/saved-fixture$/);
    const panel = page.locator('details.next-analysis');
    if (primary) await expect(panel).toBeVisible();
    else await expect(panel).toHaveCount(0);
    if (primary) assert.equal(await panel.evaluate(el => el.open), true);
    assert.deepEqual(writes, [{ path: '/api/v2/projects', analyze: 'false' }]);
    if (primary) {
      await expect(panel.getByRole('button', { name: /确认并开始解读/ })).toBeDisabled();
      await expect(panel.getByRole('button', { name: /配置我的模型/ })).toBeVisible();
      await expect(panel.getByText(/本次范围/)).toBeVisible();
      await expect(panel.locator('details.advanced-analysis')).not.toHaveAttribute('open');
      await page.reload();
      await expect(page.locator('details.next-analysis')).toHaveCount(0);
      await page.getByRole('button', { name: '开始解读', exact: true }).click();
      await expect(page.locator('details.next-analysis')).toBeVisible();
      assert.equal(writes.length, 1, 'Refresh must not repeat import or analysis');
    }
    assert.deepEqual(errors, []);
    console.log(`PASS ${primary ? 'save and continue' : 'save only'}: one non-analysis import, expected lazy confirmation state, no model account required`);
    await page.close();
  }
} finally { await browser.close(); }
