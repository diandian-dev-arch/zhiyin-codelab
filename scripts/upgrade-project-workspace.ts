// Apply the additive project/task upgrade to the inspected local workspace.
// Back up first, preserve all pre-existing columns, and refuse active work.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync, spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdir, open, readFile, writeFile, stat} from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import {pipeline} from 'node:stream/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {migrate} from '../apps/api/src/db.js';
import {connectDesktopDatabase} from './desktop-database.js';
import {workspaceDatabaseTarget} from './workspace-database-target.js';

const resumeDirectory = process.argv[2] === '--resume-stopped' ? process.argv[3] : undefined;
const expectedParent = Number(process.argv[2]);
if (resumeDirectory) assert.match(resumeDirectory, /^\.data\/backups\/project-upgrade-[0-9TZ-]+$/);
else assert(Number.isSafeInteger(expectedParent) && expectedParent > 0, 'Specify the freshly inspected supervisor PID');
const root = process.cwd();
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const directory = resumeDirectory ?? `.data/backups/project-upgrade-${stamp}`;
const ps = (command: string) => {
  const output = execFileSync('powershell.exe', ['-NoProfile','-Command',command],
    {encoding:'utf8',windowsHide:true,timeout:10000}).trim();
  return output ? JSON.parse(output) : null;
};
const proc = (id: number) => ps(`Get-CimInstance Win32_Process -Filter 'ProcessId = ${id}' | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress`);
const listeners = () => ps('ConvertTo-Json -InputObject @(Get-NetTCPConnection -State Listen -LocalPort 3102,3103,5174 -ErrorAction SilentlyContinue | Select-Object LocalPort,OwningProcess) -Compress') ?? [];
const db = await connectDesktopDatabase();
let stopped = false;
let oldColumns: {table_name: string; columns: string[]}[] = [];
let before: Record<string, unknown> = {};
const receipt: Record<string, unknown> = {state:'preparing',directory,modelCallsStarted:0};
async function idle() {
  const row = (await db.query(`SELECT
    (SELECT count(*) FROM source_analyses WHERE status IN ('queued','running')) AS source,
    (SELECT count(*) FROM execution_attempts WHERE owner_phase<>'closed') AS executions,
    (SELECT count(*) FROM analysis_attempts WHERE status IN ('queued','running') OR owner_phase<>'closed') AS analyses,
    (SELECT count(*) FROM runs WHERE status IN ('queued','preparing','building','checking','analyzing')) AS runs`)).rows[0];
  assert(Object.values(row).every(n => Number(n) === 0), 'WORKSPACE_HAS_ACTIVE_WORK');
  return row;
}
async function snapshot() {
  const result: Record<string, unknown> = {};
  for (const {table_name,columns} of oldColumns) {
    for (const name of [table_name,...columns]) assert.match(name,/^[a-z_][a-z0-9_]*$/);
    const rows = (await db.query(`SELECT to_jsonb(t) AS value FROM (SELECT ${columns.map(n=>`"${n}"`).join(',')} FROM "${table_name}") t ORDER BY to_jsonb(t)::text COLLATE "C"`)).rows;
    result[table_name] = {count:rows.length,sha256:createHash('sha256').update(JSON.stringify(rows)).digest('hex')};
  }
  return result;
}
try {
  if (resumeDirectory) {
    assert.equal(listeners().length, 0, 'WORKSPACE_ALREADY_RUNNING');
    const saved = JSON.parse(await readFile(`${directory}/before.json`, 'utf8'));
    oldColumns = saved.oldColumns;
    before = saved.snapshot;
    assert.equal((await db.query('SELECT max(version)::int AS version FROM schema_migrations')).rows[0].version,18);
    receipt.idleBefore = await idle();
    assert.deepEqual(await snapshot(), before, 'DATA_CHANGED_DURING_PAUSE');
    stopped = true;
  } else {
  const ports = listeners();
  const childId = ports.find((p: any) => p.LocalPort === 5174)?.OwningProcess;
  assert.equal(ports.find((p: any) => p.LocalPort === 3103)?.OwningProcess, expectedParent, 'SUPERVISOR_CHANGED');
  assert(childId);
  assert.equal(proc(childId)?.ParentProcessId, expectedParent);
  assert.match(proc(expectedParent)?.CommandLine,/scripts[\\/]supervised-workspace\.ts/);
  assert.match(proc(childId)?.CommandLine,/scripts[\\/]workspace-v2\.ts/);
  assert.equal((await db.query('SELECT max(version)::int AS version FROM schema_migrations')).rows[0].version,18);
  receipt.idleBefore = await idle();
  oldColumns = (await db.query(`SELECT table_name,array_agg(column_name::text ORDER BY ordinal_position) AS columns FROM information_schema.columns
    WHERE table_schema='public' AND table_name NOT IN ('sessions','schema_migrations') GROUP BY table_name ORDER BY table_name`)).rows as typeof oldColumns;
  before = await snapshot();
  await mkdir(directory,{recursive:true});
  await writeFile(`${directory}/before.json`,JSON.stringify({oldColumns,snapshot:before},null,2),{flag:'wx'});
  await idle();
  // The owned child sees the IPC disconnection and performs its normal shutdown.
  process.kill(expectedParent, 'SIGKILL');
  stopped = true;
  const until = Date.now()+25000;
  while (proc(childId) && Date.now()<until) await delay(300);
  assert.equal(proc(childId),null,'WORKSPACE_DID_NOT_STOP');
  assert.equal(listeners().length,0);
  }
  const database = await workspaceDatabaseTarget(root);
  const dump = spawn('docker',['exec',database.name,'pg_dump','-U','postgres','-Fc','codelab'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  const exited = once(dump,'exit');
  dump.stderr.resume();
  await pipeline(dump.stdout,createWriteStream(`${directory}/database.dump`,{flags:'wx'}));
  assert.equal((await exited)[0],0,'DATABASE_BACKUP_FAILED');
  receipt.backupBytes = (await stat(`${directory}/database.dump`)).size;
  assert(Number(receipt.backupBytes)>0);
  assert.deepEqual(await snapshot(),before,'DATA_CHANGED_BEFORE_MIGRATION');
  receipt.migration = await migrate(db);
  assert.equal((await db.query('SELECT max(version)::int AS version FROM schema_migrations')).rows[0].version,20);
  assert.deepEqual(await snapshot(),before,'EXISTING_DATA_CHANGED');
  receipt.existingDataPreserved = true;
  receipt.state = 'passed';
} catch (error) {
  receipt.state = 'failed';
  receipt.error = error instanceof assert.AssertionError ? error.message : 'WORKSPACE_UPGRADE_FAILED';
  process.exitCode = 1;
} finally {
  if (stopped) {
    try {
      assert.equal(listeners().length,0);
      const out = await open('.data/business-v2/project-upgrade.stdout.log','a');
      const err = await open('.data/business-v2/project-upgrade.stderr.log','a');
      const current = (await db.query('SELECT max(version)::int AS version FROM schema_migrations')).rows[0].version;
      const child = spawn(process.execPath,['--import','tsx','--env-file-if-exists=.env','scripts/supervised-workspace.ts'],
        {cwd:root,windowsHide:true,detached:true,env:{...process.env,CODELAB_WORKSPACE_SCHEMA_PIN:String(current)},stdio:['ignore',out.fd,err.fd]});
      child.unref(); await out.close(); await err.close();
      receipt.newSupervisor = child.pid;
      const until = Date.now()+45000;
      let ready = false;
      while (Date.now()<until) {
        try {ready = (await fetch('http://127.0.0.1:5174/api/v1/health',{signal:AbortSignal.timeout(1500)})).ok;} catch {}
        if (ready) break;
        await delay(300);
      }
      assert(ready,'WORKSPACE_NOT_RESTORED');
      receipt.serviceRestored = true;
      assert.deepEqual(await snapshot(),before,'DATA_CHANGED_AFTER_RESTART');
      receipt.idleAfter = await idle();
    } catch {receipt.serviceRestored=false;receipt.state='failed';process.exitCode=1;}
  }
  await db.close();
  await mkdir(directory,{recursive:true});
  await writeFile(`${directory}/receipt.json`,JSON.stringify(receipt,null,2));
  console.log(JSON.stringify(receipt));
}
