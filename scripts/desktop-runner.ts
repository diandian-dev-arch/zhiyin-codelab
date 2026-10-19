import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { root } from '../apps/api/src/template.js';

const exec = promisify(execFile);
const directory = path.join(root, '.data', 'desktop-runner');
const container = 'codelab-desktop-control';
const volume = 'codelab-desktop-runner-v2';
const label = 'codelab.desktop-control';
const port = 13200;
const docker = (args: string[]) => exec('docker', args, { windowsHide: true, timeout: 30000, maxBuffer: 1024*1024 });
const mode = process.argv[2] ?? 'up';
async function inspect(kind: 'container'|'volume', name: string): Promise<any|null> {
  try { return JSON.parse((await docker([kind,'inspect',name])).stdout)[0]; }
  catch(error) {
    if (/No such (?:object|container|volume)/i.test(String((error as {stderr?: string}).stderr))) return null;
    throw error;
  }
}
async function main() {
  const info = JSON.parse((await docker(['info','--format','{{json .}}'])).stdout);
  if (info.OSType !== 'linux' || !['x86_64','amd64'].includes(info.Architecture)) throw new Error('LINUX_AMD64_DOCKER_REQUIRED');
  await mkdir(directory, { recursive: true });
  let credential: { token: string; url: string };
  try { credential = JSON.parse(await readFile(path.join(directory,'credentials.json'),'utf8')); }
  catch(error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    credential = { token: randomBytes(32).toString('hex'), url: `http://127.0.0.1:${port}` };
    await writeFile(path.join(directory,'credentials.json'), JSON.stringify(credential), { flag: 'wx', mode: 0o600 });
  }
  const headers = { authorization: `Bearer ${credential.token}` };
  const api = async (route: string) => {
    const response = await fetch(credential.url + route, { headers, signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`RUNNER_HTTP_${response.status}`);
    return response.json();
  };
  const existing = await inspect('container',container);
  if (existing && existing.Config?.Labels?.[label] !== 'v2') throw new Error('CONTROL_NAME_OCCUPIED');
  if (mode === 'status') {
    console.log(JSON.stringify({ containerRunning: existing?.State?.Running ?? false,
      ...(existing?.State?.Running ? { capabilities: await api('/v2/capabilities') } : {}) },null,2));
    return;
  }
  if (!['up','recreate'].includes(mode)) throw new Error('EXPECTED_UP_STATUS_OR_RECREATE');
  if (existing && mode === 'recreate') {
    if (existing.State.Running) {
      const readiness = await api('/v2/capabilities');
      if (readiness.state !== 'ready') throw new Error('CANNOT_RECREATE_ACTIVE_RUNNER');
      await docker(['stop','--time','10',existing.Id]);
    }
    await docker(['rm',existing.Id]);
  }
  const actualVolume = await inspect('volume',volume);
  if (actualVolume && actualVolume.Labels?.[label] !== 'v2') throw new Error('VOLUME_NAME_OCCUPIED');
  if (!actualVolume) await docker(['volume','create','--label',`${label}=v2`,volume]);
  const imageIds: Record<string,string> = {};
  for (const [role,tag] of Object.entries({ build:'codelab-build:v2-desktop', web:'codelab-web:v2-desktop', browser:'codelab-browser:v2-desktop', control:'codelab-control:v2-desktop' }))
    imageIds[role] = JSON.parse((await docker(['image','inspect',tag])).stdout)[0].Id;
  if (!existing || mode === 'recreate') {
    await docker(['run','--detach','--name',container,'--label',`${label}=v2`,
      '--memory','768m','--memory-swap','768m','--cpus','1','--pids-limit','128',
      '--publish',`127.0.0.1:${port}:3200`,
      '--mount','type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock',
      '--mount',`type=volume,source=${volume},target=/var/lib/codelab-runner`,
      '--env','RUNNER_APPROVED=true','--env',`RUNNER_TOKEN=${credential.token}`,
      '--env',`RUNNER_DATA_VOLUME=${volume}`,
      '--env',`RUNNER_BUILD_IMAGE=${imageIds.build}`,'--env',`RUNNER_WEB_IMAGE=${imageIds.web}`,
      '--env',`RUNNER_BROWSER_IMAGE=${imageIds.browser}`,imageIds.control]);
  } else if (!existing.State.Running) await docker(['start',existing.Id]);
  let lastFailure = 'NOT_READY';
  for (let i=0;i<45;i++) {
    try {
      const [capabilities,catalog] = await Promise.all([api('/v2/capabilities'),api('/v2/catalog')]);
      await writeFile(path.join(directory,'measured-environment.json'), JSON.stringify({
        source: 'Docker Desktop development verification', measuredAt: new Date().toISOString(),
        imageIds, capabilities, catalog,
      },null,2));
      await writeFile(path.join(directory,'runtime-catalog.json'), JSON.stringify({
        packs: catalog.packs, actualEnvironment: capabilities.actualEnvironment,
      },null,2));
      console.log(JSON.stringify({ url: credential.url, state: capabilities.state,
        packManifestHashes: capabilities.packManifestHashes, configuration: '.data/desktop-runner (private token not printed)' },null,2));
      return;
    } catch(error) { lastFailure = error instanceof Error ? error.name : 'UnknownError'; }
    await delay(1000);
  }
  throw new Error(`RUNNER_NOT_READY:${lastFailure}`);
}
main().catch(error => {
  // execFile errors include credentials in argv: never print the command or stderr wholesale.
  console.error('Desktop runner setup failed:', error instanceof Error && /^[A-Z_0-9:]+$/.test(error.message) ? error.message : 'CONTROL_START_FAILED');
  process.exitCode = 1;
});
