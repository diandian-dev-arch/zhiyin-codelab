import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

// All API responses are synthetic. Any analysis POST is a test failure.
const origin = process.env.READER_TEST_ORIGIN || 'http://127.0.0.1:5175';
const output = process.env.READER_EXPECT_BRIEF === '0' ? 'output/reader-v2/rollback' : 'output/reader-v2';
await mkdir(output, { recursive: true });
const a = { path: 'src/main.ts', start: 30, end: 32 };
const b = { path: 'src/service.ts', start: 45, end: 46 };
const entry = { title: '提交数据并查看结果', body: '用户提交数据，服务完成计算并返回结果；未运行项目。', citations: [a, b] };
const report = { overview: '供学生输入数字并查看计算结果的学习项目。', stack: ['TypeScript'], modules: [entry], flows: [entry, { ...entry, title: '查看历史结果' }], findings: [], readingPath: [entry], limitations: ['静态阅读'], reportQuality: 'complete' };
const analysis = { id: 'report-old', status: 'succeeded', created_at: '2026-10-01T00:00:00Z', events: [], costSummary: { knownCny: .01, reservedCny: 0, unknownCalls: 0, price: { limitCny: 2, label: '合成测试价格' } }, report: { report, read: { [a.path]: { start: 1, end: 70 } } } };
const project = { id: 'reader-v2', name: '数字计算学习项目', available: true, files: [{ path: a.path, lines: 70 }, { path: b.path, lines: 70 }], omitted: [], analyses: [analysis] };
const requests = [], metrics = [], errors = [];
let slowA = false, failSource = false, releaseSlow, costRequests = 0;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ reducedMotion: 'reduce', viewport: { width: 1440, height: 900 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', async route => {
    const req = route.request(), url = new URL(req.url()), path = url.pathname;
    assert.ok(!path.endsWith('/analyze'), 'Reading must never start analysis');
    if (path === '/api/v2/source-cost-preview') {
      costRequests++;
      return route.fulfill({ json: { price: { inputPerMillion: 2, outputPerMillion: 3, label: '合成测试价格' }, maxCalls: 4, allocationCny: 2 } });
    }
    assert.equal(req.method(), 'GET');
    if (path.endsWith('/source')) {
      requests.push(Object.fromEntries(url.searchParams));
      assert.ok(project.analyses.some(item => item.id === url.searchParams.get('analysisId')));
      if (slowA && url.searchParams.get('path') === a.path) await new Promise(resolve => { releaseSlow = resolve; });
      if (failSource) return route.fulfill({ status: 503, json: { message: 'fixture unavailable' } });
      const file = url.searchParams.get('path');
      const lines = Array.from({ length: 70 }, (_, i) => `// ${file} line ${i + 1}`);
      const start = Number(url.searchParams.get('start') || 1), end = Number(url.searchParams.get('end') || 70);
      return route.fulfill({ json: { path: file, content: lines.slice(start - 1, end).join('\n'), startLine: start, totalLines: 70 } });
    }
    const json = path === '/api/v1/session' ? { user: { id: 'fixture', name: '合成测试', email: 'fixture@example.test', role: 'teacher' }, csrf: 'fixture', businessVersion: 2, executionApproved: false }
      : path === '/api/v2/projects' ? { projects: [{ ...project, status: 'succeeded' }], available: true }
      : path === `/api/v2/projects/${project.id}` ? project
      : path === '/api/v2/model-settings' ? { enabled: true, configured: true, active: false, settings: { vendor: 'deepseek', model: 'fixture', maxOutputTokens: 12000 } }
      : { tasks: [], projects: [] };
    await route.fulfill({ json });
  });
  await page.goto(`${origin}/projects`);
  await page.locator('.project-history a').filter({ hasText: project.name }).click();
  const reader = page.getByRole('region', { name: '项目解读报告', exact: true });
  await expect(reader).toBeVisible();
  assert.equal(costRequests, 0, 'Default reading must not mount cost preview');
  const purpose = reader.locator('.overview-text');
  const box = await purpose.boundingBox();
  await page.screenshot({ path: `${output}/desktop.png`, fullPage: true });
  await writeFile(`${output}/layout.json`, JSON.stringify(await page.evaluate(() => ['main', '.reading-header', '.reading-header h1', '.project-record-strip', '.cost-unknown', '.project-reader', '.reader-boundary', '.reader-tabs', '.reader-panel', '.reader-overview h2', '.overview-text'].map(selector => {
    const el = document.querySelector(selector), css = el && getComputedStyle(el), bounds = el?.getBoundingClientRect();
    return { selector, y: bounds?.y, height: bounds?.height, width: bounds?.width, padding: css?.padding, margin: css?.margin, fontSize: css?.fontSize, display: css?.display };
  })), null, 2));
  assert.ok(box.y <= 300, `Purpose starts at ${box.y}px, expected <=300`);
  const scene = reader.getByRole('region', { name: '核心业务场景' });
  const buttons = scene.getByRole('button', { name: /src\// });
  assert.ok((await buttons.first().boundingBox()).y < 856);
  metrics.push({ viewport: '1440x900', purposeY: box.y, bodyFont: await purpose.evaluate(el => getComputedStyle(el).fontSize) });
  await page.screenshot({ path: `${output}/desktop.png`, fullPage: true });
  await buttons.first().click();
  const pane = page.locator('.evidence-pane');
  await expect(pane.locator('.highlight').first()).toContainText('line 30');
  await expect(pane).toHaveJSProperty('tagName', 'ASIDE');
  await expect(pane).toContainText(entry.body);
  assert.deepEqual(requests.at(-1), { path: a.path, analysisId: 'report-old', start: '25', end: '42' });
  const beforeResize = requests.length;
  await page.screenshot({ path: `${output}/desktop-evidence.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(pane).toHaveJSProperty('tagName', 'DIALOG');
  await expect(pane).toHaveJSProperty('open', true);
  await expect(pane.locator('.highlight').first()).toContainText('line 30');
  assert.equal(requests.length, beforeResize, 'Resize must preserve the request and selected citation');
  await page.screenshot({ path: `${output}/mobile-evidence.png`, fullPage: false });
  await pane.getByRole('button', { name: '下一处', exact: true }).click();
  await expect(pane.locator('.highlight').first()).toContainText('src/service.ts line 45');
  await expect(buttons.nth(1)).toHaveAttribute('data-evidence-selected', 'true');
  await expect(buttons.first()).not.toHaveAttribute('data-evidence-selected', 'true');
  await pane.getByRole('button', { name: '查看完整文件', exact: true }).click();
  await expect(pane.getByText('完整文件 · 70 行', { exact: true })).toBeVisible();
  assert.equal(requests.at(-1).start, undefined, 'Full source is fetched only after explicit choice');
  await pane.getByRole('button', { name: '返回引用片段', exact: true }).click();
  await expect(pane.locator('.highlight').first()).toContainText('line 45');
  await page.keyboard.press('Escape');
  await expect(buttons.first()).toBeFocused();
  await page.setViewportSize({ width: 1440, height: 900 });
  // Slow A cannot replace fast B. Closing an in-flight request cannot reopen it.
  slowA = true;
  await buttons.first().click();
  await expect.poll(() => !!releaseSlow).toBe(true);
  await buttons.nth(1).click();
  await expect(pane.locator('.highlight').first()).toContainText('src/service.ts line 45');
  releaseSlow(); releaseSlow = undefined; slowA = false;
  await expect(pane.locator('.highlight').first()).toContainText('src/service.ts line 45');
  await pane.getByRole('button', { name: '关闭源码', exact: true }).click();
  slowA = true;
  await buttons.first().click();
  await expect.poll(() => !!releaseSlow).toBe(true);
  await pane.getByRole('button', { name: '关闭源码', exact: true }).click();
  releaseSlow(); releaseSlow = undefined; slowA = false;
  await expect(pane).toHaveCount(0);
  failSource = true;
  await buttons.first().click();
  await expect(pane.getByRole('alert')).toBeVisible();
  failSource = false;
  await pane.getByRole('button', { name: '重试读取源码', exact: true }).click();
  await expect(pane.locator('.highlight').first()).toContainText('line 30');
  await scene.getByLabel('切换场景').focus();
  await scene.getByLabel('切换场景').selectOption('1');
  await expect(pane).toHaveCount(0);
  await expect(scene.getByLabel('切换场景')).toBeFocused();
  const more = page.locator('.reading-more > summary');
  await more.click();
  await page.getByRole('button', { name: '重新解读', exact: true }).click();
  const budget = page.getByLabel('本次预算（元）');
  await budget.fill('3.7');
  await page.getByRole('button', { name: '关闭解读配置', exact: true }).click();
  await expect(more).toBeFocused();
  await more.click();
  await page.getByRole('button', { name: '重新解读', exact: true }).click();
  await expect(budget).toHaveValue('3.7');
  await page.getByRole('button', { name: '关闭解读配置', exact: true }).click();
  // New results arriving through the existing refresh GET never take the current tab.
  await reader.getByRole('tab', { name: '源码与模块', exact: true }).click();
  project.analyses.unshift({ ...analysis, id: 'report-new', created_at: '2026-10-17T00:00:00Z', report: { report: { ...report, overview: '新报告用途' } } });
  await expect(page.getByText('新报告已生成，当前阅读保持不变。')).toBeVisible({ timeout: 10000 });
  await expect(reader.getByRole('tab', { name: '源码与模块', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#project-analysis-record')).toHaveValue('report-old');
  await page.getByRole('button', { name: '查看新报告', exact: true }).click();
  await expect(reader).toContainText('新报告用途');
  await page.locator('#project-analysis-record').selectOption('report-old');
  await expect(reader.locator('.overview-text')).toContainText(report.overview);
  await scene.getByRole('button', { name: /src\/main.ts/ }).click();
  await expect(pane.locator('.highlight').first()).toBeVisible();
  await pane.getByRole('button', { name: '关闭源码', exact: true }).focus();
  await page.locator('#project-analysis-record').selectOption('report-new');
  await expect(pane).toHaveCount(0);
  await expect(reader.getByRole('tab', { name: '读懂项目', exact: true })).toBeFocused();
  await expect(reader).toContainText('新报告用途');
  for (const [width, height] of [[768, 1024], [390, 844], [320, 740]]) {
    await page.setViewportSize({ width, height });
    await page.evaluate(() => window.scrollTo(0, 0));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `Page overflow at ${width}`);
    await page.screenshot({ path: `${output}/reading-${width}.png`, fullPage: true });
  }
  // 200% browser zoom has an effective CSS viewport of 720x450 on a 1440x900 display.
  await page.setViewportSize({ width: 720, height: 450 });
  await expect(reader.getByRole('tab', { name: '读懂项目', exact: true })).toBeVisible();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.screenshot({ path: `${output}/zoom-200-equivalent.png`, fullPage: true });
  // Actual font enlargement additionally exercises text reflow; no clipped controls.
  await page.evaluate(() => document.documentElement.style.fontSize = '200%');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.screenshot({ path: `${output}/text-200.png`, fullPage: true });
  await page.evaluate(() => document.documentElement.style.fontSize = '');
  await page.setViewportSize({ width: 1440, height: 900 });
  const latest = project.analyses[0].report.report;
  latest.readingBrief = { version: 1, purpose: { text: '增强用途：帮助学生理解计算过程。', sourceRefs: [{ section: 'modules', index: 0 }], citations: [a] }, scenes: [{ sourceRef: { section: 'flows', index: 0 }, businessSummary: '增强业务：提交后得到结果。' }], takeaway: { text: '增强重点：先核对输入。', sourceRefs: [{ section: 'modules', index: 0 }], citations: [a] } };
  latest.findings = [{ ...entry, title: '输入线索', nextStep: '旧版兼容建议', condition: '输入不是数字时', verificationSteps: [{ action: '在隔离环境输入文本', expectedObservation: '返回校验错误' }], remediation: '确认后增加校验' }];
  await page.reload();
  const enhancements = process.env.READER_EXPECT_BRIEF !== '0';
  if (enhancements) {
    await expect(reader.locator('.purpose-text')).toHaveText(latest.readingBrief.purpose.text);
    await expect(scene).toContainText('增强业务：提交后得到结果。');
    await expect(scene.getByText(entry.body, { exact: true })).not.toBeVisible();
    await scene.getByText('展开实现细节', { exact: true }).click();
    await expect(scene.getByText(entry.body, { exact: true })).toBeVisible();
  } else {
    await expect(reader.locator('.purpose-text')).toHaveCount(0);
    await expect(reader.locator('.overview-text')).toHaveText(latest.overview);
  }
  await reader.getByRole('tab', { name: '待核实问题 1', exact: true }).click();
  await expect(reader.getByText('旧版兼容建议', { exact: true })).toBeVisible();
  await expect(reader.getByRole('heading', { name: '验证动作', exact: true })).toHaveCount(enhancements ? 1 : 0);
  await expect(reader.getByRole('heading', { name: '确认后的修复建议', exact: true })).toHaveCount(enhancements ? 1 : 0);
  latest.readingBrief.purpose.sourceRefs[0].index = 99;
  await page.reload();
  await expect(reader.locator('.purpose-text')).toHaveCount(0);
  await expect(reader.locator('.overview-text')).toHaveText(latest.overview);
  // Long names retain the original identifier; no regex stripping or hidden paths.
  project.name = '跨境销量统计与补货预测_多语言课程项目_'.repeat(7) + '20261017.zip';
  const longPath = 'src/' + '跨模块数据处理与历史记录/'.repeat(8) + 'calculate.ts';
  latest.flows[0] = { ...entry, citations: [{ ...a, path: longPath }] };
  delete project.analyses[0].costSummary;
  for (const [width, height] of [[1440, 900], [390, 844], [320, 740]]) {
    await page.setViewportSize({ width, height });
    await page.reload();
    await expect(page.locator('.cost-unknown')).toBeVisible();
    await expect(page.locator('.reading-header h1')).toHaveText(project.name);
    await page.getByRole('button', { name: '展开完整名称', exact: true }).click();
    await expect(page.locator('.reading-header h1')).not.toHaveClass(/name-collapsed/);
    await scene.getByRole('button', { name: new RegExp('calculate.ts') }).click();
    await expect(pane.locator('.evidence-path > span')).toHaveText(longPath);
    await expect(pane.locator('.highlight').first()).toContainText('line 30');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.keyboard.press('Escape');
    await page.screenshot({ path: `${output}/long-content-${width}${enhancements ? '' : '-rollback'}.png`, fullPage: true });
  }
  assert.deepEqual(errors, []);
  await writeFile(`${output}/metrics.json`, JSON.stringify({ synthetic: true, metrics, sourceRequests: requests.length, analysisRequests: 0, errors }, null, 2));
  console.log(`PASS reader V2: list navigation, first-screen contract, ranged/full source, responsive state, context, races/close/retry, focus, budget retention, in-place polling, report binding, reflow, long content, unknown fee, enhancement fallback/display rollback (${enhancements ? 'on' : 'off'}). No model calls.`);
} finally { releaseSlow?.(); await browser.close(); }
