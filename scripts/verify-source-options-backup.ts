// Generated fixture only: migrate 009 -> current, create real source-worker output,
// pg_dump/pg_restore into a separate database, then verify authenticated HTTP.
// Never connects to the live workspace database or to an external model.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID, randomBytes } from "node:crypto";
import { createUserModelService } from '../apps/api/src/user-model-settings.js';
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { postgres, migrate, type DB } from "../apps/api/src/db.js";
import { loadMigrations } from "../apps/api/src/migrations.js";
import { seed } from "../apps/api/src/seed.js";
import { sourceWorkerTick } from "../apps/api/src/source-projects.js";
import { sourceExecutionSnapshot } from "../apps/api/src/source-execution.js";
import { createApp } from "../apps/api/src/app.js";
import type { SummaryProviderV2 } from "../apps/api/src/model-provider-v2.js";
import { ModelRequestError } from "../apps/api/src/model-provider-v2.js";
import type { SourceContextSummary } from "../packages/contracts/src/source.js";
import { checkRestoredSourceProjects } from "./restore-http-check.js";
import { changeSourceRetentionHold, planSourceDeletion, executeSourceDeletion } from '../apps/api/src/source-retention.js';
import { withFrozenCourseHistory } from '../apps/api/src/course-retention-scope.js';
import { recordCourseAuthorization, revokeCourseAuthorization, assertCourseAuthorization } from '../apps/api/src/course-retention-authorization.js';
import { prepareCourseCleanupBackup } from './fixtures/course-cleanup-backup.js';

const id = randomUUID();
const container = `codelab-source-restore-${id}`;
const network = `codelab-source-restore-net-${id}`;
const label = `codelab.source-restore=${id}`;
const password = randomUUID(), loginPassword = randomUUID();
const verificationDate=new Date(Date.now()+8*3600_000).toISOString().slice(0,10);
const record = path.resolve("docs/verification",verificationDate, `source-options-backup-${id}`);
const backup = path.resolve(".data/source-options-backups", id);
await mkdir(record, { recursive: true });
await mkdir(backup, { recursive: true });
const exec = promisify(execFile);
let containerOwned = false, networkOwned = false;
let source: DB | undefined, target: DB | undefined;
const result: Record<string, unknown> = { id, state: "running", scope: "generated-fixture-pg-dump-restore-and-source-http", externalModelCalls: 0, liveWorkspaceAccess: false };
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
async function docker(args: string[], env = process.env) {
  try { return (await exec("docker", args, { env, windowsHide: true, timeout: 60000, maxBuffer: 2 * 1024 ** 2 })).stdout; }
  catch { throw new Error("SOURCE_RESTORE_DOCKER_FAILED"); }
}
async function inventory(db: DB) {
  const rows = (await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
  const tables: Record<string, unknown> = {};
  for (const { tablename } of rows) {
    assert.match(tablename, /^[a-z_]+$/);
    const values = (await db.query(`SELECT to_jsonb(t) AS value FROM public."${tablename}" t ORDER BY to_jsonb(t)::text COLLATE "C"`)).rows;
    tables[tablename] = { rows: values.length, sha256: hash(values) };
  }
  return tables;
}
const main = "fixture/backend/main.ts", data = "fixture/backend/data.ts", front = "fixture/frontend/main.ts";
const files = { [main]: "export { items } from './data';\n", [data]: "export const items = ['fixture'];\n", [front]: "console.log('fixture frontend');\n" };
const citation = { path: main, start: 1, end: 1 };
const section = { title: "恢复验证夹具", body: "仅验证持久化和恢复，不代表模型质量。", citations: [citation] };
const report = { overview: section.body, stack: ["TypeScript"], modules: [section], flows: [section], findings: [], readingPath: [section], limitations: ["固定测试模型；未运行上传代码。"] };
let fixtureCalls = 0;
const provider: SummaryProviderV2 = {
  configuration: { provider: "fixture", model: "fixture-no-network", endpoint: "http://test.invalid" },
  complete: async input => {
    fixtureCalls++;
    const request = JSON.parse(input.user);
    const answer = request.phase === "investigation"
      ? { goal: `恢复验证调查${request.round}`, searches: [], reads: [{ path: request.round === 1 ? data : front, start: 1, count: 10 }] }
      : request.draft ? (request.shape || request.checkShape ? { report, checks: [] } : { searches: [], reads: [] })
        : request.shape ? report : { paths: [main] };
    return { content: JSON.stringify(answer), raw: "fixture", requestId: null, usage: null };
  },
};
try {
  await docker(["network", "create", "--label", label, network]); networkOwned = true;
  await docker(["run", "--detach", "--name", container, "--label", label, "--network", network,
    "--memory", "384m", "--cpus", "1", "--pids-limit", "128", "--publish", "127.0.0.1::5432",
    "--env", "POSTGRES_PASSWORD", "--env", "POSTGRES_DB=source_fixture", "postgres:17-alpine"],
    { ...process.env, POSTGRES_PASSWORD: password });
  containerOwned = true;
  const info = JSON.parse(await docker(["inspect", container]))[0];
  assert.equal(info.Config.Labels["codelab.source-restore"], id);
  const binding = info.NetworkSettings.Ports["5432/tcp"][0];
  assert.equal(binding.HostIp, "127.0.0.1");
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    // The initialization server accepts Unix sockets before restarting. TCP
    // readiness selects the final server, so migration cannot race that restart.
    try { await docker(["exec", container, "pg_isready", "-h", "127.0.0.1", "-U", "postgres", "-d", "source_fixture"]); ready = true; break; }
    catch { await delay(250); }
  }
  assert(ready, "SOURCE_RESTORE_NOT_READY");
  source = postgres(`postgres://postgres:${password}@127.0.0.1:${binding.HostPort}/source_fixture`);
  const migrations = await loadMigrations();
  await migrate(source, migrations.filter(m => m.version <= 9));
  await seed(source, loginPassword);
  const owner = (await source.query("SELECT id FROM users WHERE email='teacher@codelab.local'")).rows[0].id;
  const projectId = randomUUID(), legacyId = randomUUID(), quickId = randomUUID(), deepId = randomUUID();
  await source.query("INSERT INTO source_projects(id,owner_id,name,sha256,files,omitted) VALUES($1,$2,$3,$4,$5,$6)",
    [projectId, owner, "迁移010恢复夹具", hash(files), JSON.stringify(files), JSON.stringify([{ path:"fixture/.env",reason:"敏感配置" }])]);
  await source.query("INSERT INTO source_analyses(id,project_id,status,events,report,created_at,finished_at) VALUES($1,$2,'succeeded',$3,$4,now()-interval '1 day',now()-interval '1 day')",
    [legacyId, projectId, JSON.stringify([{ kind:"fixture-legacy",label:"009时期构造历史记录" }]), JSON.stringify({ report, version:"fixture-legacy", limitations:["构造的历史记录，不是旧模型调用"] })]);
  await migrate(source);
  assert.equal((await source.query("SELECT analysis_options FROM source_analyses WHERE id=$1",[legacyId])).rows[0].analysis_options,null);
  for (const [analysisId, mode, modules] of [[quickId,"quick",[]],[deepId,"deep",["backend"]]] as const) {
    await source.query("INSERT INTO source_analyses(id,project_id,status,analysis_options,execution_snapshot) VALUES($1,$2,'queued',$3,$4)",
      [analysisId,projectId,JSON.stringify({ version:1,mode,modules }),JSON.stringify(sourceExecutionSnapshot(provider))]);
    assert.equal(await sourceWorkerTick(source,provider,new AbortController().signal),true);
    const row: { status:string; analysis_options:unknown; report:{ analysisOptions:unknown; investigation:unknown[]; context: SourceContextSummary } } =
      (await source.query("SELECT status,report,events,analysis_options FROM source_analyses WHERE id=$1",[analysisId])).rows[0];
    assert.equal(row.status,"succeeded");
    assert.deepEqual(row.analysis_options,{ version:1,mode,modules });
    assert.deepEqual(row.report.analysisOptions,row.analysis_options);
    assert.equal(row.report.investigation.length,mode === "deep" ? 2 : 0);
    assert.equal(row.report.context.policy.contextWindowTokens,null);
    assert.equal(row.report.context.policy.capacitySource,"application-fallback");
    assert.equal(row.report.context.callsWithoutUsage,mode === "deep" ? 6 : 4);
    assert.equal(row.report.context.knownInputTokens,null);
    assert.equal(row.report.context.knownOutputTokens,null);
  }
  assert.equal(fixtureCalls,10);
  const failedId=randomUUID();
  await source.query("INSERT INTO source_analyses(id,project_id,status,execution_snapshot,analysis_options) VALUES($1,$2,'queued',$3,$4)",[failedId,projectId,JSON.stringify(sourceExecutionSnapshot(provider)),JSON.stringify({version:1,mode:'quick',modules:[]})]);
  let failureCalls=0;
  await sourceWorkerTick(source,{...provider,complete:async request=>{
    failureCalls++;
    if(failureCalls===2) { fixtureCalls++; throw new ModelRequestError('MODEL_HTTP_403','failed'); }
    return {...await provider.complete(request),usage:{inputTokens:101,outputTokens:17}};
  }},new AbortController().signal);
  assert.equal(failureCalls,2); assert.equal(fixtureCalls,12);
  assert.equal((await source.query('SELECT status FROM source_analyses WHERE id=$1',[failedId])).rows[0].status,'failed');
  const vaultKey=randomBytes(32);
  const originalSettings=await createUserModelService(source,vaultKey).save(owner,{vendor:'deepseek',model:'deepseek-flash',apiKey:'fixture-restore-key-only'});
  const retainedTarget={projectId,ownerId:owner};
  const held=await changeSourceRetentionHold(source,{...retainedTarget,action:'hold',requestId:randomUUID(),reason:'恢复夹具专项保留'});
  await changeSourceRetentionHold(source,{...retainedTarget,action:'release',holdId:held.eventId,requestId:randomUUID(),reason:'结束第一轮夹具保留'});
  await changeSourceRetentionHold(source,{...retainedTarget,action:'hold',requestId:randomUUID(),reason:'恢复后继续专项保留'});
  const disposableId=randomUUID();
  await source.query("INSERT INTO source_projects(id,owner_id,name,sha256,files,omitted) VALUES($1,$2,'delete-fixture',$3,'{}','[]')",[disposableId,owner,'d'.repeat(64)]);
  const deletion={projectId:disposableId,ownerId:owner,requestId:randomUUID(),reason:'恢复夹具删除验证',
    fingerprint:(await planSourceDeletion(source,{projectId:disposableId,ownerId:owner})).fingerprint,
    authorizationReference:'synthetic-fixture-only',externalReferencesReviewed:true,confirm:'DELETE_SOURCE_PROJECT_AND_ALL_ANALYSES'};
  const deleted=await executeSourceDeletion(source,deletion);
  // Nonempty course authorization history, created through the actual authorization service.
  // A v2 submission without a run is part of the supported whole-history scope.
  const courseTask=(await source.query('SELECT id FROM tasks ORDER BY id LIMIT 1')).rows[0].id;
  const courseStudent=(await source.query("SELECT id FROM users WHERE email='student@codelab.local'")).rows[0].id;
  const courseRule=randomUUID(),courseSubmission=randomUUID();
  await source.query(`INSERT INTO rules(id,task_id,version,template_version,criteria,contract_version,rule_snapshot,idempotency_key,request_hash)
    VALUES($1::uuid,$2,2,'vue-board-v1','[]',2,'{"version":2}',$1::text,'fixture-rule-hash')`,[courseRule,courseTask]);
  await source.query(`INSERT INTO submissions(id,task_id,user_id,rule_id,sha256,files,request_id,contract_version,source_manifest,source_manifest_sha256)
    VALUES($1::uuid,$2,$3,$4,$5,'{}',$1::text,2,'{"version":1,"files":[]}',$5)`,
    [courseSubmission,courseTask,courseStudent,courseRule,'a'.repeat(64)]);
  const courseScope={taskId:courseTask,studentId:courseStudent};
  const courseFingerprint=await withFrozenCourseHistory(source,courseScope,async(_tx,s)=>s.fingerprint);
  const authorizationInput={...courseScope,fingerprint:courseFingerprint,requestId:randomUUID(),ttlSeconds:3600,
    reason:'隔离恢复夹具授权',policyReference:'fixture-policy-only',authorizationReference:'fixture-consent-only',
    externalReferencesReviewed:true,confirm:'AUTHORIZE_EXACT_COURSE_HISTORY'};
  const validAuthorization=await recordCourseAuthorization(source,authorizationInput);
  const revokedInput={...authorizationInput,requestId:randomUUID()};
  const revokedAuthorization=await recordCourseAuthorization(source,revokedInput);
  const revocationInput={authorizationId:revokedAuthorization.authorizationId,requestId:randomUUID(),reason:'隔离恢复夹具撤销'};
  const revocation=await revokeCourseAuthorization(source,revocationInput);
  const expiredInput={...authorizationInput,requestId:randomUUID(),ttlSeconds:1};
  const expiredAuthorization=await recordCourseAuthorization(source,expiredInput);
  await source.query('SELECT pg_sleep(1.1)');
  const verifyCleanupRestore=await prepareCourseCleanupBackup(source,backup,courseStudent,
    `postgres://postgres:${password}@127.0.0.1:${binding.HostPort}/source_fixture`);
  const before = await inventory(source);
  await docker(["exec",container,"pg_dump","-U","postgres","-d","source_fixture","-Fc","-f","/tmp/source-options.dump"]);
  await docker(["cp",`${container}:/tmp/source-options.dump`,path.join(backup,"database.dump")]);
  // Restore from the on-disk backup copy, not directly from the source database.
  await docker(["exec",container,"createdb","-U","postgres","source_restored"]);
  await docker(["cp",path.join(backup,"database.dump"),`${container}:/tmp/source-options-restored.dump`]);
  await docker(["exec",container,"pg_restore","--exit-on-error","-U","postgres","-d","source_restored","/tmp/source-options-restored.dump"]);
  target = postgres(`postgres://postgres:${password}@127.0.0.1:${binding.HostPort}/source_restored`);
  assert.deepEqual(await inventory(target),before,"RESTORED_TABLES_DIFFER");
  const migrationBefore = (await target.query("SELECT * FROM schema_migrations ORDER BY version")).rows;
  await migrate(target);
  assert.deepEqual((await target.query("SELECT * FROM schema_migrations ORDER BY version")).rows,migrationBefore);
  assert.equal(migrationBefore.at(-1).version,migrations.at(-1)!.version);
  assert.deepEqual((await planSourceDeletion(target,retainedTarget)).blockers,['ACTIVE_RETENTION_HOLD']);
  assert.equal((await executeSourceDeletion(target,deletion)).eventId,deleted.eventId);
  assert.equal((await target.query('SELECT id FROM source_retention_events')).rows.length,4);
  result.sourceRetentionRestored=true;
  assert.equal((await target.query('SELECT id FROM course_retention_authorizations')).rows.length,4);
  assert.equal((await target.query('SELECT id FROM course_retention_revocations')).rows.length,1);
  assert.equal(await withFrozenCourseHistory(target,courseScope,async(_tx,s)=>s.fingerprint),courseFingerprint);
  await withFrozenCourseHistory(target,courseScope,async(tx,s)=>assertCourseAuthorization(tx,s,validAuthorization.authorizationId));
  for(const [authorizationId,message] of [[revokedAuthorization.authorizationId,/AUTHORIZATION_REVOKED/],
    [expiredAuthorization.authorizationId,/AUTHORIZATION_EXPIRED/]] as const)
    await assert.rejects(withFrozenCourseHistory(target,courseScope,async(tx,s)=>assertCourseAuthorization(tx,s,authorizationId)),message);
  for(const [input,saved,status] of [[authorizationInput,validAuthorization,'recorded'],[revokedInput,revokedAuthorization,'revoked'],
    [expiredInput,expiredAuthorization,'expired']] as const){
    const replay=await recordCourseAuthorization(target,input);
    assert.equal(replay.authorizationId,saved.authorizationId);assert.equal(replay.replayed,true);assert.equal(replay.status,status);
    assert.equal(new Date(replay.expiresAt).toISOString(),new Date(saved.expiresAt).toISOString());
  }
  assert.deepEqual(await revokeCourseAuthorization(target,revocationInput),{...revocation,replayed:true});
  await assert.rejects(recordCourseAuthorization(target,{...authorizationInput,reason:'不能改写恢复后的授权'}),/REQUEST_CONFLICT/);
  await assert.rejects(withFrozenCourseHistory(target,courseScope,async(tx,s)=>assertCourseAuthorization(tx,
    {...s,fingerprint:'0'.repeat(64)},validAuthorization.authorizationId)),/SCOPE_CHANGED/);
  result.courseAuthorizationRestored={records:3,revocations:1,validAccepted:true,revokedRejected:true,expiredRejected:true,
    replayPreservedExpiry:true,requestConflictRejected:true,scopeChangeRejected:true};
  assert.deepEqual(await createUserModelService(target,vaultKey).state(owner),originalSettings);
  const restoredProvider=await createUserModelService(target,vaultKey).resolve(owner);
  assert.equal(restoredProvider?.configuration.credentialRevision,originalSettings.revision);
  await assert.rejects(createUserModelService(target,randomBytes(32)).resolve(owner),/无法读取已保存的密钥/);
  const restoredCalls=(await target.query('SELECT state,usage FROM source_model_calls WHERE analysis_id=$1 ORDER BY call_no',[failedId])).rows;
  assert.deepEqual(restoredCalls,[{state:'returned',usage:{inputTokens:101,outputTokens:17}},{state:'failed',usage:null}]);
  assert.equal((await target.query("SELECT execution_snapshot FROM source_analyses WHERE id=$1",[legacyId])).rows[0].execution_snapshot,null);
  for (const analysisId of [quickId,deepId]) assert.deepEqual((await target.query("SELECT execution_snapshot FROM source_analyses WHERE id=$1",[analysisId])).rows[0].execution_snapshot,sourceExecutionSnapshot(provider));
  const app = await createApp(target,{ origin:"http://127.0.0.1",secure:false,executionApproved:false,businessVersion:2,model:"unconfigured",image:"source-restore-fixture" });
  try {
    const base = await app.listen({ host:"127.0.0.1",port:0 });
    const sessions = [];
    for (const email of ["teacher@codelab.local","student@codelab.local"]) {
      const response = await fetch(base+"/api/v1/session/login",{ method:"POST",headers:{ origin:"http://127.0.0.1","content-type":"application/json" },body:JSON.stringify({ email,password:loginPassword }) });
      assert.equal(response.status,200);
      const login = await response.json() as {csrf:string};
      sessions.push({email,cookie:response.headers.getSetCookie()[0].split(";")[0],csrf:login.csrf});
    }
    const http = await checkRestoredSourceProjects(target,base,sessions);
    assert.deepEqual(http.analysisModes,{historical:1,quick:2,deep:1});
    assert.equal(http.focusedAnalyses,1);
    assert.equal(http.filesVerified,3);
    const reanalysis = await fetch(base+`/api/v2/projects/${projectId}/analyze`, { method:"POST",headers:{ origin:"http://127.0.0.1",cookie:sessions[0].cookie,"x-csrf-token":sessions[0].csrf,"content-type":"application/json" },body:JSON.stringify({mode:"deep",modules:["backend"]}) });
    assert.equal(reanalysis.status,409,"RESTORE_MUST_NOT_START_MODEL_REQUEST");
    result.http = http;
  } finally { await app.close(); }
  const rejected = async (query: string, parameters: unknown[], code: string) => {
    let actual: string | undefined;
    try { await target!.query(query,parameters); } catch(error) { actual=(error as {code?:string}).code; }
    assert.equal(actual,code,"RESTORED_INVARIANT_NOT_ENFORCED");
  };
  for(const table of ['course_retention_authorizations','course_retention_revocations']){
    await rejected(`UPDATE ${table} SET reason='tampered'`,[],'P0001');
    await rejected(`DELETE FROM ${table}`,[],'P0001');
    await rejected(`TRUNCATE ${table} CASCADE`,[],'P0001');
  }
  result.courseAuthorizationImmutableChecks=6;
  await rejected("UPDATE source_analyses SET analysis_options=$2 WHERE id=$1",[deepId,JSON.stringify({version:1,mode:"quick",modules:[]})],"P0001");
  await rejected("UPDATE source_analyses SET analysis_options=$2 WHERE id=$1",[legacyId,JSON.stringify({version:1,mode:"quick",modules:[]})],"P0001");
  await rejected("UPDATE source_analyses SET execution_snapshot=$2 WHERE id=$1",[deepId,JSON.stringify({...sourceExecutionSnapshot(provider),version:2})],"P0001");
  await rejected("UPDATE source_analyses SET execution_snapshot=$2 WHERE id=$1",[legacyId,JSON.stringify(sourceExecutionSnapshot(provider))],"P0001");
  const invalid = [null,{}, {version:1,mode:null,modules:[]}, {version:1,mode:"deep",modules:null}, {version:1,mode:"deep",modules:["a","b","c","d","e","f","g"]}];
  for (const options of invalid)
    await rejected("INSERT INTO source_analyses(id,project_id,status,analysis_options) VALUES($1,$2,'failed',$3)",[randomUUID(),projectId,JSON.stringify(options)],"23514");
  await target.transaction(async tx => {
    await tx.query("INSERT INTO source_analyses(id,project_id,status,analysis_options) VALUES($1,$2,'queued',$3)",[randomUUID(),projectId,JSON.stringify({version:1,mode:"quick",modules:[]})]);
    try {
      await tx.transaction(async nested => { await nested.query("INSERT INTO source_analyses(id,project_id,status,analysis_options) VALUES($1,$2,'queued',$3)",[randomUUID(),projectId,JSON.stringify({version:1,mode:"deep",modules:["backend"]})]); });
      throw new Error("RESTORED_ACTIVE_INDEX_NOT_ENFORCED");
    } catch(error) { assert.equal((error as {code?:string}).code,"23505"); }
    // Roll back the deliberate active record; no worker is started in restore.
    throw new Error("ROLLBACK_ACTIVE_FIXTURE");
  }).catch(error => { assert.equal(error.message,"ROLLBACK_ACTIVE_FIXTURE"); });
  assert.deepEqual(await inventory(source),before,"SOURCE_FIXTURE_CHANGED");
  const finalTarget = await inventory(target);
  // HTTP login intentionally creates sessions in the restored DB only.
  for (const name of Object.keys(before).filter(n=>n!=="sessions")) assert.deepEqual(finalTarget[name],before[name],`RESTORED_${name}_CHANGED`);
  result.courseCleanupRestored=await verifyCleanupRestore(target);
  const afterCleanup=await inventory(target);
  for(const name of Object.keys(finalTarget).filter(n=>n!=='course_evidence_cleanup_files'))
    assert.deepEqual(afterCleanup[name],finalTarget[name],`CLEANUP_CHANGED_${name}`);
  assert.deepEqual(await inventory(source),before,'SOURCE_CHANGED_AFTER_CLEANUP_RESTORE');
  const dumpSha256 = createHash("sha256").update(await readFile(path.join(backup,"database.dump"))).digest("hex");
  Object.assign(result,{state:"passed",migrationVersion:17,courseCleanupFixture:'three-files-partially-completed',courseAuthorizationFixture:'valid-revoked-expired',personalKeyRestored:true,wrongVaultRejected:true,fixtureModelCalls:fixtureCalls,sourceFixtureUnchanged:true,tables:before,dumpSha256,
    checks:{legacyNull:true,quickOptions:true,deepFocus:true,reportAndEvents:true,contextBudgetAndUnknownUsage:true,executionSnapshots:true,historicalExecutionNull:true,partialFailureUsage:true,usageHttp:true,modules:true,immutableUpdatesRejected:4,invalidInsertsRejected:invalid.length,activeUniqueIndex:true,migrationReentry:true,restoredModelDisabled:true},
    limitations:["Generated fixture, not a new backup of the live museum/course database","Two databases in one isolated PostgreSQL container, not independent hosts","No external model quality claim or offsite storage validation"]});
  await writeFile(path.join(backup,"manifest.json"),JSON.stringify({id,tables:before,dumpSha256},null,2),{flag:"wx"});
} catch(error) {
  result.state="failed";
  result.errorCode=error instanceof assert.AssertionError ? "SOURCE_RESTORE_ASSERTION_FAILED" : "SOURCE_RESTORE_VERIFICATION_FAILED";
  // Keep diagnostic details private: database errors can contain row contents.
  await writeFile(path.join(backup,"failure.txt"),error instanceof Error ? error.stack ?? error.message : "unknown",{flag:"wx",mode:0o600});
  process.exitCode=1;
} finally {
  await target?.close(); await source?.close();
  try {
    if (containerOwned) {
      const info=JSON.parse(await docker(["inspect",container]))[0];
      assert.equal(info.Config.Labels["codelab.source-restore"],id);
      await docker(["rm","--force","--volumes",info.Id]);
    }
    if (networkOwned) {
      const info=JSON.parse(await docker(["network","inspect",network]))[0];
      assert.equal(info.Labels["codelab.source-restore"],id);
      await docker(["network","rm",info.Id]);
    }
    result.cleanup="clean";
  } catch { result.cleanup="failed";result.state="failed";process.exitCode=1; }
  result.finishedAt=new Date().toISOString();
  await writeFile(path.join(record,"result.json"),JSON.stringify(result,null,2),{flag:"wx"});
}
console.log(JSON.stringify({state:result.state,cleanup:result.cleanup,directory:path.relative(process.cwd(),record),fixtureModelCalls:fixtureCalls,externalModelCalls:0}));
