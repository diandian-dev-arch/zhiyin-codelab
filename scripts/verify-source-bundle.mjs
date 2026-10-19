import { readFile, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

// Run from the extracted package root; requires Node only, before pnpm install.
const root = process.cwd();
const manifest = JSON.parse(await readFile(path.join(root, 'SOURCE_MANIFEST.json'), 'utf8'));
if (manifest.version !== 1 || !Array.isArray(manifest.files) || manifest.files.length > 10000)
  throw new Error('INVALID_SOURCE_MANIFEST');
const seen = new Set();
for (const entry of manifest.files) {
  if (typeof entry.path !== 'string' || !/^[a-zA-Z0-9_.\-/]+$/.test(entry.path)
    || entry.path.split('/').some(p => !p || p === '.' || p === '..') || entry.path.startsWith('/')
    || seen.has(entry.path) || !/^[a-f0-9]{64}$/.test(entry.sha256)
    || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > 20 * 1024 ** 2)
    throw new Error('INVALID_SOURCE_ENTRY');
  seen.add(entry.path);
  let current = root;
  for (const part of entry.path.split('/')) {
    current = path.join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new Error('SOURCE_LINK_REJECTED');
  }
  const info = await lstat(current);
  if (!info.isFile() || info.size !== entry.bytes) throw new Error('SOURCE_SIZE_MISMATCH');
  const hash = createHash('sha256').update(await readFile(current)).digest('hex');
  if (hash !== entry.sha256) throw new Error(`SOURCE_HASH_MISMATCH:${entry.path}`);
}
console.log(JSON.stringify({ state: 'passed', verifiedFiles: seen.size, source: 'local-working-tree-snapshot',
  limitation: 'Integrity check only; does not prove independent reproduction or authenticity without the separately supplied archive hash' }));
