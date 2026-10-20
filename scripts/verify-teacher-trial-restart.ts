import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { postgres, type DB } from '../apps/api/src/db.js';

const directory = path.resolve('.data/teacher-trial');
const statusPath = path.join(directory, 'status.json');
const secretsPath = path.join(directory, 'private-credentials.json');
const beforeStatus = JSON.parse(await readFile(statusPath, 'utf8'));
const secretBytes = await readFile(secretsPath);
const secrets = JSON.parse(secretBytes.toString('utf8'));
assert.equal(beforeStatus.workspace, 'teacher-trial');
assert.equal(beforeStatus.phase, 'ready');
assert.equal(beforeStatus.environmentId, secrets.environmentId);
const output = path.resolve('docs/verification/2026-10-19/teacher-trial', `restart-${randomUUID()}.json`);
const receipt: Record<string, any> = { startedAt: new Date().toISOString(), passed: false,
  environmentId: beforeStatus.environmentId, scope: 'owned-trial-graceful-stop-and-restart', externalModelCalls: 0, originalDatabaseAccess: false };
const exec = promisify(execFile);
let db: DB | undefined;
let stopped = false;
try {
  const info = JSON.parse((await exec('docker', ['inspect', beforeStatus.databaseContainerId], { windowsHide: true, timeout: 10000 })).stdout)[0];
  assert.equal(info.Config.Labels?.['codelab.teacher-trial'], beforeStatus.environmentId);
  const binding = info.NetworkSettings.Ports['5432/tcp'];
  assert.equal(binding.length, 1);
  assert.equal(binding[0].HostIp, '127.0.0.1');
  db = postgres(`postgres://postgres:${secrets.databasePassword}@127.0.0.1:${binding[0].HostPort}/teacher_trial`);
  const inventory = async () => db!.transaction(async tx => {
    await tx.exec("SET TRANSACTION READ ONLY; SET LOCAL statement_timeout='5s'");
    const tables = (await tx.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'sessions' ORDER BY tablename")).rows;
    const result: Record<string, { rows: number; sha256: string }> = {};
    for (const { tablename } of tables) {
      assert.match(tablename, /^[a-z_][a-z0-9_]*$/);
      const rows = (await tx.query(`SELECT row_to_json(t)::text AS value FROM public."${tablename}" t ORDER BY row_to_json(t)::text COLLATE "C"`)).rows;
      result[tablename] = { rows: rows.length, sha256: createHash('sha256').update(rows.map(row => row.value).join('\n')).digest('hex') };
    }
    return result;
  });
  const before = await inventory();
  const rejected = await fetch('http://127.0.0.1:3185/shutdown', { method: 'POST', headers: { Authorization: 'Bearer deliberately-wrong-test-token' }, signal: AbortSignal.timeout(3000) });
  assert.equal(rejected.status, 403);
  const rejectedOrigin = await fetch('http://127.0.0.1:3185/shutdown', { method: 'POST', headers: { Authorization: `Bearer ${secrets.controlToken}`, Origin: 'http://untrusted.example' }, signal: AbortSignal.timeout(3000) });
  assert.equal(rejectedOrigin.status, 403);
  receipt.controlProtection = true;
  await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', 'scripts/stop-teacher-trial.ps1'], { windowsHide: true, timeout: 35000 });
  stopped = true;
  assert.equal(JSON.parse(await readFile(statusPath, 'utf8')).phase, 'stopped');
  const originalHealth = await fetch('http://127.0.0.1:5174/api/v1/health', { signal: AbortSignal.timeout(5000) });
  assert.equal(originalHealth.status, 200);
  receipt.originalHealthDuringStop = 200;
  const launched = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', 'scripts/start-teacher-trial-background.ps1'], { windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024 });
  assert.equal(JSON.parse(launched.stdout.trim().split(/\r?\n/).at(-1)!).status, 'ready');
  stopped = false;
  const afterStatus = JSON.parse(await readFile(statusPath, 'utf8'));
  assert.equal(afterStatus.environmentId, beforeStatus.environmentId);
  assert.equal(afterStatus.databaseContainerId, beforeStatus.databaseContainerId);
  assert.deepEqual(afterStatus.fixture, beforeStatus.fixture);
  assert.notEqual(afterStatus.pid, beforeStatus.pid);
  assert.deepEqual(await inventory(), before);
  assert.deepEqual(await readFile(secretsPath), secretBytes);
  receipt.checkedTables = Object.keys(before).length;
  receipt.businessTablesUnchanged = true;
  receipt.credentialsUnchanged = true;
  receipt.oldPid = beforeStatus.pid;
  receipt.newPid = afterStatus.pid;
  receipt.passed = true;
} catch (error) {
  receipt.error = error instanceof assert.AssertionError ? error.message.slice(0, 160) : 'TRIAL_RESTART_UNVERIFIED';
  receipt.trialStillStopped = stopped;
  process.exitCode = 1;
} finally {
  await db?.close();
  receipt.finishedAt = new Date().toISOString();
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(receipt, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ passed: receipt.passed, checkedTables: receipt.checkedTables, error: receipt.error, trialStillStopped: receipt.trialStillStopped, evidence: path.relative(process.cwd(), output) }));
}
