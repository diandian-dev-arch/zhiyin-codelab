import { afterEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { root } from '../apps/api/src/template';
const exec = promisify(execFile), temporary: string[] = [];
afterEach(async () => { for (const directory of temporary.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function check(change: (ledger: any) => void) {
  await mkdir(path.join(root, '.data'), { recursive: true });
  const directory = await mkdtemp(path.join(root, '.data/evaluation-cli-test-')); temporary.push(directory);
  const ledger = JSON.parse(await readFile(path.join(root, 'eval/empty-ledger.json'), 'utf8'));
  change(ledger);
  const file = path.join(directory, 'ledger.json'); await writeFile(file, JSON.stringify(ledger));
  try {
    await exec(process.execPath, ['--import', 'tsx', 'scripts/check-evaluation.ts', path.relative(root, file).replaceAll('\\', '/')],
      { cwd: root, windowsHide: true, timeout: 10000 });
    throw new Error('Unexpected accepted ledger');
  } catch (error: any) {
    expect(error.code).toBe(1);
    expect(error.stdout).toBe('');
    return JSON.parse(error.stderr.trim());
  }
}
it('rejects changed registry snapshots before accepting evidence', async () => {
  expect(await check(ledger => { ledger.registrySha256 = 'b'.repeat(64); }))
    .toEqual({ state: 'rejected', code: 'REGISTRY_SNAPSHOT_CHANGED' });
});
it('rejects an artifact whose on-disk bytes do not match its declared digest', async () => {
  expect(await check(ledger => { ledger.protocol.sha256 = 'b'.repeat(64); }))
    .toEqual({ state: 'rejected', code: 'EVALUATION_ARTIFACT_CHANGED' });
});
it('rejects traversal without printing private artifact paths', async () => {
  expect(await check(ledger => { ledger.protocol.path = '../sensitive-private-material'; }))
    .toEqual({ state: 'rejected', code: 'EVALUATION_PATH_INVALID' });
});
