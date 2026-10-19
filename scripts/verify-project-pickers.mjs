import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { zipSync, strToU8 } from 'fflate';

// Exercise the served UI with synthetic reads; never upload to the user's database.
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();
  await page.route('**/api/**', route => {
    assert.equal(route.request().method(), 'GET', 'Verification must not write to the API');
    const pathname = new URL(route.request().url()).pathname;
    const json = pathname === '/api/v1/session'
      ? { user: { id: 'picker-test', name: 'Picker test', email: 'fixture@example.test', role: 'teacher' }, csrf: 'fixture', businessVersion: 2, executionApproved: false }
      : pathname === '/api/v2/model-settings'
        ? { enabled: true, configured: false, active: false, settings: null }
        : { projects: [], tasks: [] };
    return route.fulfill({ json });
  });
  await page.goto(process.env.PICKER_TEST_ORIGIN || 'http://127.0.0.1:5175/projects');
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const [name, directory] of [['选择 ZIP', false], ['选择文件夹', true]]) {
      const button = page.getByRole('button', { name, exact: true });
      const chooserPromise = page.waitForEvent('filechooser');
      await button.click();
      const chooser = await chooserPromise;
      assert.equal(await chooser.element().evaluate(el => el.hasAttribute('webkitdirectory')), directory);
      if (!directory) {
        assert.equal(await chooser.element().getAttribute('accept'), '.zip');
        await chooser.setFiles({ name: 'picker-regression.zip', mimeType: 'application/zip', buffer: Buffer.from(zipSync({ 'main.py': strToU8('print("fixture")') })) });
        await expect(page.locator('.zip-drop strong')).toHaveText('picker-regression.zip');
        await expect(page.getByRole('button', { name: '仅保存源码', exact: true })).toBeEnabled();
        await expect(page.getByRole('button', { name: '保存并继续', exact: true })).toBeEnabled();
      }
    }
  }
  console.log('PASS: desktop/mobile ZIP and folder button clicks open distinct pickers; ZIP selection enables save. No API writes.');
} finally {
  await browser.close();
}
