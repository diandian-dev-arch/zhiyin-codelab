import { afterEach, expect, it } from 'vitest';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const exec = promisify(execFile), directories: string[] = [];
const script = path.resolve('scripts/register-evaluation.ts');
const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function fixture() {
  const cwd = await mkdtemp(path.join(tmpdir(), 'codelab-registry-')); directories.push(cwd);
  await cp(path.resolve('fixtures'), path.join(cwd, 'fixtures'), { recursive: true });
  await mkdir(path.join(cwd, 'eval'));
  const registry = path.join(cwd, 'eval/development-registry.json');
  await cp(path.resolve('eval/development-registry.json'), registry);
  return { cwd, registry };
}
it('checks all registered samples without changing bytes pinned by existing ledgers', async () => {
  const { cwd, registry } = await fixture();
  const before = await readFile(registry);
  const result = await exec(process.execPath, ['--import', tsx, script, '--check'], { cwd, windowsHide: true });
  expect(result.stdout).toContain('只读核验完成：11 份 ZIP');
  expect(await readFile(registry)).toEqual(before);
});
it('rejects altered sample bytes without rewriting the registry', async () => {
  const { cwd, registry } = await fixture(), before = await readFile(registry);
  await writeFile(path.join(cwd, 'fixtures/correct.zip'), 'changed');
  await expect(exec(process.execPath, ['--import', tsx, script, '--check'], { cwd, windowsHide: true })).rejects.toMatchObject({ code: 1 });
  expect(await readFile(registry)).toEqual(before);
});
it('rejects changed family metadata rather than accepting a matching ZIP alone', async () => {
  const { cwd, registry } = await fixture();
  const saved = JSON.parse(await readFile(registry, 'utf8'));
  saved.samples[0].familyId = 'wrong-family';
  await writeFile(registry, JSON.stringify(saved));
  const before = await readFile(registry);
  await expect(exec(process.execPath, ['--import', tsx, script, '--check'], { cwd, windowsHide: true })).rejects.toMatchObject({ code: 1 });
  expect(await readFile(registry)).toEqual(before);
});
