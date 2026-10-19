import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { unzipSync, zipSync } from 'fflate';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../apps/api/src/app.js';
import { postgres, migrate, type DB } from '../apps/api/src/db.js';
import { seed } from '../apps/api/src/seed.js';
import { root } from '../apps/api/src/template.js';
import { ArtifactStore } from '../apps/api/src/artifacts-v2.js';
import { runOneV2 } from '../apps/api/src/worker-v2.js';
import { enqueueReanalysisV2 } from '../apps/api/src/reanalysis-v2.js';
import {validateIsolatedNetwork} from '../apps/runner/src/environment-v2.js';
import { createRunnerClientV2, RunnerClientError } from '../apps/api/src/runner-client-v2.js';
import {
  canonicalJson, hashRuleSnapshot, hashExecuteRequest, hashCleanupRequest, hashProbeRequest, hashPreparationRequest, sha256,
  measurementFingerprintSchema, runnerCapabilitiesSchema, validateTaskPack,
  type RunnerExecuteRequest, type RuleSnapshot, type RunnerExecuteResponse, type RunnerProbeRequest, type RunnerProbeResponse, type ArtifactManifest,
} from '../packages/contracts/src/v2/index.js';

// Constructed samples only. Never connects to the original preview database.
const id = randomUUID().slice(0,12), startedAt = new Date().toISOString();
const container = `codelab-verification-pg-${id}`, network = `codelab-verification-net-${id}`;
const label = `codelab.verification=${id}`, password = randomUUID();
const evidenceDirectory = path.join(root, 'docs/verification', new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date()), `desktop-v2-${id}`);
const privateDirectory = path.join(root,'.data','desktop-verification',id);
const exec = promisify(execFile);
const docker = (args: string[]) => exec('docker',args,{windowsHide:true,timeout:30000,maxBuffer:1024*1024});
let db: DB|undefined, app: Awaited<ReturnType<typeof createApp>>|undefined;
const results: any[] = [];
const recoveryResults: any[] = [];
const verifyProbe = process.argv.includes('--probe');
const verifyReanalysis = process.argv.includes('--reanalysis');
const verifyCpu = process.argv.includes('--cpu');
const verifyManualDecision = process.argv.includes('--manual-decision');
let currentCheck = 'startup';
let verificationPassed = false;
let finalResultRecord: Record<string,unknown>|undefined;

type TemporaryKind = 'container'|'network';
type CleanupRecord = {
  target: 'api'|'database'|TemporaryKind;
  name?: string;
  resourceId?: string;
  state: 'closed'|'not_started'|'absent'|'removed'|'failed';
  errorCode?: string;
};
class VerificationCleanupError extends Error {}

function isDockerNotFound(error: unknown, kind: TemporaryKind, reference: string): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as { code?: unknown; killed?: unknown; signal?: unknown; stdout?: unknown; stderr?: unknown };
  if (value.code !== 1 || value.killed === true || value.signal || typeof value.stderr !== 'string') return false;
  const stdout = typeof value.stdout === 'string' ? value.stdout.trim() : '';
  if (stdout && stdout !== '[]') return false;
  // Match the complete, known daemon response; connection/permission/timeout errors are not absence.
  return [
    `Error: No such object: ${reference}`,
    `Error response from daemon: No such object: ${reference}`,
    `Error: No such ${kind}: ${reference}`,
    `Error response from daemon: No such ${kind}: ${reference}`,
    ...(kind === 'network' ? [`Error response from daemon: network ${reference} not found`] : []),
  ].includes(value.stderr.trim());
}

async function inspectTemporary(kind: TemporaryKind, reference: string): Promise<any|null> {
  let stdout: string;
  try { ({stdout} = await docker([kind,'inspect',reference])); }
  catch (error) {
    if (isDockerNotFound(error,kind,reference)) return null;
    throw new VerificationCleanupError(`${kind.toUpperCase()}_INSPECT_FAILED`);
  }
  try {
    const items = JSON.parse(stdout);
    if (!Array.isArray(items) || items.length !== 1 || !/^[a-f0-9]{64}$/.test(items[0]?.Id))
      throw new Error('INVALID_INSPECT');
    return items[0];
  } catch { throw new VerificationCleanupError(`${kind.toUpperCase()}_INSPECT_INVALID`); }
}

async function cleanupTemporary(kind: TemporaryKind, name: string, record: CleanupRecord): Promise<void> {
  // Always inspect this run's precise name: a lost create reply must not suppress cleanup.
  const item = await inspectTemporary(kind,name);
  if (!item) { record.state = 'absent'; return; }
  const actualName = kind === 'container' ? item.Name?.replace(/^\//,'') : item.Name;
  const actualLabel = (kind === 'container' ? item.Config?.Labels : item.Labels)?.['codelab.verification'];
  if (actualName !== name || actualLabel !== id)
    throw new VerificationCleanupError(`${kind.toUpperCase()}_OWNERSHIP_MISMATCH`);
  record.resourceId = item.Id;
  try {
    await docker(kind === 'container' ? ['rm','--force','--volumes',item.Id] : ['network','rm',item.Id]);
  } catch (error) {
    if (!isDockerNotFound(error,kind,item.Id))
      throw new VerificationCleanupError(`${kind.toUpperCase()}_REMOVE_FAILED`);
  }
  if (await inspectTemporary(kind,item.Id) || await inspectTemporary(kind,name))
    throw new VerificationCleanupError(`${kind.toUpperCase()}_REMAINED_AFTER_REMOVE`);
  record.state = 'removed';
}

async function cleanupVerification(): Promise<CleanupRecord[]> {
  const records: CleanupRecord[] = [];
  const attempt = async (record: CleanupRecord, action: () => Promise<void>) => {
    records.push(record);
    try { await action(); }
    catch (error) {
      record.state = 'failed';
      // Do not retain arbitrary errors, command arguments, stderr, DB URLs or credentials.
      record.errorCode = error instanceof VerificationCleanupError ? error.message : `${record.target.toUpperCase()}_CLOSE_FAILED`;
    }
  };
  const close = async (operation: () => Promise<void>, target: string) => {
    let timer: ReturnType<typeof setTimeout>|undefined;
    try {
      await Promise.race([operation(),new Promise<never>((_,reject) => {
        timer = setTimeout(() => reject(new VerificationCleanupError(`${target}_CLOSE_TIMEOUT`)),5000);
      })]);
    } finally { clearTimeout(timer); }
  };
  await attempt({target:'api',state:app ? 'closed':'not_started'},async () => {
    if (app) await close(() => app!.close(),'API');
  });
  await attempt({target:'database',state:db ? 'closed':'not_started'},async () => {
    if (db) await close(() => db!.close(),'DATABASE');
  });
  for (const [kind,name] of [['container',container],['network',network]] as const) {
    const record: CleanupRecord = {target:kind,name,state:'failed'};
    await attempt(record,() => cleanupTemporary(kind,name,record));
  }
  return records;
}

async function main() {
  const credential = JSON.parse(await readFile(path.join(root,'.data/desktop-runner/credentials.json'),'utf8'));
  const headers = { authorization: `Bearer ${credential.token}` };
  const runnerFetch = async (route: string, body?: unknown) => {
    const response = await fetch(credential.url+route,{ method: body ? 'POST':'GET',
      headers: { ...headers, ...(body ? {'content-type':'application/json'} : {}) },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(280000) });
    const value = await response.json();
    return { status: response.status, value };
  };
  const capabilities = runnerCapabilitiesSchema.parse((await runnerFetch('/v2/capabilities')).value);
  assert.equal(capabilities.state,'ready','RUNNER_MUST_BE_READY');
  const info = JSON.parse((await docker(['info','--format','{{json .}}'])).stdout);
  const runtimeHost = { node:process.version,platform:process.platform,verificationCommand:'pnpm verify:desktop:v2',
    dockerVersion:info.ServerVersion,kernel:info.KernelVersion,operatingSystem:info.OperatingSystem,
    architecture:info.Architecture,cgroupVersion:info.CgroupVersion,dockerMemoryBytes:info.MemTotal,
    controlImage:(await docker(['inspect','--format','{{.Image}}','codelab-desktop-control'])).stdout.trim(),
    codeState:'uncommitted workspace; exact source hashes recorded below',
    implementationFiles: await Promise.all([
      'apps/api/src/worker-v2.ts','apps/api/src/runner-client-v2.ts','apps/api/src/routes-v2.ts',
      'apps/runner/src/app-v2.ts','apps/runner/src/engine-v2.ts','apps/runner/src/durable-store.ts',
      'apps/runner/src/resource-reaper.ts','apps/runner/src/docker-resources.ts',
      'scripts/verify-desktop-v2.ts',
    ].map(async file=>({path:file,sha256:await sha256(await readFile(path.join(root,file)))}))),
  };
  const pack = await validateTaskPack((await runnerFetch('/v2/catalog')).value.packs[0]);
  const fingerprintFor = async (rule: RuleSnapshot) => measurementFingerprintSchema.parse({
    ...capabilities.actualEnvironment.values, ruleHash: await hashRuleSnapshot(rule), parametersHash: rule.parametersHash,
  });
  await mkdir(evidenceDirectory,{recursive:true});
  await mkdir(privateDirectory,{recursive:true});
  const artifacts = new ArtifactStore({ root: path.join(privateDirectory,'evidence') });
  await docker(['network','create','--label',label,network]);
  await docker(['run','--detach','--name',container,'--label',label,'--network',network,
    '--memory','384m','--memory-swap','384m','--cpus','1','--pids-limit','128',
    '--publish','127.0.0.1::5432','--env',`POSTGRES_PASSWORD=${password}`,
    '--env','POSTGRES_DB=codelab_verify','postgres:17-alpine']);
  const port = JSON.parse((await docker(['inspect','--format','{{json .NetworkSettings.Ports}}',container])).stdout)['5432/tcp'][0].HostPort;
  let ready = false;
  for (let i=0;i<50;i++) {
    try { await docker(['exec',container,'pg_isready','-h','127.0.0.1','-p','5432','-U','postgres','-d','codelab_verify']); ready = true; break; }
    catch { await delay(250); }
  }
  assert.ok(ready,'POSTGRES_NOT_READY');
  db = postgres(`postgres://postgres:${password}@127.0.0.1:${port}/codelab_verify`);
  await migrate(db); await seed(db,password);
  const origin = 'http://127.0.0.1:5174';
  app = await createApp(db, { origin, secure:false, executionApproved:true, businessVersion:2,
    model:'unconfigured',image:'measured-desktop-v2',packs:[pack],
    approvedFingerprint: fingerprintFor, evidenceReader: evidence => artifacts.readEvidence(evidence) });
  const baseUrl = await app.listen({host:'127.0.0.1',port:0});
  type Session = { cookie: string; csrf: string };
  const login = async (email: string): Promise<Session> => {
    const response = await fetch(baseUrl+'/api/v1/session/login',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({email,password})});
    assert.equal(response.status,200,'LOGIN_FAILED');
    const value = await response.json();
    return { cookie: response.headers.getSetCookie()[0].split(';')[0], csrf:value.csrf };
  };
  const teacher = await login('teacher@codelab.local'), student = await login('student@codelab.local');
  const api = async (route: string, session: Session, method = 'GET', body?: unknown, extra: Record<string,string>={}) => {
    const response = await fetch(baseUrl+route,{method,headers:{origin,cookie:session.cookie,'x-csrf-token':session.csrf,
      'idempotency-key':randomUUID(), ...(body && !(body instanceof FormData) ? {'content-type':'application/json'}:{}), ...extra},
      body: body instanceof FormData ? body : body ? JSON.stringify(body):undefined });
    return { status:response.status, value: await response.json() };
  };
  const taskId = (await db.query('SELECT id FROM tasks LIMIT 1')).rows[0].id;
  const publishedRule = await api(`/api/v2/tasks/${taskId}/rules`,teacher,'POST',{
    packId:pack.packId,packVersion:pack.packVersion,packManifestHash:pack.contentHash,
    enabledCriterionIds:pack.criteria.map(c=>c.criterionId),parameterValues:Object.fromEntries(Object.entries(pack.parameterSchema).map(([key,value])=>[key,value.default])),confirmed:true,
  });
  assert.equal(publishedRule.status,201,`RULE_CREATION_FAILED:${JSON.stringify(publishedRule.value)}`);
  const rule: RuleSnapshot = publishedRule.value.rule;
  const realRunner = createRunnerClientV2({baseUrl:credential.url,token:credential.token});
  let capturedRequest: RunnerExecuteRequest|undefined, capturedResponse: RunnerExecuteResponse|undefined;
  let probeCapture: { request: RunnerProbeRequest; response: RunnerProbeResponse } | undefined;
  const getCapture = (): { request?: RunnerExecuteRequest; response?: RunnerExecuteResponse } =>
    ({ request: capturedRequest, response: capturedResponse });
  let executeCalls = 0, queryCalls = 0, loseFirstResponse = true;
  let inspectedResources: unknown[] = [];
  let inspectionFailure: string|undefined;
  const mountInspections: unknown[] = [];
  const networkInspections: unknown[] = [];
  const inspectOwnerMounts = async (owner: RunnerProbeRequest['owner'], expectedRoles: string[]) => {
    const networkIds = (await docker(['network','ls','-q','--no-trunc','--filter',`label=codelab.owner=${owner.ownerId}`,
      '--filter',`label=codelab.owner-kind=${owner.ownerKind}`])).stdout.trim().split(/\s+/).filter(Boolean);
    if(expectedRoles.includes('web'))assert.equal(networkIds.length,1,'OWNER_NETWORK_MISSING');
    for(const id of networkIds){
      const network=JSON.parse((await docker(['network','inspect',id])).stdout)[0];
      assert.equal(network.Labels['codelab.run'],owner.runId);
      validateIsolatedNetwork(network);
      networkInspections.push({ownerKind:owner.ownerKind,ownerId:owner.ownerId,id:network.Id,
        internal:network.Internal,options:network.Options,ipam:network.IPAM});
    }
    await writeFile(path.join(evidenceDirectory,'network-inspections.json'),JSON.stringify(networkInspections,null,2));
    const ids = (await docker(['ps','-aq','--no-trunc','--filter',`label=codelab.owner=${owner.ownerId}`,
      '--filter',`label=codelab.owner-kind=${owner.ownerKind}`])).stdout.trim().split(/\s+/).filter(Boolean);
    const observedRoles: string[] = [];
    for (const id of ids) {
      const item = JSON.parse((await docker(['inspect',id])).stdout)[0];
      assert.equal(item.Config.Labels['codelab.run'],owner.runId,'MOUNT_RUN_MISMATCH');
      const role = item.Config.Labels['codelab.resource-role'];
      const mapping: Record<string,[string,string]> = {build:['submission','/submission'],web:['out','/site'],check:['artifacts','/input'],probe:['probe','/input']};
      assert.ok(Object.hasOwn(mapping,role),'UNEXPECTED_MOUNT_ROLE');
      const [directory,target] = mapping[role];
      const mounts = item.HostConfig.Mounts;
      assert.equal(mounts.length,1,'EXCESS_PERSISTENT_MOUNTS');
      const mount = mounts[0];
      assert.equal(mount.Type,'volume');
      assert.equal(mount.Source,'codelab-desktop-runner-v2');
      assert.equal(mount.Target,target);
      assert.equal(mount.ReadOnly,true);
      assert.equal(mount.VolumeOptions?.Subpath,`resources/${owner.ownerKind}-${owner.ownerId}/${directory}`,'CROSS_OWNER_MOUNT');
      observedRoles.push(role);
      mountInspections.push({ownerKind:owner.ownerKind,ownerId:owner.ownerId,role,containerId:id,mount});
    }
    assert.deepEqual(observedRoles.sort(),[...expectedRoles].sort(),'MISSING_OWNER_MOUNT_INSPECTION');
    await writeFile(path.join(evidenceDirectory,'mount-inspections.json'),JSON.stringify(mountInspections,null,2));
  };
  const runner = { ...realRunner,
    prepareProbe: async (...args: Parameters<NonNullable<typeof realRunner.prepareProbe>>) => {
      const response = await realRunner.prepareProbe!(...args);
      await inspectOwnerMounts(args[0].probe.owner,['build','web']);
      return response;
    },
    probe: async (...args: Parameters<typeof realRunner.probe>) => {
      const response = await realRunner.probe(...args);
      await inspectOwnerMounts(args[0].owner,args[0].owner.ownerKind==='analysis'?['build','web','probe']:['build','web','check','probe']);
      return response;
    },
    execute: async (...args: Parameters<typeof realRunner.execute>) => {
      executeCalls++; capturedRequest = args[0];
      const response = await realRunner.execute(...args); capturedResponse = response;
      try {
      const ids = (await docker(['ps','--all','--quiet','--no-trunc','--filter',`label=codelab.run=${args[0].context.runId}`])).stdout.trim().split(/\s+/).filter(Boolean);
      inspectedResources = [];
      for (const id of ids) {
        const item = JSON.parse((await docker(['container','inspect',id])).stdout)[0];
        assert.equal(item.HostConfig.Privileged,false,'CHILD_PRIVILEGED');
        assert.equal(item.Config.User,'1000:1000','CHILD_USER');
        assert.equal(item.HostConfig.ReadonlyRootfs,true,'CHILD_ROOTFS');
        assert.ok(item.HostConfig.CapDrop.includes('ALL'),'CHILD_CAPABILITIES');
        const role = item.Config.Labels['codelab.resource-role'] as string;
        const expectedMemory: Record<string,number> = {build:1073741824,web:134217728,check:1610612736};
        assert.ok(Object.hasOwn(expectedMemory,role),'CHILD_ROLE');
        assert.equal(item.HostConfig.Memory,expectedMemory[role],'CHILD_MEMORY');
        assert.equal(item.HostConfig.MemorySwap,expectedMemory[role],'CHILD_MEMORY_SWAP');
        assert.equal(item.HostConfig.NanoCpus,1000000000,'CHILD_CPU');
        assert.equal(item.HostConfig.PidsLimit,role==='check' || role==='probe'?256:128,'CHILD_PIDS');
        assert.ok(item.HostConfig.SecurityOpt?.includes('no-new-privileges'),'CHILD_NO_NEW_PRIVILEGES');
        const portsPublished = Object.values(item.NetworkSettings.Ports ?? {}).some(value=>value!==null);
        assert.equal(portsPublished,false,'CHILD_PUBLISHED_PORT');
        assert.ok(!(item.Config.Env as string[]).some(value=>/^(RUNNER_TOKEN|DATABASE_URL|MODEL_API_KEY|POSTGRES_PASSWORD)=/.test(value)),'CHILD_HAS_CONTROL_CREDENTIAL');
        assert.ok((item.Mounts as any[]).every(mount=>
          (mount.Type === 'volume' && ['/submission','/site','/input'].includes(mount.Destination) && mount.RW===false) ||
          (mount.Type === 'tmpfs' && ['/tmp','/workspace','/out','/artifacts'].includes(mount.Destination))),'CHILD_MOUNT_SCOPE');
        if(role==='build') assert.match(item.HostConfig.Tmpfs['/out'],/size=64m/,'BUILD_OUTPUT_QUOTA');
        if(role==='check') assert.match(item.HostConfig.Tmpfs['/artifacts'],/size=32m/,'CHECK_OUTPUT_QUOTA');
        inspectedResources.push({id:item.Id,role:item.Config.Labels['codelab.resource-role'],
          user:item.Config.User,capDrop:item.HostConfig.CapDrop,securityOpt:item.HostConfig.SecurityOpt,
          readOnlyRootfs:item.HostConfig.ReadonlyRootfs,memory:item.HostConfig.Memory,memorySwap:item.HostConfig.MemorySwap,
          nanoCpus:item.HostConfig.NanoCpus,pidsLimit:item.HostConfig.PidsLimit,
          networkMode:item.HostConfig.NetworkMode,mounts:item.HostConfig.Mounts,tmpfs:item.HostConfig.Tmpfs,
          hasControlCredentials:false,portsPublished,
        });
      }
      } catch (error) {
        inspectionFailure = error instanceof Error && !error.message.startsWith('Command failed:') ?
          error.message : 'CHILD_INSPECTION_FAILED';
        throw error;
      }
      await inspectOwnerMounts({runId:args[0].context.runId,ownerKind:'execution',ownerId:args[0].context.executionAttemptId,ownerToken:args[0].ownerToken},
        response.outcome==='complete'?['build','web','check']:['build']);
      if (verifyProbe && response.outcome === 'complete') {
        // Controlled runner integration only: no model or production analysis budget claim.
        const baseHash=await sha256(canonicalJson(response));
        const request: RunnerProbeRequest={protocolVersion:2,context:args[0].context,
          owner:{runId:args[0].context.runId,ownerKind:'execution',ownerId:args[0].context.executionAttemptId,ownerToken:args[0].ownerToken},
          analysisAttemptId:randomUUID(),operationId:randomUUID(),requestId:randomUUID(),requestHash:'0'.repeat(64),
          probeId:'FILTER_ORDER_CHECK',parameters:{},budgetConfigVersion:args[0].budgetConfigVersion,
          workDeadlineAt:args[0].workDeadlineAt,hardDeadlineAt:args[0].hardDeadlineAt,
          remainingWorkMs:Math.min(20_000,Date.parse(args[0].workDeadlineAt)-Date.now())};
        request.requestHash=await hashProbeRequest(request);
        const supplemental=await realRunner.probe(request,rule,{timeoutMs:25_000});
        await inspectOwnerMounts(request.owner,['build','web','check','probe']);
        assert.equal(await sha256(canonicalJson(response)),baseHash,'PROBE_CHANGED_BASE');
        const observation=JSON.parse(Buffer.from(supplemental.artifacts[0].data,'base64').toString('utf8')).observation;
        assert.equal(observation.baseResultsModified,false);
        assert.ok(supplemental.stepCaptures,'PROBE_CAPTURES_MISSING');
        const images=supplemental.supplementalManifest.evidence.filter(e=>e.mediaType==='image/png');
        assert.ok(images.length>0,'PROBE_IMAGES_MISSING');
        if(currentCheck==='correct' || currentCheck==='filter-order-defect') {
          assert.equal(images.length,10,'PROBE_IMAGES_INCOMPLETE');
          assert.equal(supplemental.supplementalManifest.completeness,'complete');
        }
        for(const image of images) {
          const payload=supplemental.artifacts.find(a=>a.evidenceId===image.evidenceId)!;
          const bytes=Buffer.from(payload.data,'base64');
          assert.equal(await sha256(bytes),image.sha256);
          await writeFile(path.join(evidenceDirectory,`${currentCheck}-probe-${image.evidenceId}.png`),bytes);
        }
        if(currentCheck==='correct') assert.equal(observation.comparison,'same_observed_set');
        if(currentCheck==='filter-setup-blocked') assert.equal(observation.comparison,'inconclusive');
        if(currentCheck==='filter-setup-blocked') {
          assert.equal(supplemental.supplementalManifest.completeness,'partial');
          assert.equal(images.length,4);
          assert.ok(observation.paths.every((p:any)=>p.status==='blocked' && p.executedSteps.every((s:any)=>s.phase==='setup')));
        }
        if(currentCheck==='filter-order-defect') {
          assert.equal(observation.comparison,'different_observed_set');
          assert.equal(observation.paths[0].observations.at(-1).matches,false);
          assert.equal(observation.paths[1].observations.at(-1).matches,true);
        }
        probeCapture={request,response:supplemental};
        await writeFile(path.join(evidenceDirectory,`${currentCheck}-probe.json`),JSON.stringify({
          verificationKind:'constructed_runner_integration',realModel:false,baseResponseSha256:baseHash,response:supplemental,observation},null,2));
      }
      if (loseFirstResponse) { loseFirstResponse = false; throw new RunnerClientError('transport','INJECTED_RESPONSE_LOSS'); }
      return response;
    },
    query: async (...args: Parameters<typeof realRunner.query>) => { queryCalls++; return realRunner.query(...args); },
  };
  const registry = JSON.parse(await readFile(path.join(root,'fixtures/manifest.json'),'utf8'));
  registry.samples.push(JSON.parse(await readFile(path.join(root,'fixtures/independent-manifest.json'),'utf8')));
  registry.samples.push(...JSON.parse(await readFile(path.join(root,'fixtures/independent-defects-manifest.json'),'utf8')).samples);
  const samples = [['correct','passed','passed'],['create-missing','failed','not_run'],['create-duplicate','failed','not_run'],['build-error','not_run','not_run'],['filter-defect','passed','failed'],['filter-setup-blocked','passed','not_run'],['fixed-with-regression','passed','passed'],['correct-independent','passed','passed'],['validation-empty-defect','passed','passed'],['validation-space-defect','passed','passed'],['state-reverse-defect','passed','passed']] as const;
  const requested = process.argv.slice(2).filter(arg=>!['--probe','--reanalysis','--cpu','--manual-decision'].includes(arg));
  if (requested.some(name => name!=='filter-order-defect' && !samples.some(([id]) => id === name))) throw new Error('UNKNOWN_VERIFICATION_SAMPLE');
  const selected: Array<readonly [string,string,string]> = verifyCpu
    ? [['cpu-busy-page','not_run','not_run']]
    : samples.filter(([name]) => !requested.length || requested.includes(name));
  if(requested.includes('filter-order-defect')) selected.push(['filter-order-defect','passed','failed']);
  if (verifyCpu && (verifyProbe || verifyReanalysis || requested.length)) throw new Error('CPU_SCENARIO_MUST_RUN_ALONE');
  for (const [sample,expected,filterExpected] of selected) {
    mountInspections.length = 0;
    currentCheck = sample;
    console.log(`真实验证 ${sample}：上传 ZIP、构建、检查、存档与清理。`);
    let zip: Uint8Array = await readFile(path.join(root,'fixtures',`${verifyCpu||sample==='filter-order-defect'?'correct':sample}.zip`));
    if(sample==='filter-order-defect') {
      const files=unzipSync(zip), original=Buffer.from(files['src/App.vue']).toString('utf8');
      const expression="filter.value==='all'||(filter.value==='done'?t.done:!t.done)";
      assert.ok(original.includes(expression)&&original.includes('const visible='),'ORDER_FIXTURE_ANCHOR_CHANGED');
      files['src/App.vue']=Buffer.from(original.replace('const visible=',"const visitedActive=ref(false);watch(filter,value=>{if(value==='active')visitedActive.value=true;});\nconst visible=")
        .replace(expression,"filter.value==='all'||(filter.value==='done'&&!visitedActive.value)||(filter.value==='done'?t.done:!t.done)"));
      zip=zipSync(files);
      await writeFile(path.join(evidenceDirectory,'filter-order-defect.zip'),zip);
      await writeFile(path.join(evidenceDirectory,'filter-order-defect-origin.json'),JSON.stringify({
        kind:'constructed_template_derivative',purpose:'development',frozenEvaluationEligible:false,
        parent:'fixtures/correct.zip',changedPath:'src/App.vue',sourceSha256:await sha256(files['src/App.vue']),
        change:'Direct all-to-done includes all tasks until active has been selected; no other feature change intended.',
      },null,2));
    }
    if (verifyCpu) {
      const files = unzipSync(zip);
      assert.ok(files['src/App.vue'],'CPU_FIXTURE_APP_MISSING');
      const originalApp = Buffer.from(files['src/App.vue']).toString('utf8');
      assert.ok(originalApp.includes('<script setup>'),'CPU_FIXTURE_SCRIPT_MISSING');
      // Preserve the correct sample's controls; only block its page execution.
      files['src/App.vue'] = Buffer.from(originalApp.replace('</script>',
        '\nwhile (true) { globalThis.__codelabCpuFaultTicks = (globalThis.__codelabCpuFaultTicks || 0) + 1; }\n</script>'));
      zip = zipSync(files);
      await writeFile(path.join(evidenceDirectory,'cpu-busy-page.zip'),zip);
    }
    const form = new FormData(); form.set('file',new Blob([Buffer.from(zip)]),`${sample}.zip`);
    const submission = await api(`/api/v2/tasks/${taskId}/submissions`,student,'POST',form,{'x-rule-id':rule.ruleId});
    assert.equal(submission.status,201,`UPLOAD_FAILED:${JSON.stringify(submission.value)}`);
    const queued = await api(`/api/v2/submissions/${submission.value.submissionId}/runs`,student,'POST',{});
    assert.equal(queued.status,202,`ENQUEUE_FAILED:${JSON.stringify(queued.value)}`);
    capturedRequest = undefined; capturedResponse = undefined; inspectionFailure = undefined; probeCapture=undefined;
    const beforeCalls = executeCalls, beforeQueries = queryCalls;
    const work = await runOneV2({db,runner,artifacts,approvedFingerprint:await fingerprintFor(rule),queryPollMs:100});
    assert.equal(inspectionFailure,undefined,'CHILD_RESOURCE_VERIFICATION_FAILED');
    assert.equal(work.state,'completed',`WORKER_FAILED:${JSON.stringify(work)}`);
    assert.equal(executeCalls-beforeCalls,1,'DUPLICATE_EXECUTE');
    const actualRun = getCapture();
    assert.ok(actualRun.request && actualRun.response,'NO_REAL_RESPONSE');
    const runRequest = actualRun.request, runResponse = actualRun.response;
    await writeFile(path.join(evidenceDirectory,`${sample}-response.json`),JSON.stringify({...runResponse,artifacts:undefined},null,2));
    const declared = registry.samples.find((item: any) => item.sampleId === sample);
    assert.equal(runResponse.caseResults.length,rule.requiredCaseIds.length,'CASE_COVERAGE');
    for (const actual of runResponse.caseResults) {
      const expectedCase = verifyCpu ? {verdict:'not_run'} : sample==='filter-order-defect'
        ? {verdict:actual.caseId==='FILTER-03'?'failed':'passed'} : declared.expectedCases.find((item: any) => item.caseId === actual.caseId);
      assert.equal(actual.verdict,expectedCase.verdict,`${sample}:${actual.caseId}:WRONG_VERDICT`);
    }
    assert.equal(runResponse.caseResults[0].verdict,expected,'WRONG_VERDICT');
    const filterResult = runResponse.caseResults.find(item => item.caseId === 'FILTER-03');
    assert.ok(filterResult, 'FILTER_RESULT_MISSING');
    assert.equal(filterResult.verdict, filterExpected, 'WRONG_FILTER_VERDICT');
    if (sample === 'filter-setup-blocked') {
      assert.equal(filterResult.preconditionStatus, 'blocked');
      assert.ok(filterResult.executedSteps.every(step => step.phase === 'setup'), 'BLOCKED_FILTER_ACTION_EXECUTED');
    }
    // Individual browser steps can time out while the runner completes collection normally.
    assert.equal(runResponse.outcome,sample==='build-error' ? 'build_error':'complete');
    if (verifyCpu) {
      assert.ok(runResponse.caseResults.every(item=>item.reasonCode==='TIME_BUDGET'),'CPU_TIMEOUT_NOT_OBSERVED');
      assert.ok(runResponse.caseResults.every(item=>item.executedSteps.some(step=>step.state==='interrupted')),'CPU_INTERRUPTION_NOT_OBSERVED');
      assert.ok(runResponse.caseResults.every(item=>!item.executedSteps.some(step=>step.phase==='assert')),'CPU_FAULT_FABRICATED_ASSERTION');
      const persisted: any=(await db.query('SELECT owner_phase,cleanup_state FROM execution_attempts WHERE id=$1',[runRequest.context.executionAttemptId])).rows[0];
      assert.equal(persisted.owner_phase,'closed'); assert.equal(persisted.cleanup_state,'clean');
    }
    assert.equal(inspectedResources.length,sample==='build-error'?1:3,'MISSING_CHILD_RESOURCE_INSPECTION');
    if (sample==='build-error') assert.equal(runResponse.caseResults[0].executedSteps.length,0);
    const replay = await realRunner.execute(runRequest);
    assert.equal(canonicalJson(replay),canonicalJson(runResponse),'REPLAY_CHANGED_RESULT');
    assert.equal((await realRunner.capabilities()).state,'ready','CLEANUP_NOT_READY');
    if(probeCapture) {
      const saved=probeCapture as {request:RunnerProbeRequest;response:RunnerProbeResponse};
      assert.equal(canonicalJson(await realRunner.probe(saved.request,rule)),canonicalJson(saved.response),'PROBE_REPLAY_CHANGED_AFTER_CLEANUP');
    }
    for (const item of runResponse.baseManifest.evidence) {
      const bytes = await artifacts.readEvidence(item);
      const extension = item.mediaType==='image/png'?'png':item.mediaType==='application/json'?'json':'txt';
      await writeFile(path.join(evidenceDirectory,`${sample}-${item.evidenceId}.${extension}`),bytes);
    }
    const privateDraft = await api(`/api/v2/runs/${queued.value.runId}/review`,student);
    assert.equal(privateDraft.status,404,'STUDENT_READ_DRAFT');
    const review = await api(`/api/v2/runs/${queued.value.runId}/review`,teacher);
    assert.equal(review.status,200,'TEACHER_REVIEW_FAILED');
    if(verifyReanalysis && runResponse.outcome==='complete') {
      const configuration={provider:'synthetic-verification',model:'scripted-tool-decision',endpoint:'http://127.0.0.1/not-called'};
      const queuedAnalysis=await enqueueReanalysisV2(db,{runId:queued.value.runId,actorId:rule.confirmedBy,idempotencyKey:randomUUID(),
        body:{expectedRevisionId:review.value.revision.revisionId},configuration});
      const beforeBase=canonicalJson((await db.query('SELECT base_results,base_manifest,actual_fingerprint FROM execution_attempts WHERE id=$1',[runRequest.context.executionAttemptId])).rows[0]);
      const beforeExecutions=executeCalls;
      let modelCalls=0;
      const analyzed=await runOneV2({db,runner,artifacts,approvedFingerprint:await fingerprintFor(rule),summaryProvider:{configuration,
        complete:async request=>{
          modelCalls++;
          const content=JSON.stringify(modelCalls===1?{type:'tool',name:'run_probe',args:{probeId:'FILTER_ORDER_CHECK',parameters:{}}}:
            {type:'final',feedback:JSON.parse(request.user).initial.baseFeedback});
          return {content,raw:content,requestId:'synthetic-decision-no-model-call',usage:{inputTokens:100,outputTokens:100}};
        }}});
      assert.equal(analyzed.state,'completed',`REANALYSIS_WORKER_FAILED:${JSON.stringify(analyzed)}`);
      const attempt:Record<string,any>=(await db.query('SELECT status,owner_phase,cleanup_state,control_operations,usage FROM analysis_attempts WHERE id=$1',[queuedAnalysis.analysis.analysisAttemptId])).rows[0];
      assert.equal(attempt.status,'succeeded',`REANALYSIS_NOT_SUCCEEDED:${JSON.stringify(attempt)}`);
      const checkpointCount=Number((await db.query('SELECT count(*) AS total FROM analysis_checkpoints WHERE analysis_attempt_id=$1',[queuedAnalysis.analysis.analysisAttemptId])).rows[0].total);
      assert.ok(checkpointCount>=3,'LANGGRAPH_CHECKPOINTS_MISSING');
      // Restore a populated checkpoint database, not merely an empty schema.
      // This second database lives only inside this run's owned temporary container.
      const restoreDatabase = `restore_${randomUUID().replaceAll('-', '')}`;
      await docker(['exec',container,'pg_dump','-U','postgres','-d','codelab_verify','-Fc','-f','/tmp/checkpoints.dump']);
      await docker(['exec',container,'createdb','-U','postgres',restoreDatabase]);
      await docker(['exec',container,'pg_restore','--exit-on-error','-U','postgres','-d',restoreDatabase,'/tmp/checkpoints.dump']);
      const restoredCheckpointDb=postgres(`postgres://postgres:${password}@127.0.0.1:${port}/${restoreDatabase}`);
      let restoredCheckpointWrites=0;
      try {
        for(const table of ['analysis_checkpoints','analysis_checkpoint_writes']) {
          const query=`SELECT * FROM ${table} WHERE analysis_attempt_id=$1 ORDER BY checkpoint_id${table==='analysis_checkpoint_writes'?',task_id,write_index':''}`;
          const original: unknown[]=(await db.query(query,[queuedAnalysis.analysis.analysisAttemptId])).rows;
          const restored=(await restoredCheckpointDb.query(query,[queuedAnalysis.analysis.analysisAttemptId])).rows;
          assert.deepEqual(restored,original,'RESTORED_CHECKPOINT_CONTENT_MISMATCH');
          if(table==='analysis_checkpoint_writes') restoredCheckpointWrites=restored.length;
        }
        assert.ok(restoredCheckpointWrites>0,'NO_PENDING_WRITES_RESTORED');
      } finally {
        await restoredCheckpointDb.close();
        await docker(['exec',container,'dropdb','-U','postgres',restoreDatabase]);
        await docker(['exec',container,'rm','-f','/tmp/checkpoints.dump']);
      }
      assert.equal(attempt.control_operations.prepareProbe?.state,'completed','PREPARATION_NOT_COMPLETE');
      assert.equal(attempt.cleanup_state,'clean');assert.equal(attempt.owner_phase,'closed');
      const operations: {kind:string;state:string;error:unknown;supplemental_manifest:ArtifactManifest|null}[]=(await db.query('SELECT kind,state,error,supplemental_manifest FROM analysis_operations WHERE analysis_attempt_id=$1 ORDER BY operation_id',[queuedAnalysis.analysis.analysisAttemptId])).rows;
      assert.ok(operations.some(op=>op.kind==='run_probe' && op.state==='completed'),`PROBE_NOT_COMPLETED:${JSON.stringify(operations)}`);
      assert.equal(modelCalls,2);assert.equal(executeCalls,beforeExecutions,'REANALYSIS_RERAN_BASE');
      assert.equal(canonicalJson((await db.query('SELECT base_results,base_manifest,actual_fingerprint FROM execution_attempts WHERE id=$1',[runRequest.context.executionAttemptId])).rows[0]),beforeBase);
      assert.equal((await api(`/api/v2/runs/${queued.value.runId}/review`,teacher)).value.revision.revisionId,review.value.revision.revisionId,'REANALYSIS_CHANGED_TEACHER_REVISION');
      assert.equal((await realRunner.capabilities()).state,'ready');
      const screenshotDownloads=[];
      for(const op of operations) for(const evidence of op.supplemental_manifest?.evidence ?? []) {
        const bytes=await artifacts.readEvidence(evidence);
        await writeFile(path.join(evidenceDirectory,`${sample}-reanalysis-${evidence.evidenceId}.${evidence.mediaType==='image/png'?'png':'json'}`),bytes);
        if(evidence.mediaType==='image/png') {
          const route=baseUrl+`/api/v2/runs/${queued.value.runId}/evidence/${evidence.evidenceId}`;
          const downloaded=await fetch(route,{headers:{cookie:teacher.cookie}});
          assert.equal(downloaded.status,200,'TEACHER_PROBE_IMAGE_HTTP');
          assert.equal(await sha256(new Uint8Array(await downloaded.arrayBuffer())),evidence.sha256,'TEACHER_PROBE_IMAGE_HASH');
          assert.equal((await fetch(route,{headers:{cookie:student.cookie}})).status,404,'STUDENT_PRIVATE_PROBE_IMAGE');
          screenshotDownloads.push({evidenceId:evidence.evidenceId,teacherStatus:200,studentStatus:404,hashVerified:true});
        }
      }
      assert.ok(screenshotDownloads.length>0,'REANALYSIS_SCREENSHOTS_MISSING');
      // Real frontend, isolated generated API/database. No request reaches the live business API.
      const browser=await chromium.launch({channel:'chrome',headless:true});
      try {
        const page=await browser.newPage({viewport:{width:1440,height:1000}});
        const pageErrors:string[]=[];page.on('pageerror',e=>pageErrors.push(e.message));
        await page.route('**/api/**',async route=>{
          const requested=new URL(route.request().url());
          const response=await route.fetch({url:baseUrl+requested.pathname+requested.search,maxRetries:0});
          await route.fulfill({response});
        });
        await page.goto(`http://127.0.0.1:5174/runs/${queued.value.runId}`);
        await page.getByLabel('邮箱').fill('teacher@codelab.local');
        await page.getByLabel('密码',{exact:true}).fill(password);
        await page.getByRole('button',{name:'登录',exact:true}).click();
        await page.locator('.review-nav-item').filter({hasText:'CK-04'}).click();
        await page.locator('.supplemental-preview summary').click();
        await page.getByRole('group',{name:'查看未采纳的补充材料'}).getByRole('button',{name:/补充截图/}).first().click();
        const image=page.locator('.v2-evidence img');
        await expect(image).toBeVisible();
        await expect.poll(()=>image.evaluate((el:HTMLImageElement)=>el.complete&&el.naturalWidth>0)).toBe(true);
        await page.screenshot({path:path.join(evidenceDirectory,`${sample}-teacher-supplemental.png`),fullPage:true});
        const afterRead=await api(`/api/v2/runs/${queued.value.runId}/review`,teacher);
        assert.equal(afterRead.value.revision.revisionId,review.value.revision.revisionId,'PREVIEW_CHANGED_REVISION');
        assert.deepEqual(afterRead.value.revision.selectedSupplementalManifestIds,review.value.revision.selectedSupplementalManifestIds,'PREVIEW_SELECTED_EVIDENCE');
        assert.deepEqual(pageErrors,[]);
      } finally { await browser.close(); }
      await writeFile(path.join(evidenceDirectory,`${sample}-reanalysis.json`),JSON.stringify({source:'constructed_execution_with_synthetic_model_decisions',
        realModel:false,analysisAttemptId:queuedAnalysis.analysis.analysisAttemptId,modelCalls,checkpointCount,checkpointRestore:{passed:true,checkpoints:checkpointCount,pendingWrites:restoredCheckpointWrites},operations,attempt,screenshotDownloads,baseUnchanged:true,teacherRevisionUnchanged:true},null,2));
    }
    // Engineering walkthrough via a generated teacher account; never a real teacher outcome claim.
    const edited = await api(`/api/v2/runs/${queued.value.runId}/review`,teacher,'PUT',{
      expectedRevisionId:review.value.revision.revisionId,
      teacherJudgments:[{targetType:'manualCriterion',targetId:'readability',verdict:verifyManualDecision ? 'passed' : 'manual',
        reason:verifyManualDecision ? '工程模拟明确结论，用于验证人工判断发布通路；不是代码可读性或教学质量评价。' : '工程走查保留人工待判断状态；不将自动检查替代课程教师判断。',verificationMethod:'other_documented',evidenceRefs:[],
        verificationNote:'本次为团队样本的示例教师账号接口验收，没有真实教师参与评测。'}],
    });
    assert.equal(edited.status,201,`EDIT_FAILED:${JSON.stringify(edited.value)}`);
    const review2 = await api(`/api/v2/runs/${queued.value.runId}/review`,teacher);
    if (verifyManualDecision) {
      const manual = review2.value.reviewedResults.find((item:any)=>item.criterionId==='readability');
      assert.equal(manual.automaticVerdict,'manual','MANUAL_BASE_FACT_CHANGED');
      assert.equal(manual.reviewedVerdict,'passed','MANUAL_DECISION_NOT_APPLIED');
    }
    const confirmed = await api(`/api/v2/runs/${queued.value.runId}/review/confirm`,teacher,'POST',{
      expectedRevisionId:review2.value.revision.revisionId,
      items:Object.entries(review2.value.criterionContentHashes).map(([criterionId,contentHash])=>({criterionId,contentHash})),
    });
    assert.equal(confirmed.status,201,`CONFIRM_FAILED:${JSON.stringify(confirmed.value)}`);
    const publicIds = runResponse.baseManifest.evidence.filter(item=>item.phase!=='diagnostic').map(item=>item.evidenceId);
    const publication = await api(`/api/v2/runs/${queued.value.runId}/publications`,teacher,'POST',{
      expectedRevisionId:confirmed.value.revision.revisionId,purpose:'latest',publicEvidenceIds:publicIds,
    });
    assert.equal(publication.status,201,`PUBLISH_FAILED:${JSON.stringify(publication.value)}`);
    const publicationId = publication.value.publication.publicationId;
    const visible = await api(`/api/v2/publications/${publicationId}`,student);
    assert.equal(visible.status,200,'STUDENT_PUBLICATION_FAILED');
    if (verifyManualDecision) {
      const manual = visible.value.publication.snapshot.reviewedResults.find((item:any)=>item.criterionId==='readability');
      assert.equal(manual.automaticVerdict,'manual','PUBLISHED_MANUAL_BASE_CHANGED');
      assert.equal(manual.reviewedVerdict,'passed','PUBLISHED_MANUAL_DECISION_MISSING');
    }
    const firstPublic = runResponse.baseManifest.evidence.find(item=>publicIds.includes(item.evidenceId))!;
    const download = await fetch(baseUrl+`/api/v2/publications/${publicationId}/evidence/${firstPublic.evidenceId}`,{headers:{cookie:student.cookie}});
    assert.equal(download.status,200,'PUBLIC_EVIDENCE_FAILED');
    const downloaded = new Uint8Array(await download.arrayBuffer());
    assert.equal(downloaded.byteLength,firstPublic.byteSize,'PUBLIC_EVIDENCE_SIZE');
    assert.equal(await sha256(downloaded),firstPublic.sha256,'PUBLIC_EVIDENCE_HASH');
    const responseRecord = { ...runResponse, artifacts: undefined };
    await writeFile(path.join(evidenceDirectory,`${sample}-response.json`),JSON.stringify(responseRecord,null,2));
    results.push({sample,source:'constructed_execution',runId:queued.value.runId,submission:submission.value,
      operationId:runRequest.operationId,requestHash:runRequest.requestHash,verdict:expected,
      filterVerdict: filterResult.verdict, filterPrecondition: filterResult.preconditionStatus,
      cases: runResponse.caseResults.map(item => ({caseId:item.caseId,verdict:item.verdict,preconditionStatus:item.preconditionStatus})),
      outcome:runResponse.outcome,executedSteps:runResponse.caseResults[0].executedSteps.length,
      evidenceCount:runResponse.baseManifest.evidence.length,worker:work,executeCalls:executeCalls-beforeCalls,
      queryCalls:queryCalls-beforeQueries,replayedResponseIdentical:true,publicationId,
      studentDraftStatus:privateDraft.status,studentPublicationStatus:visible.status,publicEvidenceStatus:download.status,
      apiEvidenceScope:'generated teacher and student accounts; no real teacher evaluation',
      manualDecision:verifyManualDecision ? {source:'synthetic_engineering_judgment',automaticVerdict:'manual',reviewedVerdict:'passed',studentSnapshotVerified:true} : null,
      inspectedResources,
      mountInspections: mountInspections.filter((entry:any)=>entry.ownerId===runRequest.context.executionAttemptId || entry.ownerKind==='analysis'),
    });
    console.log(`${sample}：${runResponse.caseResults.map(item=>`${item.caseId}=${item.verdict}`).join('，')}；证据 ${runResponse.baseManifest.evidence.length} 份，发布读取和清理通过。`);
    await writeFile(path.join(evidenceDirectory,'results.json'),JSON.stringify({startedAt,source:'Docker Desktop development verification',runtimeHost,pack,capabilities,results,recoveryResults},null,2));
  }
  // Reuse controlled correct input only. Shortened budgets exercise timeout; no hostile resource workload.
  const baseRequest = getCapture().request!;
  async function newRequest(workMs: number, leaseMs: number): Promise<RunnerExecuteRequest> {
    const { validateZip } = await import('../apps/api/src/zip.js');
    const { createSourceManifest } = await import('../packages/contracts/src/v2/index.js');
    const validated = await validateZip(await readFile(path.join(root,'fixtures/correct.zip')));
    const files = Object.fromEntries(Object.entries(validated.files).filter(([name])=>/^(src|public)\//.test(name)));
    const sourceManifestSha256 = (await createSourceManifest(files)).sourceManifestSha256;
    const start = Date.now();
    const value = { ...baseRequest, files, context:{...baseRequest.context,runId:randomUUID(),executionAttemptId:randomUUID(),
        submissionId:randomUUID(),originalZipSha256:validated.sha256,sourceManifestSha256},
      operationId:randomUUID(),requestId:randomUUID(),ownerToken:randomUUID(),startedAt:new Date(start).toISOString(),
      workDeadlineAt:new Date(start+workMs).toISOString(),hardDeadlineAt:new Date(start+workMs+30000).toISOString(),
      leaseUntil:new Date(start+leaseMs).toISOString(),remainingWorkMs:workMs,
    };
    value.requestHash = await hashExecuteRequest(value);
    return value;
  }
  const ownerOf = (request: RunnerExecuteRequest) => ({runId:request.context.runId,ownerKind:'execution' as const,
    ownerId:request.context.executionAttemptId,ownerToken:request.ownerToken});
  const waitClean = async () => {
    for (let i=0;i<55;i++) {
      try { const state=await realRunner.capabilities({timeoutMs:3000}); if(state.state==='ready') return state; } catch {}
      await delay(1000);
    }
    throw new Error('REAPER_DID_NOT_CLEAN');
  };
  const cleanupReceipt = async (request: RunnerExecuteRequest) => {
    const unsigned={protocolVersion:2 as const,owner:ownerOf(request),operationId:randomUUID(),requestId:randomUUID()};
    return realRunner.cleanup({...unsigned,requestHash:await hashCleanupRequest(unsigned)});
  };
  console.log('验证短工作期限：确认不产生虚假功能判定，独立回收恢复 ready。');
  currentCheck = 'short_deadline';
  // Leave time for admission and durable registration before expiring real work.
  const shortWorkMs = 5000;
  const short = await newRequest(shortWorkMs,10000);
  const shortReply = await runnerFetch('/v2/execute',short).catch(()=>({status:0,value:null}));
  await writeFile(path.join(evidenceDirectory,'short-deadline-response.json'),JSON.stringify(shortReply,null,2));
  await waitClean();
  const shortQuery = await realRunner.query({protocolVersion:2,owner:ownerOf(short),operationId:short.operationId,requestHash:short.requestHash});
  assert.equal(shortQuery.response,null,'EXPIRED_RESULT_MUST_NOT_SEAL');
  assert.equal(shortQuery.record.state,'unknown');
  const shortCleanup = await cleanupReceipt(short); assert.equal(shortCleanup.state,'clean');
  recoveryResults.push({test:'short_deadline',workMs:shortWorkMs,leaseMs:10000,httpStatus:shortReply.status,
    operation:shortQuery.record,cleanup:shortCleanup,readyAfterIndependentReaper:true});
  console.log('验证执行服务退出：保持回收进程运行，检查原任务资源消失与旧动作不重启。');
  currentCheck = 'runner_sigkill';
  const reaperPid = async () => Number((await docker(['exec','codelab-desktop-control','node','-e',
    "const fs=require('node:fs');for(const id of fs.readdirSync('/proc')){if(!/^\\d+$/.test(id))continue;try{if(fs.readFileSync('/proc/'+id+'/cmdline','utf8').split('\\0').includes('apps/runner/src/reaper-loop.ts')){console.log(id);break}}catch{}}"
  ])).stdout.trim());
  const originalReaperPid = await reaperPid(); assert.ok(originalReaperPid > 0,'REAPER_PROCESS_MISSING');
  const crash = await newRequest(270000,12000);
  const health = await runnerFetch('/health');
  const requestPromise = runnerFetch('/v2/execute',crash).catch(()=>({status:0,value:null}));
  let observedIds: string[]=[];
  for(let i=0;i<80;i++) {
    const list=(await docker(['ps','--all','--quiet','--no-trunc','--filter',`label=codelab.run=${crash.context.runId}`])).stdout.trim();
    if(list) { observedIds=list.split(/\s+/); break; }
    await delay(100);
  }
  assert.ok(observedIds.length,'NO_RESOURCE_BEFORE_RUNNER_KILL');
  await docker(['exec','codelab-desktop-control','node','-e',`process.kill(${Number(health.value.pid)},'SIGKILL')`]);
  await requestPromise;
  await waitClean();
  const crashQuery=await realRunner.query({protocolVersion:2,owner:ownerOf(crash),operationId:crash.operationId,requestHash:crash.requestHash});
  assert.equal(crashQuery.record.state,'unknown'); assert.equal(crashQuery.response,null);
  const replay=await runnerFetch('/v2/execute',crash); assert.equal(replay.status,202,'CRASH_REPLAY_MUST_NOT_DISPATCH');
  const actual=(await docker(['ps','--all','--quiet','--filter',`label=codelab.run=${crash.context.runId}`])).stdout.trim();
  assert.equal(actual,'','CRASH_RESOURCE_REMAINED');
  const crashCleanup=await cleanupReceipt(crash); assert.equal(crashCleanup.state,'clean');
  const finalReaperPid = await reaperPid(); assert.equal(finalReaperPid,originalReaperPid,'REAPER_PROCESS_RESTARTED');
  recoveryResults.push({test:'runner_sigkill',oldRunnerPid:health.value.pid,
    originalReaperPid,finalReaperPid,
    newRunnerPid:(await runnerFetch('/health')).value.pid,observedContainerIds:observedIds,
    operation:crashQuery.record,replayHttpStatus:replay.status,cleanup:crashCleanup,readyAfterIndependentReaper:true});
  if(verifyReanalysis){
    currentCheck='preparation_sigkill';
    console.log('验证独立分析准备环境时进程退出：原操作不重发，独立回收释放资源。');
    const timestamp=Date.now(),analysisId=randomUUID();
    const owner={runId:baseRequest.context.runId,ownerKind:'analysis' as const,ownerId:analysisId,ownerToken:randomUUID()};
    const probe:RunnerProbeRequest={protocolVersion:2,context:baseRequest.context,owner,analysisAttemptId:analysisId,
      operationId:randomUUID(),requestId:randomUUID(),requestHash:'0'.repeat(64),probeId:'FILTER_ORDER_CHECK',parameters:{},
      budgetConfigVersion:baseRequest.budgetConfigVersion,workDeadlineAt:new Date(timestamp+60_000).toISOString(),
      hardDeadlineAt:new Date(timestamp+90_000).toISOString(),remainingWorkMs:60_000};
    probe.requestHash=await hashProbeRequest(probe);
    const unsigned={protocolVersion:2 as const,operationId:randomUUID(),requestId:randomUUID(),probe,files:baseRequest.files,
      ruleSnapshot:rule,approvedFingerprint:baseRequest.approvedFingerprint,startedAt:new Date(timestamp).toISOString(),leaseUntil:new Date(timestamp+12_000).toISOString()};
    const preparation={...unsigned,requestHash:await hashPreparationRequest(unsigned)};
    const health=await runnerFetch('/health');
    const pending=runnerFetch('/v2/prepare-probe',preparation).catch(()=>({status:0,value:null}));
    let observed:string[]=[];
    for(let i=0;i<80;i++){
      observed=(await docker(['ps','--all','--quiet','--no-trunc','--filter',`label=codelab.owner=${analysisId}`])).stdout.trim().split(/\s+/).filter(Boolean);
      if(observed.length)break;await delay(100);
    }
    assert.ok(observed.length,'NO_PREPARATION_RESOURCE_BEFORE_KILL');
    await docker(['exec','codelab-desktop-control','node','-e',`process.kill(${Number(health.value.pid)},'SIGKILL')`]);
    await pending;await waitClean();
    const saved=await realRunner.query({protocolVersion:2,owner,operationId:preparation.operationId,requestHash:preparation.requestHash});
    assert.equal(saved.record.state,'unknown');assert.equal(saved.response,null);
    const replay=await runnerFetch('/v2/prepare-probe',preparation);
    assert.equal(replay.status,202);assert.equal(replay.value.record.state,'unknown');
    assert.equal((await docker(['ps','--all','--quiet','--filter',`label=codelab.owner=${analysisId}`])).stdout.trim(),'');
    const cleanupBody={protocolVersion:2 as const,owner,operationId:randomUUID(),requestId:randomUUID()};
    const cleanup=await realRunner.cleanup({...cleanupBody,requestHash:await hashCleanupRequest(cleanupBody)});
    assert.equal(cleanup.state,'clean');assert.equal(await reaperPid(),originalReaperPid);
    recoveryResults.push({test:'preparation_sigkill',source:'constructed_runner_fault_injection',operation:saved.record,
      oldRunnerPid:health.value.pid,observedContainerIds:observed,replayHttpStatus:replay.status,cleanup,readyAfterIndependentReaper:true});
  }
  const finalCapabilities=await realRunner.capabilities(); assert.equal(finalCapabilities.state,'ready');
  finalResultRecord = {startedAt,verificationFinishedAt:new Date().toISOString(),verificationState:'passed',
    overallState:'pending_cleanup',cleanupEvidence:'cleanup.json',
    source:'Docker Desktop development verification',runtimeHost,pack,capabilities,results,recoveryResults,finalCapabilities};
  await writeFile(path.join(evidenceDirectory,'results.json'),JSON.stringify(finalResultRecord,null,2));
}
try { await main(); verificationPassed = true; }
catch(error) {
  const message = error instanceof Error ? error.message : 'UNKNOWN_ERROR';
  // Never print execFile's argv: database or service tokens may be present.
  const safeMessage = message.startsWith('Command failed:') ? 'DOCKER_VERIFICATION_COMMAND_FAILED' : message;
  console.error(safeMessage);
  process.exitCode=1;
  try {
    await mkdir(evidenceDirectory,{recursive:true});
    await writeFile(path.join(evidenceDirectory,'failure.json'),JSON.stringify({startedAt,failedAt:new Date().toISOString(),
      source:'Docker Desktop development verification',currentCheck,message:safeMessage,results,recoveryResults},null,2));
  } catch { console.error('VERIFICATION_FAILURE_EVIDENCE_WRITE_FAILED'); }
} finally {
  const cleanupStartedAt = new Date().toISOString();
  const cleanup = await cleanupVerification();
  const cleanupPassed = cleanup.every(record=>record.state!=='failed');
  const overallState = verificationPassed && cleanupPassed ? 'passed':'failed';
  if (!cleanupPassed) {
    process.exitCode=1;
    console.error(`VERIFICATION_CLEANUP_FAILED:${cleanup.filter(record=>record.errorCode).map(record=>record.errorCode).join(',')}`);
  }
  try {
    const finishedAt = new Date().toISOString();
    await mkdir(evidenceDirectory,{recursive:true});
    await writeFile(path.join(evidenceDirectory,'cleanup.json'),JSON.stringify({startedAt:cleanupStartedAt,finishedAt,
      source:'Docker Desktop development verification',state:cleanupPassed ? 'clean':'failed',
      verificationState:verificationPassed ? 'passed':'failed',overallState,records:cleanup},null,2));
    if (finalResultRecord) await writeFile(path.join(evidenceDirectory,'results.json'),JSON.stringify({
      ...finalResultRecord,finishedAt,overallState,cleanupState:cleanupPassed ? 'clean':'failed'},null,2));
    if (overallState==='passed') console.log(`验证及临时资源清理完成；记录 ${path.relative(root,evidenceDirectory)}。`);
  } catch {
    process.exitCode=1;
    console.error('VERIFICATION_CLEANUP_EVIDENCE_WRITE_FAILED');
  }
}
