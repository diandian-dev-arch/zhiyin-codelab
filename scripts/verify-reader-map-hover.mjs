import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { auditRenderedContrast } from './reader-rendered-contrast.mjs';

// Synthetic GET fixtures isolate hover/selection styling; all business writes fail.
const origin = process.env.READER_TEST_ORIGIN || 'http://127.0.0.1:5174';
const normalMotion = process.env.READER_NORMAL_MOTION === '1';
const hoverFault = process.env.READER_HOVER_FAULT;
assert.ok(!hoverFault || ['summary-padding', 'module-translate'].includes(hoverFault), 'Unknown hover calibration fault');
assert.ok(!hoverFault || normalMotion, 'Hover calibration requires normal motion');
const directory = `output/reader-v2/map-hover${normalMotion ? '-normal-motion' : ''}${hoverFault ? `-fault-${hoverFault}` : ''}`;
function readBackground(element) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const context = canvas.getContext('2d');
  context.fillStyle = getComputedStyle(element).backgroundColor;
  context.fillRect(0, 0, 1, 1);
  return [...context.getImageData(0, 0, 1, 1).data];
}
const entry = { title: '计算建议', body: '读取已保存的数据并计算建议；未运行项目。', citations: [{ path: 'src/calculate.ts', start: 1, end: 3 }] };
const report = { overview: '用于查看计算建议的合成项目。', stack: ['TypeScript'], modules: [entry, { ...entry, title: '读取数据' }], flows: [entry], findings: [], readingPath: [entry], limitations: ['合成验收数据'] };
const analysis = { id: 'synthetic-report', status: 'succeeded', created_at: '2026-10-01T00:00:00Z', events: [], report: { report, read: { 'src/calculate.ts': { start: 1, end: 3 } } } };
const project = { id: 'map-hover-fixture', name: '地图悬停回归样本', available: true, files: [{ path: 'src/calculate.ts', lines: 3 }], analyses: [analysis], omitted: [] };
const result = { state: 'running', startedAt: new Date().toISOString(), origin, fixtureOnly: true,
  hoverFault, reducedMotion: normalMotion ? 'no-preference' : 'reduce', motionChecks: [], states: [], rootStates: [], writes: [], errors: [] };
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
let page, stage = 'init';
try {
  page = await browser.newPage({ reducedMotion: result.reducedMotion });
  page.setDefaultTimeout(15000);
  const settle = async () => {
    await page.waitForFunction(() => document.fonts.status === 'loaded' && !document.getAnimations().some(animation =>
      animation.playState === 'running' && Number.isFinite(animation.effect?.getComputedTiming().endTime)), null, { timeout: 10000 });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  };
  const stableHover = async (target, width, state, descendants) => {
    await target.evaluate(element => element.scrollIntoView({ block: 'center', behavior: 'instant' }));
    await page.mouse.move(0, 0);
    await settle();
    // Native details closure can clamp the document scroll after layout. Start the
    // hover observation only after that non-hover adjustment has actually settled.
    await target.evaluate(element => new Promise((resolve, reject) => {
      let previous, stableSince = performance.now();
      const start = stableSince;
      function sample(now) {
        const box = element.getBoundingClientRect();
        const value = JSON.stringify([box.x, box.y, box.width, box.height, scrollY, document.documentElement.scrollHeight]);
        if (value !== previous) { previous = value; stableSince = now; }
        if (now - stableSince >= 200) resolve();
        else if (now - start > 3000) reject(new Error('Pre-hover layout did not settle'));
        else requestAnimationFrame(sample);
      }
      requestAnimationFrame(sample);
    }));
    const before = await target.evaluate((element, selectors) => [element, ...selectors.map(selector => element.querySelector(selector))]
      .map(node => {
        if (!node) throw new Error('Missing hover geometry target');
        const { x, y, width, height } = node.getBoundingClientRect();
        return { x, y, width, height, scrollY, documentY: y + scrollY };
      }), descendants);
    // Begin sampling before hover so transient movement cannot disappear before the assertion.
    await target.evaluate((element, selectors) => {
      const nodes = [element, ...selectors.map(selector => element.querySelector(selector))];
      window.__readerMotion = new Promise(resolve => {
        const samples = [], start = performance.now();
        function sample(now) {
          samples.push(nodes.map(node => {
            const { x, y, width, height } = node.getBoundingClientRect();
            return { x, y, width, height, scrollY, documentY: y + scrollY };
          }));
          if (now - start < 800) requestAnimationFrame(sample);
          else resolve(samples);
        }
        requestAnimationFrame(sample);
      });
    }, descendants);
    await expect(target).toBeInViewport({ ratio: 1 });
    const box = before[0];
    const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    assert.equal(await target.evaluate((element, point) => element.contains(document.elementFromPoint(point.x, point.y)), center), true,
      `Hover target obscured at ${width}/${state}`);
    await page.mouse.move(center.x, center.y);
    assert.equal(await target.evaluate(element => element.matches(':hover')), true);
    const samples = await page.evaluate(async () => {
      try { return await window.__readerMotion; }
      finally { delete window.__readerMotion; }
    });
    const maxDelta = Math.max(...samples.flatMap(sample => sample.flatMap((box, index) =>
      Object.keys(box).map(key => Math.abs(box[key] - before[index][key])))));
    const check = { width, state, samples: samples.length, maxDelta, before, first: samples[0], last: samples.at(-1) };
    result.motionChecks.push(check);
    assert.ok(samples.length >= 2, `No motion observations at ${width}/${state}`);
    assert.ok(maxDelta <= 0.1, `Hover moved a click target or label at ${width}/${state}: ${maxDelta}px`);
  };
  page.on('pageerror', error => result.errors.push(error.name));
  await page.route('**/api/**', async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname;
    if (request.method() !== 'GET') {
      result.writes.push({ method: request.method(), pathname });
      return route.abort('blockedbyclient');
    }
    const json = pathname === '/api/v1/session'
      ? { user: { id: 'fixture', name: '合成测试', email: 'fixture@example.test', role: 'teacher' }, csrf: 'fixture', businessVersion: 2, executionApproved: false }
      : pathname === '/api/v2/projects' ? { projects: [project], available: true }
        : pathname === `/api/v2/projects/${project.id}` ? project : { tasks: [], projects: [] };
    await route.fulfill({ json });
  });
  for (const [width, height] of [[1440, 900], [768, 1024], [390, 844], [320, 740]]) {
    stage = `${width}/report`;
    await page.setViewportSize({ width, height });
    await page.goto(new URL(`/projects/${project.id}`, origin).href, { waitUntil: 'domcontentloaded' });
    // Negative controls reproduce the removed motion only in this isolated fixture.
    if (hoverFault) await page.addStyleTag({ content: hoverFault === 'summary-padding'
      ? '.project-reader .reader-entry > summary { transition: padding-left 600ms !important; } .project-reader .reader-entry > summary:hover { padding-left: 1rem !important; }'
      : '.project-map .module-node { transition: translate 600ms !important; } .project-map .module-node:hover { translate: 0 -2px !important; }' });
    const reader = page.getByRole('region', { name: '项目解读报告', exact: true });
    await expect(reader).toBeVisible();
    assert.equal(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), !normalMotion);
    stage = `${width}/tab`;
    await reader.getByRole('tab', { name: '源码与模块', exact: true }).click();
    for (const open of [true, false]) {
      const entry = reader.locator('.reader-entry').first();
      const summary = entry.locator(':scope > summary');
      if (await entry.evaluate(element => element.open) !== open) await summary.click();
      await stableHover(summary, width, `summary-${open ? 'open' : 'closed'}`, ['.reader-entry-index', '.reader-entry-label']);
    }
    stage = `${width}/map`;
    await reader.locator('summary').filter({ hasText: '浏览项目地图与文件' }).click();
    const node = reader.locator('.module-node').first();
    for (const state of ['normal', 'hover', 'selected-hover']) {
      stage = `${width}/${state}`;
      if (state === 'selected-hover') {
        await node.click();
        await expect(reader.getByRole('group', { name: '模块职责说明', exact: true })).toBeVisible();
        await expect(node).toHaveAttribute('aria-pressed', 'true');
      }
      await node.evaluate(element => element.scrollIntoView({ block: 'center', behavior: 'instant' }));
      if (state === 'normal') await page.mouse.move(0, 0);
      else await stableHover(node, width, state, ['.module-number']);
      await settle();
      await expect(node).toBeInViewport({ ratio: 1 });
      const background = await node.evaluate(readBackground);
      assert.equal(background[3], 255, `Module surface must stay opaque at ${width}/${state}`);
      const contrast = await auditRenderedContrast(page, ['.module-node']);
      result.states.push({ width, height, state, background, ...contrast });
      assert.ok(contrast.fragments > 0);
      assert.equal(contrast.failures.length, 0, `Low contrast at ${width}/${state}`);
      assert.equal(contrast.unsupported.length, 0);
      console.log(JSON.stringify({ stage, fragments: contrast.fragments }));
      if (state === 'selected-hover') await page.screenshot({ path: `${directory}/selected-hover-${width}.png` });
    }
    const root = reader.locator('.map-root');
    for (const state of ['normal', 'hover', 'selected-hover']) {
      stage = `${width}/root-${state}`;
      if (state === 'selected-hover') {
        await root.click();
        await expect(root).toHaveAttribute('aria-pressed', 'true');
      }
      await root.evaluate(element => element.scrollIntoView({ block: 'center', behavior: 'instant' }));
      if (state === 'normal') await page.mouse.move(0, 0);
      else await stableHover(root, width, `root-${state}`, ['small', 'strong']);
      await settle();
      const background = await root.evaluate(readBackground);
      assert.equal(background[3], 255, `Root must stay opaque at ${width}/${state}`);
      const contrast = await auditRenderedContrast(page, ['.map-root']);
      result.rootStates.push({ width, height, state, background, ...contrast });
      assert.ok(contrast.fragments > 0);
      assert.equal(contrast.failures.length, 0, `Low root contrast at ${width}/${state}`);
      assert.equal(contrast.unsupported.length, 0);
    }
  }
  assert.deepEqual(result.writes, []);
  assert.deepEqual(result.errors, []);
  result.state = 'passed';
} catch (error) {
  result.state = 'failed';
  result.failedStage = stage;
  result.error = String(error.message).slice(0, 1500);
  if (page) await page.screenshot({ path: `${directory}/failed.png` });
  process.exitCode = 1;
} finally {
  await browser.close();
  result.completedAt = new Date().toISOString();
  await writeFile(`${directory}/result.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ state: result.state, states: result.states.length, error: result.error, writes: result.writes, errors: result.errors }));
}
