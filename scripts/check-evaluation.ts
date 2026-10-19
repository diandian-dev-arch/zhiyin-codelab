import { lstat, readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { root } from '../apps/api/src/template.js';
import { validateEvaluationLedger } from './evaluation-ledger.js';

const args = process.argv.slice(2);
if (args.length < 1 || args.length > 2) throw new Error('Usage: pnpm evaluation:check <ledger-path> [registry-path]');
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
let totalBytes = 0;
async function readSafe(relative: string) {
  if (path.isAbsolute(relative) || relative.includes('\\') || relative.includes(':') || relative.split('/').some(p => !p || p === '.' || p === '..'))
    throw new Error('EVALUATION_PATH_INVALID');
  let target = root;
  const segments = relative.split('/');
  for (let i = 0; i < segments.length; i++) {
    target = path.join(target, segments[i]);
    const info = await lstat(target);
    if (info.isSymbolicLink() || (i < segments.length - 1 ? !info.isDirectory() : !info.isFile())) throw new Error('EVALUATION_PATH_UNSAFE');
    if (i === segments.length - 1 && (info.nlink !== 1 || info.size > 64 * 1024 ** 2)) throw new Error('EVALUATION_FILE_LIMIT');
  }
  const bytes = await readFile(target);
  totalBytes += bytes.length;
  if (bytes.length > 64 * 1024 ** 2 || totalBytes > 256 * 1024 ** 2) throw new Error('EVALUATION_TOTAL_LIMIT');
  return bytes;
}
try {
  const ledgerBytes = await readSafe(args[0]), registryBytes = await readSafe(args[1] ?? 'eval/development-registry.json');
  const result = validateEvaluationLedger(JSON.parse(ledgerBytes.toString()), JSON.parse(registryBytes.toString()));
  if (result.ledger.registrySha256 !== digest(registryBytes)) throw new Error('REGISTRY_SNAPSHOT_CHANGED');
  const verified = new Map<string, string>();
  async function verify(reference: { path: string; sha256: string }) {
    const actual = verified.get(reference.path) ?? digest(await readSafe(reference.path));
    if (actual !== reference.sha256) throw new Error('EVALUATION_ARTIFACT_CHANGED');
    verified.set(reference.path, actual);
  }
  await verify(result.ledger.protocol);
  for (const sample of result.registry.samples) await verify({ path: sample.archivePath, sha256: sample.originalZipSha256 });
  for (const trial of result.ledger.trials) {
    for (const reference of [trial.candidate, trial.teacherRevision, trial.publication, ...trial.evidence,
      trial.rating?.independentReview, trial.model?.configuration, trial.model?.pricing,
      ...(trial.model?.requests ?? []), ...(trial.model?.responses ?? [])]) if (reference) await verify(reference);
  }
  const operation = randomUUID(), destination = path.join(root, '.data/evaluation-audits', operation);
  await mkdir(destination, { recursive: true, mode: 0o700 });
  await writeFile(path.join(destination, 'ledger.json'), ledgerBytes, { flag: 'wx', mode: 0o600 });
  await writeFile(path.join(destination, 'registry.json'), registryBytes, { flag: 'wx', mode: 0o600 });
  const report = { ...result.summary, operation, verifiedFiles: verified.size,
    ledgerSha256: digest(ledgerBytes), registrySha256: digest(registryBytes), measuredAt: new Date().toISOString() };
  await writeFile(path.join(destination, 'result.json'), JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ state: report.state, verifiedFiles: verified.size,
    planned: result.ledger.plannedTrials.length, recorded: result.ledger.trials.length,
    qualityEvaluationCompleted: false, privateReport: path.relative(root, path.join(destination, 'result.json')) }));
} catch (error) {
  // No raw JSON/schema values: those can contain private teacher or model content.
  const code = error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'EVALUATION_VALIDATION_FAILED';
  console.error(JSON.stringify({ state: 'rejected', code }));
  process.exitCode = 1;
}
