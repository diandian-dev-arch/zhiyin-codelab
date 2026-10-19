import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

// All API reads are synthetic; never authenticate, mutate real data or call a model.
const origin = process.env.READER_TEST_ORIGIN || 'http://127.0.0.1:5174';
const output = 'output/analysis-priority-2026-10-19';
await mkdir(output, { recursive: true });
const section = { title: '入口', body: '用于验证布局的静态示例。', citations: [{ path: 'src/main.ts', start: 1, end: 1 }] };
const report = { overview: '布局测试项目', stack: [], modules: [section], flows: [], findings: [], readingPath: [section], limitations: ['只读示例'], reportQuality: 'complete' };
const active = { id: 'active-fixture', status: 'running', canCancel: true, created_at: new Date(Date.now() - 25000).toISOString(),
  analysis_options: { version: 1, mode: 'deep', modules: [] }, execution_snapshot: { model: { model: 'fixture-model' } },
  events: [{ kind: 'map', label: '建立文件地图' }, { kind: 'read', path: 'src/main.ts', label: '读取关键源码' },
    { kind: 'investigate_plan', round: 1, label: '沿入口查阅业务链路' }, { kind: 'search', label: '搜索源码：入口' },
    { kind: 'investigate_done', round: 1, label: '第一轮调查已返回' }].map(e => ({ ...e, at: new Date().toISOString() })),
  costSummary: { knownCny: .12, reservedCny: 0, unknownCalls: 0, price: { limitCny: 1 } },
};
const historical = { id: 'historical-fixture', status: 'succeeded', created_at: '2026-10-18T10:00:00Z', events: [],
  report: { report, read: { 'src/main.ts': { start: 1, end: 1 } } } };
const project = { id: 'priority-fixture', name: '项目分析布局测试', available: false, files: [{ path: 'src/main.ts', lines: 1 }], omitted: [], modules: [], analyses: [active, historical] };
const browser = await chromium.launch({ channel: 'chrome' });
const results = [], errors = [];
try {
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', async route => {
    assert.equal(route.request().method(), 'GET', 'No real mutations allowed');
    const path = new URL(route.request().url()).pathname;
    const json = path === '/api/v1/session' ? { user: { id: 'layout-test', name: '学生', email: 'fixture@example.test', role: 'student' }, csrf: 'fixture', businessVersion: 2, executionApproved: false }
      : path === '/api/v2/projects/priority-fixture' ? project
      : path === '/api/v2/model-settings' ? { enabled: true, configured: false, active: false, settings: null }
      : { projects: [], tasks: [] };
    await route.fulfill({ json });
  });
  await page.goto(`${origin}/projects/priority-fixture`);
  const progress = page.getByRole('region', { name: '解读进度', exact: true });
  await expect(progress.getByRole('heading', { name: '分析过程', exact: true })).toBeVisible();
  await expect(progress).toContainText('第一轮调查已返回');
  await expect(progress).toContainText('¥0.1200');
  await expect(progress.locator('[aria-current="step"]')).toHaveText('2追踪核心业务');
  await expect(page.getByRole('button', { name: '停止当前分析', exact: true }).filter({ visible: true })).toHaveCount(1);
  for (const theme of ['bronze', 'celadon', 'ochre', 'rose']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    for (const width of [1440, 962, 768, 390, 320]) {
      await page.setViewportSize({ width, height: width < 600 ? 844 : 900 });
      await page.evaluate(() => scrollTo(0, 0));
      const layout = await progress.evaluate(element => {
        const rect = element.getBoundingClientRect(), stop = element.querySelector('button:last-child').getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom, stopBottom: stop.bottom, width: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth };
      });
      assert(!layout.overflow, `${theme}/${width}: horizontal overflow`);
      assert(layout.top >= 0 && layout.top < 500, `${theme}/${width}: progress below first viewport`);
      assert(layout.stopBottom < (width < 600 ? 844 - 90 : 900), `${theme}/${width}: stop action below usable viewport`);
      results.push({ theme, ...layout });
      if (theme === 'bronze' && [1440, 390].includes(width)) await page.screenshot({ path: `${output}/running-${width}.png` });
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator('#project-analysis-record').selectOption(historical.id);
  await expect(page.getByRole('region', { name: '项目解读报告', exact: true })).toBeVisible();
  await expect(progress).toContainText('第一轮调查已返回');
  await progress.getByRole('button', { name: '完整分析轨迹', exact: true }).click();
  await expect(page.locator('.analysis-details')).toHaveAttribute('open', '');
  await expect(page.locator('.analysis-details .source-ledger')).toContainText('第一轮调查已返回');
  await page.getByRole('button', { name: '关闭分析详情', exact: true }).click();
  await expect(progress.getByRole('button', { name: '完整分析轨迹', exact: true })).toBeFocused();
  assert.deepEqual(errors, []);
  await writeFile(`${output}/results.json`, JSON.stringify({ checks: results, pageErrors: errors, externalModelCalls: 0 }, null, 2));
  console.log(JSON.stringify({ passed: true, layouts: results.length, pageErrors: errors }));
} finally { await browser.close(); }
