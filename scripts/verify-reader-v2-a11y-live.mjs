import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect, request } from '@playwright/test';
import { connectDesktopDatabase } from './desktop-database.ts';
import { auditRenderedContrast, auditScrollableContrast } from './reader-rendered-contrast.mjs';
import { auditNonTextContrast } from './reader-nontext-contrast.mjs';

// Read-only acceptance against the restored workbench. No analysis or business writes are allowed.
const origin = 'http://127.0.0.1:5174';
const projectId = 'de8b23bc-bce3-4755-966a-8f863cf61a39';
const extendedStatesEnabled = process.env.READER_EXTENDED_STATES === '1';
const scrollContrastEnabled = process.env.READER_CONTRAST_SCROLL === '1' || extendedStatesEnabled;
const contrastEnabled = process.env.READER_CONTRAST === '1' || scrollContrastEnabled;
const nonTextEnabled = process.env.READER_NONTEXT === '1';
const outputName = (extendedStatesEnabled ? 'a11y-extended-states-result' : scrollContrastEnabled ? 'a11y-contrast-scroll-result' : contrastEnabled ? 'a11y-contrast-result' : 'a11y-result') + (nonTextEnabled ? '-nontext' : '');
const runLabel = process.env.READER_A11Y_RUN_LABEL || '';
assert.ok(!runLabel || /^[a-z0-9-]+$/.test(runLabel), 'Run label must be a simple directory name');
const outputPath = path.resolve('output/reader-v2/live', runLabel, `${outputName}.json`);
const axePath = path.resolve('output/reader-v2/a11y-tools/node_modules/axe-core/axe.min.js');
const result = { state: 'running', startedAt: new Date().toISOString(), origin, projectId,
  extendedStatesEnabled, nonTextEnabled, nonText: [], stateCoverage: [], viewports: [], evidence: [], screenshots: [], sourceRequests: [], blockedWrites: [], pageErrors: [], apiFailures: [], axe: [], contrast: [], scrollCoverage: [], expanded: [] };
let auth, browser, context, db, before, stage = 'init';
const snapshot = async () => ({
  projects: (await db.query('SELECT id,sha256,md5(files::text) AS files_hash FROM source_projects ORDER BY id')).rows,
  analyses: (await db.query('SELECT id,project_id,status,md5(report::text) AS report_hash FROM source_analyses ORDER BY id')).rows,
  calls: (await db.query('SELECT count(*)::int AS count FROM source_model_calls')).rows[0].count,
});

try {
  await mkdir(path.dirname(outputPath), { recursive: true });
  const axeSource = await readFile(axePath, 'utf8');
  stage = 'database-before';
  db = await connectDesktopDatabase();
  const active = (await db.query(`SELECT
    (SELECT count(*) FROM source_analyses WHERE status IN ('queued','running'))::int AS source,
    (SELECT count(*) FROM runs WHERE status IN ('queued','preparing','building','checking','analyzing'))::int AS runs,
    (SELECT count(*) FROM analysis_attempts WHERE status IN ('queued','running'))::int AS analyses,
    (SELECT count(*) FROM execution_attempts WHERE owner_phase<>'closed')::int AS owners`)).rows[0];
  assert.ok(Object.values(active).every(count => count === 0), 'Active work requires separate coordination');
  before = await snapshot();
  result.sourceCallsBefore = before.calls;
  auth = await request.newContext({ baseURL: origin });
  const credentials = JSON.parse(await readFile('.data/business-v2/development-credentials.json', 'utf8'));
  stage = 'login';
  const login = await auth.post('/api/v1/session/login', {
    headers: { origin }, data: { email: 'teacher@codelab.local', password: credentials.loginPassword },
  });
  assert.equal(login.status(), 200, 'Real login failed');

  browser = await chromium.launch({ channel: 'chrome', headless: true });
  context = await browser.newContext({ baseURL: origin, storageState: await auth.storageState(), reducedMotion: 'reduce', viewport: { width: 1440, height: 900 } });
  await context.route('**/api/**', async route => {
    const req = route.request();
    if (!['GET', 'HEAD'].includes(req.method())) {
      result.blockedWrites.push({ method: req.method(), path: new URL(req.url()).pathname });
      return route.abort('blockedbyclient');
    }
    const url = new URL(req.url());
    if (url.pathname.endsWith('/source')) result.sourceRequests.push({ path: url.pathname, ...Object.fromEntries(url.searchParams) });
    return route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', error => result.pageErrors.push(error.name));
  page.on('response', response => {
    const url = new URL(response.url());
    if (url.pathname.startsWith('/api/') && response.status() >= 400) result.apiFailures.push({ path: url.pathname, status: response.status() });
  });
  const reader = page.getByRole('region', { name: '项目解读报告', exact: true });
  const scanNonText = async (width, state, target, kind, focusTarget = target) => {
    if (!nonTextEnabled) return;
    await expect(target).toHaveCount(1);
    await target.scrollIntoViewIfNeeded();
    if (kind === 'stroke' || kind === 'outline') {
      const exposed = await target.evaluate(element => {
        const box = element.getBoundingClientRect();
        const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return !!hit && (element.contains(hit) || hit.contains(element));
      });
      assert.equal(exposed, true, `Non-text target is obscured: ${width}/${state}`);
    }
    if (kind === 'outline') {
      await page.keyboard.press('Tab');
      await focusTarget.focus();
      assert.equal(await focusTarget.evaluate(element => element.matches(':focus-visible')), true, 'Keyboard focus must actually be visible');
    }
    await target.evaluate(element => new Promise((resolve, reject) => {
      let last, stableSince = performance.now();
      const start = stableSince;
      const frame = now => {
        const box = element.getBoundingClientRect();
        const positions = [];
        for (let node = element; node; node = node.parentElement) positions.push([node.scrollLeft, node.scrollTop]);
        const value = JSON.stringify([box.x, box.y, box.width, box.height, positions]);
        if (last !== value) { last = value; stableSince = now; }
        if (now - stableSince >= 120) resolve();
        else if (now - start > 3000) reject(new Error('Non-text target did not settle'));
        else requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    }));
    const observation = await auditNonTextContrast(page, target, kind);
    result.nonText.push({ width, scenario: state, ...observation });
    if (state === 'map-root-keyboard-focus') {
      assert.equal(observation.outline?.offset, '-5px', 'Root focus must stay inside its opaque surface, clear of graph connectors');
    }
    if (observation.state !== 'passed' || ['tab-0-keyboard-focus', 'map-root-keyboard-focus', 'tree-file-keyboard-focus', 'evidence-close-keyboard-focus', 'map-locate-keyboard-focus'].includes(state)) {
      const screenshot = path.join(path.dirname(outputPath), `nontext-review-${width}-${state}.png`);
      await page.screenshot({ path: screenshot });
      result.screenshots.push({ width, state, path: screenshot });
    }
  };
  const scan = async (width, height, state) => {
    const axeResult = await page.evaluate(async () => {
      const audit = await window.axe.run(document, {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] },
        rules: { 'color-contrast': { enabled: true } },
      });
      // Keep audit coverage and manual-review items without copying source text into the result.
      const summarize = ({ id, impact, help, nodes }) => ({ id, impact, help,
        nodes: nodes.map(node => ({ target: node.target, failureSummary: node.failureSummary,
          checks: [...node.any, ...node.all, ...node.none].map(check => ({ id: check.id, message: check.message })) })) });
      return { axeVersion: window.axe.version, violations: audit.violations.map(summarize),
        incomplete: audit.incomplete.map(summarize), passedRules: audit.passes.map(rule => rule.id),
        inapplicableRules: audit.inapplicable.map(rule => rule.id) };
    });
    result.axe.push({ width, height, state, ...axeResult });
    const selectors = ['.reading-header', '.project-record-strip', '.project-reader', '.evidence-pane'];
    if (scrollContrastEnabled) {
      const coverage = await auditScrollableContrast(page, selectors);
      result.scrollCoverage.push({ width, height, state, scrollers: coverage.scrollers });
      result.contrast.push(...coverage.samples.map(sample => ({ width, height, state, ...sample })));
      console.log(JSON.stringify({ stage: `${width}x${height}/${state}`, scrollSamples: coverage.samples.length }));
      if (coverage.samples.some(sample => sample.failures.length || sample.unsupported.length) || axeResult.violations.length
        || axeResult.incomplete.some(rule => rule.id === 'aria-prohibited-attr')) {
        const screenshot = path.join(path.dirname(outputPath), `scroll-review-${width}-${state}.png`);
        await page.screenshot({ path: screenshot, fullPage: true });
        result.screenshots.push({ width, height, state, path: screenshot });
      }
    } else if (contrastEnabled) result.contrast.push({ width, height, state, ...await auditRenderedContrast(page, selectors) });
    assert.equal(axeResult.violations.length, 0, `axe violations at ${width}x${height}/${state}: ${axeResult.violations.map(v => v.id).join(', ')}`);
    assert.equal(axeResult.incomplete.some(rule => rule.id === 'aria-prohibited-attr'), false, 'Named reading containers must have a role that permits an accessible name');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `Page overflows at ${width}/${state}`);
  };

  for (const [width, height] of [[1440, 900], [768, 1024], [390, 844], [320, 740]]) {
    stage = `report-${width}`;
    await page.setViewportSize({ width, height });
    await page.goto('/projects', { waitUntil: 'domcontentloaded' });
    await page.locator(`.project-history a[href="/projects/${projectId}"]`).click();
    await expect(reader).toBeVisible();
    await expect(page.getByRole('group', { name: '当前分析记录', exact: true })).toBeVisible();
    await page.addScriptTag({ content: axeSource });
    const structures = [];
    for (const [index, tabName] of ['读懂项目', '源码与模块', /待核实问题/].entries()) {
      stage = `report-${width}-tab-${index}`;
      const tab = reader.getByRole('tab', { name: tabName });
      await tab.click();
      await expect(tab).toHaveAttribute('aria-selected', 'true');
      if (index === 1) await expect(reader.getByRole('group', { name: '报告识别的技术栈', exact: true })).toBeVisible();
      if (scrollContrastEnabled) {
        const expanded = [];
        for (const button of await reader.getByRole('button', { name: /^(展开完整概览|查看全部 \d+ 个阅读建议|查看全部 \d+ 条问题线索)$/ }).all()) {
          if (await button.isVisible()) { expanded.push(await button.innerText()); await button.click(); }
        }
        // Open only native report disclosures, never source links or analysis/configuration actions.
        let opened;
        do {
          opened = false;
          for (const summary of await reader.locator('details:not([open]) > summary').all()) {
            if (await summary.isVisible()) { expanded.push(await summary.innerText()); await summary.click(); opened = true; break; }
          }
        } while (opened);
        result.expanded.push({ width, height, tab: index, controls: expanded });
      }
      const structure = await reader.evaluate(root => {
        const tabs = [...root.querySelectorAll('[role="tab"]')];
        const panel = root.querySelector('[role="tabpanel"]');
        const selected = tabs.find(node => node.getAttribute('aria-selected') === 'true');
        return {
          duplicateIds: [...document.querySelectorAll('[id]')].map(node => node.id).filter((id, i, all) => all.indexOf(id) !== i),
          tabCount: tabs.length,
          selectedTabs: tabs.filter(node => node.getAttribute('aria-selected') === 'true').length,
          tabControlsExisting: tabs.every(node => document.getElementById(node.getAttribute('aria-controls') || '') !== null),
          panelLabelledBySelected: !!panel && panel.getAttribute('aria-labelledby') === selected?.id,
          bodyOverflow: document.documentElement.scrollWidth > innerWidth,
        };
      });
      assert.deepEqual(structure.duplicateIds, []);
      assert.equal(structure.tabCount, 3);
      assert.equal(structure.selectedTabs, 1);
      assert.equal(structure.tabControlsExisting, true);
      assert.equal(structure.panelLabelledBySelected, true);
      assert.equal(structure.bodyOverflow, false);
      structures.push({ tab: index, ...structure });
      await scan(width, height, `tab-${index}`);
      await scanNonText(width, `tab-${index}-selected`, tab, 'after');
      await scanNonText(width, `tab-${index}-keyboard-focus`, tab, 'outline');
      if (width === 1440 && index === 2) {
        const screenshot = path.join(path.dirname(outputPath), 'a11y-findings-1440.png');
        await page.screenshot({ path: screenshot, fullPage: true });
        result.screenshots.push({ width, height, state: 'findings', path: screenshot });
      }
    }
    result.viewports.push({ width, height, structures });

    if (nonTextEnabled) {
      stage = `nontext-map-${width}`;
      await reader.getByRole('tab', { name: '源码与模块', exact: true }).click();
      const disclosure = reader.getByText('浏览项目地图与文件', { exact: true });
      if (!(await disclosure.evaluate(element => element.parentElement.open))) await disclosure.click();
      const map = reader.locator('.project-map');
      const root = map.locator('.map-root');
      await root.click();
      await expect(root).toHaveAttribute('aria-pressed', 'true');
      await scanNonText(width, 'map-root-selected', root, 'border');
      await scanNonText(width, 'map-root-keyboard-focus', root, 'outline');
      const module = map.locator('.module-node').first();
      await module.click();
      await expect(module).toHaveAttribute('aria-pressed', 'true');
      await scanNonText(width, 'map-module-selected', module, 'border');
      await scanNonText(width, 'map-module-keyboard-focus', module, 'outline');
      await scanNonText(width, 'map-locate-icon', map.locator('.locate-source svg').first(), 'stroke');
      await scanNonText(width, 'map-locate-keyboard-focus', map.locator('.locate-source').first(), 'outline');
      await map.locator('.locate-source').first().click();
      const tree = map.locator('.source-file-tree');
      const selectedFile = tree.locator('.tree-row.is-selected');
      await expect(selectedFile).toHaveCount(1);
      await scanNonText(width, 'tree-file-selected', selectedFile, 'before');
      await scanNonText(width, 'tree-file-keyboard-focus', selectedFile, 'outline');
      const search = tree.getByRole('searchbox', { name: '搜索文件或路径', exact: true });
      await scanNonText(width, 'tree-search-control', tree.locator('.tree-search'), 'border');
      await scanNonText(width, 'tree-search-keyboard-focus', tree.locator('.tree-search'), 'outline', search);
      await search.fill('forecast');
      await scanNonText(width, 'tree-clear-icon', tree.locator('.tree-clear svg'), 'stroke');
      await scanNonText(width, 'tree-clear-keyboard-focus', tree.locator('.tree-clear'), 'outline');
      await tree.locator('.tree-clear').click();
      await expect(search).toHaveValue('');
      await expect(tree.locator('.tree-collapse')).toBeEnabled();
      await scanNonText(width, 'tree-collapse-icon', tree.locator('.tree-collapse svg'), 'stroke');
      await scanNonText(width, 'tree-collapse-keyboard-focus', tree.locator('.tree-collapse'), 'outline');
    }

    if (extendedStatesEnabled) {
      const coverage = { width, height, scenes: [], modules: [], treeStates: [] };
      result.stateCoverage.push(coverage);
      await reader.getByRole('tab', { name: '读懂项目', exact: true }).click();
      const scene = reader.locator('.core-scenario');
      if (!(await scene.isVisible())) await reader.getByRole('button', { name: '切回场景说明', exact: true }).click();
      await expect(scene).toBeVisible();
      const selector = scene.getByLabel('切换场景', { exact: true });
      const sceneCount = await selector.count() ? await selector.locator('option').count() : 1;
      assert.ok(sceneCount > 0, 'No actual scenes available for extended acceptance');
      for (let index = 0; index < sceneCount; index++) {
        stage = `extended-${width}-scene-${index}`;
        if (await selector.count()) {
          const option = selector.locator('option').nth(index);
          const title = await option.innerText();
          await selector.selectOption({ index });
          await expect(scene.locator('h3')).toHaveText(title);
        }
        await scan(width, height, `scene-${index}`);
        coverage.scenes.push(index);
      }
      if (await selector.count()) await selector.selectOption({ index: 0 });

      await reader.getByRole('tab', { name: '源码与模块', exact: true }).click();
      const map = reader.locator('.project-map');
      await expect(map).toBeVisible();
      const modules = map.locator('.module-node');
      const moduleCount = await modules.count();
      assert.ok(moduleCount > 0, 'No actual modules available for extended acceptance');
      for (let index = 0; index < moduleCount; index++) {
        stage = `extended-${width}-module-${index}`;
        const node = modules.nth(index);
        const title = await node.getAttribute('title');
        await node.click();
        await expect(node).toHaveAttribute('aria-pressed', 'true');
        await expect(map.locator('.map-inspector h3')).toHaveText(title);
        await expect(map.getByRole('group', { name: '模块职责说明', exact: true })).toBeVisible();
        await scan(width, height, `module-${index}`);
        coverage.modules.push(index);
      }
      await map.locator('.map-root').click();
      await expect(map.locator('.map-root')).toHaveAttribute('aria-pressed', 'true');

      const tree = map.locator('.source-file-tree');
      await expect(tree).toBeVisible();
      let opened = 0;
      while (await tree.locator('[role="treeitem"][aria-expanded="false"]').count()) {
        stage = `extended-${width}-tree-expand-${opened}`;
        // Only directories may be activated; file actions would change evidence state.
        const id = await tree.locator('[role="treeitem"][aria-expanded="false"]').first()
          .evaluate(element => CSS.escape(element.dataset.nodeId));
        const directory = tree.locator(`[role="treeitem"][data-node-id="${id}"]`);
        await directory.click();
        await expect(directory).toHaveAttribute('aria-expanded', 'true');
        assert.ok(++opened <= 20000, 'File tree expansion did not terminate');
      }
      const directoryCount = await tree.locator('[role="treeitem"][aria-expanded="true"]').count();
      const fileRows = tree.locator('[role="treeitem"]:not([aria-expanded])');
      const fileCount = await fileRows.count();
      assert.ok(fileCount > 0, 'No files rendered in expanded tree');
      const levels = await tree.locator('[role="treeitem"]').evaluateAll(rows => rows.map(row => ({
        level: Number(row.getAttribute('aria-level')), depth: row.title.split('/').filter(Boolean).length,
        position: Number(row.getAttribute('aria-posinset')), siblings: Number(row.getAttribute('aria-setsize')),
      })));
      assert.ok(levels.every(row => row.level === row.depth && row.position >= 1 && row.position <= row.siblings),
        'File tree must retain actual directory depth and valid sibling metadata');
      stage = `extended-${width}-tree-expanded`;
      await scan(width, height, 'tree-expanded');
      coverage.treeStates.push({ state: 'expanded', directoryCount, fileCount, maximumAriaLevel: Math.max(...levels.map(row => row.level)), actualDepthPreserved: true });

      const search = tree.getByRole('searchbox', { name: '搜索文件或路径', exact: true });
      const searchPath = await fileRows.first().getAttribute('title');
      assert.ok(searchPath);
      stage = `extended-${width}-tree-search-match`;
      await search.fill(searchPath);
      assert.ok((await fileRows.evaluateAll(rows => rows.map(row => row.title))).includes(searchPath));
      const matches = await fileRows.count();
      assert.ok(matches > 0 && matches <= fileCount);
      await scan(width, height, 'tree-search-match');
      coverage.treeStates.push({ state: 'search-match', matches });

      stage = `extended-${width}-tree-search-empty`;
      await search.fill('__reader_v2_no_matching_file__');
      await expect(tree.getByText('暂无匹配文件', { exact: true })).toBeVisible();
      await expect(tree.getByRole('tree')).toHaveCount(0);
      await scan(width, height, 'tree-search-empty');
      coverage.treeStates.push({ state: 'search-empty', matches: 0 });
      await tree.getByRole('button', { name: '清除文件搜索', exact: true }).click();
      await expect(search).toBeFocused();
      await expect(search).toHaveValue('');
      await expect(fileRows).toHaveCount(fileCount);
      await expect(tree.locator('[role="treeitem"][aria-expanded="true"]')).toHaveCount(directoryCount);

      stage = `extended-${width}-tree-collapsed`;
      await tree.getByRole('button', { name: '收起全部目录', exact: true }).click();
      await expect(tree.locator('[role="treeitem"][aria-expanded="true"]')).toHaveCount(0);
      await scan(width, height, 'tree-collapsed');
      coverage.treeStates.push({ state: 'collapsed', directoriesExpanded: 0, clearRestoredFocusAndExpansion: true });
    }

    stage = `evidence-${width}`;
    await reader.getByRole('tab', { name: '读懂项目', exact: true }).click();
    const sourceButton = reader.locator('.scene-evidence button').first();
    await sourceButton.click();
    const pane = page.locator('.evidence-pane');
    await expect(pane.locator('.highlight').first()).toBeVisible();
    await expect(pane.getByRole('group', { name: '源码内容', exact: true })).toBeVisible();
    await expect(pane).toHaveAttribute('aria-label', '源码引用');
    const mode = width === 1440 ? 'split-region' : 'modal-dialog';
    if (mode === 'split-region') {
      await expect(pane).toHaveJSProperty('tagName', 'ASIDE');
      await expect(pane).toHaveAttribute('role', 'region');
      await expect(page.locator('.evidence-workspace.is-split')).toBeVisible();
      await expect(reader.getByRole('tab', { name: '源码与模块', exact: true })).toBeEnabled();
    } else {
      await expect(pane).toHaveJSProperty('tagName', 'DIALOG');
      assert.equal(await pane.evaluate(element => element.matches(':modal')), true);
      await expect(pane.getByRole('button', { name: '关闭源码', exact: true })).toBeFocused();
    }
    await scanNonText(width, 'evidence-close-icon', pane.locator('.evidence-header button svg'), 'stroke');
    await scanNonText(width, 'evidence-copy-icon', pane.locator('.evidence-path button svg'), 'stroke');
    await scanNonText(width, 'evidence-close-keyboard-focus', pane.locator('.evidence-header button'), 'outline');
    if (width === 1440) await scanNonText(width, 'evidence-citation-selected', sourceButton, 'outline');
    let navigationCoverage;
    if (nonTextEnabled) {
      stage = `evidence-navigation-${width}`;
      const navigation = pane.getByRole('navigation', { name: '当前判断的引用', exact: true });
      const previous = navigation.getByRole('button', { name: '上一处', exact: true });
      const next = navigation.getByRole('button', { name: '下一处', exact: true });
      const citations = reader.locator('.scene-evidence button');
      const count = await citations.count();
      assert.ok(count > 1, 'Navigation acceptance requires multiple actual citations');
      const stableContext = await pane.locator('.evidence-header h3, .evidence-context, .evidence-version').allTextContents();
      const analysisId = result.sourceRequests.at(-1).analysisId;
      const checkCitation = async index => {
        await expect(navigation.locator('span')).toHaveText(`${index + 1} / ${count}`);
        await expect(pane.locator('.highlight').first()).toBeVisible();
        const expectedPath = await citations.nth(index).locator('span').first().innerText();
        await expect(pane.locator('.evidence-path > span')).toHaveText(expectedPath);
        assert.deepEqual(await pane.locator('.evidence-header h3, .evidence-context, .evidence-version').allTextContents(), stableContext,
          'Citation navigation must retain the same judgment and source version');
        assert.equal(result.sourceRequests.at(-1).analysisId, analysisId);
        assert.equal(result.sourceRequests.at(-1).path, expectedPath);
        await expect(citations.nth(index)).toHaveAttribute('data-evidence-selected', 'true');
        if (index === 0) await expect(previous).toBeDisabled();
        else await expect(previous).toBeEnabled();
        if (index === count - 1) await expect(next).toBeDisabled();
        else await expect(next).toBeEnabled();
      };
      await checkCitation(0);
      await scanNonText(width, 'evidence-next-icon', next.locator('svg'), 'stroke');
      await scanNonText(width, 'evidence-next-keyboard-focus', next, 'outline');
      for (let index = 1; index < count; index++) {
        await next.focus();
        await page.keyboard.press('Enter');
        await checkCitation(index);
        await expect(index === count - 1 ? previous : next).toBeFocused();
      }
      await scanNonText(width, 'evidence-previous-icon', previous.locator('svg'), 'stroke');
      await scanNonText(width, 'evidence-previous-keyboard-focus', previous, 'outline');
      for (let index = count - 2; index >= 0; index--) {
        await previous.focus();
        await page.keyboard.press('Enter');
        await checkCitation(index);
        await expect(index === 0 ? next : previous).toBeFocused();
      }
      navigationCoverage = { citations: count, traversedForwardAndBack: true, boundariesDisabled: true,
        contextAndVersionPreserved: true, reportAndPathBound: true };
      await scanNonText(width, 'evidence-copy-keyboard-focus', pane.locator('.evidence-path button'), 'outline');
      await scanNonText(width, 'evidence-full-file-keyboard-focus', pane.getByRole('button', { name: '查看完整文件', exact: true }), 'outline');
    }
    await scan(width, height, `${mode}-snippet`);
    const fullFileButton = pane.getByRole('button', { name: '查看完整文件', exact: true });
    await fullFileButton.focus();
    await page.keyboard.press('Enter');
    await expect(pane.getByText(/^完整文件 · \d+ 行$/)).toBeVisible();
    await expect(pane.getByRole('button', { name: '返回引用片段', exact: true })).toBeFocused();
    await scan(width, height, `${mode}-full-file`);
    let fullFileScroll;
    if (width === 320) {
      fullFileScroll = await pane.evaluate(element => ({ scrollTop: element.scrollTop, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight }));
      const screenshot = path.join(path.dirname(outputPath), 'a11y-full-file-320.png');
      await page.screenshot({ path: screenshot });
      result.screenshots.push({ width, height, state: 'full-file', path: screenshot });
      await pane.evaluate(element => { element.scrollTop = 0; });
      await expect(pane.getByRole('button', { name: '关闭源码', exact: true })).toBeInViewport();
      await scan(width, height, `${mode}-full-file-top`);
      const topScreenshot = path.join(path.dirname(outputPath), 'a11y-full-file-top-320.png');
      await page.screenshot({ path: topScreenshot });
      result.screenshots.push({ width, height, state: 'full-file-top', path: topScreenshot });
    }
    if (nonTextEnabled) {
      stage = `evidence-return-snippet-${width}`;
      const back = pane.getByRole('button', { name: '返回引用片段', exact: true });
      await scanNonText(width, 'evidence-return-snippet-keyboard-focus', back, 'outline');
      await page.keyboard.press('Enter');
      await expect(pane.getByRole('button', { name: '查看完整文件', exact: true })).toBeVisible();
      await expect(pane.getByRole('button', { name: '查看完整文件', exact: true })).toBeFocused();
      await expect(pane.locator('.highlight').first()).toBeVisible();
      await expect(sourceButton).toHaveAttribute('data-evidence-selected', 'true');
      navigationCoverage.returnedToOriginalSnippet = true;
      await scan(width, height, `${mode}-returned-snippet`);
    }
    if (width === 320) await page.keyboard.press('Escape');
    else await pane.getByRole('button', { name: '关闭源码', exact: true }).click();
    await expect(pane).toHaveCount(0);
    await expect(sourceButton).toBeFocused();
    result.evidence.push({ width, height, mode, loadedSnippet: true, loadedFullFile: true, fullFileScroll, navigationCoverage,
      closeMethod: width === 320 ? 'Escape' : 'button', focusReturned: true });
  }
  stage = 'database-after';
  const after = await snapshot();
  assert.deepEqual(after, before, 'Source data, reports or model-call ledger changed');
  result.sourceCallsAfter = after.calls;
  result.unchangedProjects = after.projects.length;
  result.unchangedAnalyses = after.analyses.length;
  result.dataUnchanged = true;
  assert.deepEqual(result.blockedWrites, []);
  assert.deepEqual(result.pageErrors, []);
  assert.deepEqual(result.apiFailures, []);
  if (contrastEnabled) {
    stage = 'contrast-sampled-fragments';
    result.contrastSummary = {
      scope: extendedStatesEnabled ? 'one actual historical report: all original scene options and module nodes; expanded, matching-search, empty-search and collapsed file tree; document and discovered nested scrollers; not other reports or full accessibility certification' : scrollContrastEnabled ? 'current report after visible disclosures opened; document and discovered nested scrollers; currently selected scene and map node; not full accessibility certification' : 'visible text only, not full accessibility certification',
      fragments: result.contrast.reduce((sum, scan) => sum + scan.fragments, 0),
      failures: result.contrast.reduce((sum, scan) => sum + scan.failures.length, 0),
      unsupported: result.contrast.reduce((sum, scan) => sum + scan.unsupported.length, 0),
      excludedGlyphFreeFragments: result.contrast.reduce((sum, scan) => sum + scan.excluded.length, 0),
      minimumRatio: Math.min(...result.contrast.map(scan => scan.minimumRatio)),
    };
    assert.ok(result.contrastSummary.fragments > 0, 'No rendered contrast observations');
    assert.equal(result.contrastSummary.failures, 0, 'Rendered contrast below 4.5:1; inspect contrast observations');
    assert.equal(result.contrastSummary.unsupported, 0, 'Unsupported rendered contrast observations require manual review');
  }
  if (nonTextEnabled) {
    stage = 'nontext-contrast-summary';
    result.nonTextSummary = {
      scope: 'one actual legacy report at four widths: three selected report-tab underlines and keyboard outlines, root/first module selected borders and focus, locate-source icon/focus, selected file marker/focus, search border/focus, clear/collapse icons/focus, evidence close/copy/previous/next icons and focus, full-file/return-snippet focus, desktop selected citation; disabled arrows checked for behavior but not counted as 3:1 observations; not all controls or full accessibility certification',
      observations: result.nonText.length,
      failures: result.nonText.filter(item => item.state === 'below-threshold').length,
      unsupported: result.nonText.filter(item => item.state === 'unsupported').length,
      excluded: result.nonText.filter(item => item.state === 'excluded').length,
      minimumRatio: Math.min(...result.nonText.filter(item => item.minimumRatio !== null).map(item => item.minimumRatio)),
    };
    assert.ok(result.nonTextSummary.observations > 0);
    assert.equal(result.nonTextSummary.failures, 0, 'Non-text contrast below 3:1; inspect nonText observations');
    assert.equal(result.nonTextSummary.unsupported, 0, 'Non-text contrast requires further review');
    assert.equal(result.nonTextSummary.excluded, 0, 'Expected non-text controls must have visible painted pixels');
  }
  result.state = 'passed';
} catch (error) {
  result.state = 'failed';
  result.failedStage = stage;
  result.errorType = error.name;
  result.errorSummary = String(error.message).split('\n').slice(0, 2).join('\n').slice(0, 500);
  process.exitCode = 1;
} finally {
  if (db && before && result.sourceCallsAfter === undefined) {
    try {
      const after = await snapshot();
      result.sourceCallsAfter = after.calls;
      assert.deepEqual(after, before, 'Source data, reports or model-call ledger changed during an incomplete audit');
      result.unchangedProjects = after.projects.length;
      result.unchangedAnalyses = after.analyses.length;
      result.dataUnchanged = true;
    } catch (error) {
      result.state = 'failed';
      result.integrityCheckError = error.name;
      process.exitCode = 1;
    }
  }
  await context?.close();
  await browser?.close();
  await auth?.dispose();
  await db?.close();
  result.completedAt = new Date().toISOString();
  await writeFile(outputPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ state: result.state, stage: result.failedStage, errorSummary: result.errorSummary,
    scans: result.axe.length, violations: result.axe.reduce((sum, scan) => sum + scan.violations.length, 0),
    incompleteRules: [...new Set(result.axe.flatMap(scan => scan.incomplete.map(rule => rule.id)))],
    contrast: { scans: result.contrast.length, fragments: result.contrast.reduce((sum, scan) => sum + scan.fragments, 0),
      failures: result.contrast.reduce((sum, scan) => sum + scan.failures.length, 0),
      unsupported: result.contrast.reduce((sum, scan) => sum + scan.unsupported.length, 0) },
    nonText: result.nonTextSummary ?? { observations: result.nonText.length },
    evidence: result.evidence, sourceCallsBefore: result.sourceCallsBefore, sourceCallsAfter: result.sourceCallsAfter,
    blockedWrites: result.blockedWrites.length, pageErrors: result.pageErrors, apiFailures: result.apiFailures, outputPath }));
}
