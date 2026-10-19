import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { restrictedContainerArgs } from '../apps/runner/src/environment-v2.js';

// A random ephemeral host endpoint containing no private data; no existing host ports are probed.
const exec = promisify(execFile), id = randomUUID(), key = 'codelab.host-network-check';
const network = `codelab-host-check-${id}`, containers: string[] = [], cleanup: unknown[] = [];
const hits: string[] = [];
const server = createServer((request,response) => {
  const phase = request.url?.split('/').at(-1);
  if (!request.url?.startsWith(`/${id}/`) || !['control','restricted','restricted-ip'].includes(phase!)) { response.writeHead(404).end(); return; }
  hits.push(phase!); response.end('controlled-codelab-canary');
});
const docker = async (args: string[]) => (await exec('docker',args,{windowsHide:true,timeout:30000,maxBuffer:1024*1024})).stdout;
let created = false, failure: string | undefined, result: unknown;
try {
  await new Promise<void>((resolve,reject) => { server.once('error',reject); server.listen(0,'0.0.0.0',resolve); });
  const port = (server.address() as {port:number}).port;
  const image = JSON.parse(await docker(['image','inspect','codelab-web:v2-desktop']))[0].Id;
  await docker(['network','create','--internal','--label',`${key}=${id}`,network]); created = true;
  const observations: Record<string,any> = {};
  for (const phase of ['control','restricted','restricted-ip']) {
    const name = `codelab-host-${phase}-${id}`; containers.push(name);
    const destination=phase==='restricted-ip'?observations.control.address:'host.docker.internal';
    if(phase==='restricted-ip') assert.match(destination,/^\d+\.\d+\.\d+\.\d+$/);
    const code = `(async()=>{try{const address=(await require('node:dns').promises.lookup('${destination}',{family:4})).address;
      const r=await fetch('http://'+address+':${port}/${id}/${phase}',{signal:AbortSignal.timeout(3000)});
      console.log(JSON.stringify({address,reached:r.ok&&(await r.text())==='controlled-codelab-canary'}));}
      catch(e){console.log(JSON.stringify({reached:false,error:e.cause?.code||e.name}));}})();`;
    observations[phase] = JSON.parse(await docker(['run','--name',name,'--label',`${key}=${id}`,
      '--network',phase==='control'?'bridge':network,...restrictedContainerArgs('128m'),'--entrypoint','node',image,'-e',code]));
  }
  result = {image,port,observations,hits};
  assert.equal(observations.control.reached,true,'POSITIVE_CONTROL_UNREACHABLE');
  assert.equal(hits.filter(x=>x==='control').length,1);
  assert.equal(observations.restricted.reached,false,'INTERNAL_NETWORK_CAN_REACH_HOST');
  assert.equal(hits.filter(x=>x==='restricted').length,0,'HOST_RECEIVED_RESTRICTED_REQUEST');
  assert.equal(observations['restricted-ip'].reached,false,'INTERNAL_NETWORK_CAN_REACH_LITERAL_HOST_IP');
  assert.equal(hits.filter(x=>x==='restricted-ip').length,0,'HOST_RECEIVED_LITERAL_IP_REQUEST');
} catch(error) { failure = error instanceof assert.AssertionError ? error.message.split('\n')[0] : 'HOST_NETWORK_CHECK_FAILED'; process.exitCode = 1; }
finally {
  for (const name of containers.reverse()) {
    try {const info=JSON.parse(await docker(['inspect',name]))[0];assert.equal(info.Config.Labels[key],id);
      assert.match(info.Id,/^[a-f0-9]{64}$/);await docker(['rm','-f',info.Id]);cleanup.push({name,removed:true});}
    catch {failure??='CONTAINER_CLEANUP_FAILED';process.exitCode=1;cleanup.push({name,removed:false});}
  }
  if(created) {
    try{const info=JSON.parse(await docker(['network','inspect',network]))[0];assert.equal(info.Labels[key],id);
      await docker(['network','rm',info.Id]);cleanup.push({name:network,removed:true});}
    catch{failure??='NETWORK_CLEANUP_FAILED';process.exitCode=1;}
  }
  await new Promise<void>(resolve=>server.close(()=>resolve()));
  const directory=path.resolve('docs/verification/2026-09-28',`host-network-${id}`);
  await mkdir(directory,{recursive:true});
  await writeFile(path.join(directory,'result.json'),JSON.stringify({id,date:new Date().toISOString(),passed:!failure,result,failure,cleanup,
    boundary:'Only the random host.docker.internal HTTP canary and its positively resolved IPv4. No claim for all host addresses, bridge gateway, metadata, UDP or firewall rules.'},null,2));
  console.log(JSON.stringify({passed:!failure,evidence:directory,failure}));
}
