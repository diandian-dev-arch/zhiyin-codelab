import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';

// Synthetic source and human-authored report, never a real model result.
const origin = new URL(process.env.READER_TEST_ORIGIN || 'http://127.0.0.1:5175');
assert.ok(['127.0.0.1', 'localhost'].includes(origin.hostname));
const out = path.resolve('output/public-source-demo', randomUUID());
await mkdir(out, { recursive: true });
const source = ['const unitPrice = 12;', 'export function total(quantity: number) {', '  return quantity * unitPrice;', '}', ''].join('\n');
const citation = { path: 'total.ts', start: 1, end: 4 };
const section = { title: '计算商品总价', body: '数量乘以固定单价 12。该文件没有支付、订单或数据库操作。', citations: [citation] };
const report = { overview: '公开合成演示：数量转换为总价。人工预置报告，不是 AI 生成或实时分析结果。', stack: ['TypeScript'], modules: [section], flows: [section], findings: [], readingPath: [{ ...section, title: '先读 total 函数', nextStep: '核对数量与单价；静态阅读不等于运行测试。' }], limitations: ['人工预置，未执行源码。'] };
const project = { id: 'public-demo', name: '合成样例 · 人工预置报告', available: false, omitted: [], files: [{ path: 'total.ts', lines: 5 }], analyses: [{ id: 'authored-report', status: 'succeeded', created_at: '2026-10-17T00:00:00Z', finished_at: '2026-10-17T00:00:00Z', events: [], report: { report, read: { 'total.ts': { start: 1, end: 4 } } } }] };
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce', serviceWorkers: 'block', recordVideo: { dir: out, size: { width: 1440, height: 900 } } });
const page = await context.newPage();
const video = page.video();
const errors = [], rejected = [], chapters = [];
let sourceReads = 0;
page.on('pageerror', error => errors.push(error.message));
await context.route('**/*', async route => {
  const request = route.request(), url = new URL(request.url());
  if (url.origin !== origin.origin || request.method() !== 'GET') { rejected.push(request.method() + ' ' + url.pathname); return route.abort(); }
  if (!url.pathname.startsWith('/api/')) return route.continue();
  let json = { projects: [], tasks: [] };
  if (url.pathname === '/api/v1/session') json = { user: { id: 'demo', name: '公开演示', email: 'demo@example.test', role: 'teacher' }, csrf: 'synthetic', businessVersion: 2, executionApproved: false };
  if (url.pathname === '/api/v2/model-settings') json = { enabled: true, configured: false, active: false, settings: null };
  if (url.pathname === '/api/v2/projects/public-demo') json = project;
  if (url.pathname === '/api/v2/projects/public-demo/source') {
    assert.equal(url.searchParams.get('path'), 'total.ts');
    assert.equal(url.searchParams.get('analysisId'), 'authored-report');
    sourceReads++;
    json = { path: 'total.ts', content: source, projectId: project.id, analysisId: 'authored-report' };
  }
  return route.fulfill({ json });
});
try {
  await page.goto(origin.origin + '/projects/public-demo');
  const reader = page.getByRole('region', { name: '项目解读报告', exact: true });
  await expect(reader).toBeVisible();
  const began = Date.now();
  const hold = async (caption, seconds, filename) => {
    const start = (Date.now() - began) / 1000;
    await page.screenshot({ path: path.join(out, filename) });
    await page.waitForTimeout(seconds * 1000);
    chapters.push({ start, end: (Date.now() - began) / 1000, caption });
    console.log('Recorded: ' + caption);
  };
  await hold('人工预置报告：理解用途，非实时 AI 结果。', 15, '01-purpose.png');
  const scene = reader.getByRole('region', { name: '核心业务场景' });
  await scene.scrollIntoViewIfNeeded();
  await hold('数量乘以单价，不声称已支付或持久化。', 30, '02-scenario.png');
  await scene.getByRole('button', { name: /total.ts/ }).click();
  await expect(page.locator('.evidence-pane .highlight').first()).toBeVisible();
  await expect(page.locator('.evidence-pane')).toContainText('return quantity * unitPrice');
  await hold('核对同版源码，解释与代码一起阅读。', 25, '03-source.png');
  await page.getByRole('button', { name: '关闭源码', exact: true }).click();
  await reader.getByRole('region', { name: '优先阅读入口', exact: true }).scrollIntoViewIfNeeded();
  await hold('继续阅读：静态理解不等于运行验证。', 20, '04-reading.png');
  assert.equal(sourceReads, 1); assert.deepEqual(errors, []); assert.deepEqual(rejected, []);
  await context.close();
  const videoPath = await video.path(), bytes = await readFile(videoPath);
  assert.ok(bytes.length > 0);
  await writeFile(path.join(out, 'result.json'), JSON.stringify({ kind: 'synthetic-ui-demonstration', reportOrigin: 'human-authored', realModelEvaluation: false, realBackendVerification: false, modelCalls: 0, sourceReads, browserErrors: errors, rejectedRequests: rejected, video: path.basename(videoPath), videoBytes: bytes.length, videoSha256: createHash('sha256').update(bytes).digest('hex'), chapters }, null, 2));
  await writeFile(path.join(out, 'README.md'), '# 公开合成演示\n\n人工预置报告，非真实 AI 生成或实时分析；所有 API 拦截，无用户凭据、私有源码或模型费用。约90秒，无配音；章节和哈希见 result.json。不能证明模型质量或真实服务可用。\n');
  console.log(JSON.stringify({ directory: out, video: videoPath, bytes: bytes.length }));
} finally { await context.close(); await browser.close(); }

