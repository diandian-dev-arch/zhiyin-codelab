// Restore a hash-pinned pg_dumpall to a NEW labelled database. Never overwrite
// the active container or delete failed restore evidence. No credentials printed.
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID, createHash, randomBytes } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { postgres } from '../apps/api/src/db.js';

const [input, expectedHash] = process.argv.slice(2);
if (!input || !/^[a-f0-9]{64}$/.test(expectedHash ?? '') || process.argv.length !== 4)
  throw new Error('EXPECTED_DUMP_PATH_AND_SHA256');
const bytes = await readFile(input);
if (createHash('sha256').update(bytes).digest('hex') !== expectedHash)
  throw new Error('RESTORE_INPUT_HASH_MISMATCH');
const id = randomUUID();
const name = `codelab-recovered-${id}`;
const directory = path.resolve('.data/takeover-recovery', id);
await mkdir(directory, { recursive: true });
// Preserve the original privately before touching Docker; do not rely on a chat cache.
await writeFile(path.join(directory, 'original.sql'), bytes, { flag: 'wx', mode: 0o600 });
const exec = promisify(execFile);
async function docker(args: string[], env = process.env) {
  try { return (await exec('docker', args, { env, windowsHide: true, timeout: 120_000, maxBuffer: 2*1024*1024 })).stdout; }
  catch { throw new Error('RECOVERY_DOCKER_FAILED'); }
}
const result: Record<string, unknown> = { id, name, dumpSha256: expectedHash, state: 'preparing', existingDatabaseUnchanged: true };
try {
  await docker(['run', '-d', '--name', name, '--label', 'codelab.workspace=v2',
    '--label', `codelab.recovery=${id}`, '--memory', '512m', '--cpus', '1',
    '--publish', '127.0.0.1::5432', '--mount', `type=volume,source=${name},target=/var/lib/postgresql/data`,
    '--env', 'POSTGRES_USER=codelab_restore_bootstrap', '--env', 'POSTGRES_PASSWORD',
    'postgres:17-alpine'], { ...process.env, POSTGRES_PASSWORD: randomBytes(32).toString('hex') });
  let ready = false;
  for (let i=0;i<40;i++) {
    try { await docker(['exec', name, 'pg_isready', '-U', 'codelab_restore_bootstrap']); ready = true; break; }
    catch { await delay(500); }
  }
  if (!ready) throw new Error('RECOVERY_DATABASE_NOT_READY');
  await new Promise<void>((resolve,reject) => {
    const child = spawn('docker', ['exec','-i',name,'psql','-X','-v','ON_ERROR_STOP=1','-U','codelab_restore_bootstrap','-d','postgres'],
      { windowsHide: true, stdio: ['pipe','ignore','pipe'] });
    child.stderr.resume(); // SQL error text can include secrets or private rows.
    const timer = setTimeout(() => { child.kill(); reject(new Error('RECOVERY_RESTORE_TIMEOUT')); }, 120_000);
    child.on('error', () => { clearTimeout(timer); reject(new Error('RECOVERY_SPAWN_FAILED')); });
    child.stdin.on('error', () => {}); // exit status remains authoritative on EPIPE.
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('RECOVERY_SQL_RESTORE_FAILED')); });
    child.stdin.end(bytes);
  });
  const info = JSON.parse(await docker(['inspect',name]))[0];
  const binding = info.NetworkSettings.Ports['5432/tcp'][0];
  if (binding.HostIp !== '127.0.0.1') throw new Error('RECOVERY_NOT_LOOPBACK');
  const credentials = JSON.parse(await readFile('.data/business-v2/development-credentials.json','utf8'));
  const db = postgres(`postgres://postgres:${encodeURIComponent(credentials.databasePassword)}@127.0.0.1:${binding.HostPort}/codelab`);
  try {
    const inventory: Record<string,number> = {};
    for (const table of ['users','tasks','runs','source_projects','source_analyses','user_model_settings'])
      inventory[table] = Number((await db.query(`SELECT count(*) AS count FROM ${table}`)).rows[0].count);
    const museum = (await db.query('SELECT id FROM source_projects WHERE id=$1',['4c99747f-d6b8-4839-b992-202f0d3a7c4f'])).rows.length === 1;
    if (!museum || !inventory.source_analyses) throw new Error('RECOVERY_EXPECTED_HISTORY_MISSING');
    Object.assign(result, { state:'restored-history-verified', inventory, museumProjectPresent: museum,
      originalDatabaseCredentialsVerified: true, port: Number(binding.HostPort),
      limitations: 'Not yet switched into the workspace; evidence files, model vault and HTTP still require verification.' });
  } finally { await db.close(); }
} catch (error) {
  result.state = 'failed-retained-for-inspection';
  result.code = error instanceof Error && /^RECOVERY_[A-Z_]+$/.test(error.message) ? error.message : 'RECOVERY_CHECK_FAILED';
  process.exitCode = 1;
} finally {
  await writeFile(path.join(directory,'result.json'),JSON.stringify(result,null,2),{flag:'wx',mode:0o600});
  console.log(JSON.stringify(result));
}
