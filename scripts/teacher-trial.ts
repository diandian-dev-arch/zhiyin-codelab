import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { createServer as createControlServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { networkInterfaces } from 'node:os';
import { isIPv4 } from 'node:net';
import path from 'node:path';
import { postgres, migrate } from '../apps/api/src/db.js';
import { createApp } from '../apps/api/src/app.js';
import { root } from '../apps/api/src/template.js';
import { createStorageAdmission } from '../apps/runner/src/storage-admission.js';
import { assertWorkspaceRuntime } from './workspace-runtime.js';
import { withWorkspaceStartup } from './workspace-startup.js';
import { initializeTeacherTrial } from './teacher-trial-fixtures.js';
import { parseTeacherTrialSecrets, type TrialSecrets } from './teacher-trial-config.js';
import { installWorkspaceLifecycle } from './workspace-lifecycle.js';

const directory = path.join(root, '.data/teacher-trial');
const containerName = 'codelab-teacher-trial-postgres';
const volumeName = 'codelab-teacher-trial-postgres';
const webPort = 5184, apiPort = 3184, controlPort = 3185;
const exec = promisify(execFile);
async function docker(args: string[], env = process.env) {
  try { return (await exec('docker', args, { windowsHide: true, timeout: 60000, env, maxBuffer: 2 * 1024 ** 2 })).stdout; }
  catch { throw new Error('TEACHER_TRIAL_DOCKER_FAILED'); }
}
const record = (value: object) => writeFile(path.join(directory, 'status.json'), JSON.stringify(value, null, 2), { mode: 0o600 });

async function main() {
  assertWorkspaceRuntime();
  assert.equal(process.argv.length, 2, 'TEACHER_TRIAL_ARGUMENT_INVALID');
  const lan = JSON.parse(await readFile(path.join(root, '.data/workspace-lan.json'), 'utf8'));
  assert(lan.enabled === true && typeof lan.address === 'string' && isIPv4(lan.address) && Object.values(networkInterfaces()).flat().some(n => n && n.address === lan.address && !n.internal), 'TEACHER_TRIAL_EXISTING_LAN_REQUIRED');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lifecycle = installWorkspaceLifecycle(directory);
  const context = JSON.parse(await docker(['context', 'inspect']))[0];
  assert(/^(?:npipe|unix):/.test(context.Endpoints?.docker?.Host ?? ''), 'TEACHER_TRIAL_LOCAL_DOCKER_REQUIRED');
  const existing = (await docker(['ps', '-aq', '--filter', `name=^/${containerName}$`])).trim();
  const volumes = (await docker(['volume', 'ls', '--format', '{{.Name}}'])).trim().split(/\r?\n/);
  const secretFile = path.join(directory, 'private-credentials.json');
  let secrets: TrialSecrets;
  try { secrets = parseTeacherTrialSecrets(JSON.parse(await readFile(secretFile, 'utf8'))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('TEACHER_TRIAL_CREDENTIALS_INVALID');
    assert(!existing && !volumes.includes(volumeName), 'TEACHER_TRIAL_EXISTING_DATA_WITHOUT_CREDENTIALS');
    secrets = {
      version: 1, environmentId: randomUUID(), databasePassword: randomBytes(32).toString('hex'), controlToken: randomBytes(32).toString('hex'),
      teacher: { email: 'teacher@trial.codelab.local', password: randomBytes(24).toString('base64url') },
      student: { email: 'student@trial.codelab.local', password: randomBytes(24).toString('base64url') },
    };
    await writeFile(secretFile, JSON.stringify(secrets, null, 2), { flag: 'wx', mode: 0o600 });
  }
  const environmentId = secrets.environmentId;
  const ownership = 'codelab.teacher-trial';
  const rootHash = createHash('sha256').update(path.resolve(root).toLowerCase()).digest('hex');
  let phase = 'starting';
  let shutdown: (() => Promise<void>) | undefined;
  const control = createControlServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('Cache-Control', 'no-store');
    if (request.url === '/status' && request.method === 'GET') {
      response.end(JSON.stringify({ workspace: 'teacher-trial', environmentId, pid: process.pid, phase }));
      return;
    }
    const supplied = createHash('sha256').update(request.headers.authorization ?? '').digest();
    const expected = createHash('sha256').update(`Bearer ${secrets.controlToken}`).digest();
    if (request.url !== '/shutdown' || request.method !== 'POST' || request.headers.origin || !timingSafeEqual(supplied, expected)) {
      response.writeHead(403).end(JSON.stringify({ error: 'TRIAL_CONTROL_FORBIDDEN' }));
      return;
    }
    if (!shutdown) { response.writeHead(409).end(JSON.stringify({ error: 'TRIAL_STARTING' })); return; }
    response.end(JSON.stringify({ stopping: true }));
    void shutdown();
  });
  await withWorkspaceStartup(async acquired => {
    await new Promise<void>((resolve, reject) => { control.once('error', reject); control.listen(controlPort, '127.0.0.1', resolve); });
    acquired('control', () => new Promise<void>(resolve => control.close(() => resolve())));
    if (!volumes.includes(volumeName)) await docker(['volume', 'create', '--label', `${ownership}=${environmentId}`, '--label', `codelab.teacher-trial-root=${rootHash}`, volumeName]);
    const volume = JSON.parse(await docker(['volume', 'inspect', volumeName]))[0];
    assert.equal(volume.Labels?.[ownership], environmentId, 'TEACHER_TRIAL_VOLUME_NOT_OWNED');
    assert.equal(volume.Labels?.['codelab.teacher-trial-root'], rootHash, 'TEACHER_TRIAL_VOLUME_ROOT_MISMATCH');
    if (!existing) {
      await docker(['run', '-d', '--pull=never', '--name', containerName, '--label', `${ownership}=${environmentId}`,
        '--label', `codelab.teacher-trial-root=${rootHash}`, '--restart', 'unless-stopped', '--memory', '384m', '--cpus', '1', '--pids-limit', '128',
        '--publish', '127.0.0.1::5432', '--mount', `type=volume,source=${volumeName},target=/var/lib/postgresql/data`,
        '--env', 'POSTGRES_PASSWORD', '--env', 'POSTGRES_DB=teacher_trial', 'postgres:17-alpine'],
      { ...process.env, POSTGRES_PASSWORD: secrets.databasePassword });
    }
    let info = JSON.parse(await docker(['inspect', containerName]))[0];
    assert.equal(info.Config.Labels?.[ownership], environmentId, 'TEACHER_TRIAL_DATABASE_NOT_OWNED');
    assert.equal(info.Config.Labels?.['codelab.teacher-trial-root'], rootHash, 'TEACHER_TRIAL_DATABASE_ROOT_MISMATCH');
    assert(info.Mounts.some((m: any) => m.Type === 'volume' && m.Name === volumeName && m.Destination === '/var/lib/postgresql/data'), 'TEACHER_TRIAL_VOLUME_MISMATCH');
    if (!info.State.Running) { await docker(['start', info.Id]); info = JSON.parse(await docker(['inspect', info.Id]))[0]; }
    const bindings = info.NetworkSettings.Ports['5432/tcp'];
    assert(bindings?.length === 1 && bindings[0].HostIp === '127.0.0.1', 'TEACHER_TRIAL_DATABASE_MUST_BE_LOOPBACK');
    const db = postgres(`postgres://postgres:${secrets.databasePassword}@127.0.0.1:${bindings[0].HostPort}/teacher_trial`);
    acquired('database', () => db.close());
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      try { assert.equal((await db.query('SELECT current_database() AS name')).rows[0].name, 'teacher_trial'); ready = true; break; }
      catch { await new Promise(resolve => setTimeout(resolve, 250)); }
    }
    assert(ready, 'TEACHER_TRIAL_DATABASE_NOT_READY');
    await migrate(db);
    const fixture = await initializeTeacherTrial(db, { teacher: secrets.teacher, student: secrets.student });
    const app = await createApp(db, {
      teacherTrial: true, sessionCookieName: 'codelab_teacher_trial_sid',
      origin: `http://127.0.0.1:${webPort}`, additionalOrigins: [`http://${lan.address}:${webPort}`],
      secure: false, executionApproved: false, businessVersion: 2,
      model: 'disabled-teacher-trial', image: 'disabled-teacher-trial', packs: [],
      coursework: { enabled: true, background: false }, storageAdmission: createStorageAdmission(directory),
    });
    acquired('api', () => app.close());
    await app.listen({ host: '127.0.0.1', port: apiPort });
    const webRequire = createRequire(path.join(root, 'apps/web/package.json'));
    const { createServer } = await import(pathToFileURL(webRequire.resolve('vite')).href);
    const envDirectory = path.join(directory, 'frontend-env');
    await mkdir(envDirectory, { recursive: true });
    const web = await createServer({ root: path.join(root, 'apps/web'), envDir: envDirectory,
      server: { host: lan.address, port: webPort, strictPort: true, proxy: { '/api': `http://127.0.0.1:${apiPort}` } },
      plugins: [{ name: 'teacher-trial-title', transformIndexHtml: (html: string) => html.replace('<title>CodeLab · 智能代码实验平台</title>', '<title>知因 CodeLab · 教师试用</title>') }],
    });
    acquired('web', () => web.close());
    await web.listen();
    phase = 'ready';
    lifecycle('ready');
    const status = { workspace: 'teacher-trial', phase, environmentId, pid: process.pid,
      databaseContainerId: info.Id, databaseVolume: volumeName, databaseName: 'teacher_trial',
      lanUrl: `http://${lan.address}:${webPort}/assignments`, localApiUrl: `http://127.0.0.1:${apiPort}`,
      controlUrl: `http://127.0.0.1:${controlPort}`, cookieName: 'codelab_teacher_trial_sid',
      modelsEnabled: false, codeExecutionEnabled: false, fixture, startedAt: new Date().toISOString() };
    await record(status);
    let stopping: Promise<void> | undefined;
    shutdown = () => stopping ??= (async () => {
      phase = 'stopping';
      for (const [name, close] of [['web', () => web.close()], ['api', () => app.close()], ['database', () => db.close()]] as const) {
        try { await close(); } catch { console.error(JSON.stringify({ code: 'TEACHER_TRIAL_CLOSE_FAILED', stage: name })); }
      }
      await new Promise<void>(resolve => control.close(() => resolve()));
      phase = 'stopped';
      await record({ ...status, phase, stoppedAt: new Date().toISOString() });
    })();
    process.once('SIGINT', () => { void shutdown?.(); });
    process.once('SIGTERM', () => { void shutdown?.(); });
    console.log(JSON.stringify({ workspace: 'teacher-trial', phase, lanUrl: status.lanUrl, credentialsFile: path.relative(root, secretFile), modelsEnabled: false, codeExecutionEnabled: false }));
  }, stage => console.error(JSON.stringify({ code: 'TEACHER_TRIAL_ROLLBACK_CLOSE_FAILED', stage })));
}
main().catch(error => {
  const message = error instanceof Error ? error.message : '';
  const code = /^TEACHER_TRIAL_[A-Z_]+$/.test(message) ? message : 'TEACHER_TRIAL_START_FAILED';
  console.error(JSON.stringify({ code, originalWorkspaceChanged: false, privateLogs: '.data/teacher-trial' }));
  process.exitCode = 1;
});
