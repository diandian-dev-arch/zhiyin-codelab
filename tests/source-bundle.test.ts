import { afterEach, expect, it } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { tmpdir } from 'node:os';
const exec = promisify(execFile), directories: string[] = [];
const verifier = path.resolve('scripts/verify-source-bundle.mjs');
afterEach(async () => { for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function fixture(file = 'sample.txt') {
  const directory = await mkdtemp(path.join(tmpdir(), 'codelab-source-check-')); directories.push(directory);
  await writeFile(path.join(directory, 'sample.txt'), 'abc');
  await writeFile(path.join(directory, 'SOURCE_MANIFEST.json'), JSON.stringify({ version: 1,
    files: [{ path: file, bytes: 3, sha256: createHash('sha256').update('abc').digest('hex') }] }));
  return directory;
}
it('verifies a source snapshot before dependency installation', async () => {
  const cwd = await fixture();
  const result = await exec(process.execPath, [verifier], { cwd, windowsHide: true });
  expect(JSON.parse(result.stdout)).toMatchObject({ state: 'passed', verifiedFiles: 1 });
});
it('rejects changed content even when byte length stays equal', async () => {
  const cwd = await fixture(); await writeFile(path.join(cwd, 'sample.txt'), 'xyz');
  await expect(exec(process.execPath, [verifier], { cwd, windowsHide: true })).rejects.toMatchObject({ code: 1 });
});
it.each(['../sample.txt', '/sample.txt', 'a//sample.txt'])('rejects an invalid manifest path %s', async file => {
  const cwd = await fixture(file);
  await expect(exec(process.execPath, [verifier], { cwd, windowsHide: true })).rejects.toMatchObject({ code: 1 });
});
