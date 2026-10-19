import { chromium, expect } from '@playwright/test';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { unzipSync } from 'fflate';
import path from 'node:path';
import { root } from '../apps/api/src/template.js';

// Explicit paid engineering acceptance, restricted to registered nonstudent development samples.
// Never retries a POST or automatically adopts/publishes a model candidate.
const runId = process.argv[2];
if (!runId || !/^[0-9a-f-]{36}$/.test(runId)) throw new Error('RUN_ID_REQUIRED');
const id = randomUUID();
const output = path.join(root, '.data/live-model-pairs', id);
await mkdir(output, { recursive: true });
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const credentials = JSON.parse(await readFile(path.join(root, '.data/business-v2/development-credentials.json'), 'utf8'));
const registry = JSON.parse(await readFile(path.join(root, 'eval/development-registry.json'), 'utf8'));
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const acceptedIds: string[] = [];
try {
  const page = await browser.newPage({ baseURL: 'http://127.0.0.1:5174', viewport: { width: 1440, height: 1000 } });
  const errors: string[] = [];
  page.on('pageerror', () => errors.push('PAGE_ERROR'));
  await page.goto('/');
  await page.getByLabel('邮箱', { exact: true }).fill('teacher@codelab.local');
  await page.getByLabel('密码', { exact: true }).fill(credentials.loginPassword);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '实训任务', exact: true })).toBeVisible();
  await page.goto(`/runs/${runId}`);
  await expect(page.getByRole('navigation', { name: '验收条目' })).toBeVisible();
  const review = async () => {
    const response = await page.request.get(`/api/v2/runs/${runId}/review`);
    expect(response.ok()).toBe(true);
    return response.json();
  };
  const openAnalysisSettings = async () => {
    const drawer = page.locator('details.analysis-drawer');
    if (await drawer.getAttribute('open') === null) await drawer.locator(':scope > summary').click();
  };
  const live = await review();
  const resumeDirectory = process.argv[3];
  if (resumeDirectory && !/^[0-9a-f-]{36}$/.test(resumeDirectory)) throw new Error('INVALID_RESUME_ID');
  const before = resumeDirectory ? JSON.parse(await readFile(path.join(root, '.data/live-model-pairs', resumeDirectory, 'before.json'), 'utf8')) : live;
  expect(before.analysisAvailable).toBe(true);
  const sample = registry.samples.find((s: any) => s.originalZipSha256 === before.baseManifest.context.originalZipSha256
    && s.origin === 'team-constructed' && s.containsStudentSubmission === false && s.partition === 'development');
  if (!sample) throw new Error('REGISTERED_NONSTUDENT_SAMPLE_REQUIRED');
  const baseline = JSON.stringify({ manifest: before.baseManifest, results: before.baseResults, revision: before.revision });
  await writeFile(path.join(output, 'before.json'), JSON.stringify(before, null, 2));
  for (const strategy of ['summary', 'agent']) {
    const recovered = resumeDirectory && strategy === 'summary'
      ? live.analyses.filter((a: any) => a.strategy === 'summary' && !before.analyses.some((b: any) => b.id === a.id)) : [];
    if (resumeDirectory && strategy === 'summary' && recovered.length !== 1) throw new Error('AMBIGUOUS_RESUME');
    let analysisId: string;
    if (recovered.length === 1) {
      analysisId = recovered[0].id;
    } else {
    await openAnalysisSettings();
    await page.getByLabel('分析方式', { exact: true }).selectOption(strategy);
    if (strategy === 'agent') await page.getByLabel('对照已有分析（可选）', { exact: true }).selectOption(acceptedIds[0]);
    const responsePromise = page.waitForResponse(r => r.url().endsWith(`/api/v2/runs/${runId}/analyses`) && r.request().method() === 'POST');
    await page.getByRole('button', { name: '重新分析存档', exact: true }).click();
    const response = await responsePromise;
    expect(response.ok()).toBe(true);
    const result = await response.json();
    analysisId = result.analysis.analysisAttemptId;
    expect(typeof analysisId).toBe('string');
    }
    acceptedIds.push(analysisId);
    await writeFile(path.join(output, 'accepted.json'), JSON.stringify({ runId, acceptedIds }));
    console.log(JSON.stringify({ strategy, analysisId, state: 'accepted' }));
    await expect.poll(async () => {
      const current = (await review()).analyses.find((a: any) => a.id === analysisId);
      return current && ['succeeded', 'degraded', 'interrupted', 'cancelled'].includes(current.status) && current.cleanup_state === 'clean';
    }, { timeout: 180_000, intervals: [1000, 2000, 3000] }).toBe(true);
    await page.reload();
    await expect(page.getByRole('navigation', { name: '验收条目' })).toBeVisible();
    const current = (await review()).analyses.find((a: any) => a.id === analysisId);
    console.log(JSON.stringify({ strategy, analysisId, status: current.status, code: current.code, operations: current.operations }));
  }
  const after = await review();
  expect(JSON.stringify({ manifest: after.baseManifest, results: after.baseResults, revision: after.revision })).toBe(baseline);
  await writeFile(path.join(output, 'after.json'), JSON.stringify(after, null, 2));
  await openAnalysisSettings();
  await page.locator('summary').filter({ hasText: '查看分析记录' }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.locator('.analysis-records > li').filter({ hasText: acceptedIds[1].slice(0, 8) })
    .getByRole('button', { name: '下载配对材料', exact: true }).click();
  const download = await downloadPromise;
  const zipPath = path.join(output, 'pair.zip');
  await download.saveAs(zipPath);
  const bytes = await readFile(zipPath);
  const files = unzipSync(bytes);
  const parse = (name: string) => JSON.parse(Buffer.from(files[name]).toString('utf8'));
  const manifest = parse('manifest.json');
  for (const item of manifest.files) {
    expect(files[item.path].byteLength).toBe(item.byteSize);
    expect(hash(files[item.path])).toBe(item.sha256);
  }
  expect(Object.keys(files).length).toBe(manifest.files.length + 1);
  const materials = parse('evaluation-materials.json');
  const modelConfiguration = parse('common/model-configuration.json');
  expect(materials.arms.map((arm: any) => arm.analysisAttemptId).sort()).toEqual([...acceptedIds].sort());
  const arms = materials.arms.map((arm: any) => ({
    group: arm.group, analysisAttemptId: arm.analysisAttemptId, status: arm.analysisStatus,
    hasCandidate: !!arm.candidate, confirmedCompletedCalls: arm.confirmedCompletedCalls,
    operations: Object.keys(files).filter(n => n.startsWith(`analyses/${arm.analysisAttemptId}/operations/`) && n.endsWith('/record.json'))
      .map(n => { const op = parse(n); return { kind: op.kind, state: op.state, usage: op.actualUsage, errorCode: op.error?.code ?? null }; }),
  }));
  await page.screenshot({ path: path.join(output, 'desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileOverflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  await page.screenshot({ path: path.join(output, 'mobile.png'), fullPage: true });
  expect(mobileOverflow).toBe(false);
  expect(errors).toEqual([]);
  const summary = { verificationId: id, runId, sampleId: sample.sampleId, origin: sample.origin,
    containsStudentSubmission: false, originalZipSha256: sample.originalZipSha256,
    baseInputHash: materials.baseInputHash, baselineUnchanged: true, teacherRevisionId: before.revision.revisionId,
    archiveSha256: hash(bytes), verifiedFiles: manifest.files.length, arms, mobileOverflow, pageErrors: errors,
    modelConfigurationHash: hash(files['common/model-configuration.json']),
    enableThinking: modelConfiguration.enableThinking ?? null,
    cost: null, qualityEvaluationCompleted: false, candidateAutoAdopted: false, candidateAutoPublished: false };
  const publicOutput = path.join(root, 'docs/verification/2026-09-28', `live-model-pair-${id}`);
  await mkdir(publicOutput, { recursive: true });
  await writeFile(path.join(publicOutput, 'result.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  await writeFile(path.join(output, 'failure.txt'), error instanceof Error ? error.stack ?? error.message : 'UNKNOWN');
  console.error(JSON.stringify({ code: 'LIVE_PAIR_VERIFICATION_FAILED', verificationId: id, acceptedIds,
    instruction: 'Inspect existing private records before any new paid run; do not blindly retry.' }));
  process.exitCode = 1;
} finally { await browser.close(); }
