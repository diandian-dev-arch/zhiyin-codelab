import { readFile, readdir, lstat, mkdir, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { zipSync, unzipSync } from 'fflate';
import { root } from '../apps/api/src/template.js';

const rootFiles = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json', 'vitest.config.ts',
  'playwright.config.ts', 'playwright.v2.config.ts', 'playwright.review-recovery.config.ts', 'playwright.review-write.config.ts', 'playwright.login.config.ts', 'playwright.source.config.ts', 'playwright.source-flow.config.ts', '.dockerignore', '.gitignore', '.env.example',
  'README.md', 'THIRD_PARTY_NOTICES.md', 'docs/REPRODUCE.md', 'docs/MODEL_SETUP.md', 'docs/EVALUATION.md',
  'docs/CURRENT_PLATFORM_STATUS.md', 'docs/TEACHER_TRIAL_READINESS.md',
  'docs/QUICKSTART.md', 'docs/DEPLOYMENT.md', 'docs/DATA_RETENTION.md', 'docs/EVALUATION_RECORDS.md', 'docs/IMPLEMENTATION_STATUS.md',
  'docs/PERSONAL_MODEL_DESIGN.md', 'docs/PERSONAL_MODEL_GUIDE.md', 'docs/COURSE_RETENTION_OPERATIONS.md',
  'docs/ACCEPTANCE_AUDIT.md', 'docs/DEMO_SCRIPT.md', 'docs/SUBMISSION_DELIVERABLES.md', 'docs/engineering/DEVELOPMENT_SAMPLES.md',
  'docs/engineering/CONTRACTS_V1.md', 'docs/engineering/IMPLEMENTATION_PLAN_V1.md', 'docs/engineering/FRONTEND-REPAIR-ACCEPTANCE.md',
  'docs/engineering/RUNNER_DURABILITY_V2.md', 'docs/engineering/SOURCE_PROJECT_ANALYSIS_V1.md', 'docs/engineering/SOURCE_ANALYSIS_MODES.md', 'docs/engineering/AGENT_STUDIO_V1.md'];
const sourceRoots = ['apps', 'packages', 'deploy', 'scripts', 'tests', 'templates', 'fixtures', 'eval'];
const excluded = new Set(['node_modules', 'dist', 'coverage', 'test-results', 'playwright-report', 'artifacts']);
const files: Record<string, Uint8Array> = {};
for (const file of await readdir(root)) {
  if (/^playwright(?:\.[a-z0-9-]+)*\.config\.ts$/.test(file) && !rootFiles.includes(file)) rootFiles.push(file);
}
let total = 0;
async function add(relative: string) {
  if (!/^[a-zA-Z0-9_.\-/]+$/.test(relative) || relative.split('/').some(p => p === '..')) throw new Error('BUNDLE_PATH_INVALID');
  const filename = path.join(root, relative), info = await lstat(filename);
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1 || info.size > 20 * 1024 ** 2) throw new Error('BUNDLE_FILE_UNSAFE');
  const bytes = await readFile(filename);
  total += bytes.length;
  if (total > 80 * 1024 ** 2 || Object.keys(files).length >= 10000) throw new Error('BUNDLE_LIMIT');
  files[relative] = bytes;
}
async function walk(relative: string) {
  if ((await lstat(path.join(root, relative))).isSymbolicLink()) throw new Error('BUNDLE_DIRECTORY_LINK');
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    if (entry.name.startsWith('.') || excluded.has(entry.name) || entry.name.endsWith('.tsbuildinfo')) continue;
    const child = `${relative}/${entry.name}`;
    if (entry.isDirectory()) await walk(child);
    else await add(child);
  }
}
for (const relative of rootFiles) await add(relative);
for (const relative of sourceRoots) await walk(relative);
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const manifest = { version: 1, createdAt: new Date().toISOString(), source: 'local-working-tree-snapshot',
  independentReproductionCompleted: false,
  excluded: ['.env', '.data', '.git', 'node_modules', 'output', 'runtime databases, credentials and private evidence'],
  files: Object.keys(files).sort().map(file => ({ path: file, bytes: files[file].length, sha256: digest(files[file]) })) };
files['SOURCE_MANIFEST.json'] = Buffer.from(JSON.stringify(manifest, null, 2));
const archive = zipSync(files, { level: 6 });
// Verify the actual archive contents, not merely the pre-compression file map.
const unpacked = unzipSync(archive);
if (Object.keys(unpacked).length !== manifest.files.length + 1) throw new Error('BUNDLE_ENTRY_COUNT');
for (const entry of manifest.files) {
  if (unpacked[entry.path]?.length !== entry.bytes || digest(unpacked[entry.path]) !== entry.sha256)
    throw new Error('BUNDLE_ROUNDTRIP_FAILED');
}
const directory = path.join(root, 'output/reproduction', randomUUID());
await mkdir(directory, { recursive: true });
await writeFile(path.join(directory, 'codelab-source.zip'), archive, { flag: 'wx' });
const result = { state: 'packaged_and_roundtrip_verified', sha256: digest(archive), archiveBytes: archive.length,
  sourceBytes: total, fileCount: manifest.files.length, independentReproductionCompleted: false,
  limitation: 'Source snapshot excludes private runtime data; no images or installed dependencies are bundled' };
await writeFile(path.join(directory, 'result.json'), JSON.stringify(result, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ ...result, directory: path.relative(root, directory) }));
