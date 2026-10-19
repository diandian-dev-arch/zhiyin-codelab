// Isolated synthetic TCP traffic on ephemeral loopback ports. No project/env/API
// credentials, Docker, external hosts, or business services are used.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const runtimes = process.argv.slice(2);
assert(runtimes.length === 2 && runtimes.every(p => path.isAbsolute(p)), 'TWO_ABSOLUTE_NODE_EXECUTABLES_REQUIRED');
const childCode = `
  const net=require('node:net');const {once}=require('node:events');
  (async()=>{
    const server=net.createServer(socket=>{socket.on('error',()=>{});socket.end('synthetic-canary');});
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
    const port=server.address().port;let completed=0;
    try {
      for(let round=0;round<16;round++) await Promise.all(Array.from({length:16},()=>new Promise((resolve,reject)=>{
        const socket=net.connect({host:'127.0.0.1',port});let text='';
        socket.on('data',data=>text+=data);socket.on('error',reject);
        socket.setTimeout(2000,()=>socket.destroy(new Error('LOOPBACK_TIMEOUT')));
        socket.on('close',()=>{if(text!=='synthetic-canary')reject(new Error('INVALID_CANARY'));else{completed++;resolve()}});
      })));
      console.log(JSON.stringify({node:process.version,uv:process.versions.uv,completed}));
    }finally{await new Promise(resolve=>server.close(resolve))}
  })().catch(()=>{console.error('LOOPBACK_CHILD_FAILED');process.exitCode=1});`;
const minimalEnv = Object.fromEntries(['SystemRoot','WINDIR','TEMP','TMP'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
const record = { at: new Date().toISOString(), scope: 'bounded synthetic loopback comparison, not application endurance proof', runtimeResults: [] };
const directory = path.resolve('docs/verification',new Date(Date.now()+8*3600000).toISOString().slice(0,10),`node-loopback-${randomUUID()}`);
await mkdir(directory,{recursive:true});
for(const executable of runtimes) {
  const result = { executable, sha256:createHash('sha256').update(await readFile(executable)).digest('hex'), attempts:[] };
  record.runtimeResults.push(result);
  for(let i=0;i<64;i++) {
    const started=Date.now();
    const child=spawn(executable,['-e',childCode],{windowsHide:true,env:minimalEnv,stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='',timedOut=false,spawnError=false;
    child.stdout.on('data',bytes=>{stdout=(stdout+bytes).slice(-4096)});
    child.stderr.on('data',bytes=>{stderr=(stderr+bytes).slice(-4096)});
    const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL')},10000);
    const outcome=await new Promise(resolve=>{
      child.once('error',()=>{spawnError=true});child.once('close',(code,signal)=>resolve({code,signal}));
    });
    clearTimeout(timer);
    let output;try{output=JSON.parse(stdout)}catch{}
    const attempt={index:i,...outcome,timedOut,spawnError,elapsedMs:Date.now()-started,output,stderr};
    result.attempts.push(attempt);
    await writeFile(path.join(directory,'result.json'),JSON.stringify(record,null,2));
    if(outcome.code!==0||timedOut||spawnError) console.log(JSON.stringify({runtime:path.basename(path.dirname(executable)),attempt:i,code:outcome.code,signal:outcome.signal}));
    // Five repeat crashes are enough evidence; never create an unlimited restart loop.
    if(result.attempts.filter(a=>a.code!==0).length>=5)break;
  }
  result.summary={attempts:result.attempts.length,passed:result.attempts.filter(a=>a.code===0&&a.output?.completed===256).length,
    nativeFastFails:result.attempts.filter(a=>a.code===3221226505).length,completedConnections:result.attempts.reduce((n,a)=>n+(a.output?.completed??0),0)};
  console.log(JSON.stringify({executable,...result.summary}));
}
await writeFile(path.join(directory,'result.json'),JSON.stringify(record,null,2));
console.log(JSON.stringify({directory}));
