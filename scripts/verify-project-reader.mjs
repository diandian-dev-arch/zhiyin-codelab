import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { checkReaderContrast } from './reader-contrast.mjs';

// Synthetic GET responses only: no user source, credentials, model calls or DB writes.
const citation = { path: 'src/main.ts', start: 2, end: 3 };
const section = (title, citations = [citation]) => ({ title, body: `${title}：用于解释业务的完整正文。`, citations, nextStep: '核对输入与输出。' });
const report = {
  overview: '公开测试样例：接收请求并返回计算结果。', stack: ['TypeScript'],
  modules: [section('请求处理模块')],
  flows: [section('接收请求'), section('返回结果'), section('缺少依据的场景', [])],
  findings: [], readingPath: [1, 2, 3, 4].map(n => section(`阅读入口 ${n}`)), limitations: ['仅覆盖已读文件。'],
  analysisWarnings: ['测试样例：可选补查未完成。'],
};
const project = {
  id: 'reader-fixture', name: '公开测试项目', available: false,
  files: [{ path: citation.path, lines: 4 }], omitted: [{ path: 'src/large.ts', reason: '单文件超过 512 KB' }, { path: 'src/legacy.py', reason: '不是 UTF-8 文本' }, { path: 'node_modules/pkg/main.js', reason: '依赖或构建产物' }],
  analyses: [{ id: 'report-fixture', status: 'succeeded', created_at: '2026-10-14T10:00:00Z', finished_at: '2026-10-14T10:00:30Z', events: [], report: { report, read: { [citation.path]: { start: 1, end: 4 } } } }],
};
let nextSourceControl;
function holdNextSource() {
  let release;
  const response = new Promise(resolve => { release = resolve; });
  nextSourceControl = { response };
  return { release };
}
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ reducedMotion: process.env.READER_NORMAL_MOTION === '1' ? 'no-preference' : 'reduce' });
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.route('**/api/**', async route => {
    assert.equal(route.request().method(), 'GET', 'Reader verification must not write to the API');
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/v2/projects/reader-fixture/source') {
      const analysisId = new URL(route.request().url()).searchParams.get('analysisId');
      assert.ok(project.analyses.some(analysis => analysis.id === analysisId), 'Citation source requests must identify a report from this project');
      if (nextSourceControl) {
        const control = nextSourceControl;
        nextSourceControl = undefined;
        await control.response;
      }
    }
    const json = path === '/api/v1/session'
      ? { user: { id: 'reader-test', name: 'Reader test', email: 'fixture@example.test', role: 'teacher' }, csrf: 'fixture', businessVersion: 2, executionApproved: false }
      : path === '/api/v2/projects/reader-fixture' ? project
      : path === '/api/v2/projects/reader-fixture/source' ? { path: citation.path, content: '// fixture\nconst input = 1;\nexport const result = input + 1;\n' }
      : path === '/api/v2/model-settings' ? { enabled: true, configured: false, active: false, settings: null }
      : { projects: [], tasks: [] };
    await route.fulfill({ json });
  });
  await page.goto(`${process.env.READER_TEST_ORIGIN || 'http://127.0.0.1:5175'}/projects/reader-fixture`);
  const reader = page.getByRole('region', { name: '项目解读报告', exact: true });
  await page.getByRole('button', { name: '分析详情', exact: true }).click();
  await expect(page.getByLabel('报告版本与费用摘要')).toContainText('源码版本 reader-f');
  await expect(page.getByLabel('报告版本与费用摘要')).toContainText('不代表零费用');
  await page.getByRole('button', { name: '关闭分析详情', exact: true }).click();
  for (const [width, height] of [[1440, 900], [768, 1024], [390, 844], [320, 740]]) {
    await page.setViewportSize({ width, height });
    await expect(page.getByLabel('导入范围提醒')).toContainText('2 个文件未能纳入源码解读');
    await expect(page.getByLabel('导入范围提醒')).toContainText('增加分析轮次不会补回');
    await page.getByRole('button', { name: '查看跳过文件与原因', exact: true }).click();
    await expect(page.getByText('已跳过 3 个文件', { exact: true })).toBeFocused();
    await expect(page.locator('.omitted').filter({ hasText: 'src/large.ts' })).toBeVisible();
    await page.getByRole('button', { name: '关闭分析详情', exact: true }).click();
    await reader.getByRole('tab', { name: '读懂项目', exact: true }).click();
    await expect(reader.getByRole('tab')).toHaveCount(3);
    await expect(reader.getByLabel('报告范围受限')).toBeVisible();
    const scene = reader.getByRole('region', { name: '核心业务场景' });
    await scene.getByLabel('切换场景').selectOption('1');
    await expect(scene.getByRole('heading', { name: '返回结果', exact: true })).toBeVisible();
    const sourceButton = scene.getByRole('button', { name: /src\/main.ts/ });
    await sourceButton.click();
    await expect(page.locator('.evidence-pane .highlight').first()).toContainText('const input = 1');
    const contextDisclosure = page.locator('.evidence-context-details');
    await expect(contextDisclosure).toHaveJSProperty('open', false);
    await contextDisclosure.locator('summary').click();
    await expect(contextDisclosure.locator('.evidence-context')).toContainText('返回结果：用于解释业务的完整正文。');
    await contextDisclosure.locator('summary').click();
    await expect(contextDisclosure).toHaveJSProperty('open', false);
    const fullFile = page.getByRole('button', { name: '查看完整文件', exact: true });
    const snippet = page.getByRole('button', { name: '返回引用片段', exact: true });
    await fullFile.focus();
    await page.keyboard.press('Enter');
    await expect(snippet).toBeFocused();
    await expect(page.locator('.evidence-pane .highlight').first()).toContainText('const input = 1');
    await page.keyboard.press('Enter');
    await expect(fullFile).toBeFocused();
    const delayedSource = holdNextSource();
    try {
      const requested = page.waitForRequest(request => new URL(request.url()).pathname === '/api/v2/projects/reader-fixture/source');
      await page.keyboard.press('Enter');
      await requested;
      await expect(page.locator('.evidence-pane').getByRole('status')).toBeVisible();
      const close = page.getByRole('button', { name: '关闭源码', exact: true });
      await close.focus();
      delayedSource.release();
      await expect(snippet).toBeVisible();
      await expect(close).toBeFocused();
      await snippet.focus();
      await page.keyboard.press('Enter');
      await expect(fullFile).toBeFocused();
    } finally { delayedSource.release(); }
    await page.getByRole('button', { name: '关闭源码', exact: true }).click();
    await expect(sourceButton).toBeFocused();
    await expect(scene.getByRole('heading', { name: '返回结果', exact: true })).toBeVisible();
    await reader.getByRole('tab', { name: '源码与模块', exact: true }).click();
    const mapDisclosure = reader.getByText('浏览项目地图与文件', { exact: true });
    if (!await mapDisclosure.evaluate(element => element.parentElement.open)) await mapDisclosure.click();
    await expect(reader.getByRole('tab')).toHaveCount(3);
    const root = reader.locator('.map-root');
    for (const selected of [true, false]) {
      if (!selected) await reader.locator('.module-node').first().click();
      await root.scrollIntoViewIfNeeded();
      await root.hover();
      await page.keyboard.press('Tab');
      await root.focus();
      assert.equal(await root.evaluate(element => element.matches(':focus-visible')), true);
      const focus = await root.evaluate(element => {
        const css = getComputedStyle(element);
        return { active: document.activeElement === element, visible: element.matches(':focus-visible'), width: css.outlineWidth, offset: css.outlineOffset, style: css.outlineStyle };
      });
      assert.deepEqual(focus, { active: true, visible: true, width: '2px', offset: '-5px', style: 'dashed' }, 'Focus clearance must be immediate, not animated across graph connectors');
      await expect(root).toHaveAttribute('aria-pressed', String(selected));
      await expect(root).toHaveCSS('outline-offset', '-5px');
      await expect(root).toHaveCSS('outline-width', '2px');
      await expect(root).toHaveCSS('outline-style', 'dashed');
    }
    await root.click();
    await reader.getByRole('tab', { name: '读懂项目', exact: true }).click();
    await expect(scene.getByRole('heading', { name: '返回结果', exact: true })).toBeVisible();
    await scene.getByLabel('切换场景').selectOption('2');
    await expect(scene.getByText(/尚无源码引用/)).toBeVisible();
    await expect(scene.getByRole('button')).toHaveCount(0);
    const more = reader.getByRole('button', { name: /查看全部 4 个阅读建议/ });
    if (await more.isVisible()) await more.click();
    await expect(reader.getByRole('heading', { name: '阅读入口 4', exact: true })).toBeVisible();
    await expect(reader.getByText('核对输入与输出。', { exact: true })).toHaveCount(4);
    await reader.getByRole('button', { name: '收起更多阅读建议', exact: true }).click();
    await expect(reader.getByRole('heading', { name: '阅读入口 4', exact: true })).toHaveCount(0);
    const tab = reader.getByRole('tab', { name: '读懂项目', exact: true });
    await tab.focus(); await page.keyboard.press('End');
    await expect(reader.getByRole('tab', { name: '待核实问题', exact: true })).toBeFocused();
    await expect(reader.getByText(/当前已读范围没有形成可发布的问题线索/)).toBeVisible();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `Outer page overflow at ${width}px`);
    console.log(`PASS reader: ${width}x${height}, scenes, citations, full-file focus restoration without stealing newer focus, selected/unselected root focus clears connectors even on hover, reading expansion, keyboard tabs, no overflow`);
  }
  // The evidence pane changes from a desktop region to a native mobile dialog.
  // Keep it open during resize: keyboard focus must follow the replacement node.
  await page.setViewportSize({ width: 1440, height: 900 });
  await reader.getByRole('tab', { name: '读懂项目', exact: true }).click();
  const resizeScene = reader.getByRole('region', { name: '核心业务场景' });
  await resizeScene.getByLabel('切换场景').selectOption('0');
  const resizeCitation = resizeScene.getByRole('button', { name: /src\/main.ts/ });
  await resizeCitation.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('region', { name: '源码引用', exact: true })).toBeVisible();
  await expect(page.locator('.evidence-pane .highlight').first()).toBeVisible();
  await page.waitForFunction(() => document.fonts.status === 'loaded' && !document.getAnimations().some(animation =>
    animation.playState === 'running' && Number.isFinite(animation.effect?.getComputedTiming().endTime)));
  await checkReaderContrast(page, ['.overview-text', '.reader-warning p', '.reader-source span', '.evidence-version', '.evidence-pane .highlight', '.evidence-pane .highlight > span']);
  await page.getByRole('button', { name: '关闭源码', exact: true }).focus();
  await page.setViewportSize({ width: 390, height: 844 });
  const sourceDialog = page.getByRole('dialog', { name: '源码引用', exact: true });
  await expect(sourceDialog).toBeVisible();
  assert.ok(await sourceDialog.evaluate(element => element.matches(':modal')), 'Narrow evidence reader must use the native modal top layer');
  await expect(page.getByRole('button', { name: '关闭源码', exact: true })).toBeFocused();
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('Tab');
    assert.ok(await sourceDialog.evaluate(element => element.contains(document.activeElement)
      || document.activeElement === document.body), 'Mobile modal must not focus background controls (native Tab may visit browser chrome)');
  }
  await page.keyboard.press('Escape');
  await expect(sourceDialog).toHaveCount(0);
  await expect(resizeCitation).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(sourceDialog).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByRole('region', { name: '源码引用', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '关闭源码', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('.evidence-pane')).toHaveCount(0);
  await expect(resizeCitation).toBeFocused();
  console.log('PASS evidence keyboard: Enter, mobile Tab containment, Escape, bidirectional responsive transition and trigger focus restoration.');
  project.omitted = [{ path: 'assets/logo.png', reason: '非源码文件' }];
  await page.reload();
  await expect(page.getByLabel('导入范围提醒')).toHaveCount(0);
  await page.getByRole('button', { name: '分析详情', exact: true }).click();
  await page.getByText('已跳过 1 个文件', { exact: true }).click();
  await expect(page.locator('.omitted')).toContainText('assets/logo.png');
  await page.getByRole('button', { name: '关闭分析详情', exact: true }).click();
  project.omitted = [];
  await page.reload();
  await expect(page.getByLabel('导入范围提醒')).toHaveCount(0);
  const originalWarnings = report.analysisWarnings;
  report.analysisWarnings = [];
  report.reportQuality = 'limited';
  report.reportLimitReasons = ['COUNTEREVIDENCE_PLAN_INVALID'];
  await page.reload();
  await expect(reader.getByLabel('报告范围受限')).toContainText('未完成全部预定核查');
  delete report.reportQuality;
  delete report.reportLimitReasons;
  await page.reload();
  await expect(reader.getByLabel('报告范围受限')).toHaveCount(0);
  report.analysisWarnings = originalWarnings;
  report.evidenceFlows = [{ id: 'flow', title: '请求处理链路', summary: '公开样例，推断关系尚待核实。',
    steps: ['入口', '处理', '存储'].map((title, i) => ({ id: `step-${i}`, title, responsibility: `${title}职责`, citations: [citation] })),
    edges: [{ from: 'step-0', to: 'step-1', relation: 'inferred', evidence: [citation], explanation: '缺少完整调用上下文。' }, { from: 'step-0', to: 'step-2', relation: 'inferred', evidence: [], explanation: '存储关系仍待确认。' }], gaps: ['尚未确认调用关系'] }];
  await page.reload();
  const chain = page.getByRole('region', { name: '有据可查的业务链路' });
  if (process.env.READER_EXPECT_FLOWS === '0') {
    await expect(chain).toHaveCount(0);
    await expect(reader.getByRole('button', { name: '查看结构化链路', exact: true })).toHaveCount(0);
    const fallback = reader.getByRole('region', { name: '核心业务场景' });
    await expect(fallback).toBeVisible();
    await fallback.getByRole('button', { name: /src\/main.ts/ }).click();
    await expect(page.locator('.evidence-pane .highlight').first()).toContainText('const input = 1');
    await page.getByRole('button', { name: '关闭源码', exact: true }).click();
    console.log('PASS disabled production feature: valid stored flows hidden, legacy scenario and source still readable.');
  } else {
  await chain.getByText('展开实现步骤与关系', { exact: true }).click();
  for (const [width, height] of [[1440,900], [768,1024], [390,844], [320,740]]) {
    await page.setViewportSize({ width, height });
    await expect(chain).toBeVisible();
    await chain.getByRole('button', { name: '入口', exact: true }).click();
    await expect(chain.locator('.flow-relation.inferred')).toHaveCount(2);
    await expect(chain.getByText('推断关系 · 待核实', { exact: true })).toHaveCount(2);
    const citeButton = chain.getByRole('region', { name: '当前步骤详情' }).getByRole('button', { name: 'src/main.ts · L2–3', exact: true });
    await citeButton.click();
    await expect(page.locator('.evidence-pane .highlight').first()).toContainText('const input = 1');
    await page.getByRole('button', { name: '关闭源码', exact: true }).click();
    await expect(citeButton).toBeFocused();
    await chain.getByRole('button', { name: '查看步骤：存储', exact: true }).click();
    await expect(chain.getByRole('region', { name: '当前步骤详情' }).getByRole('heading', { name: '存储', exact: true })).toBeVisible();
    await reader.getByRole('button', { name: '切回场景说明', exact: true }).click();
    await expect(reader.getByRole('region', { name: '核心业务场景' })).toBeVisible();
    await reader.getByRole('button', { name: '查看结构化链路', exact: true }).click();
    await expect(chain.getByRole('button', { name: '存储', exact: true })).toHaveAttribute('aria-pressed', 'true');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  }
  }
  report.evidenceFlows = [{ broken: true }];
  await page.reload();
  await expect(chain).toHaveCount(0);
  await expect(reader.getByRole('region', { name: '核心业务场景' })).toBeVisible();
  delete report.evidenceFlows;
  if (process.env.READER_EXPECT_FLOWS !== '0') console.log('PASS structured flow: four sizes, branches, inferred labels, citations/focus, fallback and preserved selection.');
  // Legacy reports without optional warnings still render without recomputation.
  report.findings = [
    { ...section('无依据高优先级', []), severity: 'high', confidence: 'direct' },
    { ...section('待验证高优先级'), severity: 'high', confidence: 'hypothesis' },
    { ...section('可核实低优先级'), severity: 'low', confidence: 'direct' },
    { ...section('可核实中优先级'), severity: 'medium', confidence: 'direct' },
  ];
  await page.reload();
  for (const [width, height] of [[1440,900], [768,1024], [390,844], [320,740]]) {
    await page.setViewportSize({ width, height });
    await reader.getByRole('tab', { name: '待核实问题 4', exact: true }).click();
    await expect(reader.locator('.reader-finding')).toHaveCount(3);
    await expect(reader.locator('.reader-finding h3')).toHaveText(['可核实中优先级', '可核实低优先级', '待验证高优先级']);
    await reader.getByRole('button', { name: '查看全部 4 条问题线索', exact: true }).click();
    await expect(reader.locator('.reader-finding')).toHaveCount(4);
    await expect(reader.getByText('缺少源码引用 · 待核实', { exact: true })).toBeVisible();
    await reader.locator('.reader-finding').first().getByRole('button', { name: /src\/main.ts/ }).click();
    await expect(page.locator('.evidence-pane .highlight').first()).toContainText('const input = 1');
    await page.getByRole('button', { name: '关闭源码', exact: true }).click();
    await reader.getByRole('button', { name: '收起更多问题线索', exact: true }).click();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  }
  report.findings = [];
  console.log('PASS findings: evidence-first ordering, three default entries, full expansion, source access and four viewport sizes.');
  delete report.analysisWarnings;
  report.flows = [];
  await page.reload();
  await expect(reader.getByLabel('报告范围受限')).toHaveCount(0);
  await expect(reader.getByText(/当前已读源码不足以明确核心场景/)).toBeVisible();
  // A failed latest analysis must expose, not overwrite, the older readable report.
  project.analyses.unshift({ id: 'failed-fixture', status: 'failed', created_at: '2026-10-14T11:00:00Z', events: [], code: 'SOURCE_PLAN_INVALID' });
  await page.reload();
  await expect(page.getByRole('region', { name: '可用历史报告' })).toBeVisible();
  await page.getByRole('button', { name: '阅读历史报告', exact: true }).click();
  await expect(reader).toBeVisible();
  await expect(page.locator('#project-analysis-record')).toHaveValue('report-fixture');
  // A running analysis keeps the three-stage summary outside technical details.
  const latest = project.analyses[0];
  latest.status = 'running';
  latest.events = [{ kind: 'synthesize', at: '2026-10-14T11:00:02Z', label: 'technical synthesis' }, { kind: 'search', at: '2026-10-14T11:00:03Z', label: 'technical search' }];
  await page.reload();
  const progress = page.getByRole('region', { name: '解读进度' });
  await expect(progress).toBeVisible();
  await expect(progress.locator('[aria-current="step"]')).toContainText('整理解读与源码依据');
  await page.getByRole('button', { name: '阅读历史报告', exact: true }).click();
  await expect(reader).toBeVisible();
  await expect(progress).toBeVisible();
  await expect(progress.locator('[aria-current="step"]')).toContainText('整理解读与源码依据');
  assert.deepEqual(pageErrors, []);
  console.log('PASS legacy/empty report compatibility; no page errors or API writes.');
} finally { await browser.close(); }
