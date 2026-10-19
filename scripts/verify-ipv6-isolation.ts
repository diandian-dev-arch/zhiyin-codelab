import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { restrictedContainerArgs } from '../apps/runner/src/environment-v2.js';

const exec = promisify(execFile), id = randomUUID(), key = 'codelab.ipv6-check';
const networks: string[] = [], containers: string[] = [], cleanup: unknown[] = [];
const docker = async (args: string[]) => (await exec('docker', args, { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 })).stdout;
let result: unknown, failure: string | undefined;
let stage = 'image';
try {
  const image = JSON.parse(await docker(['image','inspect','codelab-web:v2-desktop']))[0].Id;
  const network = `codelab-ipv6-${id}`, peerNetwork = `${network}-peer`;
  stage = 'network';
  networks.push(network);
  await docker(['network','create','--internal','--label',`${key}=${id}`,network]);
  const productionShape = JSON.parse(await docker(['network','inspect',network]))[0];
  assert.equal(productionShape.Internal,true);
  assert.equal(productionShape.EnableIPv6,false,'DEFAULT_TASK_NETWORK_NOW_HAS_IPV6');
  // A real reachable IPv6 endpoint is required; an absent service is not isolation evidence.
  const hex = randomBytes(5).toString('hex');
  const subnet = `fd${hex.slice(0,2)}:${hex.slice(2,6)}:${hex.slice(6,10)}::/64`;
  networks.push(peerNetwork);
  await docker(['network','create','--internal','--ipv6','--subnet',subnet,'--label',`${key}=${id}`,peerNetwork]);
  const receiver = `codelab-ipv6-receiver-${id}`;
  containers.push(receiver);
  stage = 'receiver';
  await docker(['run','-d','--name',receiver,'--label',`${key}=${id}`,'--network',peerNetwork,
    ...restrictedContainerArgs('128m'),'--entrypoint','node',image,'-e',`
      const http=require('node:http'),dgram=require('node:dgram');let tcp=0,udp=0;
      const socket=dgram.createSocket('udp6');socket.on('message',()=>udp++);socket.bind(3478,'::');
      http.createServer((req,res)=>{if(req.url!='/stats')tcp++;res.end(JSON.stringify({tcp,udp}));}).listen(8080,'::');
    `]);
  const receiverInfo = JSON.parse(await docker(['inspect',receiver]))[0];
  const address = receiverInfo.NetworkSettings.Networks[peerNetwork].GlobalIPv6Address;
  assert.ok(address.includes(':'));
  stage = 'positive-control';
  const control = JSON.parse(await docker(['exec',receiver,'node','-e',`
    (async()=>{const url='http://[${address}]:8080';await fetch(url+'/control');
      const s=require('node:dgram').createSocket('udp6');await new Promise((resolve,reject)=>s.send(Buffer.from('positive-control'),3478,'${address}',e=>{s.close();e?reject(e):resolve();}));
      await new Promise(r=>setTimeout(r,200));console.log(JSON.stringify(await (await fetch(url+'/stats')).json()));
    })().catch(()=>process.exitCode=1);
  `]));
  assert.equal(control.tcp,1); assert.equal(control.udp,1);
  const sender = `codelab-ipv6-sender-${id}`;
  containers.push(sender);
  stage = 'cross-task';
  const observation = JSON.parse(await docker(['run','--name',sender,'--label',`${key}=${id}`,'--network',network,
    ...restrictedContainerArgs('128m'),'--entrypoint','node',image,'-e',`
      (async()=>{let tcp='connected',udp='sent';
        try{await fetch('http://[${address}]:8080/probe',{signal:AbortSignal.timeout(2000)});}catch(e){tcp=e.cause?.code||e.name;}
        const socket=require('node:dgram').createSocket('udp6');
        try{await new Promise((resolve,reject)=>{socket.once('error',reject);socket.send(Buffer.from('probe'),3478,'${address}',e=>e?reject(e):resolve());});}
        catch(e){udp=e.code;}finally{socket.close();}
        console.log(JSON.stringify({tcp,udp,interfaces:require('node:os').networkInterfaces()}));
      })().catch(()=>process.exitCode=1);
    `]));
  assert.equal(observation.tcp,'ENETUNREACH'); assert.equal(observation.udp,'ENETUNREACH');
  const after = JSON.parse(await docker(['exec',receiver,'node','-e',
    `fetch('http://[${address}]:8080/stats').then(r=>r.json()).then(x=>console.log(JSON.stringify(x)))`]));
  assert.deepEqual(after,control);
  result = { image, taskNetwork: {internal:productionShape.Internal,ipv6:productionShape.EnableIPv6},
    receiverAddress:address,control,observation,after };
} catch { failure = `IPV6_CHECK_FAILED:${stage}`; process.exitCode = 1; }
finally {
  for (const [kind,names] of [['container',containers],['network',networks]] as const) {
    for (const name of [...names].reverse()) {
      try {
        const info = JSON.parse(await docker([kind,'inspect',name]))[0];
        assert.equal((kind==='container'?info.Config.Labels:info.Labels)[key],id);
        assert.match(info.Id,/^[a-f0-9]{64}$/);
        await docker(kind==='container'?['rm','-f',info.Id]:['network','rm',info.Id]);
        cleanup.push({kind,name,removed:true});
      } catch { cleanup.push({kind,name,removed:false}); failure ??= 'CLEANUP_FAILED'; process.exitCode = 1; }
    }
  }
  const directory = path.resolve('docs/verification/2026-09-28',`ipv6-${id}`);
  await mkdir(directory,{recursive:true});
  await writeFile(path.join(directory,'result.json'),JSON.stringify({id,date:new Date().toISOString(),passed:!failure,result,failure,cleanup,
    boundary:'Current Docker Desktop default internal task network has IPv6 disabled. Controlled peer IPv6 TCP/UDP only; no claim for IPv6-enabled task networks or host firewall.'},null,2));
  console.log(JSON.stringify({passed:!failure,evidence:directory,failure}));
}
