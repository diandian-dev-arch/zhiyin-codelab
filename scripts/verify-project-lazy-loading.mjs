import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';

// Run against a production preview. All APIs are mocked; asset requests use
// the actual built files so this verifies chunk loading, not only dev modules.
const origin = process.env.READER_TEST_ORIGIN || 'http://127.0.0.1:5197';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  let failChunk = true;
  let chunkRequests = 0;
  const writes = [];
  await page.route('**/api/**', async route => {
    const request = route.request();
    if (request.method() !== 'GET') writes.push(request.method());
    const path = new URL(request.url()).pathname;
    const json = path === '/api/v1/session'
      ? { user: { id: 'lazy-test', name: 'Test', email: 'test@example.test', role: 'teacher' }, csrf: 'fixture', businessVersion: 2, executionApproved: false }
      : path === '/api/v2/projects/lazy-fixture'
        ? { id: 'lazy-fixture', name: '页面加载测试', available: false, files: [{ path: 'main.ts', lines: 1 }], omitted: [], analyses: [] }
        : path === '/api/v2/model-settings'
          ? { enabled: true, configured: false, active: false, settings: null }
          : { projects: [], tasks: [] };
    await route.fulfill({ json });
  });
  await page.route('**/assets/Projects-*.js', async route => {
    chunkRequests++;
    if (failChunk) await route.abort('failed');
    else await route.continue();
  });
  await page.goto(`${origin}/settings`);
  await expect(page.getByRole('navigation', { name: '工作台主导航' })).toBeVisible();
  assert.equal(chunkRequests, 0, 'Unrelated pages must not load the project chunk');
  await page.getByRole('navigation', { name: '工作台主导航' }).getByRole('link', { name: /项目/ }).click();
  await expect(page.getByRole('heading', { name: '项目页面暂时未能加载', exact: true })).toBeVisible();
  assert.equal(chunkRequests, 1, 'Chunk failure must not cause automatic retries');
  failChunk = false;
  await page.getByRole('button', { name: '重新加载项目页面', exact: true }).click();
  await expect(page.getByRole('button', { name: '选择 ZIP', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '项目页面暂时未能加载', exact: true })).toHaveCount(0);
  await page.goto(`${origin}/projects/lazy-fixture`);
  await expect(page.getByRole('button', { name: '开始解读', exact: true })).toBeVisible();
  assert.deepEqual(writes, [], 'Load/recovery must not write or start paid work');
  console.log('PASS production chunks: deferred outside projects, navigation failure recovery, direct detail entry; no API writes.');
} finally {
  await browser.close();
}
