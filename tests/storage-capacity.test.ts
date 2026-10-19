import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { capacityLevel, inspectDirectory } from '../scripts/storage-capacity';
const roots: string[] = [];
afterEach(async () => { for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function fixture() { const dir = await mkdtemp(path.join(tmpdir(), 'codelab-storage-')); roots.push(dir); return dir; }
it('classifies low free bytes and percentage independently', () => {
  const G = 1024 ** 3;
  expect(capacityLevel(100 * G, 50 * G)).toBe('ok');
  expect(capacityLevel(100 * G, 10 * G)).toBe('warning');
  expect(capacityLevel(1000 * G, 49 * G)).toBe('critical');
  expect(capacityLevel(3 * G, 2 * G)).toBe('critical');
  expect(() => capacityLevel(0, 0)).toThrow();
});
it('counts nested file metadata without including directory sizes', async () => {
  const dir = await fixture(); await mkdir(path.join(dir, 'nested'));
  await writeFile(path.join(dir, 'nested', 'a'), 'abc'); await writeFile(path.join(dir, 'b'), 'de');
  expect(await inspectDirectory(dir)).toMatchObject({ complete: true, files: 2, logicalBytes: 5 });
});
it('does not present a bounded partial scan as complete', async () => {
  const dir = await fixture(); await writeFile(path.join(dir, 'a'), 'a'); await writeFile(path.join(dir, 'b'), 'b');
  expect(await inspectDirectory(dir, 1)).toMatchObject({ complete: false, issues: ['ENTRY_LIMIT'] });
});
it('marks a missing directory unknown rather than empty healthy storage', async () => {
  const dir = await fixture();
  expect(await inspectDirectory(path.join(dir, 'missing'))).toMatchObject({ complete: false, files: 0 });
});
it('does not follow directory links to another store', async () => {
  const dir = await fixture(), other = await fixture(); await writeFile(path.join(other, 'private'), 'secret');
  await symlink(other, path.join(dir, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  expect(await inspectDirectory(dir)).toMatchObject({ complete: false, files: 0, logicalBytes: 0, skippedLinks: 1 });
});
