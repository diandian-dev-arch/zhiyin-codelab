import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { restrictedBrowserArgs, restrictedContainerArgs } from '../apps/runner/src/environment-v2.js';
import { createDevelopmentPack, sha256, validateCaseResult } from '../packages/contracts/src/v2/index.js';

// Controlled HTML fault injection, real production driver and sandboxed Chromium.
// No model, database mutation, user submission or production runner interruption.
const exec = promisify(execFile), id = randomUUID(), key = 'codelab.interruption-check';
const network = `codelab-interruption-${id}`, names: string[] = [], cleanup: unknown[] = [];
const directory = path.resolve('docs/verification/2026-09-28', `checker-interruption-${id}`);
const docker = async (args: string[], timeout = 30000) =>
  (await exec('docker', args, { timeout, windowsHide: true, maxBuffer: 1024 * 1024 })).stdout;
let networkCreated = false, result: unknown, failure: string | undefined;
await mkdir(directory, { recursive: true });
try {
  const hashes = Object.fromEntries(await Promise.all(['check-v2.mjs', 'v2-new-case.mjs'].map(async file =>
    [file, await sha256(await readFile(path.join('deploy/executor', file)))])));
  const pack = await createDevelopmentPack('new-only', { packVersion: 'controlled-browser-interruption-v1',
    templateVersion: 'controlled-html-v1', templateHash: 'a'.repeat(64), dependencyLockHash: 'a'.repeat(64),
    initializationVersion: 'clean-ui-v1', caseImplementationHashes: { 'NEW-01': hashes['v2-new-case.mjs'] } });
  const definition = pack.cases[0];
  const browserImage = JSON.parse(await docker(['image', 'inspect', 'codelab-browser:v2-desktop']))[0].Id;
  const webImage = JSON.parse(await docker(['image', 'inspect', 'codelab-web:v2-desktop']))[0].Id;
  await docker(['network', 'create', '--internal', '--label', `${key}=${id}`, network]);
  networkCreated = true;
  const server = `
    let mode='control',fills=0,clicks=0;
    require('node:http').createServer((req,res)=>{
      const url=new URL(req.url,'http://project:8080');
      if(url.pathname==='/mode'){mode=url.searchParams.get('value');fills=0;clicks=0;res.end('ok');return;}
      if(url.pathname==='/stats'){res.end(JSON.stringify({mode,fills,clicks}));return;}
      if(url.pathname==='/event'){if(url.searchParams.get('kind')==='fill')fills++;else clicks++;res.end('ok');return;}
      res.setHeader('Content-Type','text/html; charset=utf-8');
      res.end('<!doctype html><meta charset="utf-8"><input data-testid="task-input"><button data-testid="add-task">Add</button><div id="rows"></div><script>'+ 
        'const input=document.querySelector("input"),button=document.querySelector("button");'+
        'input.addEventListener("input",()=>{fetch("/event?kind=fill");'+(mode==='interrupted'?'button.disabled=true;':'')+'});'+
        'button.addEventListener("click",()=>{fetch("/event?kind=click");const row=document.createElement("div"),title=document.createElement("span");row.dataset.testid="task-row";title.dataset.testid="task-title";title.textContent=input.value;row.append(title);document.querySelector("#rows").append(row);});</script>');
    }).listen(8080,'0.0.0.0');`;
  const webName = `${network}-web`; names.push(webName);
  await docker(['run', '-d', '--name', webName, '--label', `${key}=${id}`, '--network', network, '--network-alias', 'project',
    ...restrictedContainerArgs('128m'), '--entrypoint', 'node', webImage, '-e', server]);
  const code = `
    const assert=require('node:assert/strict'),fs=require('node:fs'),crypto=require('node:crypto');
    (async()=>{
      const hashes=${JSON.stringify(hashes)};
      for(const [file,hash] of Object.entries(hashes))assert.equal(crypto.createHash('sha256').update(fs.readFileSync('/opt/'+file)).digest('hex'),hash,'STALE_CHECKER_IMAGE');
      const {createDriver}=await import('/opt/check-v2.mjs'),{runNewCase}=await import('/opt/v2-new-case.mjs');
      const {chromium}=require('/opt/node_modules/playwright');
      const browser=await chromium.launch({headless:true,chromiumSandbox:true,args:['--disable-dev-shm-usage','--force-webrtc-ip-handling-policy=disable_non_proxied_udp']});
      const observations=[];
      try {
        for(const mode of ['control','interrupted']){
          await fetch('http://project:8080/mode?value='+mode);
          const driver=createDriver(browser);
          try {
            const outcome=await runNewCase({caseDefinitions:[${JSON.stringify(definition)}],parameterValues:{},remainingWorkMs:15000},driver);
            const stats=await (await fetch('http://project:8080/stats')).json();
            const actual=outcome.caseResult;
            assert.equal(stats.fills,1);
            if(mode==='control'){
              assert.equal(actual.verdict,'passed');assert.equal(stats.clicks,1);
              assert.deepEqual(actual.unexecutedStepIds,[]);assert.equal(outcome.observation.after.count,1);
            }else{
              assert.equal(stats.clicks,0);assert.equal(actual.verdict,'not_run');assert.equal(actual.reasonCode,'TIME_BUDGET');
              assert.equal(actual.preconditionStatus,'satisfied');
              assert.deepEqual(actual.executedSteps.map(s=>[s.stepId,s.state]),[
                ['setup:open-clean-context','completed'],['setup:record-initial-tasks','completed'],['action:create-unique-task','interrupted']]);
              assert.deepEqual(actual.unexecutedStepIds,['assert:exactly-one-created']);
              assert.equal(outcome.observation.after,null);assert.equal(outcome.observation.assertion,null);
              assert.equal(await driver.screenshot(),null);
            }
            observations.push({mode,stats,...outcome});
          }finally{await driver.close();}
        }
        console.log(JSON.stringify({browserVersion:browser.version(),chromiumSandbox:true,hashes,observations}));
      }finally{await browser.close();}
    })().catch(error=>{console.error(error.message);process.exitCode=1;});`;
  const browserName = `${network}-browser`; names.push(browserName);
  await docker(['create', '--name', browserName, '--label', `${key}=${id}`, '--network', network,
    ...restrictedBrowserArgs('1536m'), '--shm-size', '256m', '--entrypoint', 'node', browserImage, '-e', code]);
  await docker(['start', browserName]);
  const exitCode = Number((await docker(['wait', browserName], 45000)).trim());
  const logs = await exec('docker', ['logs', browserName], { timeout: 10000, windowsHide: true, maxBuffer: 1024 * 1024 });
  assert.equal(exitCode, 0, `CHECKER_PROBE_FAILED:${logs.stderr}`);
  const measured = JSON.parse(logs.stdout.trim());
  for (const item of measured.observations) {
    const evidenceId = randomUUID();
    validateCaseResult(definition, { ...item.caseResult, evidenceIds: [evidenceId],
      executedSteps: item.caseResult.executedSteps.map((step: Record<string, unknown>) => ({ ...step, evidenceIds: [evidenceId] })) });
  }
  result = { ...measured, browserImage, webImage, fixture: 'controlled-html-no-student-data' };
} catch (error) {
  failure = error instanceof Error ? error.message : 'CHECKER_INTERRUPTION_FAILED'; process.exitCode = 1;
} finally {
  for (const name of names.reverse()) {
    try {
      const info = JSON.parse(await docker(['inspect', name]))[0];
      assert.equal(info.Config.Labels[key], id);
      await docker(['rm', '-f', info.Id]); cleanup.push({ name, removed: true });
    } catch { failure ??= 'CONTAINER_CLEANUP_FAILED'; process.exitCode = 1; cleanup.push({ name, removed: false }); }
  }
  if (networkCreated) {
    try {
      const info = JSON.parse(await docker(['network', 'inspect', network]))[0];
      assert.equal(info.Labels[key], id);
      await docker(['network', 'rm', info.Id]); cleanup.push({ name: network, removed: true });
    } catch { failure ??= 'NETWORK_CLEANUP_FAILED'; process.exitCode = 1; }
  }
  await writeFile(path.join(directory, 'result.json'), JSON.stringify({ id, date: new Date().toISOString(), passed: !failure,
    result, failure, cleanup, notCovered: ['full worker publication flow for this injected interruption', 'host shutdown'] }, null, 2));
  console.log(JSON.stringify({ passed: !failure, evidence: path.relative(process.cwd(), directory), failure }));
}
