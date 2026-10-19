import { randomBytes, randomUUID } from "node:crypto";
import { createUserModelService } from '../apps/api/src/user-model-settings';
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  canonicalJson,
  createArtifactManifest,
  createDevelopmentPack,
  createRuleSnapshot,
  createSourceManifest,
  encodeBase64,
  hashRuleSnapshot,
  sha256,
  unknownMeasuredEnvironment,
  type MeasurementFingerprint,
  type RuleSnapshot,
  type RunnerCleanupRequest,
  type RunnerCleanupResponse,
  type RunnerExecuteRequest,
  type RunnerExecuteResponse,
  type RunnerOperationQueryRequest,
  type RunnerOperationQueryResponse,
} from "../packages/contracts/src/v2/index.js";
import { ArtifactStore } from "../apps/api/src/artifacts-v2.js";
import { AnalysisCheckpointSaverV2 } from "../apps/api/src/analysis-checkpoints-v2.js";
import { migrate, type DB } from "../apps/api/src/db.js";
import { enqueueRunV2, claimNextV2 } from "../apps/api/src/lifecycle-v2.js";
import { enqueueReanalysisV2,cancelReanalysisV2 } from "../apps/api/src/reanalysis-v2.js";
import { ModelRequestError } from '../apps/api/src/model-provider-v2.js';
import {
  createRunnerClientV2,
  RunnerClientError,
  type RunnerClientV2,
} from "../apps/api/src/runner-client-v2.js";
import {
  loadWorkerApprovedFingerprintV2,
  runOneV2,
  runWorkerV2Loop,
  type WorkerOptionsV2,
} from "../apps/api/src/worker-v2.js";
import { validateZip } from "../apps/api/src/zip.js";
import { isolatedTestDB } from "./isolated-db.js";

// Engineering fixtures only. These tests never dispatch Docker, browser or model work.
const digest = "a".repeat(64);
let db: DB, store: ArtifactStore, temporary: string;
let rule: RuleSnapshot, fingerprint: MeasurementFingerprint;
let submissionId: string, student: string;
let runner: RunnerClientV2, options: WorkerOptionsV2;
let lastRequest: RunnerExecuteRequest | undefined;
let lastResponse: RunnerExecuteResponse | undefined;
let lastCleanup: RunnerCleanupRequest | undefined;

const wait = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean) {
  const limit = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() >= limit)
      throw new Error("Fixture did not reach its expected stage");
    await wait(5);
  }
}
const never = () => new Promise<never>(() => {});
function intercept(database: DB, before: (sql: string) => void): DB {
  return {
    ...database,
    query: async (sql, params) => {
      before(sql);
      return database.query(sql, params);
    },
    exec: async (sql) => {
      before(sql);
      return database.exec(sql);
    },
    transaction: (fn) =>
      database.transaction((tx) => fn(intercept(tx, before))),
  };
}
async function responseFor(
  request: RunnerExecuteRequest,
): Promise<RunnerExecuteResponse> {
  const definition = rule.packManifest.cases[0];
  const at = new Date().toISOString();
  const manifestId = randomUUID(),
    evidenceId = randomUUID();
  const bytes = new TextEncoder().encode(
    '{"fixture":true,"observed":"one created"}',
  );
  const evidence = {
    evidenceId,
    manifestId,
    runId: request.context.runId,
    submissionId,
    originalZipSha256: request.context.originalZipSha256,
    sourceManifestSha256: request.context.sourceManifestSha256,
    executionAttemptId: request.context.executionAttemptId,
    analysisAttemptId: null,
    operationId: null,
    scope: "case" as const,
    criterionId: definition.criterionId,
    caseId: definition.caseId,
    phase: "base" as const,
    collector: "runner" as const,
    contentOrigin: "checker_observation" as const,
    ruleHash: request.context.ruleHash,
    packManifestHash: request.context.packManifestHash,
    sha256: await sha256(bytes),
    byteSize: bytes.byteLength,
    mediaType: "application/json" as const,
    storageKey: `runs/${request.context.runId}/${manifestId}/${evidenceId}.json`,
    capturedAt: at,
  };
  return {
    protocolVersion: 2,
    context: {
      ...request.context,
      operationId: request.operationId,
      requestHash: request.requestHash,
      observedSourceManifestSha256: request.context.sourceManifestSha256,
      sourceVerificationReason: null,
    },
    outcome: "complete",
    actualFingerprint: {
      completeness: "complete",
      values: fingerprint,
      missingFields: [],
    },
    caseResults: [
      {
        caseId: definition.caseId,
        criterionId: definition.criterionId,
        expected: definition.expected,
        verdict: "passed",
        preconditionStatus: "satisfied",
        reasonCode: "ASSERTION_SATISFIED",
        observed: "Fixture exact-one observation",
        executedSteps: definition.plannedSteps.map((step) => ({
          stepId: step.stepId,
          phase: step.phase,
          startedAt: at,
          finishedAt: at,
          state: "completed",
          observation: `Fixture ${step.stepId}`,
          evidenceIds: [evidenceId],
        })),
        unexecutedStepIds: [],
        blockedBy: [],
        evidenceIds: [evidenceId],
      },
    ],
    baseManifest: await createArtifactManifest({
      manifestId,
      context: request.context,
      source: "base",
      analysisAttemptId: null,
      operationId: null,
      evidence: [evidence],
      completeness: "complete",
    }),
    artifacts: [{ evidenceId, encoding: "base64", data: encodeBase64(bytes) }],
    timings: [],
    resourceState: "retained_for_initial_analysis",
  };
}
function receiptFor(
  request: RunnerCleanupRequest,
  pending = false,
): RunnerCleanupResponse {
  return {
    protocolVersion: 2,
    runId: request.owner.runId,
    ownerKind: request.owner.ownerKind,
    ownerId: request.owner.ownerId,
    operationId: request.operationId,
    requestHash: request.requestHash,
    state: pending ? "cleanup_pending" : "clean",
    residualResourceIds: pending ? ["fixture-container"] : [],
    completedAt: new Date().toISOString(),
  };
}
async function queried(
  request: RunnerOperationQueryRequest,
  response: unknown | null,
  kind: "execute" | "cleanup" = "execute",
): Promise<RunnerOperationQueryResponse> {
  return {
    record: {
      operationId: request.operationId,
      requestHash: request.requestHash!,
      runId: request.owner.runId,
      ownerKind: request.owner.ownerKind,
      ownerId: request.owner.ownerId,
      kind,
      state: response === null ? "running" : "completed",
      responseHash:
        response === null ? null : await sha256(canonicalJson(response)),
    },
    response,
  };
}
async function enqueue() {
  return enqueueRunV2(db, {
    submissionId,
    actorId: student,
    idempotencyKey: randomUUID(),
    executionApproved: true,
    approvedFingerprint: fingerprint,
  });
}
it('leaves queued work unclaimed when storage admission fails', async () => {
  const queued = await enqueue();
  options.storageAdmission = async () => { throw new Error('capacity unavailable'); };
  const result = await runOneV2(options);
  expect(result).toMatchObject({ state: 'unavailable', issues: [{ kind: 'storage', stage: 'claim' }] });
  expect((await db.query('SELECT status FROM runs WHERE id=$1', [queued.run.id])).rows[0].status).toBe('queued');
  expect((await db.query('SELECT id FROM execution_attempts')).rows).toHaveLength(0);
});
async function savedOwner() {
  return (
    await db.query(
      "SELECT * FROM execution_attempts ORDER BY created_at LIMIT 1",
    )
  ).rows[0];
}
async function expireOwner() {
  await db.query(
    "UPDATE execution_attempts SET lease_until=clock_timestamp()-interval '1 second' WHERE owner_phase<>'closed'",
  );
}

beforeEach(async () => {
  db = await isolatedTestDB();
  await migrate(db);
  temporary = await mkdtemp(path.join(os.tmpdir(), "codelab-worker-v2-"));
  store = new ArtifactStore({ root: temporary });
  lastRequest = undefined;
  lastResponse = undefined;
  lastCleanup = undefined;
  const teacher = randomUUID(),
    classId = randomUUID(),
    taskId = randomUUID();
  student = randomUUID();
  submissionId = randomUUID();
  const pack = await createDevelopmentPack("new-only", {
    packVersion: "worker-fixture-v1",
    templateVersion: "worker-fixture-v1",
    templateHash: digest,
    dependencyLockHash: digest,
    initializationVersion: "worker-fixture-v1",
    caseImplementationHashes: { "NEW-01": digest },
  });
  rule = await createRuleSnapshot({
    ruleId: randomUUID(),
    taskId,
    version: 1,
    packManifest: pack,
    enabledCriterionIds: ["create"],
    parameterValues: {},
    confirmedBy: teacher,
    confirmedAt: new Date().toISOString(),
  });
  const validated = await validateZip(
    await readFile(new URL("../fixtures/correct.zip", import.meta.url)),
  );
  const files = validated.files;
  const manifest = await createSourceManifest(
    Object.fromEntries(
      Object.entries(files).filter(
        ([name]) => name.startsWith("src/") || name.startsWith("public/"),
      ),
    ),
  );
  const image = {
    identifierType: "local_image_id" as const,
    value: `sha256:${digest}`,
  };
  fingerprint = {
    ruleHash: await hashRuleSnapshot(rule),
    packManifestHash: pack.contentHash,
    templateHash: digest,
    dependencyLockHash: digest,
    initializationVersion: pack.initializationVersion,
    parametersHash: rule.parametersHash,
    aggregationVersion: pack.aggregationVersion,
    buildImage: image,
    webImage: image,
    browserImage: image,
    playwrightVersion: "fixture-1",
    chromiumVersion: "fixture-1",
    viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
    locale: "zh-CN",
    timezone: "Asia/Shanghai",
    clockPolicy: "fixture-v1",
    randomPolicy: "fixture-v1",
    pageServerPolicy: "fixture-v1",
    resourceTimeoutConfigVersion: "fixture-v1",
  };
  await db.query(
    "INSERT INTO users(id,email,name,role,password_hash) VALUES($1,$2,'Teacher','teacher','x'),($3,$4,'Student','student','x')",
    [teacher, `${teacher}@test`, student, `${student}@test`],
  );
  await db.query("INSERT INTO classes VALUES($1,'Class',$2)", [
    classId,
    teacher,
  ]);
  await db.query("INSERT INTO memberships VALUES($1,$2)", [classId, student]);
  await db.query(
    "INSERT INTO tasks(id,class_id,title,description) VALUES($1,$2,'Task','Fixture')",
    [taskId, classId],
  );
  await db.query(
    "INSERT INTO rules(id,task_id,version,template_version,criteria,contract_version,rule_snapshot,idempotency_key,request_hash) VALUES($1,$2,1,'worker-fixture-v1','[]',2,$3,'fixture-rule',$4)",
    [rule.ruleId, taskId, JSON.stringify(rule), digest],
  );
  await db.query(
    "INSERT INTO submissions(id,task_id,user_id,rule_id,sha256,files,request_id,contract_version,source_manifest,source_manifest_sha256,source_manifest_version) VALUES($1,$2,$3,$4,$5,$6,$7,2,$8,$9,'source-manifest-v1')",
    [
      submissionId,
      taskId,
      student,
      rule.ruleId,
      validated.sha256,
      JSON.stringify(files),
      randomUUID(),
      JSON.stringify(manifest),
      manifest.sourceManifestSha256,
    ],
  );
  runner = {
    probe: vi.fn(async () => { throw new Error("UNEXPECTED_PROBE"); }),
    capabilities: vi.fn(async () => ({
      protocolVersion: 2 as const,
      limitsVersion: "limits-v1" as const,
      state: "ready" as const,
      templateHashes: [digest],
      packManifestHashes: [pack.contentHash],
      actualEnvironment: unknownMeasuredEnvironment(),
      activeOwner: null,
      residualResourceIds: [],
      admissionRecordVersion: "fixture-v1",
    })),
    execute: vi.fn(async (request) => {
      lastRequest = request;
      const row = await savedOwner();
      expect(row.control_operations.execute).toMatchObject({
        operationId: request.operationId,
        requestHash: request.requestHash,
      });
      expect(row.owner_phase).toBe("building");
      lastResponse = await responseFor(request);
      return lastResponse;
    }),
    heartbeat: vi.fn(async (request) => ({
      protocolVersion: 2 as const,
      leaseUntil: request.leaseUntil,
    })),
    query: vi.fn(async () => {
      throw new RunnerClientError("http", "OPERATION_NOT_FOUND", 404);
    }),
    cleanup: vi.fn(async (request) => {
      lastCleanup = request;
      return receiptFor(request);
    }),
  };
  options = {
    db,
    runner,
    artifacts: store,
    approvedFingerprint: fingerprint,
    queryPollMs: 5,
  };
});
afterEach(async () => {
  await db?.close();
  if (temporary) await rm(temporary, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("v2 worker dispatch and recovery", () => {
  it.each(['summary', 'agent'] as const)('bills the requesting teacher for archived %s, never the student or platform', async strategy => {
    const calls: string[] = [];
    const userModels = createUserModelService(db, randomBytes(32), env => ({
      configuration: { provider: 'fixture', model: env.MODEL_NAME!, endpoint: env.MODEL_BASE_URL! },
      complete: async input => {
        calls.push(env.MODEL_API_KEY!);
        const material = JSON.parse(input.user);
        const content = JSON.stringify({ ...(strategy === 'agent' ? { type: 'final' } : {}), feedback: strategy === 'agent' ? material.initial.baseFeedback : material.baseFeedback });
        return { content, raw: content, requestId: null, usage: null };
      },
    }));
    const config = { vendor: 'deepseek', model: 'fixture' };
    await userModels.save(student, { ...config, apiKey: 'fixture-student-key' });
    const created = await enqueue();
    await runOneV2(options);
    const before = (await db.query('SELECT * FROM report_revisions')).rows;
    const input = { runId: created.run.id, actorId: rule.confirmedBy, idempotencyKey: randomUUID(), body: { strategy, expectedRevisionId: before[0].id }, personalModels: userModels.resolve };
    await expect(enqueueReanalysisV2(db, input)).rejects.toMatchObject({ code: 'MODEL_NOT_CONFIGURED' });
    await userModels.save(rule.confirmedBy, { ...config, apiKey: 'fixture-teacher-key' });
    const queued = await enqueueReanalysisV2(db, input);
    expect((await userModels.state(rule.confirmedBy)).active).toBe(true);
    await expect(userModels.remove(rule.confirmedBy)).rejects.toMatchObject({ code: 'MODEL_ANALYSIS_ACTIVE' });
    await userModels.remove(student);
    const fallback = vi.fn(async () => { throw new Error('PLATFORM_MUST_NOT_BE_CALLED'); });
    const result = await runOneV2({ ...options, personalModels: userModels.resolve, summaryProvider: { configuration: { provider: 'fixture', model: 'platform', endpoint: 'http://localhost' }, complete: fallback } });
    expect(result).toMatchObject({ state: 'completed', issues: [] });
    expect(calls).toEqual(['fixture-teacher-key']);
    expect(fallback).not.toHaveBeenCalled();
    expect((await db.query('SELECT status,configuration FROM analysis_attempts WHERE id=$1', [queued.analysis.analysisAttemptId])).rows[0]).toMatchObject({ status: 'succeeded', configuration: { billingUserId: rule.confirmedBy } });
    expect((await db.query('SELECT * FROM report_revisions')).rows).toEqual(before);
    await userModels.remove(rule.confirmedBy);
    expect((await enqueueReanalysisV2(db, input)).replayed).toBe(true);
  });

  it('requires explicit initial AI consent, freezes payer, locks edits, and preserves base checks', async () => {
    const complete = vi.fn(async (input: any) => {
      const content = JSON.stringify({ feedback: JSON.parse(input.user).baseFeedback });
      return { content, raw: content, requestId: null, usage: null };
    });
    const userModels = createUserModelService(db, randomBytes(32), env => ({ configuration: { provider: 'fixture', model: env.MODEL_NAME!, endpoint: env.MODEL_BASE_URL! }, complete }));
    const input = { submissionId, actorId: student, idempotencyKey: randomUUID(), executionApproved: true, approvedFingerprint: fingerprint, personalModels: userModels.resolve };
    const off = await enqueueRunV2(db, input);
    expect(off.run.execution_config.initialAnalysisMode).toBe('off');
    expect(await runOneV2({ ...options, personalModels: userModels.resolve, summaryProvider: { configuration: { provider:'fixture', model:'platform', endpoint:'http://localhost' }, complete } })).toMatchObject({ state: 'completed', issues: [] });
    expect(complete).not.toHaveBeenCalled();
    const enabled = { ...input, idempotencyKey: randomUUID(), personalAnalysisMode: 'summary' as const };
    await expect(enqueueRunV2(db, enabled)).rejects.toMatchObject({ code: 'MODEL_NOT_CONFIGURED' });
    await userModels.save(student, { vendor: 'deepseek', model: 'fixture', apiKey: 'fixture-student-key' });
    const queued = await enqueueRunV2(db, enabled);
    expect(queued.run.execution_config.initialModel.billingUserId).toBe(student);
    await expect(userModels.save(student, { vendor: 'deepseek', model: 'other', apiKey: 'fixture-other-key' })).rejects.toMatchObject({ code:'MODEL_ANALYSIS_ACTIVE' });
    await expect(enqueueRunV2(db, { ...enabled, personalAnalysisMode: 'off' })).rejects.toMatchObject({ code:'IDEMPOTENCY_CONFLICT' });
    // This case runs twice; the shared fixture's original execute assertion selects the first owner.
    runner.execute = vi.fn(async request => { lastRequest = request; lastResponse = await responseFor(request); return lastResponse; });
    expect(await runOneV2({ ...options, personalModels: userModels.resolve })).toMatchObject({ state: 'completed', issues: [] });
    expect(complete).toHaveBeenCalledTimes(1);
    await userModels.remove(student);
  });

  it('rejects changed personal credentials before course dispatch and never falls back', async () => {
    const complete = vi.fn(async () => { throw new Error('MUST_NOT_CALL'); });
    const userModels = createUserModelService(db, randomBytes(32), env => ({ configuration: { provider: 'fixture', model: env.MODEL_NAME!, endpoint: env.MODEL_BASE_URL! }, complete }));
    await userModels.save(student, { vendor: 'deepseek', model: 'fixture', apiKey: 'fixture-student-key' });
    await enqueueRunV2(db, { submissionId, actorId:student, idempotencyKey:randomUUID(), executionApproved:true, approvedFingerprint:fingerprint, personalAnalysisMode:'summary', personalModels:userModels.resolve });
    await db.query('UPDATE user_model_settings SET revision=$2 WHERE user_id=$1', [student, randomUUID()]);
    const result = await runOneV2({ ...options, personalModels:userModels.resolve });
    expect(result).toMatchObject({ state:'completed', reportReady:true, issues:[{code:'ANALYSIS_CONFIGURATION_CHANGED'}] });
    expect(complete).not.toHaveBeenCalled();
    expect((await savedOwner()).cleanup_state).toBe('clean');
  });
  it.each([false, true])("recovers an expired independent owner without replaying analysis (cancelled=%s)", async cancelled => {
    const queued = await enqueue();
    expect((await runOneV2(options)).state).toBe("completed");
    const base = await savedOwner();
    const revision = (await db.query("SELECT id FROM report_revisions WHERE run_id=$1", [queued.run.id])).rows[0];
    const configuration = { provider: "test-only", model: "synthetic", endpoint: "http://127.0.0.1/fixture" };
    const requested = await enqueueReanalysisV2(db, { runId: queued.run.id, actorId: rule.confirmedBy, idempotencyKey: randomUUID(), body: { expectedRevisionId: revision.id }, configuration });
    const claimed = await claimNextV2(db);
    expect(claimed!.identity.id).toBe(requested.analysis.analysisAttemptId);
    if (cancelled) await cancelReanalysisV2(db, { runId: queued.run.id, actorId: rule.confirmedBy, analysisAttemptId: claimed!.identity.id });
    await db.query("UPDATE analysis_attempts SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [claimed!.identity.id]);
    const complete = vi.fn(async () => { throw new Error("MUST_NOT_REPLAY_MODEL"); });
    const recovered = await runOneV2({ ...options, summaryProvider: { configuration, complete } });
    expect(recovered.state).toBe("recovered");
    expect(complete).not.toHaveBeenCalled();
    expect(runner.execute).toHaveBeenCalledTimes(1);
    expect(lastCleanup!.owner).toMatchObject({ ownerKind: "analysis", ownerId: claimed!.identity.id });
    const stored = (await db.query("SELECT status,owner_phase,cleanup_state FROM analysis_attempts WHERE id=$1", [claimed!.identity.id])).rows[0];
    expect(stored).toMatchObject({ status: cancelled ? "cancelled" : "interrupted", owner_phase: "closed", cleanup_state: "clean" });
    expect((await savedOwner()).base_manifest).toEqual(base.base_manifest);
    expect((await db.query("SELECT id FROM report_revisions WHERE run_id=$1", [queued.run.id])).rows).toEqual([revision]);
  });
  it('persists the parent checkpoint before writes when checkpoint storage is delayed', async () => {
    const queued = await enqueue();
    expect((await runOneV2(options)).state).toBe('completed');
    const base = await savedOwner();
    const revision = (await db.query('SELECT id FROM report_revisions WHERE run_id=$1', [queued.run.id])).rows[0];
    const configuration = {provider:'test-only', model:'synthetic', endpoint:'http://127.0.0.1/fixture'};
    const analysis = await enqueueReanalysisV2(db, {runId:queued.run.id, actorId:rule.confirmedBy,
      idempotencyKey:randomUUID(), body:{expectedRevisionId:revision.id, strategy:'agent'}, configuration});
    const put = AnalysisCheckpointSaverV2.prototype.put;
    const delayedSavers = new WeakSet<AnalysisCheckpointSaverV2>();
    vi.spyOn(AnalysisCheckpointSaverV2.prototype, 'put').mockImplementation(function (this: AnalysisCheckpointSaverV2, ...args) {
      if (!delayedSavers.has(this)) {
        delayedSavers.add(this);
        const encode = this.serde.dumpsTyped.bind(this.serde);
        vi.spyOn(this.serde, 'dumpsTyped').mockImplementation(async value => {
          // Delay checkpoint serialization, not the independent pending writes.
          if (value && typeof value === 'object' && 'channel_values' in value) await wait(80);
          return encode(value);
        });
      }
      return put.apply(this, args);
    });
    let calls = 0;
    const result = await runOneV2({...options, heartbeatMs:5, summaryProvider:{configuration, complete:async request => {
      calls++;
      const content = JSON.stringify({type:'final', feedback:JSON.parse(request.user).initial.baseFeedback});
      return {content, raw:content, requestId:'delayed-checkpoint-fixture', usage:{inputTokens:100, outputTokens:100}};
    }}});
    const stored = (await db.query('SELECT status,usage FROM analysis_attempts WHERE id=$1', [analysis.analysis.analysisAttemptId])).rows[0];
    expect(stored.status, JSON.stringify({issues:result.issues, usage:stored.usage})).toBe('succeeded');
    expect(result.state).toBe('completed');
    expect(calls).toBe(1);
    expect((await savedOwner()).base_manifest).toEqual(base.base_manifest);
    expect((await db.query('SELECT id FROM report_revisions WHERE run_id=$1', [queued.run.id])).rows).toEqual([revision]);
  });
  it.each((process.env.CODELAB_TEST_RECOVERY_STRESS === '1'
    ? Array.from({length: 12}, () => 'cleanup-pending')
    : ["candidate","unconfigured","cancelled","cleanup-pending","summary","summary-unknown"]
  ).map((mode, iteration) => ({mode, iteration})))("dispatches independent archived analysis ($mode, iteration $iteration) and keeps base execution immutable",async ({mode})=>{
    const queued=await enqueue();
    expect((await runOneV2(options)).state).toBe("completed");
    const base=await savedOwner();
    const revision=(await db.query("SELECT id FROM report_revisions WHERE run_id=$1",[queued.run.id])).rows[0];
    const configuration={provider:"test-only",model:"synthetic",endpoint:"http://127.0.0.1/fixture"};
    const analysis=await enqueueReanalysisV2(db,{runId:queued.run.id,actorId:rule.confirmedBy,idempotencyKey:randomUUID(),body:{expectedRevisionId:revision.id, strategy: mode.startsWith('summary') ? 'summary' : 'agent'},configuration});
    vi.mocked(runner.heartbeat).mockClear();
    if(mode==="cleanup-pending") runner.cleanup=vi.fn(async request=>{lastCleanup=request;return receiptFor(request,true);});
    let calls=0;
    const result=await runOneV2({...options,heartbeatMs:5,summaryProvider:mode==="unconfigured" ? undefined:{configuration,complete:async request=>{
      calls++;
      await wait(20);
      expect(runner.heartbeat).not.toHaveBeenCalled(); // No runner owner exists until a probe is prepared.
      if(mode==="cancelled") await cancelReanalysisV2(db,{runId:queued.run.id,actorId:rule.confirmedBy,analysisAttemptId:analysis.analysis.analysisAttemptId});
      if(mode==='summary-unknown') throw new ModelRequestError('MODEL_TRANSPORT_UNKNOWN','unknown');
      const material=JSON.parse(request.user);
      const content=JSON.stringify({...(mode==='summary' ? {} : {type:"final"}),feedback:(mode==='summary' ? material.baseFeedback : material.initial.baseFeedback).map((f:any)=> mode==='summary' || mode==='candidate'
        ? {criterionId:f.criterionId,observation:f.observation,possibleCause:f.possibleCause,nextStep:f.nextStep,causeSupport:f.causeSupport,causeEvidenceRefs:f.causeEvidenceRefs}
        : {...f})});
      return {content,raw:content,requestId:"synthetic-independent",usage:{inputTokens:100,outputTokens:100}};
    }}});
    expect(result.state).toBe(mode==="cleanup-pending" ? "cleanup_pending":"completed");
    expect(calls).toBe(mode==="unconfigured" ? 0:1);
    expect(runner.execute).toHaveBeenCalledTimes(1);
    const stored=(await db.query("SELECT * FROM analysis_attempts WHERE id=$1",[analysis.analysis.analysisAttemptId])).rows[0];
    expect(stored.status, JSON.stringify({issues: result.issues, usage: stored.usage})).toBe(mode==="cancelled" ? "cancelled":["unconfigured","summary-unknown"].includes(mode) ? "degraded":"succeeded");
    expect(stored.owner_phase).toBe(mode==="cleanup-pending" ? "cleanup_pending":"closed");
    expect(lastCleanup!.owner.ownerKind).toBe("analysis");
    expect(lastCleanup!.owner.ownerId).toBe(analysis.analysis.analysisAttemptId);
    expect((await savedOwner()).base_manifest).toEqual(base.base_manifest);
    expect((await db.query("SELECT id FROM report_revisions WHERE run_id=$1",[queued.run.id])).rows).toEqual([revision]);
    if (mode === "cleanup-pending") {
      const originalCleanup = lastCleanup!;
      runner.cleanup = vi.fn(async request => { lastCleanup=request; return receiptFor(request); });
      expect((await runOneV2(options)).state).toBe("recovered");
      expect(lastCleanup!.operationId).toBe(originalCleanup.operationId);
      expect(lastCleanup!.requestHash).toBe(originalCleanup.requestHash);
      expect(calls).toBe(1);
      expect(runner.execute).toHaveBeenCalledTimes(1);
      expect((await db.query("SELECT status,owner_phase FROM analysis_attempts WHERE id=$1",[analysis.analysis.analysisAttemptId])).rows[0]).toMatchObject({status:"succeeded",owner_phase:"closed"});
    }
  });
  it.each(["passed","failed"] as const)("integrates agent analysis after %s base results and always cleans resources",async verdict=>{
    const execute=runner.execute;
    runner.execute=async(...args)=>{
      const response=await execute(...args);
      response.caseResults[0].verdict=verdict;
      response.caseResults[0].reasonCode=verdict==="passed" ? "ASSERTION_SATISFIED":"ASSERTION_NOT_SATISFIED";
      return response;
    };
    await enqueue();let calls=0;
    const result=await runOneV2({...options,analysisMode:"agent",summaryProvider:{
      configuration:{provider:"test-only",model:"synthetic",endpoint:"http://127.0.0.1/fixture"},
      complete:async request=>{
        calls++;
        const material=JSON.parse(request.user);
        const content=JSON.stringify(calls===1 ? {type:"tool",name:"read_source_excerpt",args:{path:"src/App.vue",startLine:1,lineCount:20}}:
          {type:"final",feedback:material.initial.baseFeedback});
        return {content,raw:content,requestId:null,usage:{inputTokens:100,outputTokens:100}};
      },
    }});
    expect(result).toMatchObject({state:"completed",baseSealed:true,reportReady:true,issues:[]});
    expect((await savedOwner()).cleanup_state).toBe("clean");
    expect(calls).toBe(verdict==="passed" ? 0:2);
    const analyses=(await db.query("SELECT status FROM analysis_attempts")).rows;
    expect(analyses).toHaveLength(verdict==="passed" ? 0:1);
    if(verdict==="failed") expect(analyses[0].status).toBe("succeeded");
  });
  it.each(['off', 'summary'] as const)('honors frozen %s initial strategy even when restarted worker selects agent', async mode => {
    const created = await enqueue();
    await db.query("UPDATE runs SET execution_config=jsonb_set(execution_config,'{initialAnalysisMode}',$2::jsonb) WHERE id=$1", [created.run.id, JSON.stringify(mode)]);
    let calls = 0;
    const result = await runOneV2({ ...options, analysisMode: 'agent', summaryProvider: {
      configuration: { provider: 'test-only', model: 'synthetic', endpoint: 'http://127.0.0.1/fixture' },
      complete: async request => {
        calls++;
        const material = JSON.parse(request.user);
        expect(material).toHaveProperty('baseFeedback');
        expect(material).not.toHaveProperty('initial');
        const content = JSON.stringify({ feedback: material.baseFeedback });
        return { content, raw: content, requestId: null, usage: null };
      },
    } });
    expect(result).toMatchObject({ state: 'completed', reportReady: true, issues: [] });
    expect(calls).toBe(mode === 'off' ? 0 : 1);
    const analyses = (await db.query('SELECT configuration FROM analysis_attempts')).rows;
    expect(analyses).toHaveLength(mode === 'off' ? 0 : 1);
    if (mode === 'summary') expect(analyses[0].configuration.promptVersion).toBe('sealed-text-summary-v4-observation-bounds');
    expect((await savedOwner()).cleanup_state).toBe('clean');
  });
  it.each(["valid", "invalid", "lost-response"])(
    "completes base and cleanup with a %s synthetic model response",
    async (mode) => {
      await enqueue();
      let calls = 0;
      const result = await runOneV2({
        ...options,
        summaryProvider: {
          configuration: {
            provider: "test-only",
            model: "synthetic",
            endpoint: "http://127.0.0.1/fixture",
          },
          complete: async (request) => {
            calls++;
            expect((await savedOwner()).base_sealed_at).toBeTruthy();
            expect(
              (await db.query("SELECT * FROM report_revisions")).rows,
            ).toHaveLength(1);
            if (mode === "lost-response")
              throw new Error("synthetic lost reply");
            const feedback = JSON.parse(request.user).baseFeedback;
            return {
              raw: "synthetic private response",
              content:
                mode === "valid"
                  ? JSON.stringify({ feedback })
                  : "invalid JSON",
              requestId: null,
              usage: null,
            };
          },
        },
      });
      expect(result).toMatchObject({
        state: "completed",
        baseSealed: true,
        reportReady: true,
        issues: [],
      });
      expect(calls).toBe(1);
      expect((await savedOwner()).cleanup_state).toBe("clean");
      expect(
        (await db.query("SELECT status FROM analysis_attempts")).rows[0].status,
      ).toBe(mode === "valid" ? "succeeded" : "degraded");
      expect(
        (await db.query("SELECT * FROM report_revisions")).rows,
      ).toHaveLength(1);
    },
  );
  it("dispatches only verified editable source from a complete validated ZIP dictionary", async () => {
    const validated = await validateZip(
      await readFile(new URL("../fixtures/correct.zip", import.meta.url)),
    );
    expect(Object.keys(validated.files)).toEqual(
      expect.arrayContaining([
        "package.json",
        "package-lock.json",
        "vite.config.js",
        "index.html",
        "src/App.vue",
      ]),
    );
    const editable = Object.fromEntries(
      Object.entries(validated.files).filter(
        ([name]) => name.startsWith("src/") || name.startsWith("public/"),
      ),
    );
    const manifest = await createSourceManifest(editable);
    await enqueue();
    expect(await runOneV2(options)).toMatchObject({
      state: "completed",
      reportReady: true,
      issues: [],
    });
    expect(lastRequest?.files).toEqual(editable);
    expect(lastRequest?.context).toMatchObject({
      originalZipSha256: validated.sha256,
      sourceManifestSha256: manifest.sourceManifestSha256,
    });
    expect(
      (
        await db.query("SELECT files FROM submissions WHERE id=$1", [
          submissionId,
        ])
      ).rows[0].files,
    ).toEqual(validated.files);
    expect(runner.execute).toHaveBeenCalledTimes(1);
  });

  it.each(["source_bytes", "stored_manifest"])(
    "rejects changed %s before dispatching or registering an execute action",
    async (changed) => {
      const changedFiles = {
        "src/App.vue": encodeBase64(new TextEncoder().encode("changed bytes")),
      };
      const changedManifest = await createSourceManifest(changedFiles);
      // Fault injection at the read boundary preserves immutable DB records.
      const corrupted: DB = {
        ...db,
        query: async (sql, params) => {
          const result = await db.query(sql, params);
          if (!sql.includes("s.source_manifest,s.source_manifest_sha256"))
            return result;
          return {
            ...result,
            rows: result.rows.map((row) => ({
              ...row,
              ...(changed === "source_bytes"
                ? { files: changedFiles }
                : { source_manifest: changedManifest }),
            })),
          };
        },
      };
      await enqueue();
      expect(await runOneV2({ ...options, db: corrupted })).toMatchObject({
        state: "recovery_pending",
        issues: [
          {
            kind: "configuration",
            stage: "request_validation",
            code: "SOURCE_HASH_MISMATCH",
          },
        ],
      });
      expect(runner.execute).not.toHaveBeenCalled();
      expect((await savedOwner()).control_operations.execute).toBeUndefined();
    },
  );

  it("polls without an optional result observer and stops promptly", async () => {
    const stop = new AbortController();
    runner.capabilities = vi.fn(async () => {
      stop.abort();
      return {
        protocolVersion: 2 as const,
        limitsVersion: "limits-v1" as const,
        state: "busy" as const,
        templateHashes: [],
        packManifestHashes: [],
        actualEnvironment: unknownMeasuredEnvironment(),
        activeOwner: null,
        residualResourceIds: [],
        admissionRecordVersion: "fixture-v1",
      };
    });
    await runWorkerV2Loop({ ...options, signal: stop.signal, pollMs: 10 });
    expect(runner.capabilities).toHaveBeenCalledTimes(1);
  });

  it("stores exact evidence before sealing, makes one deterministic report, and verifies cleanup", async () => {
    await enqueue();
    const result = await runOneV2(options);
    expect(result).toMatchObject({
      state: "completed",
      baseSealed: true,
      reportReady: true,
      issues: [],
    });
    const owner = await savedOwner();
    expect(owner).toMatchObject({
      owner_phase: "closed",
      cleanup_state: "clean",
    });
    expect(owner.base_results[0].verdict).toBe("passed");
    expect(
      Buffer.from(
        await store.readEvidence(lastResponse!.baseManifest.evidence[0]),
      ),
    ).toEqual(Buffer.from(lastResponse!.artifacts[0].data, "base64"));
    expect(
      (await db.query("SELECT * FROM report_revisions")).rows,
    ).toHaveLength(1);
    expect(
      (await db.query("SELECT * FROM analysis_attempts")).rows,
    ).toHaveLength(0);
    expect((await runOneV2(options)).state).toBe("idle");
    expect(runner.execute).toHaveBeenCalledTimes(1);
  });

  it.each(["transport", "timeout"] as const)(
    "queries the original operation after an execute %s failure without dispatching it again",
    async (kind) => {
      await enqueue();
      runner.execute = vi.fn(async (request) => {
        lastRequest = request;
        lastResponse = await responseFor(request);
        throw new RunnerClientError(
          kind,
          kind === "timeout"
            ? "RUNNER_CALL_TIMEOUT"
            : "RUNNER_TRANSPORT_FAILED",
        );
      });
      let queries = 0;
      runner.query = vi.fn(async (request) => {
        expect(request.operationId).toBe(lastRequest!.operationId);
        expect(request.requestHash).toBe(lastRequest!.requestHash);
        return queried(request, ++queries === 1 ? null : lastResponse);
      });
      expect((await runOneV2(options)).state).toBe("completed");
      expect(runner.execute).toHaveBeenCalledTimes(1);
      expect(runner.query).toHaveBeenCalledTimes(2);
    },
  );

  it("rejects altered stored responses and recovers expired unsealed work as unknown/not_run", async () => {
    await enqueue();
    runner.execute = vi.fn(async (request) => {
      lastRequest = request;
      lastResponse = await responseFor(request);
      throw new RunnerClientError("transport", "RUNNER_TRANSPORT_FAILED");
    });
    runner.query = vi.fn(async (request) => {
      const value = await queried(request, lastResponse);
      value.record.responseHash = "b".repeat(64);
      return value;
    });
    expect(await runOneV2(options)).toMatchObject({
      state: "recovery_pending",
      issues: [
        { kind: "runner_protocol", code: "RUNNER_STORED_RESPONSE_MISMATCH" },
      ],
    });
    expect((await savedOwner()).base_sealed_at).toBeNull();
    expect(runner.cleanup).not.toHaveBeenCalled();
    await expireOwner();
    expect((await runOneV2(options)).state).toBe("recovered");
    const owner = await savedOwner();
    expect(owner.base_results[0]).toMatchObject({
      verdict: "not_run",
      executedSteps: [],
    });
    expect(owner.actual_fingerprint).toEqual(unknownMeasuredEnvironment());
    expect(owner.owner_phase).toBe("closed");
    expect(runner.execute).toHaveBeenCalledTimes(1);
  });

  it("renews the database before independent runner heartbeats while execute is pending", async () => {
    await enqueue();
    let release!: (response: RunnerExecuteResponse) => void;
    runner.execute = vi.fn(async (request) => {
      lastRequest = request;
      return new Promise<RunnerExecuteResponse>((resolve) => {
        release = resolve;
      });
    });
    let beats = 0;
    runner.heartbeat = vi.fn(async (request) => {
      const owner = await savedOwner();
      expect(request.leaseUntil).toBe(
        new Date(owner.lease_until).toISOString(),
      );
      expect(
        new Date(owner.pipeline_deadline_at).getTime() -
          new Date(owner.pipeline_started_at).getTime(),
      ).toBe(300_000);
      beats++;
      return { protocolVersion: 2 as const, leaseUntil: request.leaseUntil };
    });
    const running = runOneV2({ ...options, heartbeatMs: 10 });
    await until(() => beats >= 2);
    release(await responseFor(lastRequest!));
    expect((await running).state).toBe("completed");
    expect(beats).toBeGreaterThanOrEqual(2);
  });

  it("does not renew the runner after the database heartbeat fails", async () => {
    await enqueue();
    let failDatabase = false;
    runner.execute = vi.fn(async (request) => {
      lastRequest = request;
      failDatabase = true;
      return never();
    });
    const broken = intercept(db, (sql) => {
      if (failDatabase && sql.includes("SET heartbeat_at=clock_timestamp()"))
        throw new Error("DB_HEARTBEAT_INJECTED");
    });
    const result = await runOneV2({ ...options, db: broken, heartbeatMs: 10 });
    expect(result).toMatchObject({
      state: "recovery_pending",
      issues: [
        {
          kind: "database",
          stage: "database_heartbeat",
          code: "DB_HEARTBEAT_INJECTED",
        },
      ],
    });
    expect(runner.heartbeat).not.toHaveBeenCalled();
    expect((await savedOwner()).base_sealed_at).toBeNull();
  });

  it.each(["resolve", "reject"] as const)("fences a delayed database heartbeat %s after worker shutdown", async (completion) => {
    await enqueue();
    const shutdown = new AbortController();
    let executing = false, held = false, delivered = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    runner.execute = vi.fn(async (request) => {
      lastRequest = request;
      executing = true;
      return never();
    });
    const delayed: DB = {
      ...db,
      async transaction(fn) {
        let heartbeat = false;
        const result = await db.transaction(tx => fn(intercept(tx, sql => {
          if (executing && sql.includes("SET heartbeat_at=clock_timestamp()")) heartbeat = true;
        })));
        if (heartbeat) {
          // Commit has finished, but its response is still in transit to the worker.
          held = true;
          await gate;
          delivered = true;
          if (completion === "reject") throw new Error("DB_RESPONSE_LOST_AFTER_COMMIT");
        }
        return result;
      },
    };
    const running = runOneV2({ ...options, db: delayed, signal: shutdown.signal, heartbeatMs: 10 });
    try {
      await until(() => held);
      shutdown.abort();
      expect(await running).toMatchObject({ state: "recovery_pending", issues: [{ kind: "stopped" }] });
      expect(delivered).toBe(false);
      expect(runner.heartbeat).not.toHaveBeenCalled();
      release();
      await until(() => delivered);
      await wait(30);
      expect(runner.heartbeat).not.toHaveBeenCalled();
      expect(runner.cleanup).not.toHaveBeenCalled();
      expect((await savedOwner()).base_sealed_at).toBeNull();
      await expireOwner();
      expect((await runOneV2(options)).state).toBe("recovered");
      expect((await savedOwner()).owner_phase).toBe("closed");
      expect(runner.execute).toHaveBeenCalledTimes(1);
    } finally {
      shutdown.abort();
      release();
      await running;
    }
  });

  it("classifies runner lease loss separately and refuses to accept a late execute response", async () => {
    await enqueue();
    let release!: (response: RunnerExecuteResponse) => void;
    runner.execute = vi.fn(async (request) => {
      lastRequest = request;
      return new Promise<RunnerExecuteResponse>((resolve) => {
        release = resolve;
      });
    });
    runner.heartbeat = vi.fn(async () => {
      throw new RunnerClientError("http", "OWNER_EXPIRED", 409);
    });
    expect(await runOneV2({ ...options, heartbeatMs: 10 })).toMatchObject({
      state: "recovery_pending",
      issues: [
        {
          kind: "runner_lease",
          stage: "runner_heartbeat",
          code: "OWNER_EXPIRED",
        },
      ],
    });
    release(await responseFor(lastRequest!));
    await wait(5);
    expect((await savedOwner()).base_sealed_at).toBeNull();
    expect(runner.cleanup).not.toHaveBeenCalled();
  });

  it("does not seal when durable artifact verification fails", async () => {
    await enqueue();
    const artifacts = {
      storeManifest: store.storeManifest.bind(store),
      verifyEvidence: vi.fn(async () => {
        throw new Error("ARTIFACT_STORAGE_MISMATCH");
      }),
    };
    expect((await runOneV2({ ...options, artifacts })).state).toBe(
      "recovery_pending",
    );
    expect(artifacts.verifyEvidence).toHaveBeenCalledTimes(1);
    expect((await savedOwner()).base_sealed_at).toBeNull();
    expect(
      (await db.query("SELECT * FROM report_revisions")).rows,
    ).toHaveLength(0);
  });

  it("preserves the sealed base after a report failure and repairs its draft on the next poll", async () => {
    await enqueue();
    let injected = false;
    const broken = intercept(db, (sql) => {
      if (!injected && /INSERT INTO report_revisions/.test(sql)) {
        injected = true;
        throw new Error("REPORT_INSERT_INJECTED");
      }
    });
    expect(await runOneV2({ ...options, db: broken })).toMatchObject({
      state: "completed",
      baseSealed: true,
      reportReady: false,
    });
    const before = await savedOwner();
    expect(before.owner_phase).toBe("closed");
    expect(
      (await db.query("SELECT * FROM report_revisions")).rows,
    ).toHaveLength(0);
    expect((await runOneV2(options)).state).toBe("idle");
    const after = await savedOwner();
    expect([
      after.base_results,
      after.base_manifest,
      after.actual_fingerprint,
      after.base_sealed_at,
    ]).toEqual([
      before.base_results,
      before.base_manifest,
      before.actual_fingerprint,
      before.base_sealed_at,
    ]);
    expect(
      (await db.query("SELECT * FROM report_revisions")).rows,
    ).toHaveLength(1);
    expect(runner.execute).toHaveBeenCalledTimes(1);
  });

  it("uses the stored cleanup response after a lost reply and never re-executes the base", async () => {
    await enqueue();
    runner.cleanup = vi.fn(async (request) => {
      lastCleanup = request;
      throw new RunnerClientError("transport", "RUNNER_TRANSPORT_FAILED");
    });
    runner.query = vi.fn(async (request) =>
      queried(request, receiptFor(lastCleanup!), "cleanup"),
    );
    expect((await runOneV2(options)).state).toBe("completed");
    expect(runner.cleanup).toHaveBeenCalledTimes(1);
    expect(runner.execute).toHaveBeenCalledTimes(1);
    expect((await savedOwner()).owner_phase).toBe("closed");
  });

  it("holds the slot on cleanup_pending and retries only the original cleanup identity", async () => {
    await enqueue();
    const cleanups: RunnerCleanupRequest[] = [];
    runner.cleanup = vi.fn(async (request) => {
      cleanups.push(request);
      return receiptFor(request, cleanups.length === 1);
    });
    expect((await runOneV2(options)).state).toBe("cleanup_pending");
    const sealed = await savedOwner();
    await enqueue();
    options.storageAdmission = async () => { throw new Error('low capacity during cleanup'); };
    expect((await runOneV2(options)).state).toBe("recovered");
    expect(cleanups[1].operationId).toBe(cleanups[0].operationId);
    expect(cleanups[1].requestHash).toBe(cleanups[0].requestHash);
    expect((await savedOwner()).base_results).toEqual(sealed.base_results);
    expect(runner.execute).toHaveBeenCalledTimes(1);
    expect(
      (await db.query("SELECT * FROM runs WHERE status='queued'")).rows,
    ).toHaveLength(1);
  });

  it("requires the same measured approved fingerprint that was registered on the run", async () => {
    await enqueue();
    expect(
      await runOneV2({
        ...options,
        approvedFingerprint: {
          ...fingerprint,
          chromiumVersion: "different-fixture",
        },
      }),
    ).toMatchObject({
      state: "recovery_pending",
      issues: [
        { kind: "configuration", code: "APPROVED_ENVIRONMENT_MISMATCH" },
      ],
    });
    expect(runner.execute).not.toHaveBeenCalled();
    await expireOwner();
    expect((await runOneV2(options)).state).toBe("recovered");
    expect((await savedOwner()).base_results[0].verdict).toBe("not_run");
  });

  it("accepts a truthful build error without fabricating completed checks", async () => {
    await enqueue();
    runner.execute = vi.fn(async (request): Promise<RunnerExecuteResponse> => {
      const response = await responseFor(request);
      const definition = rule.packManifest.cases[0];
      return {
        ...response,
        outcome: "build_error",
        actualFingerprint: unknownMeasuredEnvironment(),
        caseResults: [
          {
            caseId: definition.caseId,
            criterionId: definition.criterionId,
            expected: definition.expected,
            verdict: "not_run",
            preconditionStatus: "uncertain",
            reasonCode: "BUILD_ERROR",
            observed: "Fixture build rejected",
            executedSteps: [],
            unexecutedStepIds: definition.plannedSteps.map(
              (step) => step.stepId,
            ),
            blockedBy: [
              {
                kind: "execution_stage",
                id: "build",
                reasonCode: "BUILD_ERROR",
              },
            ],
            evidenceIds: [],
          },
        ],
        baseManifest: await createArtifactManifest({
          manifestId: randomUUID(),
          context: request.context,
          source: "base",
          analysisAttemptId: null,
          operationId: null,
          evidence: [],
          completeness: "partial",
        }),
        artifacts: [],
      };
    });
    expect((await runOneV2(options)).state).toBe("completed");
    const saved = await savedOwner();
    expect(saved.base_results[0]).toMatchObject({
      verdict: "not_run",
      reasonCode: "BUILD_ERROR",
      executedSteps: [],
    });
    expect((await db.query("SELECT status FROM runs")).rows[0].status).toBe(
      "build_error",
    );
    expect(saved.owner_phase).toBe("closed");
  });
});

describe("v2 worker approved runtime selection", () => {
  it("uses the shared runtime catalog even when a legacy fingerprint path is also supplied", async () => {
    const {
      ruleHash: _ruleHash,
      parametersHash: _parametersHash,
      ...values
    } = fingerprint;
    const runtimeFile = path.join(temporary, "runtime-catalog.json");
    await writeFile(
      runtimeFile,
      JSON.stringify({
        packs: [rule.packManifest],
        actualEnvironment: {
          completeness: "partial",
          values,
          missingFields: ["ruleHash", "parametersHash"],
        },
      }),
    );
    const approvedFingerprint = await loadWorkerApprovedFingerprintV2({
      CODELAB_V2_RUNTIME_FILE: runtimeFile,
      WORKER_V2_FINGERPRINT_FILE: path.join(temporary, "does-not-exist.json"),
    });
    await enqueue();
    expect(await runOneV2({ ...options, approvedFingerprint })).toMatchObject({
      state: "completed",
      reportReady: true,
      issues: [],
    });
    expect(lastRequest?.approvedFingerprint).toEqual(fingerprint);
  });

  it("refuses an invalid configured runtime instead of falling back to a valid legacy file", async () => {
    const runtimeFile = path.join(temporary, "invalid-runtime.json");
    const legacyFile = path.join(temporary, "fingerprints.json");
    await writeFile(runtimeFile, JSON.stringify({ packs: [] }));
    await writeFile(
      legacyFile,
      JSON.stringify({ fingerprints: [fingerprint] }),
    );
    await expect(
      loadWorkerApprovedFingerprintV2({
        CODELAB_V2_RUNTIME_FILE: runtimeFile,
        WORKER_V2_FINGERPRINT_FILE: legacyFile,
      }),
    ).rejects.toBeInstanceOf(Error);
    expect(runner.execute).not.toHaveBeenCalled();
  });

  it("retains legacy per-rule fingerprints when no runtime catalog is configured", async () => {
    const legacyFile = path.join(temporary, "fingerprints.json");
    await writeFile(
      legacyFile,
      JSON.stringify({ fingerprints: [fingerprint] }),
    );
    const approvedFingerprint = await loadWorkerApprovedFingerprintV2({
      WORKER_V2_FINGERPRINT_FILE: legacyFile,
    });
    await enqueue();
    expect(await runOneV2({ ...options, approvedFingerprint })).toMatchObject({
      state: "completed",
      reportReady: true,
      issues: [],
    });
    expect(lastRequest?.approvedFingerprint).toEqual(fingerprint);
  });
});

describe("v2 runner HTTP client", () => {
  it("follows a 202 execute response with a strict operation query and one dispatch", async () => {
    await enqueue();
    const capabilities = await runner.capabilities();
    const endpoints: string[] = [];
    const transport = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        const endpoint = new URL(String(url)).pathname;
        endpoints.push(endpoint);
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        if (endpoint === "/v2/capabilities") return Response.json(capabilities);
        if (endpoint === "/v2/execute") {
          lastRequest = body;
          lastResponse = await responseFor(body);
          return Response.json(
            await queried(
              {
                protocolVersion: 2,
                owner: {
                  runId: body.context.runId,
                  ownerKind: "execution",
                  ownerId: body.context.executionAttemptId,
                  ownerToken: body.ownerToken,
                },
                operationId: body.operationId,
                requestHash: body.requestHash,
              },
              null,
            ),
            { status: 202 },
          );
        }
        if (endpoint === "/v2/operations/query") {
          expect(Object.keys(body).sort()).toEqual([
            "operationId",
            "owner",
            "protocolVersion",
            "requestHash",
          ]);
          return Response.json(await queried(body, lastResponse));
        }
        if (endpoint === "/v2/cleanup") return Response.json(receiptFor(body));
        throw new Error(`Unexpected fixture endpoint ${endpoint}`);
      },
    );
    const client = createRunnerClientV2({
      baseUrl: "http://runner.example.test",
      token: "t".repeat(32),
      fetchImpl: transport,
    });
    expect((await runOneV2({ ...options, runner: client })).state).toBe(
      "completed",
    );
    expect(endpoints).toEqual([
      "/v2/capabilities",
      "/v2/execute",
      "/v2/operations/query",
      "/v2/cleanup",
    ]);
  });

  it("uses bearer authentication and rejects redirect following", async () => {
    const capabilities = await runner.capabilities();
    const transport = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        expect(init?.headers).toMatchObject({
          Authorization: `Bearer ${"t".repeat(32)}`,
        });
        expect(init?.redirect).toBe("error");
        return new Response(JSON.stringify(capabilities), {
          headers: { "content-type": "application/json" },
        });
      },
    );
    const client = createRunnerClientV2({
      baseUrl: "http://runner.example.test",
      token: "t".repeat(32),
      fetchImpl: transport,
    });
    expect(await client.capabilities()).toEqual(capabilities);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("bounds streamed response bytes without trusting content-length", async () => {
    let cancelled = false;
    const client = createRunnerClientV2({
      baseUrl: "http://runner.example.test",
      token: "t".repeat(32),
      fetchImpl: async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.enqueue(new Uint8Array(1024 * 1024 + 1));
            },
            cancel() {
              cancelled = true;
            },
          }),
        ),
    });
    await expect(client.capabilities()).rejects.toMatchObject({
      kind: "protocol",
      code: "RUNNER_RESPONSE_TOO_LARGE",
    });
    expect(cancelled).toBe(true);
  });

  it("classifies HTTP and timeout failures without exposing remote text or retrying", async () => {
    const transport = vi.fn(
      async () =>
        new Response(
          '{"error":{"code":"OWNER_EXPIRED","message":"sensitive remote text"}}',
          { status: 409 },
        ),
    );
    const client = createRunnerClientV2({
      baseUrl: "http://runner.example.test",
      token: "t".repeat(32),
      fetchImpl: transport,
    });
    await expect(client.capabilities()).rejects.toMatchObject({
      kind: "http",
      code: "OWNER_EXPIRED",
      message: "OWNER_EXPIRED",
      statusCode: 409,
    });
    expect(transport).toHaveBeenCalledTimes(1);
    const timeoutClient = createRunnerClientV2({
      baseUrl: "http://runner.example.test",
      token: "t".repeat(32),
      fetchImpl: async (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new Error("transport aborted")),
            { once: true },
          );
        }),
    });
    await expect(
      timeoutClient.capabilities({ timeoutMs: 5 }),
    ).rejects.toMatchObject({ kind: "timeout", code: "RUNNER_CALL_TIMEOUT" });
  });
});
