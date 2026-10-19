import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect, request } from '@playwright/test';
import { connectDesktopDatabase } from './desktop-database.ts';

// Explicit local acceptance only. This script logs in, then allows real GETs only.
const origin = 'http://127.0.0.1:5174';
const projectId = 'de8b23bc-bce3-4755-966a-8f863cf61a39';
const historyProjectId = 'f2370e8a-9427-437c-b0c7-c9b1121217ae';
const directory = path.resolve('output/reader-v2/live');
await mkdir(directory, { recursive: true });
const result = { state: 'running', origin, projectId, historyProjectId, synthetic: false,
  viewports: [], sourceRequests: [], blockedWrites: [], pageErrors: [], apiFailures: [] };
let stage = 'database-before', browser, auth, context;
const db = await connectDesktopDatabase();
const snapshot = async () => ({
  projects: (await db.query('SELECT id,sha256,md5(files::text) AS files_hash FROM source_projects ORDER BY id')).rows,
  analyses: (await db.query('SELECT id,project_id,status,md5(report::text) AS report_hash FROM source_analyses ORDER BY id')).rows,
  calls: (await db.query('SELECT count(*)::int AS count FROM source_model_calls')).rows[0].count,
});
try {
  const active = (await db.query(`SELECT
    (SELECT count(*) FROM source_analyses WHERE status IN ('queued','running'))::int AS source,
    (SELECT count(*) FROM runs WHERE status IN ('queued','preparing','building','checking','analyzing'))::int AS runs,
    (SELECT count(*) FROM analysis_attempts WHERE status IN ('queued','running'))::int AS analyses,
    (SELECT count(*) FROM execution_attempts WHERE owner_phase<>'closed')::int AS owners`)).rows[0];
  assert.ok(Object.values(active).every(count => count === 0), 'Active work requires separate coordination');
  const before = await snapshot();
  result.sourceCallsBefore = before.calls;
  stage = 'login';
  const { loginPassword } = JSON.parse(await readFile('.data/business-v2/development-credentials.json', 'utf8'));
  auth = await request.newContext({ baseURL: origin });
  const login = await auth.post('/api/v1/session/login', {
    headers: { origin }, data: { email: 'teacher@codelab.local', password: loginPassword },
  });
  assert.equal(login.status(), 200, 'Real login failed');
  const existing = await auth.get(`/api/v2/projects/${projectId}`);
  assert.equal(existing.status(), 200);
  const project = await existing.json();
  const readable = project.analyses.filter(analysis => analysis.report?.report);
  assert.ok(readable.length > 0);
  result.originalReportIds = readable.map(analysis => analysis.id);
  result.originalHasBrief = readable.some(analysis => !!analysis.report.report.readingBrief);
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  context = await browser.newContext({ baseURL: origin, storageState: await auth.storageState(),
    reducedMotion: 'reduce', viewport: { width: 1440, height: 900 } });
  await context.route('**/api/**', async route => {
    const req = route.request(), url = new URL(req.url());
    if (!['GET', 'HEAD'].includes(req.method())) {
      result.blockedWrites.push({ method: req.method(), path: url.pathname });
      return route.abort('blockedbyclient');
    }
    if (url.pathname.endsWith('/source')) {
      const entry = { projectId: url.pathname.split('/')[4], ...Object.fromEntries(url.searchParams) };
      result.sourceRequests.push(entry);
    }
    return route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', error => result.pageErrors.push(error.name));
  page.on('response', response => {
    const url = new URL(response.url());
    if (url.pathname.startsWith('/api/') && response.status() >= 400)
      result.apiFailures.push({ path: url.pathname, status: response.status() });
  });
  const report = page.getByRole('region', { name: '项目解读报告', exact: true });
  for (const [width, height] of [[1440, 900], [768, 1024], [390, 844], [320, 740]]) {
    stage = `original-report-${width}`;
    await page.setViewportSize({ width, height });
    await page.goto('/projects', { waitUntil: 'domcontentloaded' });
    await page.locator(`.project-history a[href="/projects/${projectId}"]`).click();
    await expect(report).toBeVisible();
    await expect(page.locator('.studio-title h1')).toHaveText(project.name);
    await expect(report.getByRole('tab')).toHaveCount(3);
    const purpose = report.locator('.overview-text');
    await expect(purpose).toBeVisible();
    const purposeBox = await purpose.boundingBox();
    const sourceButton = report.locator('.scene-evidence button').first();
    await expect(sourceButton).toBeVisible();
    await sourceButton.click();
    const pane = page.locator('.evidence-pane');
    await expect(pane.locator('.highlight').first()).toBeVisible();
    const contextDisclosure = pane.locator('.evidence-context-details');
    await expect(contextDisclosure).toHaveJSProperty('open', false);
    await contextDisclosure.locator('summary').click();
    await expect(pane.locator('.evidence-context')).toBeVisible();
    assert.ok(readable.some(analysis => analysis.id === result.sourceRequests.at(-1).analysisId));
    const selectedRequest = result.sourceRequests.at(-1);
    assert.equal(selectedRequest.projectId, projectId);
    assert.ok(Number(selectedRequest.start) > 0 && Number(selectedRequest.end) >= Number(selectedRequest.start));
    await page.screenshot({ path: path.join(directory, `evidence-${width}.png`), fullPage: width >= 768 });
    await pane.getByRole('button', { name: '查看完整文件', exact: true }).click();
    await expect(pane.getByText(/^完整文件 · \d+ 行$/)).toBeVisible();
    assert.equal(result.sourceRequests.at(-1).start, undefined);
    await pane.getByRole('button', { name: '关闭源码', exact: true }).click();
    await expect(sourceButton).toBeFocused();
    for (const name of ['源码与模块', /待核实问题/, '读懂项目'])
      await report.getByRole('tab', { name }).click();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    assert.equal(overflow, false, `Original report overflows at ${width}`);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: path.join(directory, `reading-${width}.png`), fullPage: true });
    result.viewports.push({ width, height, purposeY: purposeBox.y, overflow,
      bodyFont: await purpose.evaluate(element => getComputedStyle(element).fontSize) });
    await page.getByRole('link', { name: '我的项目', exact: true }).first().click();
    await expect(page.locator(`.project-history a[href="/projects/${projectId}"]`)).toBeVisible();
  }
  stage = 'existing-history';
  const historyResponse = await auth.get(`/api/v2/projects/${historyProjectId}`);
  assert.equal(historyResponse.status(), 200);
  const history = await historyResponse.json();
  const historyReports = history.analyses.filter(analysis => analysis.report?.report);
  assert.ok(historyReports.length >= 2, 'Historical switching needs two existing reports');
  await page.setViewportSize({ width: 1440, height: 900 });
  stage = 'history-open-from-list';
  await page.locator(`.project-history a[href="/projects/${historyProjectId}"]`).click();
  await expect(report).toBeVisible();
  for (const analysis of historyReports.slice(0, 2)) {
    stage = `history-select-${analysis.id}`;
    await page.locator('#project-analysis-record').selectOption(analysis.id);
    await expect(report.locator('.overview-text')).toHaveText(analysis.report.report.overview);
    await report.getByRole('tab', { name: '读懂项目', exact: true }).click();
    const citation = report.locator('.scene-evidence button').first();
    stage = `history-source-${analysis.id}`;
    await expect(citation).toBeVisible();
    await citation.click();
    await expect(page.locator('.evidence-pane .highlight').first()).toBeVisible();
    assert.equal(result.sourceRequests.at(-1).analysisId, analysis.id);
    assert.equal(result.sourceRequests.at(-1).projectId, historyProjectId);
    await page.locator('.evidence-pane').getByRole('button', { name: '关闭源码', exact: true }).click();
  }
  result.historyReportIds = historyReports.slice(0, 2).map(analysis => analysis.id);
  await page.getByRole('link', { name: '我的项目', exact: true }).first().click();
  await expect(page.locator(`.project-history a[href="/projects/${historyProjectId}"]`)).toBeVisible();
  stage = 'database-after';
  const after = await snapshot();
  assert.deepEqual(after, before, 'Source data, reports or model-call ledger changed');
  assert.deepEqual(result.blockedWrites, []);
  assert.deepEqual(result.pageErrors, []);
  assert.deepEqual(result.apiFailures, []);
  result.sourceCallsAfter = after.calls;
  result.unchangedProjects = after.projects.length;
  result.unchangedAnalyses = after.analyses.length;
  result.state = 'passed';
} catch (error) {
  result.state = 'failed';
  result.failedStage = stage;
  result.errorType = error.name;
  result.errorSummary = String(error.message).split('\n').slice(0, 2).join('\n').slice(0, 300);
  const failedPage = context?.pages()[0];
  if (failedPage) await failedPage.screenshot({ path: path.join(directory, 'failed.png'), fullPage: true }).catch(() => {});
  process.exitCode = 1;
} finally {
  await context?.close();
  await browser?.close();
  await auth?.dispose();
  await db.close();
  await writeFile(path.join(directory, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ state: result.state, stage: result.failedStage, viewports: result.viewports,
    sourceRequests: result.sourceRequests.length, blockedWrites: result.blockedWrites.length,
    pageErrors: result.pageErrors, apiFailures: result.apiFailures, sourceCallsBefore: result.sourceCallsBefore,
    sourceCallsAfter: result.sourceCallsAfter, resultPath: path.join(directory, 'result.json') }));
}
