import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { zipSync, strToU8 } from 'fflate';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  await page.route('**/api/**', route => {
    assert.equal(route.request().method(), 'GET');
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({ json: path === '/api/v1/session'
      ? { user: { id: 'library-test', name: 'Library test', email: 'fixture@example.test', role: 'teacher' }, csrf: 'fixture', businessVersion: 2, executionApproved: false }
      : { projects: [{ id: 'existing-fixture', name: '已有项目', status: 'succeeded', report_quality: 'limited', created_at: '2026-10-10T10:00:00Z', last_analyzed_at: '2026-10-14T10:00:00Z' }, { id: 'old', name: '旧版项目', status: 'succeeded' }, { id: 'complete', name: '正常项目', status: 'succeeded', report_quality: 'complete' }], available: false } });
  });
  for (const [width, height] of [[1440,900], [768,1024], [390,844], [320,740]]) {
    await page.setViewportSize({ width, height });
    await page.goto(`${process.env.READER_TEST_ORIGIN || 'http://127.0.0.1:5175'}/projects`);
    const link = page.getByRole('link', { name: /已有项目/ });
    await expect(link).toBeVisible();
    await expect(link).toContainText('导入于');
    await expect(link).toContainText('最近解读');
    await expect(link).toContainText('报告可读 · 范围受限');
    await expect(page.getByRole('link', { name: /旧版项目/ })).toContainText('质量未记录');
    await expect(page.getByRole('link', { name: /正常项目/ })).toContainText('报告可读');
    await expect(page.getByRole('button', { name: '选择 ZIP', exact: true })).not.toBeVisible();
    const bounds = await link.boundingBox();
    assert.ok(bounds && bounds.y < height, `Existing project must be in first viewport at ${width}px`);
    await page.getByRole('button', { name: '导入新项目', exact: true }).click();
    const panel = page.getByRole('region', { name: '导入项目', exact: true });
    await expect(panel).toBeVisible();
    await expect(panel).toBeFocused();
    const chooserPromise = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: '选择 ZIP', exact: true }).click();
    await (await chooserPromise).setFiles({ name: 'retained.zip', mimeType: 'application/zip', buffer: Buffer.from(zipSync({ 'main.py': strToU8('print(1)') })) });
    await page.getByRole('button', { name: '收起导入', exact: true }).click();
    await expect(page.getByRole('button', { name: '导入新项目', exact: true })).toBeFocused();
    await page.getByRole('button', { name: '导入新项目', exact: true }).click();
    await expect(page.locator('.zip-drop strong')).toHaveText('retained.zip');
    await page.getByRole('button', { name: '移除文件', exact: true }).click();
    await expect(page.getByRole('button', { name: '保存并继续', exact: true })).toBeDisabled();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    console.log(`PASS library ${width}x${height}: list first, explicit import, retained selection, focus restoration, no overflow`);
  }
} finally { await browser.close(); }
