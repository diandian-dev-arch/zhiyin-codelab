import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';

// UI contract only: all API requests are mocked. Server deduplication is tested
// independently against PostgreSQL in source-projects.test.ts.
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  const pages = await Promise.all([context.newPage(), context.newPage()]);
  const errors = [];
  pages.forEach(page => page.on('pageerror', error => errors.push(error.message)));
  let posts = 0;
  const readers = new Set();
  let release;
  const bothSubmitted = new Promise(resolve => { release = resolve; });
  const project = { id: 'multitab-fixture', name: '双标签页验证', available: true,
    files: [{ path: 'main.ts', lines: 1 }], omitted: [], analyses: [] };
  await context.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/v2/projects/multitab-fixture/analyze') {
      assert.equal(request.method(), 'POST');
      const ordinal = ++posts;
      if (posts === 2) {
        project.analyses = [{ id: 'shared-job', status: 'running',
          created_at: new Date().toISOString(), started_at: new Date().toISOString(),
          canCancel: false, events: [] }];
        release();
      }
      await bothSubmitted;
      return route.fulfill({ json: { id: 'shared-job', reused: false,
        active: ordinal > 1, analysisDisposition: ordinal === 1 ? 'queued' : 'active' } });
    }
    if (path === '/api/v2/source-cost-preview') return route.fulfill({ json: {
      price: { inputPerMillion: 2, outputPerMillion: 3, label: '测试价格' }, allocationCny: 1, maxCalls: 4,
    } });
    assert.equal(request.method(), 'GET', `Unexpected mutation: ${path}`);
    if (path === '/api/v2/projects/multitab-fixture') {
      if (project.analyses.length) readers.add(request.frame().page());
      return route.fulfill({ json: project });
    }
    return route.fulfill({ json: path === '/api/v1/session'
      ? { user: { id: 'test', name: 'Test', email: 'fixture@example.test', role: 'teacher' }, csrf: 'fixture', businessVersion: 2, executionApproved: false }
      : path === '/api/v2/model-settings'
        ? { enabled: true, configured: true, active: false, settings: { vendor: 'deepseek', model: 'fixture', maxOutputTokens: 12000 } }
        : { projects: [], tasks: [] } });
  });
  const origin = process.env.READER_TEST_ORIGIN || 'http://127.0.0.1:5175';
  await Promise.all(pages.map(async page => {
    await page.goto(`${origin}/projects/multitab-fixture`);
    await page.getByRole('button', { name: '开始解读', exact: true }).click();
    await expect(page.getByRole('button', { name: /确认并开始解读/ })).toBeEnabled();
  }));
  await Promise.all(pages.map(page => page.getByRole('button', { name: /确认并开始解读/ }).click()));
  await Promise.all(pages.map(page => expect(page.getByRole('region', { name: '解读进度' })).toBeVisible()));
  assert.equal(posts, 2, 'One explicit submission per tab; no automatic replay');
  assert.equal(readers.size, 2, 'Both tabs fetched the shared active task');
  const reuseNotices = await Promise.all(pages.map(page => page.getByText('这份项目已有分析正在进行，已打开现有进度。本次没有重复发起分析。', { exact: true }).count()));
  assert.equal(reuseNotices.reduce((a, b) => a + b, 0), 1);
  await Promise.all(pages.map(page => page.reload()));
  await Promise.all(pages.map(async page => {
    await expect(page.getByRole('region', { name: '解读进度' })).toBeVisible();
    await expect(page.getByRole('button', { name: '开始解读', exact: true })).toHaveCount(0);
  }));
  assert.equal(posts, 2, 'Refreshing either tab must only query status');
  assert.deepEqual(errors, []);
  console.log('PASS two tabs submit once each, show shared active state and reuse notice, refresh without resubmission; all APIs mocked, zero real fees.');
} finally { await browser.close(); }
