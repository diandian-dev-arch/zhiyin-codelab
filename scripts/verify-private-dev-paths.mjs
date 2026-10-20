import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

// Check status codes only; never decode or retain a private file response body.
const trial = JSON.parse(await readFile('.data/teacher-trial/status.json', 'utf8'));
const root = process.cwd().replaceAll('\\', '/');
const output = path.resolve('docs/verification/2026-10-19/teacher-trial', `private-paths-${randomUUID()}.json`);
const results = [];
const receipt = { scope: 'local-status-only-vite-file-boundary', passed: false, privateBodiesRead: false, results };
try {
  for (const origin of [new URL(trial.lanUrl).origin, 'http://127.0.0.1:5174']) {
    for (const [name, relative] of [
      ['trial-state', '.data/teacher-trial/status.json'],
      ['private-credentials', '.data/teacher-trial/private-credentials.json'],
      ['git-metadata', '.git/HEAD'],
      ['output-record', 'output/reproduction/caf78851-1d0d-4621-96d7-cbd692fed70d/result.json'],
      ['backend-source', 'apps/api/src/app.ts'],
    ]) {
      const response = await fetch(`${origin}/@fs/${root}/${relative}`, { signal: AbortSignal.timeout(5000) });
      await response.body?.cancel();
      results.push({ origin, pathClass: name, status: response.status });
      assert.equal(response.status, 403, `Private path was not rejected: ${name}`);
    }
    for (const [name, url] of [['frontend-entry', `${origin}/src/main-codelab.ts`], ['shared-contract', `${origin}/@fs/${root}/packages/contracts/src/coursework.ts`]]) {
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
      await response.body?.cancel();
      results.push({ origin, pathClass: name, status: response.status });
      assert.equal(response.status, 200, `Required frontend module rejected: ${name}`);
    }
  }
  receipt.passed = true;
} catch (error) {
  receipt.error = error instanceof assert.AssertionError ? error.message : 'PRIVATE_PATH_BOUNDARY_UNVERIFIED';
  process.exitCode = 1;
} finally {
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(receipt, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ passed: receipt.passed, checks: results.length, error: receipt.error, privateBodiesRead: false, evidence: path.relative(process.cwd(), output) }));
}
