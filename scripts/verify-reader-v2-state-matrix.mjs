import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { auditScrollableContrast } from './reader-rendered-contrast.mjs';

// Synthetic API boundary: never authenticate, write data, or call a model.
const origin = process.env.READER_TEST_ORIGIN || 'http://127.0.0.1:5174';
const output = path.resolve('output/reader-v2/state-matrix', new Date().toISOString().replace(/[:.]/g, '-'));
const citation = { path: 'src/request/main.ts', start: 2, end: 3 };
const other = { path: 'src/result/main.ts', start: 2, end: 3 };
const section = title => ({ title, body: `${title}的原始正文，保留业务描述与实现依据。`, citations: [citation], nextStep: '对照输入与返回结果。' });
const base = () => ({
  overview: '合成学习项目：让学生输入数字，查看计算结果。', stack: ['TypeScript'],
  modules: [section('请求与结果处理')], flows: [section('提交计算请求'), section('查看结果')],
  findings: [], readingPath: [section('从请求入口开始')], limitations: ['仅静态阅读，未执行项目或测试。'],
});
const enhanced = () => ({ version: 1,
  purpose: { text: '学生用它提交数字并查看结果。', audience: '学习中的学生', input: '待计算的数字', output: '计算结果',
    sourceRefs: [{ section: 'modules', index: 0 }], citations: [citation] },
  scenes: [0, 1].map(index => ({ sourceRef: { section: 'flows', index },
    businessSummary: `场景 ${index + 1} 的分层业务说明。`, activities: [{ text: `核对场景 ${index + 1} 的输入`, citations: [citation] }] })),
});
const cases = [
  { id: 'legacy', make: base, quality: 'unknown' },
  { id: 'complete-enhanced', make: () => ({ ...base(), reportQuality: 'complete', readingBrief: enhanced(),
    findings: [{ ...section('需在条件满足时核对结果'), severity: 'medium', confidence: 'direct', condition: '输入为空时。',
      verificationSteps: [{ action: '发送一个空输入。', expectedObservation: '观察是否拒绝无效输入。' }], remediation: '确认缺少验证后再补充输入约束。' }] }), quality: 'complete' },
  { id: 'limited-reason', make: () => ({ ...base(), reportQuality: 'limited', reportLimitReasons: ['COUNTEREVIDENCE_PLAN_INVALID'], analysisWarnings: [] }), quality: 'limited' },
  { id: 'limited-warning', make: () => ({ ...base(), analysisWarnings: ['合成限制：部分预定文件尚未读取，不能作全仓库判断。'] }), quality: 'limited' },
  { id: 'empty', make: () => ({ ...base(), overview: '', stack: [], modules: [], flows: [], readingPath: [], verification: [], reportQuality: 'unknown' }), quality: 'unknown' },
  { id: 'twelve-findings-eight-reading', make: () => ({ ...base(), reportQuality: 'complete',
    findings: Array.from({ length: 12 }, (_, i) => ({ ...section(`待核实线索 ${i + 1}`), severity: 'medium', confidence: 'direct' })),
    readingPath: Array.from({ length: 8 }, (_, i) => section(`阅读建议 ${i + 1}`)),
    verification: [
      { originalTitle: '已撤回的初步判断', decision: 'withdrawn', reason: '补充源码表明已有对应检查，不进入最终问题线索。', citations: [other] },
      { originalTitle: '待核实线索 1', decision: 'retained', reason: '保留供运行核查，尚未确认缺陷。', citations: [citation] },
      { originalTitle: '条件尚未确认的观察', decision: 'unresolved', reason: '静态源码不足以确认运行条件。', citations: [citation] },
    ] }), quality: 'complete' },
  { id: 'invalid-enhancements', make: () => ({ ...base(), reportQuality: 'limited', analysisWarnings: ['合成限制：结构化链路未通过校验。'],
    readingBrief: { ...enhanced(), purpose: { ...enhanced().purpose, text: '不可展示的无效摘要', sourceRefs: [{ section: 'modules', index: 999 }] } },
    evidenceFlows: [{ broken: true }] }), quality: 'limited' },
  { id: 'unknown-omissions', make: () => ({ ...base(), reportQuality: 'unknown' }), quality: 'unknown', omitted: [
    { path: 'node_modules/pkg/main.js', reason: '依赖或构建产物' },
    { path: 'src/large.ts', reason: '单文件超过 512 KB' },
    { path: 'src/unclassified.ts', reason: '尚未归类的原因' },
  ] },
  { id: 'long-paths', make: () => ({ ...base(), reportQuality: 'complete',
    flows: [{ ...section('含多语言路径的业务场景'), citations: [
      { ...citation, path: `src/请求处理/${'long-English-directory-'.repeat(9)}main.ts` },
      { ...other, path: `src/结果处理/${'另一个目录-'.repeat(20)}main.ts` },
    ] }], stack: Array.from({ length: 12 }, (_, i) => `技术标记 ${i + 1}`) }), quality: 'complete' },
];
const result = { state: 'running', startedAt: new Date().toISOString(), origin, output,
  boundary: 'All API responses synthetic; no real login, backend writes, model calls or source files.',
  requests: [], blockedRequests: [], unexpectedRequests: [], pageErrors: [], cases: [], scans: [], screenshots: [] };
let current, browser, page, stage = 'init';
const viewports = [[1440, 900], [768, 1024], [390, 844], [320, 740]];
await mkdir(output, { recursive: true });
try {
  const axe = await readFile('output/reader-v2/a11y-tools/node_modules/axe-core/axe.min.js', 'utf8');
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  page = await browser.newPage({ reducedMotion: 'reduce' });
  page.on('pageerror', error => result.pageErrors.push(error.message));
  await page.route('**/api/**', async route => {
    const req = route.request(), url = new URL(req.url()), pathname = url.pathname;
    result.requests.push({ method: req.method(), path: pathname, query: Object.fromEntries(url.searchParams) });
    if (req.method() !== 'GET' || pathname.endsWith('/analyze') || pathname.includes('cost-preview')) {
      result.blockedRequests.push({ method: req.method(), path: pathname });
      return route.abort('blockedbyclient');
    }
    if (pathname === `/api/v2/projects/${current.id}/source`) {
      const file = url.searchParams.get('path');
      assert.equal(url.searchParams.get('analysisId'), current.analyses[0].id, 'Source report binding changed');
      assert.ok(current.files.some(item => item.path === file), 'Source path not in this synthetic project');
      return route.fulfill({ json: { path: file, content: `// ${file}\nexport const input = 1;\nexport const result = input + 1;`, startLine: 1, totalLines: 3 } });
    }
    const replies = new Map([
      ['/api/v1/session', { user: { id: 'matrix', name: '合成验收', email: 'matrix@example.test', role: 'teacher' }, csrf: 'fixture', businessVersion: 2, executionApproved: false }],
      ['/api/v2/projects', { projects: [{ id: current.id, name: current.name, status: 'succeeded' }], available: true }],
      [`/api/v2/projects/${current.id}`, current],
      ['/api/v2/model-settings', { enabled: true, configured: false, active: false, settings: null }],
    ]);
    if (!replies.has(pathname)) {
      result.unexpectedRequests.push(pathname);
      return route.fulfill({ status: 404, json: { message: 'Unexpected synthetic API request' } });
    }
    return route.fulfill({ json: replies.get(pathname) });
  });
  const reader = page.getByRole('region', { name: '项目解读报告', exact: true });
  const scan = async (state, width, height) => {
    stage = `${current.id}/${width}/${state}`;
    const disclosureMotion = await reader.locator('details[open]').evaluateAll(elements => elements.map(element => {
      const css = getComputedStyle(element, '::details-content');
      return { className: element.className, opacity: css.opacity, blockSize: css.blockSize,
        transitionProperty: css.transitionProperty, transitionDuration: css.transitionDuration,
        activeAnimations: element.getAnimations({ subtree: true }).filter(a => a.playState === 'running').length };
    }));
    assert.ok(disclosureMotion.every(item => item.transitionDuration.split(',').every(duration => parseFloat(duration) === 0)),
      `Reduced motion must disable native disclosure-content transitions in ${stage}`);
    await page.waitForFunction(() => document.fonts.status === 'loaded' && !document.getAnimations().some(animation =>
      animation.playState === 'running' && Number.isFinite(animation.effect?.getComputedTiming().endTime)), null, { timeout: 10000 });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const audit = await page.evaluate(async () => {
      const a = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] } });
      const summarize = item => ({ id: item.id, impact: item.impact, targets: item.nodes.map(n => n.target),
        checks: item.nodes.flatMap(n => [...n.any, ...n.all, ...n.none].map(c => ({ id: c.id, message: c.message }))) });
      return { version: window.axe.version, violations: a.violations.map(summarize), incomplete: a.incomplete.map(summarize) };
    });
    const contrast = await auditScrollableContrast(page, ['.reading-header', '.project-record-strip', '.cost-unknown', '.project-reader', '.evidence-pane']);
    const record = { case: current.id, width, height, state, disclosureMotion, axe: audit, ...contrast };
    result.scans.push(record);
    assert.equal(audit.violations.length, 0, `axe violations in ${stage}: ${audit.violations.map(v => v.id)}`);
    assert.ok(contrast.samples.length > 0, 'No composited contrast samples');
    assert.ok(contrast.samples.reduce((sum, s) => sum + s.fragments, 0) > 0, 'No measurable text fragments');
    assert.ok(contrast.samples.every(s => !s.failures.length && !s.unsupported.length), `Text contrast failed in ${stage}`);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `Outer overflow in ${stage}`);
    const tabs = await reader.getByRole('tab').evaluateAll(elements => elements.map(element => {
      const box = element.getBoundingClientRect();
      const text = [...element.childNodes].filter(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
      const labelLines = text.flatMap(node => {
        const range = document.createRange();
        range.selectNodeContents(node);
        return [...range.getClientRects()].map(rect => ({ left: rect.left, right: rect.right }));
      });
      const count = element.querySelector('.finding-count')?.getBoundingClientRect();
      return { width: box.width, height: box.height, fits: element.scrollWidth <= element.clientWidth + 1,
        labelLines: labelLines.length, labelFits: labelLines.every(rect => rect.left >= box.left - 1 && rect.right <= box.right + 1),
        countFits: !count || count.left >= box.left - 1 && count.right <= box.right + 1 };
    }));
    record.tabGeometry = tabs;
    assert.ok(tabs.length === 3 && tabs.every(tab => tab.width >= 44 && tab.height >= 44 && tab.fits && tab.labelLines === 1 && tab.labelFits && tab.countFits),
      `Report tabs must retain a single-line label, attached count and 44px targets in ${stage}`);
    console.log(`PASS ${stage}: ${contrast.samples.length} scroll samples`);
  };
  for (const sample of cases) {
    for (const [width, height] of viewports) {
      stage = `${sample.id}/${width}/entry`;
      await page.goto('about:blank');
      const report = sample.make();
      const paths = [...new Set([citation.path, other.path, ...report.flows.flatMap(flow => flow.citations.map(c => c.path))])];
      current = { id: `matrix-${sample.id}`, name: sample.id === 'long-paths' ? '多语言长名称学习项目'.repeat(6) : `合成验收：${sample.id}`,
        available: true, files: paths.map(p => ({ path: p, lines: 3 })), omitted: sample.omitted || [],
        analyses: [{ id: `report-${sample.id}`, status: 'succeeded', created_at: '2026-10-01T00:00:00Z', finished_at: '2026-10-01T00:00:30Z', events: [],
          report: { report, read: Object.fromEntries(paths.map(p => [p, { start: 1, end: 3 }])) } }] };
      await page.setViewportSize({ width, height });
      await page.goto(`${origin}/projects`, { waitUntil: 'domcontentloaded' });
      await page.locator(`.project-history a[href="/projects/${current.id}"]`).click();
      await expect(reader).toBeVisible();
      await page.addScriptTag({ content: axe });
      const check = { case: sample.id, width, height, quality: sample.quality, assertions: [] };
      result.cases.push(check);
      await expect(page.locator('.project-record-status')).toHaveText(sample.quality === 'complete' ? '报告可读' : sample.quality === 'limited' ? '报告可读 · 范围受限' : '历史报告 · 质量未记录');
      await expect(reader.getByLabel('报告范围受限', { exact: true })).toHaveCount(sample.quality === 'limited' ? 1 : 0);
      await expect(page.locator('.cost-unknown')).toContainText('不代表零费用');
      check.assertions.push('quality-and-unknown-fee');
      if (sample.quality === 'limited') await expect(reader.getByLabel('报告范围受限')).toContainText('不会自动重新付费分析');
      if (sample.id === 'complete-enhanced') {
        await expect(reader.locator('.purpose-text')).toHaveText(report.readingBrief.purpose.text);
        await reader.getByText('完整项目概览', { exact: true }).click();
        await expect(reader.locator('.overview-text')).toHaveText(report.overview);
        const scene = reader.getByRole('region', { name: '核心业务场景', exact: true });
        for (let index = 0; index < 2; index++) {
          await scene.getByLabel('切换场景').selectOption(String(index));
          await expect(scene.getByText(report.readingBrief.scenes[index].businessSummary, { exact: true })).toBeVisible();
          await scene.getByText('展开实现细节', { exact: true }).click();
          await expect(scene.getByText(report.flows[index].body, { exact: true })).toBeVisible();
          await scene.getByText('展开实现细节', { exact: true }).click();
        }
        check.assertions.push('enhanced-purpose-original-overview-two-scenes');
      }
      if (sample.id === 'invalid-enhancements') {
        await expect(reader.locator('.purpose-text')).toHaveCount(0);
        await expect(reader.getByText('不可展示的无效摘要', { exact: true })).toHaveCount(0);
        await expect(reader.locator('.overview-text')).toHaveText(report.overview);
        await expect(reader.getByRole('region', { name: '有据可查的业务链路', exact: true })).toHaveCount(0);
        await expect(reader.getByRole('region', { name: '核心业务场景', exact: true })).toBeVisible();
        check.assertions.push('invalid-optional-fields-fall-back');
      }
      if (sample.id === 'empty') {
        await expect(reader.locator('.overview-text')).toContainText('尚未提供足够证据');
        await expect(reader.getByText(/当前已读源码不足以明确核心场景/)).toBeVisible();
        await expect(reader.getByText('当前报告未提供足够证据形成阅读路线。', { exact: true })).toBeVisible();
        await expect(reader.locator('.scene-evidence button')).toHaveCount(0);
        check.assertions.push('no-fabricated-purpose-scenes-reading');
      }
      if (sample.id === 'unknown-omissions') {
        await expect(page.getByLabel('导入范围提醒')).toContainText('2 个文件');
        await page.getByRole('button', { name: '查看跳过文件与原因', exact: true }).click();
        await expect(page.locator('.omitted')).toHaveCount(sample.omitted.length);
        for (const omitted of sample.omitted) await expect(page.locator('.omitted').filter({ hasText: omitted.path })).toBeVisible();
        await page.getByRole('button', { name: '关闭分析详情', exact: true }).click();
        check.assertions.push('routine-important-unknown-omissions-reachable');
      }
      if (sample.id === 'twelve-findings-eight-reading') {
        await expect(reader.locator('.reader-learning-list h3')).toHaveText(['阅读建议 1']);
        await reader.getByRole('button', { name: '查看全部 8 个阅读建议', exact: true }).click();
        await expect(reader.locator('.reader-learning-list h3')).toHaveText(report.readingPath.map(entry => entry.title));
        await scan('eight-reading-expanded', width, height);
        await reader.getByRole('button', { name: '收起更多阅读建议', exact: true }).click();
        await expect(reader.locator('.reader-learning-list h3')).toHaveCount(1);
        check.assertions.push('one-default-eight-reachable-original-order');
      }
      await scan('overview', width, height);
      if (['complete-enhanced', 'twelve-findings-eight-reading'].includes(sample.id) && [1440, 320].includes(width)) {
        const y = await page.evaluate(() => scrollY);
        await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
        const filename = path.join(output, `${sample.id}-overview-${width}.png`);
        await page.screenshot({ path: filename });
        result.screenshots.push(filename);
        await page.evaluate(y => scrollTo({ top: y, behavior: 'instant' }), y);
      }
      await reader.getByRole('tab', { name: /^待核实问题/ }).click();
      if (report.findings.length) {
        await expect(reader.locator('.reader-finding')).toHaveCount(Math.min(3, report.findings.length));
        if (sample.id === 'twelve-findings-eight-reading') {
          await expect(reader.getByRole('tab', { name: '待核实问题 12', exact: true })).toBeVisible();
          await reader.getByRole('button', { name: '查看全部 12 条问题线索', exact: true }).click();
          await expect(reader.locator('.reader-finding h3')).toHaveText(report.findings.map(f => f.title));
          await expect(reader.locator('.reader-finding').getByRole('heading', { name: '已撤回的初步判断', exact: true })).toHaveCount(0);
          await reader.locator('.reader-verification > summary').click();
          for (const record of report.verification) await expect(reader.locator('.reader-verification')).toContainText(record.originalTitle);
          await expect(reader.locator('.reader-verification .withdrawn')).toHaveText('已撤回');
          check.assertions.push('three-default-twelve-reachable-stable-order-withdrawals-separate');
        }
        if (sample.id === 'complete-enhanced') {
          const finding = reader.locator('.reader-finding');
          for (const heading of ['发生条件', '验证动作', '确认后的修复建议']) await expect(finding.getByRole('heading', { name: heading, exact: true })).toBeVisible();
          await expect(finding.locator('.reader-next-step')).toContainText('后续建议');
          check.assertions.push('verification-and-remediation-separate-legacy-label-neutral');
        }
      } else {
        await expect(reader.getByText(/当前已读范围没有形成可发布的问题线索/)).toBeVisible();
        await expect(reader.getByText(/没有发现问题不等于项目没有问题/)).toBeVisible();
        await reader.locator('.reader-verification > summary').click();
        await expect(reader.locator('.reader-verification')).toContainText(report.verification ? '这不代表项目没有问题' : '这份历史报告没有记录反证复核');
        check.assertions.push('empty-findings-not-safe-pass-verification-absence-neutral');
      }
      await scan('findings-and-verification', width, height);
      if (['complete-enhanced', 'twelve-findings-eight-reading'].includes(sample.id) && [1440, 320].includes(width)) {
        const filename = path.join(output, `${sample.id}-findings-${width}.png`);
        await page.screenshot({ path: filename, fullPage: true });
        result.screenshots.push(filename);
      }
      if (sample.id === 'twelve-findings-eight-reading') {
        await reader.getByRole('button', { name: '收起更多问题线索', exact: true }).click();
        await expect(reader.locator('.reader-finding')).toHaveCount(3);
      }
      await reader.getByRole('tab', { name: '读懂项目', exact: true }).click();
      if (report.flows.length) {
        const scene = reader.getByRole('region', { name: '核心业务场景', exact: true });
        const buttons = scene.locator('.scene-evidence button');
        const citations = report.flows[sample.id === 'complete-enhanced' ? 1 : 0].citations;
        for (let index = 0; index < citations.length; index++) {
          const button = buttons.nth(index);
          await button.click();
          const pane = page.locator('.evidence-pane');
          await expect(pane.locator('.highlight').first()).toContainText('export const input = 1');
          await expect(pane.locator('.evidence-path')).toContainText(citations[index].path);
          await page.getByRole('button', { name: '关闭源码', exact: true }).focus();
          await page.keyboard.press('Escape');
          await expect(pane).toHaveCount(0);
          await expect(button).toBeFocused();
        }
        check.assertions.push('exact-citation-path-report-and-focus');
      }
      await reader.getByRole('tab', { name: '源码与模块', exact: true }).click();
      if (sample.id === 'empty') await expect(reader.getByText('当前已读片段没有足够证据形成这一部分的结论。', { exact: true })).toBeVisible();
      if (sample.id === 'long-paths') {
        await reader.getByText('另外 7 项', { exact: true }).click();
        await expect(reader.getByRole('group', { name: '报告识别的技术栈', exact: true }).locator('span')).toHaveCount(12);
        check.assertions.push('all-twelve-stack-labels-reachable');
      }
      await scan('structure', width, height);
      assert.deepEqual(result.blockedRequests, []);
      assert.deepEqual(result.unexpectedRequests, []);
      assert.deepEqual(result.pageErrors, []);
    }
  }
  result.state = 'passed';
} catch (error) {
  result.state = 'failed';
  result.failure = { stage, name: error.name, message: error.message };
  if (page) result.failure.layout = await page.locator('.reader-verification, .reader-verification > *').evaluateAll(elements => elements.map(element => {
    const css = getComputedStyle(element), bounds = element.getBoundingClientRect();
    return { tag: element.tagName, className: element.className, x: bounds.x, y: bounds.y, height: bounds.height, width: bounds.width,
      margin: css.margin, padding: css.padding, overflow: css.overflow, opacity: css.opacity,
      content: { blockSize: getComputedStyle(element, '::details-content').blockSize, opacity: getComputedStyle(element, '::details-content').opacity } };
  })).catch(() => []);
  if (page) await page.screenshot({ path: path.join(output, 'failed.png'), fullPage: true }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser?.close();
  result.finishedAt = new Date().toISOString();
  const samples = result.scans.flatMap(scan => scan.samples);
  result.summary = { caseViewports: result.cases.length, states: result.scans.length, scrollSamples: samples.length,
    measurableTextFragments: samples.reduce((sum, s) => sum + s.fragments, 0),
    minimumTextRatio: samples.length ? Math.min(...samples.map(s => s.minimumRatio)) : null,
    contrastFailures: samples.reduce((sum, s) => sum + s.failures.length, 0),
    unsupported: samples.reduce((sum, s) => sum + s.unsupported.length, 0),
    axeViolations: result.scans.reduce((sum, s) => sum + s.axe.violations.length, 0),
    incompleteRuleIds: [...new Set(result.scans.flatMap(s => s.axe.incomplete.map(rule => rule.id)))],
    sourceGets: result.requests.filter(req => req.path.endsWith('/source')).length,
    blockedRequests: result.blockedRequests.length, unexpectedRequests: result.unexpectedRequests.length, pageErrors: result.pageErrors.length };
  await writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ state: result.state, output, summary: result.summary, failure: result.failure }, null, 2));
}
