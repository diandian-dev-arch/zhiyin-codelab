import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { restrictedBrowserArgs, restrictedContainerArgs } from '../apps/runner/src/environment-v2.js';

// Controlled canaries only. Forbidden addresses are intercepted before any connection.
// This tests browser policy, not host firewall or arbitrary compromised-browser containment.
const exec = promisify(execFile), id = randomUUID();
const label = `codelab.network-check=${id}`;
const network = `codelab-network-${id}`;
const peerNetwork = `codelab-peer-network-${id}`;
const names: string[] = [];
const directory = path.resolve('docs/verification/2026-09-28', `browser-network-${id}`);
const docker = async (args: string[], timeout = 30000) =>
  (await exec('docker', args, {timeout, windowsHide:true, maxBuffer:1024*1024})).stdout;
const cleanup: unknown[] = [];
let result: unknown, failure: string | undefined, networkCreated = false, peerNetworkCreated = false;
await mkdir(directory,{recursive:true});
try {
  await docker(['network','create','--internal','--label',label,network]);
  networkCreated = true;
  await docker(['network','create','--internal','--label',label,peerNetwork]);
  peerNetworkCreated = true;
  const browserImage = JSON.parse(await docker(['image','inspect',process.env.CODELAB_NETWORK_BROWSER_IMAGE ?? 'codelab-browser:v2-desktop']))[0].Id;
  const webImage = JSON.parse(await docker(['image','inspect','codelab-web:v2-desktop']))[0].Id;
  const server = `
    const http=require('node:http'),dgram=require('node:dgram'),net=require('node:net');let hits=0,upgrades=0,udp=0,turnTcp=0,tlsHello=0;
    net.createServer(socket=>{socket.once('data',data=>{if(data.length>=20 && data.readUInt32BE(4)===0x2112a442)turnTcp++;socket.destroy();});socket.setTimeout(3000,()=>socket.destroy());}).listen(3478,'0.0.0.0');
    net.createServer(socket=>{socket.once('data',data=>{if(data[0]===22 && data[1]===3)tlsHello++;socket.destroy();});socket.setTimeout(3000,()=>socket.destroy());}).listen(5349,'0.0.0.0');
    const receiver=dgram.createSocket('udp4');receiver.on('message',()=>udp++);receiver.bind(3478,'0.0.0.0');
    http.createServer((req,res)=>{res.setHeader('Access-Control-Allow-Origin','*');
      if(req.url==='/stats'){res.end(JSON.stringify({hits,upgrades,udp,turnTcp,tlsHello}));return;}
      hits++;res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Controlled network canary</title>');
    }).on('upgrade',(req,socket)=>{upgrades++;socket.destroy();}).listen(8080,'0.0.0.0');`;
  for(const alias of ['project','forbidden','other-task']) {
    const name=`codelab-network-${id}-${alias}`;names.push(name);
    await docker(['run','-d','--name',name,'--label',label,'--network',alias==='other-task'?peerNetwork:network,'--network-alias',alias,
      ...restrictedContainerArgs('128m'),'--entrypoint','node',webImage,'-e',server]);
  }
  const peerName=`codelab-network-${id}-other-task`;
  const peerInfo=JSON.parse(await docker(['inspect',peerName]))[0];
  const peerIp=peerInfo.NetworkSettings.Networks[peerNetwork].IPAddress;
  assert.match(peerIp,/^\d+\.\d+\.\d+\.\d+$/);
  const peerControl=JSON.parse(await docker(['exec',peerName,'node','-e',
    "fetch('http://127.0.0.1:8080/control').then(async r=>{if(r.status!==200)process.exit(1);const s=require('node:dgram').createSocket('udp4');await new Promise((resolve,reject)=>s.send(Buffer.from('control'),3478,'127.0.0.1',e=>{s.close();e?reject(e):resolve();}));await new Promise(r=>setTimeout(r,200));console.log(JSON.stringify(await (await fetch('http://127.0.0.1:8080/stats')).json()));})"]));
  assert.ok(peerControl.udp>0,'Peer UDP canary must receive its positive control');
  const code = `
    const assert=require('node:assert/strict');
    const {chromium}=require('/opt/node_modules/playwright');
    (async()=>{
      const {installNetworkPolicy}=await import('/opt/check-v2.mjs');
      const {CONTEXT_OPTIONS}=await import('/opt/v2-new-case.mjs');
      const canaryIp=(await require('node:dns').promises.lookup('forbidden')).address;
      const sendUdp=address=>new Promise((resolve,reject)=>{const socket=require('node:dgram').createSocket('udp4');
        socket.on('error',reject);socket.send(Buffer.from('controlled-probe'),3478,address,error=>{socket.close();error?reject(error):resolve();});});
      const stats=()=>fetch('http://forbidden:8080/stats').then(r=>r.json());
      const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
      const initial=await stats();await sendUdp(canaryIp);await wait(200);
      assert.ok((await stats()).udp>initial.udp,'UDP positive control must arrive');
      let crossTaskUdp='sent-without-delivery-confirmation';
      try{await sendUdp('${peerIp}');}catch(error){crossTaskUdp=error.code;assert.ok(['ENETUNREACH','EHOSTUNREACH','EACCES'].includes(error.code));}
      await wait(200);
      const rtc=async (protectedMode,transport='udp')=>{
        const instance=await chromium.launch({channel:'chromium',headless:true,chromiumSandbox:true,
          args:['--disable-dev-shm-usage',...(protectedMode?['--force-webrtc-ip-handling-policy=disable_non_proxied_udp']:[])]});
        try{const ctx=await instance.newContext(CONTEXT_OPTIONS);if(protectedMode)await installNetworkPolicy(ctx,()=>{});
          const tab=await ctx.newPage();await tab.goto('http://project:8080/');
          return await tab.evaluate(async ({ip,transport})=>{
            if(typeof RTCPeerConnection==='undefined'){
              const frame=document.createElement('iframe');document.body.append(frame);
              await new Promise(resolve=>setTimeout(resolve,100));
              const frameDisabled=typeof frame.contentWindow.RTCPeerConnection==='undefined';
              const descriptor=Object.getOwnPropertyDescriptor(window,'RTCPeerConnection');
              frame.remove();return {available:false,frameDisabled,locked:!descriptor.writable&&!descriptor.configurable};
            }
            const iceServer=transport==='udp'?{urls:'stun:'+ip+':3478'}:
              {urls:(transport==='tcp'?'turn:':'turns:')+ip+(transport==='tcp'?':3478':':5349')+'?transport=tcp',username:'controlled',credential:'synthetic-test-only'};
            const pc=new RTCPeerConnection({iceServers:[iceServer],...(transport==='udp'?{}:{iceTransportPolicy:'relay'})});
            try{pc.createDataChannel('controlled-probe');await pc.setLocalDescription(await pc.createOffer());
              await new Promise(resolve=>setTimeout(resolve,3000));return {available:true,gatheringState:pc.iceGatheringState};
            }finally{pc.close();}},{ip:canaryIp,transport});
        }finally{await instance.close();}
      };
      const beforeRtc=await stats();const rtcControl=await rtc(false);const afterRtcControl=await stats();
      assert.ok(afterRtcControl.udp>beforeRtc.udp,'Unrestricted WebRTC must reach the UDP canary');
      // Allow in-flight packets from the closed positive-control browser to settle.
      await wait(300);const beforeProtected=await stats();const rtcProtected=await rtc(true);await wait(200);
      const afterProtected=await stats();assert.equal(afterProtected.udp,beforeProtected.udp,'Protected WebRTC sent UDP');
      assert.deepEqual(rtcProtected,{available:false,frameDisabled:true,locked:true});
      const turnObservations=[];
      for(const [transport,counter] of [['tcp','turnTcp'],['tls','tlsHello']]) {
        const before=await stats();const control=await rtc(false,transport);await wait(200);const afterControl=await stats();
        assert.ok(afterControl[counter]>before[counter],'WebRTC positive control missing: '+transport);
        await wait(300);const beforePolicy=await stats();const protectedResult=await rtc(true,transport);await wait(200);const afterPolicy=await stats();
        assert.deepEqual(protectedResult,{available:false,frameDisabled:true,locked:true});
        assert.equal(afterPolicy[counter],beforePolicy[counter],'WebRTC outbound attempt despite policy: '+transport);
        turnObservations.push({transport,counter,before,control,afterControl,beforePolicy,protectedResult,afterPolicy});
      }
      // Positive control: the prohibited canary is reachable from this very container.
      assert.equal((await fetch('http://forbidden:8080/control')).status,200);
      const baseline=await (await fetch('http://forbidden:8080/stats')).json();
      let peerReachable=false;
      try {await fetch('http://${peerIp}:8080/cross-task',{signal:AbortSignal.timeout(2500)});peerReachable=true;}catch{}
      assert.equal(peerReachable,false,'A different task network must not be reachable');
      const browser=await chromium.launch({channel:'chromium',headless:true,chromiumSandbox:true,
        args:['--disable-dev-shm-usage','--disable-background-networking','--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
          '--unsafely-treat-insecure-origin-as-secure=http://project:8080']});
      try {
        const context=await browser.newContext(CONTEXT_OPTIONS);let blocked=0;
        await installNetworkPolicy(context,()=>blocked++);
        const page=await context.newPage();await page.goto('http://project:8080/',{timeout:10000});
        const allowed=await page.evaluate(async()=> (await fetch('/allowed')).status);
        assert.equal(allowed,200);
        const targets=['http://forbidden:8080/denied','http://127.0.0.1:8080/denied',
          'http://host.docker.internal:8080/denied','http://169.254.169.254/latest/meta-data/',
          'http://[::1]:8080/denied','http://project:8081/denied','http://project.evil.invalid:8080/denied'];
        const observations=[];
        for(const url of targets){
          const before=blocked;
          const fetched=await page.evaluate(async url=>{try{await fetch(url,{mode:'no-cors',signal:AbortSignal.timeout(2000)});return true;}catch{return false;}},url);
          assert.equal(fetched,false,url);assert.equal(blocked,before+1,'Policy must intercept '+url);
          observations.push({url,fetchSucceeded:fetched,policyIntercepted:true});
        }
        const beforeSocket=blocked;
        const socket=await page.evaluate(()=>new Promise(resolve=>{const ws=new WebSocket('ws://forbidden:8080/socket');
          const timer=setTimeout(()=>{ws.close();resolve('timeout');},2000);
          ws.onopen=()=>{clearTimeout(timer);ws.close();resolve('opened');};
          ws.onclose=()=>{clearTimeout(timer);resolve('closed');};}));
        assert.equal(socket,'closed');assert.equal(blocked,beforeSocket+1);
        const after=await (await fetch('http://forbidden:8080/stats')).json();assert.deepEqual(after,baseline);
        console.log(JSON.stringify({source:'trusted-controlled-browser-policy-probe',allowedStatus:allowed,
          positiveControl:baseline,forbiddenCanaryAfter:after,observations,websocket:socket,blocked,peerReachable,
          webrtc:{rtcControl,rtcProtected,beforeRtc,afterRtcControl,beforeProtected,afterProtected},
          crossTaskUdp,turnObservations,serviceWorkers:CONTEXT_OPTIONS.serviceWorkers,chromiumSandbox:true,browserVersion:browser.version()}));
      }finally{await browser.close();}
    })().catch(e=>{console.error(e.message);process.exitCode=1;});`;
  const browserName=`codelab-network-${id}-browser`;names.push(browserName);
  await docker(['create','--name',browserName,'--label',label,'--network',network,
    ...restrictedBrowserArgs('1536m'),'--shm-size','256m',
    '--entrypoint','node',browserImage,'-e',code]);
  await docker(['start',browserName]);
  const exitCode=Number((await docker(['wait',browserName],45000)).trim());
  const captured=await exec('docker',['logs',browserName],{timeout:30000,windowsHide:true,maxBuffer:1024*1024});
  const logs=captured.stdout;
  assert.equal(exitCode,0,`NETWORK_PROBE_FAILED:${logs}\n${captured.stderr}`);
  const peerAfter=JSON.parse(await docker(['exec',peerName,'node','-e',
    "fetch('http://127.0.0.1:8080/stats').then(r=>r.json()).then(x=>console.log(JSON.stringify(x)))"]));
  assert.deepEqual(peerAfter,peerControl,'Cross-task canary received a connection');
  result={...JSON.parse(logs.trim()),browserImage,webImage,peerControl,peerAfter};
} catch(error) {
  failure=error instanceof Error ? error.message : 'NETWORK_PROBE_FAILED';process.exitCode=1;
} finally {
  for(const name of names.reverse()) {
    try {
      const info=JSON.parse(await docker(['inspect',name]))[0];
      assert.equal(info.Config.Labels['codelab.network-check'],id);
      await docker(['rm','-f',info.Id]);cleanup.push({name,removed:true});
    }catch {cleanup.push({name,removed:false});failure??='CLEANUP_FAILED';process.exitCode=1;}
  }
  for(const ownedNetwork of [networkCreated?network:null,peerNetworkCreated?peerNetwork:null].filter((value):value is string=>value!==null)) {
    try {
      const info=JSON.parse(await docker(['network','inspect',ownedNetwork]))[0];
      assert.equal(info.Labels['codelab.network-check'],id);
      await docker(['network','rm',info.Id]);cleanup.push({name:ownedNetwork,removed:true});
    }catch{failure??='NETWORK_CLEANUP_FAILED';process.exitCode=1;}
  }
  await writeFile(path.join(directory,'result.json'),JSON.stringify({id,date:new Date().toISOString(),passed:!failure,
    result,failure,cleanup,notCovered:['TURN authentication and relay payload','host firewall isolation','cross-task IPv6 and filesystem attacks (separate verifiers)']},null,2));
  console.log(JSON.stringify({passed:!failure,evidence:path.relative(process.cwd(),directory),failure}));
}
