import { lstat, readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { randomBytes, createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
import { zipSync, unzipSync } from 'fflate';
import { root } from '../apps/api/src/template.js';

const configPath = '.env.pocketbay';
const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const excluded = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', 'test-results', 'playwright-report', 'artifacts']);
export function deployablePath(relative: string) {
  return /^[a-zA-Z0-9_.\-/]+$/.test(relative) && !relative.split('/').some(part => part.startsWith('.') || excluded.has(part)) &&
    !/\.(?:log|sql|dump|pem|key|crt|pfx|p12|zip|tgz|tsbuildinfo)$/i.test(relative) &&
    !/(?:credentials|secret|token)\.(?:json|txt)$/i.test(relative);
}

export async function prepareOnlineCredentials(directory = root) {
  const filename = path.join(directory, configPath);
  try {
    const info = await lstat(filename);
    assert(info.isFile() && !info.isSymbolicLink() && info.nlink === 1, 'ONLINE_CONFIG_UNSAFE');
    const content = await readFile(filename, 'utf8');
    assert(/^CODELAB_BOOTSTRAP_EMAIL=owner@codelab\.online\nCODELAB_BOOTSTRAP_PASSWORD=[A-Za-z0-9_-]{32,128}\n$/.test(content), 'ONLINE_CONFIG_UNEXPECTED');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await writeFile(filename, `CODELAB_BOOTSTRAP_EMAIL=owner@codelab.online\nCODELAB_BOOTSTRAP_PASSWORD=${randomBytes(32).toString('base64url')}\n`, { flag: 'wx', mode: 0o600 });
  }
  const bytes = await readFile(filename);
  return { path: configPath, size: bytes.length, sha256: hash(bytes), sensitive: true, usage_phase: 'runtime', upload_mode: 'package' };
}

export async function packageOnline(slug: string, approved: string[], approvedConfigHash: string) {
  assert(/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug), 'ONLINE_SLUG_INVALID');
  assert(approved.length === 1 && approved[0] === configPath, 'ONLINE_CONFIG_APPROVAL_REQUIRED');
  const config = await prepareOnlineCredentials();
  assert(/^[a-f0-9]{64}$/.test(approvedConfigHash) && config.sha256 === approvedConfigHash, 'ONLINE_APPROVED_CONFIG_CHANGED');
  const files: Record<string, Uint8Array> = {};
  let sourceBytes = 0;
  async function add(relative: string) {
    const filename = path.join(root, relative), info = await lstat(filename);
    assert(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size <= 20 * 1024 ** 2, 'ONLINE_SOURCE_FILE_UNSAFE');
    const bytes = await readFile(filename);
    sourceBytes += bytes.length;
    assert(sourceBytes <= 80 * 1024 ** 2 && Object.keys(files).length < 10000, 'ONLINE_PACKAGE_LIMIT');
    files[relative] = bytes;
  }
  async function walk(relative: string) {
    assert(!(await lstat(path.join(root, relative))).isSymbolicLink(), 'ONLINE_SOURCE_DIRECTORY_LINK');
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
      const child = `${relative}/${entry.name}`;
      if (!deployablePath(child)) continue;
      if (entry.isDirectory()) await walk(child); else await add(child);
    }
  }
  for (const relative of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json']) await add(relative);
  for (const relative of ['apps', 'packages', 'scripts', 'templates']) await walk(relative);
  const manifest = JSON.parse(Buffer.from(files['package.json']).toString('utf8'));
  manifest.scripts.start += ` --origin=https://${slug}.pocketbay.app`;
  files['package.json'] = Buffer.from(JSON.stringify(manifest, null, 2));
  await add(configPath);
  assert(hash(files[configPath]) === config.sha256, 'ONLINE_CONFIG_CHANGED_DURING_PACKAGING');
  const archive = zipSync(files, { level: 6 });
  const unpacked = unzipSync(archive);
  assert.deepEqual(Object.keys(unpacked).sort(), Object.keys(files).sort());
  for (const [name, bytes] of Object.entries(files)) assert.equal(hash(unpacked[name]), hash(bytes), 'ONLINE_ARCHIVE_ROUNDTRIP_FAILED');
  const directory = path.join(root, '.data/pocketbay', randomUUID());
  await mkdir(directory, { recursive: true });
  const filename = path.join(directory, 'codelab-online.zip');
  await writeFile(filename, archive, { flag: 'wx', mode: 0o600 });
  const receipt = { sha256: hash(archive), bytes: archive.length, fileCount: Object.keys(files).length, origin: `https://${slug}.pocketbay.app`,
    configPaths: approved, localHistoryIncluded: false, originalModelKeysIncluded: false,
    files: Object.keys(files).sort().map(name => ({ path: name, sha256: hash(files[name]) })) };
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(receipt, null, 2), { flag: 'wx' });
  return { filename, manifest: path.join(directory, 'manifest.json'), sha256: receipt.sha256, bytes: archive.length, fileCount: receipt.fileCount };
}
