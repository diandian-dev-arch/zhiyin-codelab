import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { restrictedContainerArgs } from '../apps/runner/src/environment-v2.js';

// Only verifier-owned disposable data. Never mount the live runner volume.
const exec = promisify(execFile);
const id = randomUUID(), key = 'codelab.filesystem-check';
const volume = `codelab-filesystem-${id}`;
const containers: string[] = [];
const results: unknown[] = [], cleanup: unknown[] = [];
let created = false, failure: string | undefined;
const docker = async (args: string[]) => (await exec('docker', args, {
  windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024,
})).stdout;
let image: string | undefined;
try {
  image = JSON.parse(await docker(['image', 'inspect', 'codelab-web:v2-desktop']))[0].Id;
  assert.match(image!, /^sha256:[a-f0-9]{64}$/);
  await docker(['volume', 'create', '--label', `${key}=${id}`, volume]);
  created = true;
  const initialize = `
    const fs=require('node:fs');
    for(const name of ['submission','out','artifacts']) {
      const p='/fixture/resources/execution-a/'+name;fs.mkdirSync(p,{recursive:true});
      fs.writeFileSync(p+'/own.txt','own-'+name);
      fs.chmodSync(p+'/own.txt',0o666);
      fs.symlinkSync('../../execution-b/secret.txt',p+'/relative-escape');
      fs.symlinkSync('/fixture/resources/execution-b/secret.txt',p+'/absolute-escape');
    }
    fs.mkdirSync('/fixture/resources/execution-b',{recursive:true});
    fs.mkdirSync('/fixture/journal',{recursive:true});
    fs.writeFileSync('/fixture/resources/execution-b/secret.txt','peer-canary');
    fs.writeFileSync('/fixture/journal/private.txt','controller-canary');
    console.log(JSON.stringify({peer:fs.readFileSync('/fixture/resources/execution-b/secret.txt','utf8'),journal:fs.readFileSync('/fixture/journal/private.txt','utf8')}));
  `;
  const setup = `codelab-fs-${id}-setup`;
  containers.push(setup);
  const positiveControl = JSON.parse(await docker(['run', '--name', setup, '--label', `${key}=${id}`,
    '--network', 'none', '--user', '0:0', '--mount', `type=volume,source=${volume},target=/fixture`,
    '--entrypoint', 'node', image!, '-e', initialize]));
  assert.deepEqual(positiveControl, { peer: 'peer-canary', journal: 'controller-canary' });
  results.push({ positiveControl });
  for (const [directory, target] of [['submission', '/submission'], ['out', '/site'], ['artifacts', '/input']]) {
    const name = `codelab-fs-${id}-${directory}`;
    containers.push(name);
    const code = `
      const fs=require('node:fs'),assert=require('node:assert/strict');
      const target=${JSON.stringify(target)}, observed=[];
      fs.writeFileSync('/tmp/write-control','writable');
      assert.equal(fs.readFileSync('/tmp/write-control','utf8'),'writable');
      assert.equal(fs.readFileSync(target+'/own.txt','utf8'),${JSON.stringify('own-' + directory)});
      for(const p of [target+'/relative-escape',target+'/absolute-escape',target+'/../execution-b/secret.txt',
        '/fixture/resources/execution-b/secret.txt','/resources/execution-b/secret.txt','/journal/private.txt',
        '/proc/1/root'+target+'/relative-escape','/var/run/docker.sock']) {
        let error;try{fs.readFileSync(p);}catch(e){error=e.code;}
        assert.ok(['ENOENT','EACCES','EPERM'].includes(error),'Unexpected read access: '+p);
        observed.push({path:p,result:error});
      }
      let writeError;try{fs.writeFileSync(target+'/own.txt','modified');}catch(e){writeError=e.code;}
      assert.equal(writeError,'EROFS');
      assert.equal(fs.readFileSync(target+'/own.txt','utf8'),${JSON.stringify('own-' + directory)});
      console.log(JSON.stringify({target,uid:process.getuid(),ownReadable:true,tmpWriteControl:true,writeError,observed}));
    `;
    const raw = await docker(['run', '--name', name, '--label', `${key}=${id}`, '--network', 'none',
      ...restrictedContainerArgs('128m'), '--mount',
      `type=volume,source=${volume},volume-subpath=resources/execution-a/${directory},target=${target},readonly`,
      '--entrypoint', 'node', image!, '-e', code]);
    const observation = JSON.parse(raw);
    assert.equal(observation.uid, 1000);
    const info = JSON.parse(await docker(['inspect', name]))[0];
    assert.equal(info.Mounts.filter((mount: any) => mount.Type === 'volume').length, 1);
    assert.equal(info.Mounts.find((mount: any) => mount.Type === 'volume').RW, false);
    results.push(observation);
  }
} catch {
  failure = 'FILESYSTEM_ISOLATION_VERIFICATION_FAILED';
  process.exitCode = 1;
} finally {
  for (const name of containers.reverse()) {
    try {
      const info = JSON.parse(await docker(['inspect', name]))[0];
      assert.equal(info.Config.Labels[key], id);
      assert.match(info.Id, /^[a-f0-9]{64}$/);
      await docker(['rm', '-f', info.Id]);
      cleanup.push({ name, removed: true });
    } catch { cleanup.push({ name, removed: false }); failure ??= 'CLEANUP_FAILED'; process.exitCode = 1; }
  }
  if (created) {
    try {
      const info = JSON.parse(await docker(['volume', 'inspect', volume]))[0];
      assert.equal(info.Name, volume); assert.equal(info.Labels[key], id);
      await docker(['volume', 'rm', volume]); cleanup.push({ name: volume, removed: true });
    } catch { failure ??= 'VOLUME_CLEANUP_FAILED'; process.exitCode = 1; }
  }
  const directory = path.resolve('docs/verification/2026-09-28', `filesystem-${id}`);
  await mkdir(directory, { recursive: true });
  const record = { id, date: new Date().toISOString(), passed: !failure, image,
    scriptSha256: createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex'),
    results, cleanup, failure,
    boundary: 'Disposable volume with production subpath shapes and restricted container args; no actual student input, kernel exploit, host compromise or live runner mount verification.' };
  await writeFile(path.join(directory, 'result.json'), JSON.stringify(record, null, 2));
  console.log(JSON.stringify({ passed: !failure, evidence: directory, failure }));
}
