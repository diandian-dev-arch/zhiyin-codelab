import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createServer} from 'node:net';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {restrictedContainerArgs} from '../apps/runner/src/environment-v2.js';

// TCP handshakes only: no HTTP, metadata reads, credentials, or host mutation.
// Refusal and timeout are observations, never proof of a firewall boundary.
const exec=promisify(execFile), id=randomUUID(), key='codelab.destination-check';
assert(process.argv.slice(2).every(a=>a==='--isolated'), 'UNKNOWN_ARGUMENT');
const isolated=process.argv.includes('--isolated');
const network=`codelab-destinations-${id}`, names:string[]=[], cleanup:unknown[]=[];
const directory=path.resolve('docs/verification',new Date(Date.now()+8*3600000).toISOString().slice(0,10),`network-destinations-${id}`);
const docker=async(args:string[]) => (await exec('docker',args,{windowsHide:true,timeout:30000,maxBuffer:1024*1024})).stdout;
let hostConnections=0,created=false,failure:string|undefined;
const server=createServer(socket=>{hostConnections++;socket.end();});
const observations:Record<string,any>={};
try {
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'0.0.0.0',resolve);});
  const port=(server.address() as {port:number}).port;
  const image=JSON.parse(await docker(['image','inspect','codelab-web:v2-desktop']))[0].Id;
  await docker(['network','create','--internal',...(isolated?['--opt','com.docker.network.bridge.gateway_mode_ipv4=isolated']:[]),'--label',`${key}=${id}`,network]);created=true;
  const info=JSON.parse(await docker(['network','inspect',network]))[0];
  assert.equal(info.Internal,true);
  const gateway=info.IPAM.Config[0].Gateway ?? null;
  if(gateway)assert.match(gateway,/^\d+\.\d+\.\d+\.\d+$/);
  if(isolated)assert.equal(gateway,null,'ISOLATED_NETWORK_STILL_HAS_GATEWAY');
  const peer=`codelab-destination-peer-${id}`;names.push(peer);
  await docker(['run','-d','--name',peer,'--label',`${key}=${id}`,'--network',network,'--network-alias','project',
    ...restrictedContainerArgs('128m'),'--entrypoint','node',image,'-e',
    "require('node:net').createServer(s=>s.end()).listen(7070,'0.0.0.0')"]);
  const probe=async(phase:string,net:string,targets:{name:string;host:string;port:number}[])=>{
    const name=`codelab-destination-${phase}-${id}`;names.push(name);
    const code=`const net=require('node:net');(async()=>{
      const results=[];for(const target of ${JSON.stringify(targets)}){
        results.push(await new Promise(resolve=>{
          const started=Date.now(),socket=net.createConnection({host:target.host,port:target.port});let done=false;
          const finish=(outcome,error)=>{if(done)return;done=true;clearTimeout(timer);const remoteAddress=socket.remoteAddress;socket.destroy();resolve({...target,outcome,error,remoteAddress,elapsedMs:Date.now()-started});};
          const timer=setTimeout(()=>finish('timeout','LOCAL_DEADLINE'),1500);
          socket.once('connect',()=>finish('connected',null));socket.once('error',e=>finish('error',e.code));
        }));
      }console.log(JSON.stringify({results,interfaces:require('node:os').networkInterfaces()}));
    })().catch(()=>process.exitCode=1);`;
    return JSON.parse(await docker(['run','--name',name,'--label',`${key}=${id}`,'--network',net,
      ...restrictedContainerArgs('128m'),'--entrypoint','node',image,'-e',code]));
  };
  const control=[{name:'random-host-canary',host:'host.docker.internal',port}];
  observations.control=await probe('control','bridge',control);
  assert.equal(observations.control.results[0].outcome,'connected','HOST_POSITIVE_CONTROL_FAILED');
  assert.equal(hostConnections,1);
  const baseline=hostConnections;
  const hostAddress=observations.control.results[0].remoteAddress;
  assert.match(hostAddress,/^\d+\.\d+\.\d+\.\d+$/);
  const targets=[...control,
    {name:'positively-resolved-host-ip',host:hostAddress,port},
    ...(gateway?[{name:'actual-task-bridge-gateway',host:gateway,port}]:[]),
    {name:'link-local-metadata',host:'169.254.169.254',port:80},
    {name:'container-credentials-link-local',host:'169.254.170.2',port:80},
    {name:'ipv6-metadata-ula',host:'fd00:ec2::254',port:80},
  ];
  observations.internal=await probe('internal',network,[{name:'allowed-project-peer',host:'project',port:7070},...targets]);
  assert.equal(observations.internal.results[0].outcome,'connected','INTERNAL_PEER_CONTROL_FAILED');
  observations.none=await probe('none','none',targets);
  assert.equal(hostConnections,baseline,'RESTRICTED_HOST_CONNECTION_DELIVERED');
  for(const phase of ['internal','none']) {
    for(const row of observations[phase].results) {
      row.interpretation=row.name==='allowed-project-peer'?'allowed-positive-control':row.outcome==='connected'?'tcp-reachable':
        ['ENETUNREACH','EHOSTUNREACH'].includes(row.error)?'kernel-reported-unreachable':
        row.error==='ECONNREFUSED'?'refused-not-isolation-proof':
        row.error==='ENOTFOUND'||row.error==='EAI_AGAIN'?'dns-failed-not-route-proof':
        'inconclusive';
    }
  }
  Object.assign(observations,{image,network:{internal:true,gateway,options:info.Options,requestedIsolated:isolated},hostCanary:{port,positiveConnections:baseline,finalConnections:hostConnections}});
} catch(error) {
  failure=error instanceof Error?error.message:'DESTINATION_CHECK_FAILED';process.exitCode=1;
} finally {
  for(const name of names.reverse()) {
    try {
      const info=JSON.parse(await docker(['inspect',name]))[0];assert.equal(info.Config.Labels[key],id);
      assert.match(info.Id,/^[a-f0-9]{64}$/);await docker(['rm','-f',info.Id]);cleanup.push({name,removed:true});
    }catch{failure??='CONTAINER_CLEANUP_FAILED';cleanup.push({name,removed:false});process.exitCode=1;}
  }
  if(created)try{
    const info=JSON.parse(await docker(['network','inspect',network]))[0];assert.equal(info.Labels[key],id);
    await docker(['network','rm',info.Id]);cleanup.push({name:network,removed:true});
  }catch{failure??='NETWORK_CLEANUP_FAILED';process.exitCode=1;}
  await new Promise<void>(resolve=>server.close(()=>resolve()));
  const restricted=['internal','none'].flatMap(p=>observations[p]?.results??[]).filter(r=>r.name!=='allowed-project-peer');
  const reachable=restricted.filter(r=>r.outcome==='connected');
  const inconclusive=restricted.filter(r=>r.interpretation!=='kernel-reported-unreachable');
  const result={id,at:new Date().toISOString(),state:failure?'failed':'observed',failure,
    observations,cleanup,restrictedTcpConnections:reachable.length,inconclusiveDestinations:inconclusive.length,
    fullIsolationAcceptance:false,
    boundary:'Actual Docker Desktop bridge and selected link-local addresses; TCP handshakes only. Refusal, DNS failure and timeout are not isolation proof. No HTTP/metadata contents read. No claim for production Linux, UDP or all possible destinations.'};
  await mkdir(directory,{recursive:true});await writeFile(path.join(directory,'result.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify({directory,state:result.state,failure,restrictedTcpConnections:result.restrictedTcpConnections,
    inconclusiveDestinations:result.inconclusiveDestinations,fullIsolationAcceptance:false}));
}
