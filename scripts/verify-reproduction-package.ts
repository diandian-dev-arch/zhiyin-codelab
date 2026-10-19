// Local cached reproduction, not an independent member's acceptance receipt.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { root } from '../apps/api/src/template.js';

const [id, ...extra] = process.argv.slice(2);
assert(id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id) && !extra.length,
  'Usage: pnpm exec tsx scripts/verify-reproduction-package.ts <source-package-uuid>');
const directory = path.join(root, 'output/reproduction', id);
const result: Record<string, unknown> = {state: 'running', independentReproductionCompleted: false,
  externalModelCalls: 0, runtimeServicesStarted: false, checks: [],
  limitations: ['Same host and cached dependencies; not independent reproduction',
    'No live database, browser or model requests', 'Generated evidence and license attachments are separate']};
const execute = promisify(execFile);
try {
  const packaged = JSON.parse(await readFile(path.join(directory, 'result.json'), 'utf8'));
  const archive = await readFile(path.join(directory, 'codelab-source.zip'));
  const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  assert.equal(digest(archive), packaged.sha256);
  const files = unzipSync(archive);
  const manifest = JSON.parse(Buffer.from(files['SOURCE_MANIFEST.json']).toString('utf8'));
  assert.equal(manifest.version, 1);
  assert.equal(manifest.files.length, packaged.fileCount);
  assert.equal(Object.keys(files).length, manifest.files.length + 1);
  await mkdir(path.join(root, '.data'), {recursive: true});
  const extracted = await mkdtemp(path.join(root, '.data/reproduction-execution-'));
  result.extracted = extracted;
  const seen = new Set<string>();
  for (const entry of manifest.files) {
    assert(typeof entry.path === 'string' && /^[a-zA-Z0-9_.\-/]+$/.test(entry.path)
      && !entry.path.split('/').some((p: string) => !p || p === '..' || p === '.'), 'SOURCE_PATH_INVALID');
    assert(!seen.has(entry.path)); seen.add(entry.path);
    assert(!/^\.data\/|^\.git\/|^output\/|(^|\/)node_modules\/|(^|\/)\.env$|\.key$/.test(entry.path), 'PRIVATE_FILE_IN_SOURCE');
    const target = path.resolve(extracted, entry.path);
    assert(target.startsWith(extracted + path.sep));
    const bytes = files[entry.path];
    assert(bytes && bytes.length === entry.bytes);
    assert.equal(digest(bytes), entry.sha256);
    await mkdir(path.dirname(target), {recursive: true});
    await writeFile(target, bytes, {flag: 'wx'});
    assert.equal(digest(await readFile(target)), entry.sha256);
  }
  await writeFile(path.join(extracted, 'SOURCE_MANIFEST.json'), files['SOURCE_MANIFEST.json'], {flag: 'wx'});
  Object.assign(result, {archiveSha256: packaged.sha256, fileCount: seen.size, manifestAndDiskHashesMatch: true});
  async function run(label: string, command: string, args: string[]) {
    const started = Date.now();
    const {stdout, stderr} = await execute(command, args, {cwd: extracted, encoding: 'utf8',
      windowsHide: true, timeout: 120_000, maxBuffer: 4 * 1024 ** 2});
    (result.checks as object[]).push({label, passed: true, elapsedMs: Date.now() - started, stdout, stderr});
    console.log(JSON.stringify({check: label, passed: true}));
  }
  const pnpm = async (label: string, command: string) => {
    // Only fixed commands below, never user-controlled shell text.
    if (process.platform === 'win32') await run(label, 'powershell.exe', ['-NoProfile', '-Command', command]);
    else await run(label, 'pnpm', command.split(' ').slice(1));
  };
  await run('manifest', process.execPath, ['scripts/verify-source-bundle.mjs']);
  await pnpm('offline_frozen_install', 'pnpm install --offline --frozen-lockfile --ignore-scripts');
  await run('root_typecheck', process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit']);
  await pnpm('workspace_typecheck', 'pnpm typecheck');
  await pnpm('web_build', 'pnpm build');
  await run('review_draft_storage_regression', process.execPath, ['node_modules/vitest/vitest.mjs', 'run',
    'tests/review-draft-storage.test.ts', '--reporter=json', '--outputFile=review-draft-tests.json']);
  const draftTests = JSON.parse(await readFile(path.join(extracted, 'review-draft-tests.json'), 'utf8'));
  assert(draftTests.success && draftTests.numPassedTests === 5 && draftTests.numFailedTests === 0
    && draftTests.numPendingTests === 0, 'REVIEW_DRAFT_REGRESSION_INCOMPLETE');
  result.draftTests = {total: draftTests.numTotalTests, passed: draftTests.numPassedTests,
    skipped: draftTests.numPendingTests, failed: draftTests.numFailedTests};
  await run('management_and_read_recovery_regression', process.execPath, ['node_modules/vitest/vitest.mjs', 'run',
    'tests/api.test.ts', 'tests/web-api-read-timeout.test.ts',
    '--reporter=json', '--outputFile=management-read-tests.json']);
  const managementTests = JSON.parse(await readFile(path.join(extracted, 'management-read-tests.json'), 'utf8'));
  assert(managementTests.success && managementTests.numPassedTests > 0
    && managementTests.numPassedTests === managementTests.numTotalTests
    && managementTests.numFailedTests === 0 && managementTests.numPendingTests === 0,
    'MANAGEMENT_READ_REGRESSION_INCOMPLETE');
  result.managementTests = {total: managementTests.numTotalTests, passed: managementTests.numPassedTests,
    skipped: managementTests.numPendingTests, failed: managementTests.numFailedTests};
  await pnpm('personal_model_runtime_network_source_retention_and_probe_tests', 'pnpm exec vitest run tests/api-v2.test.ts tests/template-integrity.test.ts tests/runtime-catalog-v2.test.ts tests/isolated-network.test.ts tests/course-model-v2.test.ts tests/user-model-settings.test.ts tests/workspace-diagnostics.test.ts tests/workspace-lifecycle.test.ts tests/workspace-supervisor.test.ts tests/workspace-runtime.test.ts tests/backup-archive.test.ts tests/checker-v2.test.ts tests/source-verification.test.ts tests/course-retention-command.test.ts tests/workspace-migration-policy.test.ts tests/artifacts-v2.test.ts tests/probe-capture-v2.test.ts tests/filter-probe-v2.test.ts tests/probe-runner-v2.test.ts tests/output-transfer-v2.test.ts tests/evaluation-ledger.test.ts --reporter=json --outputFile=reproduction-tests.json');
  const tests = JSON.parse(await readFile(path.join(extracted, 'reproduction-tests.json'), 'utf8'));
  result.tests = {total: tests.numTotalTests, passed: tests.numPassedTests, skipped: tests.numPendingTests, failed: tests.numFailedTests};
  assert.equal(tests.success, true, 'REPRODUCTION_TEST_SUITE_FAILED');
  assert(tests.numTotalTests > 0 && tests.numPassedTests === tests.numTotalTests && tests.numPendingTests === 0,
    'REPRODUCTION_TESTS_INCOMPLETE');
  await run('publication_integrity_regression', process.execPath, ['node_modules/vitest/vitest.mjs', 'run',
    'tests/reports-v2.test.ts', '-t', 'rejects a damaged publication', '--reporter=json', '--outputFile=publication-integrity-tests.json']);
  const publicationTests = JSON.parse(await readFile(path.join(extracted, 'publication-integrity-tests.json'), 'utf8'));
  assert(publicationTests.success && publicationTests.numPassedTests === 2 && publicationTests.numFailedTests === 0,
    'PUBLICATION_REGRESSION_INCOMPLETE');
  result.publicationTests = {selectedPassed: publicationTests.numPassedTests, notSelected: publicationTests.numPendingTests,
    failed: publicationTests.numFailedTests};
  await run('lifecycle_budget_and_api_regression', process.execPath, ['node_modules/vitest/vitest.mjs', 'run',
    'tests/reports-v2.test.ts', 'tests/lifecycle-v2.test.ts', '-t',
    'preserves summary usage|accounts provider usage|compares explicit run pairs|validates explicit comparison HTTP|protects analysis HTTP writes|real SQL failure',
    '--reporter=json', '--outputFile=lifecycle-budget-api-tests.json']);
  const boundaryTests = JSON.parse(await readFile(path.join(extracted, 'lifecycle-budget-api-tests.json'), 'utf8'));
  assert(boundaryTests.success && boundaryTests.numPassedTests === 15 && boundaryTests.numFailedTests === 0,
    'LIFECYCLE_BUDGET_API_REGRESSION_INCOMPLETE');
  result.boundaryTests = {selectedPassed: boundaryTests.numPassedTests, notSelected: boundaryTests.numPendingTests,
    failed: boundaryTests.numFailedTests};
  await run('runner_replay_and_durability_regression', process.execPath, ['node_modules/vitest/vitest.mjs', 'run',
    'tests/runner-http-v2.test.ts', 'tests/runner-durability.test.ts',
    '--reporter=json', '--outputFile=runner-replay-tests.json']);
  const runnerTests = JSON.parse(await readFile(path.join(extracted, 'runner-replay-tests.json'), 'utf8'));
  assert(runnerTests.success && runnerTests.numPassedTests > 0 && runnerTests.numPassedTests === runnerTests.numTotalTests
    && runnerTests.numFailedTests === 0 && runnerTests.numPendingTests === 0, 'RUNNER_REPLAY_REGRESSION_INCOMPLETE');
  result.runnerTests = {total: runnerTests.numTotalTests, passed: runnerTests.numPassedTests,
    skipped: runnerTests.numPendingTests, failed: runnerTests.numFailedTests};
  await run('agent_checkpoint_order_regression', process.execPath, ['node_modules/vitest/vitest.mjs', 'run',
    'tests/reports-v2.test.ts', 'tests/worker-v2.test.ts', '-t',
    'persists LangGraph checkpoints|persists the parent checkpoint|integrates agent analysis|dispatches independent archived analysis',
    '--maxWorkers=1', '--no-file-parallelism', '--reporter=json', '--outputFile=checkpoint-order-tests.json']);
  const checkpointTests = JSON.parse(await readFile(path.join(extracted, 'checkpoint-order-tests.json'), 'utf8'));
  assert(checkpointTests.success && checkpointTests.numPassedTests === 10 && checkpointTests.numFailedTests === 0,
    'CHECKPOINT_ORDER_REGRESSION_INCOMPLETE');
  result.checkpointTests = {selectedPassed: checkpointTests.numPassedTests, notSelected: checkpointTests.numPendingTests,
    failed: checkpointTests.numFailedTests};
  await run('platform_readiness_regression', process.execPath, ['node_modules/vitest/vitest.mjs', 'run',
    'tests/session-write-order.test.ts', 'tests/coursework-api.test.ts', 'tests/task-experience-contract.test.ts',
    'tests/source-folder-archive.test.ts', 'tests/coursework-quality.test.ts', 'tests/coursework-queue-capacity.test.ts',
    'tests/coursework-review-packet.test.ts', 'tests/coursework-report-policy.test.ts', 'tests/coursework-live-guard.test.ts',
    '--reporter=json', '--outputFile=platform-readiness-tests.json']);
  const readinessTests = JSON.parse(await readFile(path.join(extracted, 'platform-readiness-tests.json'), 'utf8'));
  assert(readinessTests.success && readinessTests.numPassedTests > 0
    && readinessTests.numPassedTests === readinessTests.numTotalTests
    && readinessTests.numFailedTests === 0 && readinessTests.numPendingTests === 0,
    'PLATFORM_READINESS_REGRESSION_INCOMPLETE');
  result.readinessTests = {total: readinessTests.numTotalTests, passed: readinessTests.numPassedTests,
    skipped: readinessTests.numPendingTests, failed: readinessTests.numFailedTests};
  result.state = 'passed';
} catch (error) {
  result.state = 'failed';
  // Do not include arbitrary child command errors or inherited environment values.
  result.error = error instanceof Error ? error.name : 'REPRODUCTION_FAILED';
  process.exitCode = 1;
} finally {
  result.at = new Date().toISOString();
  const verificationFile = path.join(directory, 'verification.json');
  await writeFile(verificationFile, JSON.stringify(result, null, 2), {flag: 'wx'});
  console.log(JSON.stringify({state: result.state, directory, fileCount: result.fileCount,
    extracted: result.extracted, tests: result.tests, verificationFile}));
}
