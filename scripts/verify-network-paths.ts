import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { restrictedBrowserArgs, restrictedContainerArgs } from '../apps/runner/src/environment-v2.js';

// Only an isolated internal network and synthetic canary. No model, host service,
// metadata endpoint, credentials, business mount or existing container is used.
const exec = promisify(execFile), id = randomUUID(), labelKey = 'codelab.network-paths';
const network = `codelab-network-paths-${id}`, names: string[] = [], cleanup: unknown[] = [];
const docker = async (args: string[], timeout = 30000) =>
  (await exec('docker', args, { windowsHide: true, timeout, maxBuffer: 2 * 1024 ** 2 })).stdout;
const directory = path.resolve('docs/verification', new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10), `network-paths-${id}`);
let networkCreated = false, failure: string | undefined, observations: unknown;
try {
  const webImage = JSON.parse(await docker(['image', 'inspect', 'codelab-web:v2-desktop']))[0].Id;
  const browserReference = process.env.CODELAB_NETWORK_BROWSER_IMAGE ?? 'codelab-browser:v2-desktop';
  const browserImage = JSON.parse(await docker(['image', 'inspect', browserReference]))[0].Id;
  await docker(['network', 'create', '--internal', '--label', `${labelKey}=${id}`, network]);
  networkCreated = true;
  const server = `
    const http=require('node:http');let requests=[],upgrades=[];
    const target='http://forbidden:8080';
    http.createServer((req,res)=>{
      res.setHeader('Access-Control-Allow-Origin','*');
      if(req.url==='/stats'){res.end(JSON.stringify({requests,upgrades}));return;}
      requests.push(req.url);
      if(req.url.startsWith('/redirect/')){res.writeHead(Number(req.url.split('/')[2]),{Location:target+'/redirect-target'}).end();return;}
      if(req.url==='/worker.js'){
        res.setHeader('Content-Type','application/javascript');
        res.end('onmessage=async()=>{try{await fetch("'+target+'/worker",{mode:"no-cors"});postMessage("reached")}catch{postMessage("blocked")}}');return;
      }
      res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>CodeLab network path canary</title>');
    }).on('upgrade',(req,socket)=>{upgrades.push(req.url);socket.destroy();}).listen(8080,'0.0.0.0');`;
  for (const alias of ['project', 'forbidden']) {
    const name = `${network}-${alias}`; names.push(name);
    await docker(['run', '-d', '--name', name, '--label', `${labelKey}=${id}`, '--network', network,
      '--network-alias', alias, ...restrictedContainerArgs('128m'), '--entrypoint', 'node', webImage, '-e', server]);
  }
  const code = `
    const assert=require('node:assert/strict');const {chromium}=require('/opt/node_modules/playwright');
    (async()=>{
      const {installNetworkPolicy}=await import('/opt/check-v2.mjs');
      const {CONTEXT_OPTIONS}=await import('/opt/v2-new-case.mjs');
      const result={paths:[],imagePolicy:'inspected-browser-image'};
      const stats=()=>fetch('http://forbidden:8080/stats').then(r=>r.json());
      await fetch('http://forbidden:8080/node-positive');
      const browser=await chromium.launch({channel:'chromium',headless:true,chromiumSandbox:true,args:['--disable-dev-shm-usage']});
      try {
        const control=await browser.newContext(CONTEXT_OPTIONS);const cp=await control.newPage();
        await cp.goto('http://project:8080');
        await cp.evaluate(()=>fetch('http://forbidden:8080/browser-positive',{mode:'no-cors'}));
        await control.close();
        const baseline=await stats();assert.ok(baseline.requests.includes('/browser-positive'));
        const context=await browser.newContext(CONTEXT_OPTIONS);let blocked=0;
        await installNetworkPolicy(context,()=>blocked++);
        const page=await context.newPage();await page.goto('http://project:8080');
        const run=async(name,action)=>{
          const before=await stats(),count=blocked;let outcome;
          try{outcome=await action();}catch(e){outcome='browser-rejected';}
          const after=await stats();
          result.paths.push({name,outcome,policyBlocks:blocked-count,canaryUnchanged:JSON.stringify(before)===JSON.stringify(after),before,after});
        };
        await run('fetch',()=>page.evaluate(async()=>{try{await fetch('http://forbidden:8080/fetch',{mode:'no-cors'});return 'reached'}catch{return 'blocked'}}));
        await run('image',()=>page.evaluate(()=>new Promise(resolve=>{
          const image=new Image();const timer=setTimeout(()=>{image.src='';resolve('timeout')},2000);
          image.onload=()=>{clearTimeout(timer);resolve('reached')};
          image.onerror=()=>{clearTimeout(timer);resolve('blocked')};image.src='http://forbidden:8080/image';
        })));
        await run('event-source',()=>page.evaluate(()=>new Promise(resolve=>{
          const events=new EventSource('http://forbidden:8080/events');
          const finish=value=>{clearTimeout(timer);events.close();resolve(value)};
          const timer=setTimeout(()=>finish('timeout'),2000);
          events.onopen=()=>finish('opened');events.onerror=()=>finish('blocked');
        })));
        await run('send-beacon',async()=>{
          const count=blocked;
          const queued=await page.evaluate(()=>navigator.sendBeacon('http://forbidden:8080/beacon','synthetic-canary'));
          // A true return means queued, not delivered. Require the policy callback
          // and unchanged server observations instead of treating it as success.
          for(let i=0;i<40 && blocked===count;i++)await new Promise(resolve=>setTimeout(resolve,50));
          return queued && blocked>count ? 'blocked-after-queue' : 'timeout';
        });
        for(const status of [301,302,303,307,308]) await run('redirect-'+status,()=>page.evaluate(async status=>{
          try{await fetch('/redirect/'+status,{mode:'no-cors'});return 'reached'}catch{return 'blocked'}
        },status));
        await run('iframe',()=>page.evaluate(()=>new Promise(resolve=>{const f=document.createElement('iframe');
          f.onload=()=>{f.remove();resolve('load-event')};f.onerror=()=>{f.remove();resolve('error-event')};
          f.src='http://forbidden:8080/frame';document.body.append(f);setTimeout(()=>{f.remove();resolve('timeout')},1500);
        })));
        await run('worker-fetch',()=>page.evaluate(()=>new Promise(resolve=>{const w=new Worker('/worker.js');
          const timer=setTimeout(()=>{w.terminate();resolve('timeout')},3000);
          w.onmessage=e=>{clearTimeout(timer);w.terminate();resolve(e.data)};
          w.onerror=()=>{clearTimeout(timer);w.terminate();resolve('worker-error')};w.postMessage('go');
        })));
        await run('websocket',()=>page.evaluate(()=>new Promise(resolve=>{const ws=new WebSocket('ws://forbidden:8080/socket');
          const timer=setTimeout(()=>{ws.close();resolve('timeout')},1500);
          ws.onclose=()=>{clearTimeout(timer);resolve('closed')};ws.onopen=()=>{clearTimeout(timer);ws.close();resolve('opened')};
        })));
        result.baseline=baseline;result.final=await stats();result.browserVersion=browser.version();
        result.checkerSha256=require('node:crypto').createHash('sha256').update(require('node:fs').readFileSync('/opt/check-v2.mjs')).digest('hex');
        result.passed=result.paths.length===12 && result.paths.every(p=>p.canaryUnchanged && p.policyBlocks>0 && !['timeout','worker-error','browser-rejected','reached','opened'].includes(p.outcome));
        console.log(JSON.stringify(result));await context.close();
      }finally{await browser.close()}
    })().catch(e=>{console.error(e.message);process.exitCode=1});`;
  const name = `${network}-browser`; names.push(name);
  await docker(['create', '--name', name, '--label', `${labelKey}=${id}`, '--network', network,
    ...restrictedBrowserArgs('768m'), '--shm-size', '128m', '--entrypoint', 'node', browserImage, '-e', code]);
  await docker(['start', name]);
  const exitCode = Number((await docker(['wait', name], 45000)).trim());
  const logs = await exec('docker', ['logs', name], { windowsHide: true, timeout: 15000, maxBuffer: 2 * 1024 ** 2 });
  assert.equal(exitCode, 0, `NETWORK_PATH_PROBE_ERROR:${logs.stderr}`);
  const probe = JSON.parse(logs.stdout.trim());
  observations = { webImage, browserImage, browserReference, ...probe };
  assert.equal(probe.checkerSha256, createHash('sha256').update(await readFile('deploy/executor/check-v2.mjs')).digest('hex'), 'IMAGE_CHECKER_SOURCE_MISMATCH');
  assert.equal(probe.passed, true, 'NETWORK_PATH_CANARY_REACHED');
} catch (error) {
  failure = error instanceof Error ? error.message : 'NETWORK_PATH_CHECK_FAILED'; process.exitCode = 1;
} finally {
  for (const name of names.reverse()) {
    try {
      const info = JSON.parse(await docker(['inspect', name]))[0];
      assert.equal(info.Config.Labels[labelKey], id); assert.match(info.Id, /^[a-f0-9]{64}$/);
      await docker(['rm', '-f', info.Id]); cleanup.push({ name, removed: true });
    } catch { cleanup.push({ name, removed: false }); failure ??= 'CONTAINER_CLEANUP_FAILED'; process.exitCode = 1; }
  }
  if (networkCreated) try {
    const info = JSON.parse(await docker(['network', 'inspect', network]))[0];
    assert.equal(info.Labels[labelKey], id); await docker(['network', 'rm', info.Id]); cleanup.push({ name: network, removed: true });
  } catch { failure ??= 'NETWORK_CLEANUP_FAILED'; process.exitCode = 1; }
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'result.json'), JSON.stringify({ id, at: new Date().toISOString(), passed: !failure, failure, observations, cleanup,
    scope: 'Production image browser policy against synthetic same-network canary; not host firewall or production isolation acceptance.' }, null, 2));
  console.log(JSON.stringify({ passed: !failure, directory, failure }));
}
