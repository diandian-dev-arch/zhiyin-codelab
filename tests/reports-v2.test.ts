import { randomBytes, randomUUID } from "node:crypto";
import { createUserModelService } from '../apps/api/src/user-model-settings';
import { fork } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { unzipSync } from 'fflate';
import { exportAnalysisPairV2 } from '../apps/api/src/analysis-export-v2';
import { AnalysisCheckpointSaverV2 } from "../apps/api/src/analysis-checkpoints-v2";
import { mkdtemp,rm,writeFile,readFile,symlink } from "node:fs/promises";
import { auditRetentionV2 } from '../apps/api/src/retention-v2';
import { planCourseRetention } from '../apps/api/src/course-retention-plan';
import { withFrozenCourseHistory } from '../apps/api/src/course-retention-scope';
import { executeCourseDeletion } from '../apps/api/src/course-deletion';
import { cleanNextCourseEvidence } from '../apps/api/src/course-evidence-cleanup';
import { recordCourseAuthorization, revokeCourseAuthorization, assertCourseAuthorization } from '../apps/api/src/course-retention-authorization';
import { changeRetentionHoldV2 } from '../apps/api/src/retention-holds-v2';
import { tmpdir } from "node:os";
import path from "node:path";
import { ArtifactStore } from "../apps/api/src/artifacts-v2";
import { runAnalysisProbeV2 } from "../apps/api/src/analysis-probe-v2";
import type { RunnerClientV2 } from "../apps/api/src/runner-client-v2";
import { runInitialAnalysisV2, runReanalysisSummaryV2 } from "../apps/api/src/analysis-v2";
import { runInitialAgentV2, runReanalysisAgentV2 } from "../apps/api/src/agent-v2";
import { enqueueReanalysisV2, cancelReanalysisV2, beginReanalysisV2 } from "../apps/api/src/reanalysis-v2";
import { runAnalysisReadToolV2, boundedAnalysisToolResultV2 } from "../apps/api/src/analysis-read-tools-v2";
import { reserveAnalysisOperationV2,sendAnalysisOperationV2,finishAnalysisOperationV2 } from "../apps/api/src/analysis-operations-v2";
import {
  ModelRequestError,
  type SummaryProviderV2,
} from "../apps/api/src/model-provider-v2";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../apps/api/src/app";
import { digest } from "../apps/api/src/auth";
import { migrate, type DB } from "../apps/api/src/db";
import { loadMigrations } from '../apps/api/src/migrations';
import { lockStudentTask, recoverExpiredV2, claimNextV2, type OwnerIdentity } from "../apps/api/src/lifecycle-v2";
import {
  adoptReviewV2,
  confirmReviewV2,
  createCorrectionV2,
  editReviewV2,
  ensureBaseReportV2,
  getPublicationV2,
  getPublicationComparisonV2,
  getPublicationComparisonOptionsV2,
  getReviewV2,
  getRunComparisonV2,
  getExplicitRunComparisonV2,
  publishReportV2,
  readPublicationEvidenceV2,
  readReviewEvidenceV2,
  type EvidenceReader,
} from "../apps/api/src/reports-v2";
import {
  createArtifactManifest,
  createDevelopmentPack,
  createRuleSnapshot,
  createSourceManifest,
  hashRuleSnapshot,
  hashProbeRequest,
  type RunnerProbeRequest,
  type RunnerProbeResponse,
  hashTaskPack,
  sha256,
  unknownMeasuredEnvironment,
  type ArtifactManifest,
  type CaseResult,
  type Evidence,
  type RuleSnapshot,
} from "../packages/contracts/src/v2/index";
import { isolatedTestDB, type IsolatedTestDatabase } from "./isolated-db";

// All observations, teacher actions and publications are isolated ui_fixture records.
// These tests do not execute a browser, authenticate a real teacher or certify G1.
const timestamp = "2026-09-27T00:00:00.000Z";
const fixtureHash = "a".repeat(64);
let db: IsolatedTestDatabase;
let teacherId: string,
  studentId: string,
  peerId: string,
  outsiderId: string,
  classId: string,
  taskId: string;
let runId: string, submissionId: string, executionId: string;
let rule: RuleSnapshot,
  baseManifest: ArtifactManifest,
  baseResults: CaseResult[];
let contents: Map<string, Uint8Array>;
const openApps: Awaited<ReturnType<typeof createApp>>[] = [];
const identity = () => ({
  runId,
  actorId: teacherId,
  idempotencyKey: randomUUID(),
});
const reader: EvidenceReader = async (evidence) => {
  const bytes = contents.get(evidence.evidenceId);
  if (!bytes) throw new Error("fixture artifact unavailable");
  return bytes;
};
async function review() {
  return getReviewV2(db, { runId, actorId: teacherId });
}
async function ready() {
  await ensureBaseReportV2(db, runId);
  return review();
}
async function confirmAll() {
  const current = await review();
  return confirmReviewV2(db, identity(), {
    expectedRevisionId: current.revision.revisionId,
    items: Object.entries(current.criterionContentHashes).map(
      ([criterionId, contentHash]) => ({ criterionId, contentHash }),
    ),
  });
}
function publicationBody(revisionId: string) {
  return {
    expectedRevisionId: revisionId,
    purpose: "latest" as const,
    publicEvidenceIds: baseManifest.evidence
      .filter((evidence) => evidence.phase !== "diagnostic")
      .map((evidence) => evidence.evidenceId),
  };
}
async function firstPublication() {
  await ready();
  const current = await confirmAll();
  return publishReportV2(
    db,
    identity(),
    publicationBody(current.revision.revisionId),
    reader,
  );
}
// Build another genuinely distinct submission/manifest/publication without mutating sealed rows.
async function nextComparisonPublication(options: {student?: string; locale?: string; differentTask?: boolean; nextRule?: boolean} = {}) {
  const sourceSubmission=submissionId;
  if(options.student)studentId=options.student;
  if(options.differentTask){
    taskId=randomUUID();
    await db.query("INSERT INTO tasks(id,class_id,title,description) VALUES($1,$2,'comparison scope','ui_fixture')",[taskId,classId]);
    rule=await createRuleSnapshot({ruleId:randomUUID(),taskId,version:1,packManifest:rule.packManifest,
      enabledCriterionIds:rule.enabledCriterionIds,parameterValues:rule.parameterValues,confirmedBy:teacherId,confirmedAt:timestamp});
    await db.query("INSERT INTO rules(id,task_id,version,template_version,criteria,contract_version,rule_snapshot,idempotency_key,request_hash) VALUES($1,$2,1,'vue-board-v1','[]',2,$3,$4,$5)",[rule.ruleId,taskId,JSON.stringify(rule),randomUUID(),fixtureHash]);
  }
  if(options.nextRule){
    rule=await createRuleSnapshot({ruleId:randomUUID(),taskId,version:rule.version+1,packManifest:rule.packManifest,
      enabledCriterionIds:rule.enabledCriterionIds,parameterValues:rule.parameterValues,confirmedBy:teacherId,confirmedAt:timestamp});
    await db.query("INSERT INTO rules(id,task_id,version,template_version,criteria,contract_version,rule_snapshot,idempotency_key,request_hash) VALUES($1,$2,$3,'vue-board-v1','[]',2,$4,$5,$6)",[rule.ruleId,taskId,rule.version,JSON.stringify(rule),randomUUID(),fixtureHash]);
  }
  submissionId=randomUUID();runId=randomUUID();executionId=randomUUID();
  await db.query(`INSERT INTO submissions(id,task_id,user_id,rule_id,sha256,files,request_id,contract_version,source_manifest,source_manifest_sha256,source_manifest_version,created_at)
    SELECT $2,$3,$4,$5,sha256,files,$6,2,source_manifest,source_manifest_sha256,source_manifest_version,now() FROM submissions WHERE id=$1`,
    [sourceSubmission,submissionId,taskId,studentId,rule.ruleId,randomUUID()]);
  await db.query("INSERT INTO runs(id,submission_id,rule_id,status,contract_version,execution_config,request_id,idempotency_key,request_hash) VALUES($1,$2,$3,'completed',2,'{}',$4,$5,$6)",[runId,submissionId,rule.ruleId,randomUUID(),randomUUID(),fixtureHash]);
  const manifestId=randomUUID();
  const context={...baseManifest.context,runId,submissionId,executionAttemptId:executionId,ruleId:rule.ruleId,ruleHash:await hashRuleSnapshot(rule)};
  const ids=new Map<string,string>();
  const evidence=baseManifest.evidence.map(e=>{
    const id=randomUUID();ids.set(e.evidenceId,id);contents.set(id,contents.get(e.evidenceId)!);
    return {...e,evidenceId:id,manifestId,runId,submissionId,executionAttemptId:executionId,ruleHash:context.ruleHash,storageKey:`runs/${runId}/${manifestId}/${id}.txt`};
  });
  baseManifest=await createArtifactManifest({manifestId,context,source:'base',analysisAttemptId:null,operationId:null,evidence,completeness:'complete'});
  baseResults=baseResults.map(r=>({...r,evidenceIds:r.evidenceIds.map(id=>ids.get(id)!),executedSteps:r.executedSteps.map(s=>({...s,evidenceIds:s.evidenceIds.map(id=>ids.get(id)!)}))}));
  const image={identifierType:'digest',value:`sha256:${fixtureHash}`};
  const fingerprint={completeness:'complete',missingFields:[],values:{ruleHash:context.ruleHash,packManifestHash:rule.packManifestHash,
    templateHash:rule.packManifest.templateHash,dependencyLockHash:rule.packManifest.dependencyLockHash,initializationVersion:rule.packManifest.initializationVersion,
    parametersHash:rule.parametersHash,aggregationVersion:'aggregation-v1',buildImage:image,webImage:image,browserImage:image,playwrightVersion:'synthetic-1',chromiumVersion:'synthetic-1',
    viewport:{width:1280,height:720,deviceScaleFactor:1},locale:options.locale ?? 'zh-CN',timezone:'UTC',clockPolicy:'real-time-v1',randomPolicy:'uncontrolled-v1',pageServerPolicy:'static-v1',resourceTimeoutConfigVersion:'limits-v1'}};
  await db.query(`INSERT INTO execution_attempts(id,run_id,attempt_no,owner_phase,pipeline_started_at,work_deadline_at,pipeline_deadline_at,base_sealed_at,base_results,base_manifest,actual_fingerprint)
    VALUES($1,$2,1,'initial_analysis',now(),now()+interval '270 seconds',now()+interval '300 seconds',now(),$3,$4,$5)`,[executionId,runId,JSON.stringify(baseResults),JSON.stringify(baseManifest),JSON.stringify(fingerprint)]);
  await db.query('UPDATE runs SET accepted_execution_attempt_id=$2 WHERE id=$1',[runId,executionId]);
  return (await firstPublication()).publication;
}
function manualJudgment(
  targetId: string,
  targetType: "case" | "manualCriterion" = "case",
) {
  return {
    targetType,
    targetId,
    verdict: "failed" as const,
    reason: "ui_fixture：教师独立复现后确认未满足",
    verificationMethod: "manual_reproduction" as const,
    evidenceRefs: [],
    verificationNote:
      "ui_fixture：重新打开页面按公开步骤操作并记录目标任务状态",
  };
}
async function addSubmission(tx: DB = db) {
  const id = randomUUID();
  await tx.query(
    `INSERT INTO submissions(id,task_id,user_id,rule_id,sha256,files,request_id,contract_version,
    source_manifest,source_manifest_sha256,source_manifest_version,created_at)
    SELECT $1,task_id,user_id,rule_id,sha256,files,$2,2,source_manifest,source_manifest_sha256,source_manifest_version,clock_timestamp()
    FROM submissions WHERE id=$3`,
    [id, randomUUID(), submissionId],
  );
  return id;
}
async function addRun(tx: DB = db) {
  const id = randomUUID();
  await tx.query(
    `INSERT INTO runs(id,submission_id,rule_id,status,contract_version,execution_config,request_id,idempotency_key,request_hash,created_at)
    VALUES($1,$2,$3,'queued',2,'{}',$4,$5,$6,clock_timestamp())`,
    [id, submissionId, rule.ruleId, randomUUID(), randomUUID(), fixtureHash],
  );
  return id;
}
async function supplementalFixture(
  phase: "source_excerpt" | "diagnostic" = "source_excerpt",
) {
  const analysisId = randomUUID(),
    operationId = randomUUID(),
    manifestId = randomUUID(),
    evidenceId = randomUUID();
  const bytes = new TextEncoder().encode(`ui_fixture ${phase} ${evidenceId}`);
  const evidence: Evidence = {
    ...baseManifest.evidence.find((item) => item.criterionId === "create")!,
    evidenceId,
    manifestId,
    analysisAttemptId: analysisId,
    operationId,
    phase,
    collector: "business_extractor",
    contentOrigin:
      phase === "source_excerpt" ? "student_source" : "platform_diagnostic",
    sha256: await sha256(bytes),
    byteSize: bytes.byteLength,
    storageKey: `runs/${runId}/${manifestId}/${evidenceId}.txt`,
  };
  contents.set(evidenceId, bytes);
  const manifest = await createArtifactManifest({
    manifestId,
    context: baseManifest.context,
    source: "supplemental",
    analysisAttemptId: analysisId,
    operationId,
    evidence: [evidence],
    completeness: "complete",
  });
  await db.query(
    `INSERT INTO analysis_attempts(id,run_id,base_manifest_id,mode,owner_execution_attempt_id,status)
    VALUES($1,$2,$3,'initial',$4,'succeeded')`,
    [analysisId, runId, baseManifest.manifestId, executionId],
  );
  await db.query(
    `INSERT INTO analysis_operations(analysis_attempt_id,operation_id,kind,request_hash,state,reserved_budget,supplemental_manifest)
    VALUES($1,$2,'read_source_excerpt',$3,'completed','{}',$4)`,
    [analysisId, operationId, fixtureHash, JSON.stringify(manifest)],
  );
  return manifest;
}
async function setupReportFixture(filterFailed = false) {
  db = await isolatedTestDB();
  await migrate(db);
  contents = new Map();
  [
    teacherId,
    studentId,
    peerId,
    outsiderId,
    classId,
    taskId,
    runId,
    submissionId,
    executionId,
  ] = Array.from({ length: 9 }, () => randomUUID());
  for (const [id, role] of [
    [teacherId, "teacher"],
    [studentId, "student"],
    [peerId, "student"],
    [outsiderId, "teacher"],
  ])
    await db.query(
      "INSERT INTO users(id,email,name,role,password_hash) VALUES($1,$2,'ui_fixture',$3,'not-a-login-hash')",
      [id, `${id}@example.test`, role],
    );
  await db.query(
    "INSERT INTO classes(id,name,teacher_id) VALUES($1,'ui_fixture',$2)",
    [classId, teacherId],
  );
  for (const id of [studentId, peerId])
    await db.query("INSERT INTO memberships(class_id,user_id) VALUES($1,$2)", [
      classId,
      id,
    ]);
  await db.query(
    "INSERT INTO tasks(id,class_id,title,description) VALUES($1,$2,'ui_fixture report task','No real measurement')",
    [taskId, classId],
  );
  const pack = await createDevelopmentPack("new-filter", {
    packVersion: "ui-fixture-reports-v1",
    templateVersion: "vue-board-v1",
    templateHash: fixtureHash,
    dependencyLockHash: fixtureHash,
    initializationVersion: "ui-fixture-init",
    probeImplementationHashes:{FILTER_ORDER_CHECK:fixtureHash},
    caseImplementationHashes: {
      "NEW-01": fixtureHash,
      "FILTER-03": fixtureHash,
    },
  });
  pack.criteria.push({
    criterionId: "readability",
    displayCode: "CK-06",
    title: "人工可读性",
    mode: "manual",
    expectedBehavior: "教师根据公开要求复核",
  });
  pack.contentHash = await hashTaskPack(pack);
  rule = await createRuleSnapshot({
    ruleId: randomUUID(),
    taskId,
    version: 1,
    packManifest: pack,
    enabledCriterionIds: pack.criteria.map(
      (criterion) => criterion.criterionId,
    ),
    parameterValues: {},
    confirmedBy: teacherId,
    confirmedAt: timestamp,
  });
  await db.query(
    `INSERT INTO rules(id,task_id,version,template_version,criteria,contract_version,rule_snapshot,idempotency_key,request_hash)
    VALUES($1,$2,1,'vue-board-v1','[]',2,$3,$4,$5)`,
    [rule.ruleId, taskId, JSON.stringify(rule), randomUUID(), fixtureHash],
  );
  const files = {
    "src/App.vue": Buffer.from("<template>ui_fixture</template>").toString(
      "base64",
    ),
  };
  const source = await createSourceManifest(files);
  await db.query(
    `INSERT INTO submissions(id,task_id,user_id,rule_id,sha256,files,request_id,contract_version,
    source_manifest,source_manifest_sha256,source_manifest_version,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,2,$8,$9,$10,$11)`,
    [
      submissionId,
      taskId,
      studentId,
      rule.ruleId,
      fixtureHash,
      JSON.stringify(files),
      randomUUID(),
      JSON.stringify(source),
      source.sourceManifestSha256,
      source.algorithmVersion,
      timestamp,
    ],
  );
  await db.query(
    `INSERT INTO runs(id,submission_id,rule_id,status,contract_version,execution_config,request_id,idempotency_key,request_hash,created_at)
    VALUES($1,$2,$3,'completed',2,'{}',$4,$5,$6,$7)`,
    [
      runId,
      submissionId,
      rule.ruleId,
      randomUUID(),
      randomUUID(),
      fixtureHash,
      timestamp,
    ],
  );
  const context = {
    runId,
    executionAttemptId: executionId,
    submissionId,
    originalZipSha256: fixtureHash,
    sourceManifestSha256: source.sourceManifestSha256,
    ruleId: rule.ruleId,
    ruleHash: await hashRuleSnapshot(rule),
    packManifestHash: rule.packManifestHash,
    templateHash: pack.templateHash,
  };
  const manifestId = randomUUID();
  const evidence: Evidence[] = [];
  baseResults = [];
  for (const definition of pack.cases) {
    const evidenceId = randomUUID(),
      filter = definition.criterionId === "filter";
    const observed = `ui_fixture：${definition.caseId}${filter ? (filterFailed ? "筛选已完成但顺序与要求相反" : "准备阶段受阻，未执行筛选断言") : "实际观察新增一个任务"}`;
    const bytes = new TextEncoder().encode(observed);
    contents.set(evidenceId, bytes);
    evidence.push({
      evidenceId,
      manifestId,
      ...context,
      analysisAttemptId: null,
      operationId: null,
      scope: "case",
      criterionId: definition.criterionId,
      caseId: definition.caseId,
      phase: "base",
      collector: "runner",
      contentOrigin: "checker_observation",
      sha256: await sha256(bytes),
      byteSize: bytes.byteLength,
      mediaType: "text/plain; charset=utf-8",
      storageKey: `runs/${runId}/${manifestId}/${evidenceId}.txt`,
      capturedAt: timestamp,
    } as Evidence);
    // Evidence does not contain ruleId/templateHash; identity is carried by the manifest context.
    delete (evidence.at(-1) as any).ruleId;
    delete (evidence.at(-1) as any).templateHash;
    baseResults.push({
      caseId: definition.caseId,
      criterionId: definition.criterionId,
      expected: definition.expected,
      verdict: filter ? (filterFailed ? "failed" : "not_run") : "passed",
      preconditionStatus: filter && !filterFailed ? "blocked" : "satisfied",
      reasonCode: filter ? (filterFailed ? "ASSERTION_FAILED" : "SETUP_BLOCKED") : "ASSERTION_SATISFIED",
      observed,
      executedSteps: (filter && !filterFailed
        ? definition.plannedSteps.slice(0, 1)
        : definition.plannedSteps
      ).map((step, index) => ({
        stepId: step.stepId,
        phase: step.phase,
        startedAt: new Date(Date.parse(timestamp) + index * 100).toISOString(),
        finishedAt: new Date(
          Date.parse(timestamp) + index * 100 + 50,
        ).toISOString(),
        state: filter && (!filterFailed || index === definition.plannedSteps.length - 1) ? ("failed" as const) : ("completed" as const),
        observation: `ui_fixture performed ${step.stepId}`,
        evidenceIds: [evidenceId],
      })),
      unexecutedStepIds: filter && !filterFailed
        ? definition.plannedSteps.slice(1).map((step) => step.stepId)
        : [],
      blockedBy: filter && !filterFailed
        ? [
            {
              kind: "setup_step",
              id: definition.plannedSteps[0].stepId,
              reasonCode: "SETUP_BLOCKED",
            },
          ]
        : [],
      evidenceIds: [evidenceId],
    });
  }
  const internalId = randomUUID(),
    internalBytes = new TextEncoder().encode("ui_fixture private diagnostic");
  contents.set(internalId, internalBytes);
  evidence.push({
    ...evidence[0],
    evidenceId: internalId,
    scope: "run",
    criterionId: null,
    caseId: null,
    phase: "diagnostic",
    contentOrigin: "platform_diagnostic",
    sha256: await sha256(internalBytes),
    byteSize: internalBytes.byteLength,
    storageKey: `runs/${runId}/${manifestId}/${internalId}.txt`,
  });
  baseManifest = await createArtifactManifest({
    manifestId,
    context,
    source: "base",
    analysisAttemptId: null,
    operationId: null,
    evidence,
    completeness: "complete",
  });
  await db.query(
    `INSERT INTO execution_attempts(id,run_id,attempt_no,owner_phase,pipeline_started_at,work_deadline_at,pipeline_deadline_at,
    base_sealed_at,base_results,base_manifest,actual_fingerprint) VALUES($1,$2,1,'initial_analysis',$3,$4,$5,$3,$6,$7,$8)`,
    [
      executionId,
      runId,
      new Date().toISOString(),
      new Date(Date.now() + 270_000).toISOString(),
      new Date(Date.now() + 300_000).toISOString(),
      JSON.stringify(baseResults),
      JSON.stringify(baseManifest),
      JSON.stringify(unknownMeasuredEnvironment()),
    ],
  );
  await db.query(
    "UPDATE runs SET accepted_execution_attempt_id=$2 WHERE id=$1",
    [runId, executionId],
  );
}
beforeEach(() => setupReportFixture(), 60000);
afterEach(async () => {
  for (const app of openApps.splice(0)) await app.close();
  await db?.close();
});

describe("T11 independent analysis ownership (synthetic persistence)", () => {
  async function authorizationFixture(ttlSeconds=3600){
    await db.query("UPDATE execution_attempts SET owner_phase='closed',cleanup_state='clean',cleanup_receipt='{\"fixture\":true}' WHERE id=$1",[executionId]);
    const snapshot=await withFrozenCourseHistory(db,{taskId,studentId},async(_tx,s)=>s);
    return {taskId,studentId,fingerprint:snapshot.fingerprint,requestId:randomUUID(),ttlSeconds,
      reason:'隔离样本授权测试',policyReference:'fixture-policy',authorizationReference:'fixture-consent',
      externalReferencesReviewed:true,confirm:'AUTHORIZE_EXACT_COURSE_HISTORY'};
  }
  it('deletes authorized course history and atomically persists exact evidence cleanup intent',async()=>{
    const published=await firstPublication();
    const current=await review();
    await createCorrectionV2(db,{publicationId:published.publication.publicationId,actorId:teacherId,idempotencyKey:randomUUID()},
      {expectedRevisionId:current.revision.revisionId,expectedLatestPublicationId:published.publication.publicationId,correctionReason:'隔离删除循环引用夹具'});
    const input=await authorizationFixture();
    const auth=await recordCourseAuthorization(db,input);
    const request={taskId,studentId,authorizationId:auth.authorizationId,requestId:randomUUID(),fingerprint:input.fingerprint,confirm:'DELETE_EXACT_COURSE_HISTORY'};
    const result=await executeCourseDeletion(db,request);
    expect(result.databaseDeleted).toBe(true);
    expect((await db.query('SELECT id FROM submissions WHERE id=$1',[submissionId])).rows).toHaveLength(0);
    for(const table of ['runs','execution_attempts','publications','report_revisions'])
      expect((await db.query(`SELECT * FROM ${table}`)).rows).toHaveLength(0);
    expect((await db.query('SELECT * FROM course_evidence_cleanup_batches')).rows).toHaveLength(1);
    const files=(await db.query('SELECT evidence,state FROM course_evidence_cleanup_files')).rows;
    expect(files).toHaveLength(baseManifest.evidence.length);
    expect(files.every(f=>f.state==='pending')).toBe(true);
    expect(new Set(files.map(f=>f.evidence.storageKey))).toEqual(new Set(baseManifest.evidence.map(e=>e.storageKey)));
    expect(await executeCourseDeletion(db,request)).toEqual({...result,replayed:true});
    await expect(executeCourseDeletion(db,{...request,authorizationId:randomUUID()})).rejects.toThrow('REQUEST_CONFLICT');
    expect((await db.query('SELECT id FROM users WHERE id=$1',[studentId])).rows).toHaveLength(1);
    expect((await db.query('SELECT id FROM tasks WHERE id=$1',[taskId])).rows).toHaveLength(1);
    const directory=await mkdtemp(path.join(tmpdir(),'codelab-course-delete-'));
    try{
      const store=new ArtifactStore({root:directory});
      await store.storeManifest(baseManifest,baseManifest.evidence.map(e=>({evidenceId:e.evidenceId,encoding:'base64' as const,data:Buffer.from(contents.get(e.evidenceId)!).toString('base64')})));
      for(let i=0;i<files.length;i++)expect((await cleanNextCourseEvidence(db,store,result.batchId)).state).toBe('processed');
      expect(await cleanNextCourseEvidence(db,store,result.batchId)).toEqual({state:'complete'});
      expect((await db.query("SELECT * FROM course_evidence_cleanup_files WHERE state<>'removed'")).rows).toHaveLength(0);
    }finally{await rm(directory,{recursive:true,force:true});}
  });
  it('rolls back course deletion and its outbox together on a late database failure',async()=>{
    const input=await authorizationFixture(),auth=await recordCourseAuthorization(db,input);
    const failing:DB={...db,transaction:fn=>db.transaction(tx=>fn({...tx,query:async(sql,params)=>{
      if(sql.startsWith('DELETE FROM submissions'))throw new Error('fixture late deletion failure');
      return tx.query(sql,params);
    }}))};
    await expect(executeCourseDeletion(failing,{taskId,studentId,authorizationId:auth.authorizationId,requestId:randomUUID(),fingerprint:input.fingerprint,confirm:'DELETE_EXACT_COURSE_HISTORY'})).rejects.toThrow('fixture late deletion failure');
    expect((await db.query('SELECT id FROM runs WHERE id=$1',[runId])).rows).toHaveLength(1);
    expect((await db.query('SELECT id FROM execution_attempts WHERE id=$1',[executionId])).rows).toHaveLength(1);
    expect((await db.query('SELECT id FROM course_evidence_cleanup_batches')).rows).toHaveLength(0);
    expect((await db.query('SELECT * FROM course_evidence_cleanup_files')).rows).toHaveLength(0);
    await expect(db.query('DELETE FROM execution_attempts WHERE id=$1',[executionId])).rejects.toThrow();
  });
  it('cleans private agent dependencies, released holds and supplemental evidence while preserving another student',async()=>{
    const supplemental=await supplementalFixture(),analysis=supplemental.analysisAttemptId!,operation=supplemental.operationId!;
    await db.query(`INSERT INTO analysis_private_io(analysis_attempt_id,operation_id,input,response)
      VALUES($1,$2,'{"private":"input-marker"}','private-response-marker')`,[analysis,operation]);
    await db.query(`INSERT INTO analysis_checkpoints(analysis_attempt_id,checkpoint_id,checkpoint_type,checkpoint_data,metadata_type,metadata_data)
      VALUES($1,'one','json','private-checkpoint-marker','json','{}')`,[analysis]);
    await db.query(`INSERT INTO analysis_checkpoint_writes(analysis_attempt_id,checkpoint_id,task_id,write_index,channel,value_type,value_data)
      VALUES($1,'one','fixture',0,'fixture','json','private-write-marker')`,[analysis]);
    const held=await changeRetentionHoldV2(db,{action:'hold',targetId:runId,requestId:randomUUID(),reason:'隔离依赖保留'});
    await changeRetentionHoldV2(db,{action:'release',targetId:held.eventId,requestId:randomUUID(),reason:'解除隔离依赖保留'});
    const otherSubmission=randomUUID(),otherRun=randomUUID();
    await db.query(`INSERT INTO submissions(id,task_id,user_id,rule_id,sha256,files,request_id,contract_version,source_manifest,source_manifest_sha256)
      SELECT $1::uuid,task_id,$2::uuid,rule_id,sha256,files,$1::text,2,source_manifest,source_manifest_sha256 FROM submissions WHERE id=$3`,[otherSubmission,peerId,submissionId]);
    await db.query(`INSERT INTO runs(id,submission_id,rule_id,status,contract_version,execution_config,request_id,idempotency_key,request_hash)
      VALUES($1::uuid,$2,$3,'completed',2,'{}',$1::text,$1::text,'fixture')`,[otherRun,otherSubmission,rule.ruleId]);
    const before=(await db.query('SELECT to_jsonb(r) AS data FROM runs r WHERE id=$1',[otherRun])).rows;
    const input=await authorizationFixture(),auth=await recordCourseAuthorization(db,input);
    const result=await executeCourseDeletion(db,{taskId,studentId,authorizationId:auth.authorizationId,requestId:randomUUID(),fingerprint:input.fingerprint,confirm:'DELETE_EXACT_COURSE_HISTORY'});
    for(const table of ['analysis_private_io','analysis_checkpoint_writes','analysis_checkpoints','analysis_operations','analysis_attempts','retention_hold_releases','retention_holds'])
      expect((await db.query(`SELECT * FROM ${table}`)).rows).toHaveLength(0);
    expect((await db.query('SELECT to_jsonb(r) AS data FROM runs r WHERE id=$1',[otherRun])).rows).toEqual(before);
    expect((await db.query('SELECT id FROM submissions WHERE id=$1',[otherSubmission])).rows).toHaveLength(1);
    const queued=(await db.query('SELECT evidence FROM course_evidence_cleanup_files WHERE batch_id=$1',[result.batchId])).rows;
    expect(queued).toHaveLength(baseManifest.evidence.length+supplemental.evidence.length);
    expect(JSON.stringify(queued)).not.toContain('private-input');
    const directory=await mkdtemp(path.join(tmpdir(),'codelab-course-private-cleanup-'));
    try{
      const store=new ArtifactStore({root:directory});
      for(const manifest of [baseManifest,supplemental])await store.storeManifest(manifest,manifest.evidence.map(e=>({evidenceId:e.evidenceId,encoding:'base64' as const,data:Buffer.from(contents.get(e.evidenceId)!).toString('base64')})));
      for(let i=0;i<queued.length;i++)expect((await cleanNextCourseEvidence(db,store,result.batchId)).state).toBe('processed');
      expect(await cleanNextCourseEvidence(db,store,result.batchId)).toEqual({state:'complete'});
    }finally{await rm(directory,{recursive:true,force:true});}
  });
  it('refuses revoked course deletion without creating a cleanup batch',async()=>{
    const input=await authorizationFixture(),auth=await recordCourseAuthorization(db,input);
    await revokeCourseAuthorization(db,{authorizationId:auth.authorizationId,requestId:randomUUID(),reason:'删除前撤销隔离授权'});
    await expect(executeCourseDeletion(db,{taskId,studentId,authorizationId:auth.authorizationId,requestId:randomUUID(),fingerprint:input.fingerprint,confirm:'DELETE_EXACT_COURSE_HISTORY'})).rejects.toThrow('AUTHORIZATION_REVOKED');
    expect((await db.query('SELECT id FROM course_evidence_cleanup_batches')).rows).toHaveLength(0);
    expect((await db.query('SELECT id FROM runs WHERE id=$1',[runId])).rows).toHaveLength(1);
  });
  it('rejects a supplemental manifest attached to the wrong operation during course deletion',async()=>{
    const supplemental=await supplementalFixture();
    await db.query('UPDATE analysis_operations SET operation_id=$2 WHERE analysis_attempt_id=$1',[supplemental.analysisAttemptId,randomUUID()]);
    const input=await authorizationFixture(),auth=await recordCourseAuthorization(db,input);
    await expect(executeCourseDeletion(db,{taskId,studentId,authorizationId:auth.authorizationId,requestId:randomUUID(),fingerprint:input.fingerprint,confirm:'DELETE_EXACT_COURSE_HISTORY'})).rejects.toThrow('MANIFEST_INVALID');
    expect((await db.query('SELECT id FROM runs WHERE id=$1',[runId])).rows).toHaveLength(1);
    expect((await db.query('SELECT id FROM course_evidence_cleanup_batches')).rows).toHaveLength(0);
  });
  it('refuses course deletion when another students retained JSON refers to its evidence',async()=>{
    const input=await authorizationFixture(),auth=await recordCourseAuthorization(db,input),otherSubmission=randomUUID(),otherRun=randomUUID();
    await db.query(`INSERT INTO submissions(id,task_id,user_id,rule_id,sha256,files,request_id,contract_version,source_manifest,source_manifest_sha256)
      SELECT $1::uuid,task_id,$2::uuid,rule_id,sha256,files,$1::text,2,source_manifest,source_manifest_sha256 FROM submissions WHERE id=$3`,[otherSubmission,peerId,submissionId]);
    await db.query(`INSERT INTO runs(id,submission_id,rule_id,status,contract_version,execution_config,request_id,idempotency_key,request_hash)
      VALUES($1::uuid,$2,$3,'completed',2,'{}',$1::text,$1::text,'fixture')`,[otherRun,otherSubmission,rule.ruleId]);
    await db.query("INSERT INTO events(run_id,kind,payload) VALUES($1,'outside_reference',$2)",[otherRun,JSON.stringify({ref:baseManifest.evidence[0].evidenceId})]);
    await expect(executeCourseDeletion(db,{taskId,studentId,authorizationId:auth.authorizationId,requestId:randomUUID(),fingerprint:input.fingerprint,confirm:'DELETE_EXACT_COURSE_HISTORY'})).rejects.toThrow('OUTSIDE_REFERENCE');
    expect((await db.query('SELECT id FROM course_evidence_cleanup_batches')).rows).toHaveLength(0);
    expect((await db.query('SELECT id FROM runs WHERE id=ANY($1::uuid[])',[[runId,otherRun]])).rows).toHaveLength(2);
  });
  it.skipIf(!process.env.CODELAB_TEST_POSTGRES_URL)('replays competing identical course deletions without a second cleanup batch',async()=>{
    const input=await authorizationFixture(),auth=await recordCourseAuthorization(db,input),peer=db.connectPeer();
    const request={taskId,studentId,authorizationId:auth.authorizationId,requestId:randomUUID(),fingerprint:input.fingerprint,confirm:'DELETE_EXACT_COURSE_HISTORY'};
    try{
      const results=await Promise.all([executeCourseDeletion(db,request),executeCourseDeletion(peer,request)]);
      expect(new Set(results.map(r=>r.batchId)).size).toBe(1);
      expect(results.filter(r=>r.replayed)).toHaveLength(1);
      expect((await db.query('SELECT id FROM course_evidence_cleanup_batches')).rows).toHaveLength(1);
    }finally{await peer.close();}
  });
  it('records exact course authorization, rejects scope edits, revokes durably without changing course history',async()=>{
    const input=await authorizationFixture();
    const saved=await recordCourseAuthorization(db,input);
    expect(saved).toMatchObject({status:'recorded',deletionAuthorized:false,replayed:false});
    expect(await recordCourseAuthorization(db,input)).toMatchObject({authorizationId:saved.authorizationId,replayed:true});
    await expect(recordCourseAuthorization(db,{...input,reason:'不同的授权原因'})).rejects.toThrow('REQUEST_CONFLICT');
    const check=()=>withFrozenCourseHistory(db,{taskId,studentId},async(tx,s)=>assertCourseAuthorization(tx,s,saved.authorizationId));
    await check();
    const revoke={authorizationId:saved.authorizationId,requestId:randomUUID(),reason:'撤销隔离样本授权'};
    const revoked=await revokeCourseAuthorization(db,revoke);
    expect(await revokeCourseAuthorization(db,revoke)).toEqual({...revoked,replayed:true});
    await expect(check()).rejects.toThrow('AUTHORIZATION_REVOKED');
    expect(await recordCourseAuthorization(db,input)).toMatchObject({status:'revoked',replayed:true});
    await expect(revokeCourseAuthorization(db,{...revoke,requestId:randomUUID()})).rejects.toThrow('ALREADY_REVOKED');
    await expect(revokeCourseAuthorization(db,{...revoke,reason:'更改历史撤销理由'})).rejects.toThrow('REQUEST_CONFLICT');
    for(const table of ['course_retention_authorizations','course_retention_revocations']){
      await expect(db.exec(`UPDATE ${table} SET reason='tampered'`)).rejects.toThrow('immutable record');
      await expect(db.exec(`DELETE FROM ${table}`)).rejects.toThrow('immutable record');
      await expect(db.exec(`TRUNCATE ${table} CASCADE`)).rejects.toThrow('immutable record');
    }
    expect((await db.query('SELECT id FROM submissions WHERE id=$1',[submissionId])).rows).toHaveLength(1);
    const next=await recordCourseAuthorization(db,{...input,requestId:randomUUID()});
    await db.query("INSERT INTO events(run_id,kind,payload) VALUES($1,'authorization_change','{}')",[runId]);
    await expect(withFrozenCourseHistory(db,{taskId,studentId},async(tx,s)=>assertCourseAuthorization(tx,s,next.authorizationId))).rejects.toThrow('SCOPE_CHANGED');
    await expect(recordCourseAuthorization(db,{...input,requestId:randomUUID()})).rejects.toThrow('PLAN_STALE');
  });
  it('rejects incomplete course authorization and active holds',async()=>{
    const input=await authorizationFixture();
    for(const change of [{externalReferencesReviewed:false},{ttlSeconds:86401},{policyReference:''},{confirm:'delete'}])
      await expect(recordCourseAuthorization(db,{...input,...change})).rejects.toThrow();
    await changeRetentionHoldV2(db,{action:'hold',targetId:runId,requestId:randomUUID(),reason:'隔离样本需要保留'});
    const fingerprint=await withFrozenCourseHistory(db,{taskId,studentId},async(_tx,s)=>s.fingerprint);
    await expect(recordCourseAuthorization(db,{...input,fingerprint})).rejects.toThrow('ACTIVE_RETENTION_HOLD');
    expect((await db.query('SELECT id FROM course_retention_authorizations')).rows).toHaveLength(0);
  });
  it('refuses course maintenance when an unaccounted table references history, even if empty',async()=>{
    await authorizationFixture();
    await db.exec('CREATE TABLE unknown_retention_dependency(id uuid PRIMARY KEY, run_id uuid REFERENCES runs(id) ON DELETE CASCADE)');
    let called=false;
    await expect(withFrozenCourseHistory(db,{taskId,studentId},async()=>{called=true;})).rejects.toThrow('UNSUPPORTED_REFERENCE_TABLE');
    expect(called).toBe(false);
  });
  it('invalidates course fingerprints when known-table constraints change without data changes',async()=>{
    const input=await authorizationFixture();
    await db.exec('ALTER TABLE events ADD CONSTRAINT extra_fixture_fk FOREIGN KEY(run_id) REFERENCES runs(id)');
    await expect(recordCourseAuthorization(db,input)).rejects.toThrow('PLAN_STALE');
  });
  it('invalidates course fingerprints after a new migration without changing scoped rows',async()=>{
    const input=await authorizationFixture(),existing=await loadMigrations();
    const version=existing.at(-1)!.version+1;
    await migrate(db,[...existing,{version,name:`${String(version).padStart(3,'0')}_fixture_only.sql`,sql:'CREATE TABLE fixture_migration_marker(id integer);'}]);
    await expect(recordCourseAuthorization(db,input)).rejects.toThrow('PLAN_STALE');
  });
  it.skipIf(!process.env.CODELAB_TEST_POSTGRES_URL)('detects outside-schema dependencies on course history',async()=>{
    await authorizationFixture();
    const otherSchema=`retention_fixture_${randomUUID().replaceAll('-','')}`;
    try{
      await db.exec(`CREATE SCHEMA "${otherSchema}"`);
      await db.exec(`CREATE TABLE "${otherSchema}".outside_reference(run_id uuid REFERENCES runs(id))`);
      await expect(withFrozenCourseHistory(db,{taskId,studentId},async()=>true)).rejects.toThrow('UNSUPPORTED_REFERENCE_TABLE');
    }finally{
      await db.exec(`DROP SCHEMA "${otherSchema}" CASCADE`);
    }
  });
  it.skipIf(!process.env.CODELAB_TEST_POSTGRES_URL)('expires course authorization on database time and serializes concurrent records',async()=>{
    const input=await authorizationFixture(1),peer=db.connectPeer();
    try{
      const results=await Promise.all([recordCourseAuthorization(db,input),recordCourseAuthorization(peer,input)]);
      expect(new Set(results.map(r=>r.authorizationId)).size).toBe(1);
      expect(results.filter(r=>r.replayed)).toHaveLength(1);
      await db.query('SELECT pg_sleep(1.1)');
      await expect(withFrozenCourseHistory(db,{taskId,studentId},async(tx,s)=>assertCourseAuthorization(tx,s,results[0].authorizationId))).rejects.toThrow('AUTHORIZATION_EXPIRED');
      expect(await recordCourseAuthorization(db,input)).toMatchObject({status:'expired',replayed:true});
    }finally{await peer.close();}
  });
  it.skipIf(!process.env.CODELAB_TEST_POSTGRES_URL)('keeps course authorization validation and competing revocation in separate serial transactions',async()=>{
    const input=await authorizationFixture(),saved=await recordCourseAuthorization(db,input),peer=db.connectPeer();
    let pending:ReturnType<typeof revokeCourseAuthorization>|undefined;
    try{
      await withFrozenCourseHistory(db,{taskId,studentId},async(tx,s)=>{
        await assertCourseAuthorization(tx,s,saved.authorizationId);
        let settled=false;
        pending=revokeCourseAuthorization(peer,{authorizationId:saved.authorizationId,requestId:randomUUID(),reason:'并发撤销隔离授权'});
        void pending.then(()=>{settled=true;},()=>{settled=true;});
        await tx.query('SELECT pg_sleep(0.15)');
        expect(settled).toBe(false);
        expect((await tx.query('SELECT id FROM course_retention_revocations')).rows).toHaveLength(0);
      });
      await pending;
      await expect(withFrozenCourseHistory(db,{taskId,studentId},async(tx,s)=>assertCourseAuthorization(tx,s,saved.authorizationId))).rejects.toThrow('AUTHORIZATION_REVOKED');
    }finally{await pending?.catch(()=>{});await peer.close();}
  });
  it.skipIf(!process.env.CODELAB_TEST_POSTGRES_URL)('serializes retention holds and competing releases across independent connections', async () => {
    const peer = db.connectPeer();
    const input = { action: 'hold', targetId: runId, requestId: randomUUID(), reason: '独立连接并发保留' };
    try {
      const held = await Promise.all([changeRetentionHoldV2(db, input), changeRetentionHoldV2(peer, input)]);
      expect(new Set(held.map(h => h.eventId)).size).toBe(1);
      expect(held.filter(h => h.replayed)).toHaveLength(1);
      const release = { action: 'release', targetId: held[0].eventId, reason: '并发解除评测保留' };
      const outcomes = await Promise.allSettled([changeRetentionHoldV2(db, { ...release, requestId: randomUUID() }),
        changeRetentionHoldV2(peer, { ...release, requestId: randomUUID() })]);
      expect(outcomes.filter(o => o.status === 'fulfilled')).toHaveLength(1);
      expect(outcomes.find(o => o.status === 'rejected')).toMatchObject({ reason: { message: 'RETENTION_HOLD_ALREADY_RELEASED' } });
      expect((await db.query('SELECT id FROM retention_holds')).rows).toHaveLength(1);
      expect((await db.query('SELECT id FROM retention_hold_releases')).rows).toHaveLength(1);
      await expect(db.exec('TRUNCATE retention_holds,retention_hold_releases')).rejects.toThrow();
      expect((await db.query('SELECT id FROM retention_holds')).rows).toHaveLength(1);
    } finally { await peer.close(); }
  });
  it('fingerprints frozen history contents and rejects same-count edits before the maintenance callback', async () => {
    await db.query("UPDATE execution_attempts SET owner_phase='closed',cleanup_state='clean',cleanup_receipt='{}'::jsonb || '{\"fixture\":true}'::jsonb WHERE id=$1",[executionId]);
    await db.query("INSERT INTO events(run_id,kind,payload) VALUES($1,'retention_fixture','{\"value\":1}')",[runId]);
    const target={taskId,studentId};
    const first=await withFrozenCourseHistory(db,target,async (_tx,snapshot)=>snapshot);
    expect(first.deletionAuthorized).toBe(false);
    expect(first.tables.submissions.rows).toBe(1);
    expect(JSON.stringify(first)).not.toContain('ui_fixture');
    expect((await withFrozenCourseHistory(db,target,async (_tx,s)=>s.fingerprint)).toString()).toBe(first.fingerprint);
    await db.query("UPDATE events SET payload='{\"value\":2}' WHERE run_id=$1 AND kind='retention_fixture'",[runId]);
    let called=false;
    await expect(withFrozenCourseHistory(db,target,async()=>{called=true;},first.fingerprint)).rejects.toThrow('RETENTION_COURSE_PLAN_STALE');
    expect(called).toBe(false);
    await addSubmission();
    expect((await withFrozenCourseHistory(db,target,async (_tx,s)=>s)).tables.submissions.rows).toBe(2);
  });
  it('refuses maintenance on active resource owners and rolls back callback writes without bypassing immutable records', async () => {
    const target={taskId,studentId};
    await expect(withFrozenCourseHistory(db,target,async()=>true)).rejects.toThrow('RETENTION_COURSE_WORKSPACE_BUSY');
    await db.query("UPDATE execution_attempts SET owner_phase='closed',cleanup_state='clean',cleanup_receipt='{\"fixture\":true}' WHERE id=$1",[executionId]);
    await expect(withFrozenCourseHistory(db,target,async tx=>{
      await tx.query("INSERT INTO events(run_id,kind,payload) VALUES($1,'rollback_fixture','{}')",[runId]);
      throw new Error('EXPECTED_FIXTURE_FAILURE');
    })).rejects.toThrow('EXPECTED_FIXTURE_FAILURE');
    expect((await db.query("SELECT id FROM events WHERE kind='rollback_fixture'")).rows).toHaveLength(0);
    await expect(withFrozenCourseHistory(db,target,async tx=>{
      await tx.query('DELETE FROM submissions WHERE id=$1',[submissionId]);
    })).rejects.toThrow('immutable record');
    expect((await db.query('SELECT id FROM submissions WHERE id=$1',[submissionId])).rows).toHaveLength(1);
    await addRun();
    await expect(withFrozenCourseHistory(db,target,async()=>true)).rejects.toThrow('RETENTION_COURSE_WORKSPACE_BUSY');
  });
  it.skipIf(!process.env.CODELAB_TEST_POSTGRES_URL)('blocks independent course writers during frozen maintenance but permits reads and releases locks', async () => {
    await db.query("UPDATE execution_attempts SET owner_phase='closed',cleanup_state='clean',cleanup_receipt='{\"fixture\":true}' WHERE id=$1",[executionId]);
    const peer=db.connectPeer();
    try {
      await withFrozenCourseHistory(db,{taskId,studentId},async()=>{
        expect((await peer.query('SELECT id FROM submissions WHERE id=$1',[submissionId])).rows).toHaveLength(1);
        await expect(peer.transaction(async tx=>{
          await tx.exec("SET LOCAL lock_timeout='100ms'");
          await tx.query("INSERT INTO events(run_id,kind,payload) VALUES($1,'blocked_writer','{}')",[runId]);
        })).rejects.toMatchObject({code:'55P03'});
        await expect(peer.transaction(async tx=>{
          await tx.exec("SET LOCAL lock_timeout='100ms'");
          await addSubmission(tx);
        })).rejects.toMatchObject({code:'55P03'});
      });
      await peer.query("INSERT INTO events(run_id,kind,payload) VALUES($1,'after_release','{}')",[runId]);
      expect((await peer.query("SELECT id FROM events WHERE kind='after_release'")).rows).toHaveLength(1);
    } finally {await peer.close();}
  });
  it.skipIf(!process.env.CODELAB_TEST_POSTGRES_URL)('rechecks a queued run committed while course maintenance waits for writer locks', async () => {
    await db.query("UPDATE execution_attempts SET owner_phase='closed',cleanup_state='clean',cleanup_receipt='{\"fixture\":true}' WHERE id=$1",[executionId]);
    const peer=db.connectPeer();
    let ready!:()=>void,release!:()=>void,enter!:()=>void;
    const started=new Promise<void>(r=>{ready=r;}),gate=new Promise<void>(r=>{release=r;}),locking=new Promise<void>(r=>{enter=r;});
    let writer:Promise<void>|undefined;
    try {
      writer=peer.transaction(async tx=>{await addRun(tx);ready();await gate;});
      await started;
      const observed:DB={...db,transaction:fn=>db.transaction(tx=>fn({...tx,exec:async sql=>{
        if(sql.startsWith('LOCK TABLE'))enter();
        await tx.exec(sql);
      }}))};
      let called=false;
      const maintenance=withFrozenCourseHistory(observed,{taskId,studentId},async()=>{called=true;});
      const rejected=expect(maintenance).rejects.toThrow('RETENTION_COURSE_WORKSPACE_BUSY');
      await locking;release();await writer;await rejected;
      expect(called).toBe(false);
    } finally {release();await writer;await peer.close();}
  });
  it('previews the whole student-task history, preserving publication data and showing holds and queued retries', async () => {
    await firstPublication();
    const before=(await db.query('SELECT snapshot FROM publications WHERE run_id=$1',[runId])).rows;
    const target={taskId,studentId};
    const initial=await planCourseRetention(db,target);
    expect(initial.scope).toBe('all_submissions_and_runs_for_student_task');
    expect(initial.counts).toMatchObject({submissions:1,runs:1,executions:1,publications:1,active_holds:0});
    expect(initial.deletionAuthorized).toBe(false);
    expect(initial.blockers).toContain('COURSE_DELETE_EXECUTOR_NOT_IMPLEMENTED');
    expect(JSON.stringify(initial)).not.toContain('ui_fixture');
    await addSubmission(); // Even an older/newer submission with no Run belongs to the scope.
    await addRun();
    const held=await changeRetentionHoldV2(db,{action:'hold',targetId:runId,requestId:randomUUID(),reason:'课程评测待核查'});
    const active=await planCourseRetention(db,target);
    expect(active.counts).toMatchObject({submissions:2,runs:2,holds:1,active_holds:1});
    expect(active.blockers).toContain('ACTIVE_WORK_OR_CLEANUP');
    expect(active.blockers).toContain('ACTIVE_RETENTION_HOLD');
    await changeRetentionHoldV2(db,{action:'release',targetId:held.eventId,requestId:randomUUID(),reason:'课程评测已核查'});
    const released=await planCourseRetention(db,target);
    expect(released.counts).toMatchObject({holds:1,hold_releases:1,active_holds:0});
    expect(released.blockers).not.toContain('ACTIVE_RETENTION_HOLD');
    expect(released.deletionAuthorized).toBe(false);
    expect((await db.query('SELECT snapshot FROM publications WHERE run_id=$1',[runId])).rows).toEqual(before);
    await expect(planCourseRetention(db,{taskId,studentId:teacherId})).rejects.toThrow('RETENTION_COURSE_TARGET_NOT_FOUND');
    await expect(planCourseRetention(db,{taskId,studentId:peerId})).rejects.toThrow('RETENTION_COURSE_HISTORY_NOT_FOUND');
  });
  it('flags cross-student retry references, mixed legacy history and quarantined material without broadening scope', async () => {
    const peerSubmission=randomUUID(),peerRun=randomUUID();
    await db.query(`INSERT INTO submissions(id,task_id,user_id,rule_id,sha256,files,request_id)
      VALUES($1,$2,$3,$4,$5,'{}',$6)`,[peerSubmission,taskId,peerId,rule.ruleId,fixtureHash,randomUUID()]);
    await db.query(`INSERT INTO runs(id,submission_id,status,execution_config,request_id,retry_of_run_id)
      VALUES($1,$2,'review','{}',$3,$4)`,[peerRun,peerSubmission,randomUUID(),runId]);
    await db.query("INSERT INTO events(run_id,kind,payload) VALUES($1,'v2_invalid_partial_quarantined',$2)",[runId,JSON.stringify({secret:'must-not-leak'})]);
    const current=await planCourseRetention(db,{taskId,studentId});
    expect(current.counts).toMatchObject({submissions:1,runs:1,incoming_retry_references:1,quarantined_events:1});
    expect(current.blockers).toContain('CROSS_SCOPE_OR_MISSING_REFERENCE');
    expect(current.blockers).toContain('QUARANTINED_MATERIAL_REQUIRES_REVIEW');
    expect(JSON.stringify(current)).not.toContain('must-not-leak');
    const legacy=await planCourseRetention(db,{taskId,studentId:peerId});
    expect(legacy.counts).toMatchObject({submissions:1,runs:1,outgoing_retry_references:1});
    expect(legacy.blockers).toContain('LEGACY_HISTORY_REQUIRES_SEPARATE_REVIEW');
    expect(legacy.blockers).toContain('CROSS_SCOPE_OR_MISSING_REFERENCE');
  });
  it('includes private analysis dependencies and blocks unsettled operations and missing pair targets', async () => {
    const analysis=randomUUID(),operation=randomUUID();
    await db.query(`INSERT INTO analysis_attempts(id,run_id,base_manifest_id,mode,owner_execution_attempt_id,status,configuration)
      VALUES($1,$2,$3,'initial',$4,'succeeded',$5)`,[analysis,runId,baseManifest.manifestId,executionId,JSON.stringify({pairedWithAnalysisId:randomUUID()})]);
    await db.query(`INSERT INTO analysis_operations(analysis_attempt_id,operation_id,kind,request_hash,state,reserved_budget)
      VALUES($1,$2,'model',$3,'sent','{}')`,[analysis,operation,fixtureHash]);
    await db.query(`INSERT INTO analysis_private_io(analysis_attempt_id,operation_id,input,response)
      VALUES($1,$2,$3,'private-response-marker')`,[analysis,operation,JSON.stringify({secret:'private-input-marker'})]);
    await db.query(`INSERT INTO analysis_checkpoints(analysis_attempt_id,checkpoint_id,checkpoint_type,checkpoint_data,metadata_type,metadata_data)
      VALUES($1,'one','json','private-checkpoint-marker','json','{}')`,[analysis]);
    await db.query(`INSERT INTO analysis_checkpoint_writes(analysis_attempt_id,checkpoint_id,task_id,write_index,channel,value_type,value_data)
      VALUES($1,'one','fixture',0,'fixture','json','private-write-marker')`,[analysis]);
    const result=await planCourseRetention(db,{taskId,studentId});
    expect(result.counts).toMatchObject({analyses:1,operations:1,private_io:1,checkpoints:1,checkpoint_writes:1,unsettled_operations:1,outside_or_missing_pair_references:1});
    expect(result.blockers).toContain('UNSETTLED_ANALYSIS_OPERATION');
    expect(result.blockers).toContain('CROSS_SCOPE_OR_MISSING_REFERENCE');
    expect(JSON.stringify(result)).not.toContain('private-');
  });
  it('counts ordinary ZIP analysis activity without exposing source or treating unsettled receipts as live work', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'codelab-retention-test-'));
    try {
      const store = new ArtifactStore({ root: directory });
      const baseline = await auditRetentionV2(db, store);
      const projectId = randomUUID(), analysisId = randomUUID();
      await db.query(`INSERT INTO source_projects(id,owner_id,name,sha256,files,omitted)
        VALUES($1,$2,'private-source-name',$3,$4,'[]')`,
        [projectId, studentId, 'a'.repeat(64), JSON.stringify({ 'private-source.ts': 'private-source-marker' })]);
      await db.query("INSERT INTO source_analyses(id,project_id,status) VALUES($1,$2,'queued')", [analysisId, projectId]);
      const queued = await auditRetentionV2(db, store);
      expect(queued.activeRecords).toBe(baseline.activeRecords + 1);
      expect(queued.sourceInventory).toMatchObject({ projects: 1, files: 1, analyses: 1, active_analyses: 1 });
      await db.query("UPDATE source_analyses SET status='running' WHERE id=$1", [analysisId]);
      await db.query("INSERT INTO source_model_calls(id,analysis_id,call_no,state,budget) VALUES($1,$2,1,'started','{}')", [randomUUID(), analysisId]);
      expect((await auditRetentionV2(db, store)).activeRecords).toBe(baseline.activeRecords + 1);
      await db.query("UPDATE source_analyses SET status='failed' WHERE id=$1", [analysisId]);
      const terminal = await auditRetentionV2(db, store);
      expect(terminal.activeRecords).toBe(baseline.activeRecords);
      expect(terminal.sourceInventory).toMatchObject({ model_calls: 1, unsettled_model_calls: 1, active_analyses: 0 });
      expect(JSON.stringify(terminal)).not.toContain('private-source');
      expect(terminal.deletionAuthorized).toBe(false);
      await db.query("UPDATE source_projects SET files='[]' WHERE id=$1", [projectId]);
      const invalid = await auditRetentionV2(db, store);
      expect(invalid.complete).toBe(false);
      expect(invalid.issues).toContainEqual({ code: 'INVALID_SOURCE_FILE_LIST', source: 'source-projects' });
      expect(invalid.sourceInventory.files).toBe(0);
    } finally {
      if (path.dirname(directory) === tmpdir() && path.basename(directory).startsWith('codelab-retention-test-'))
        await rm(directory, { recursive: true, force: true });
    }
  });
  it('audits historical evidence references without deleting unreferenced files or rewriting reports', async () => {
    const publication = await firstPublication();
    const directory = await mkdtemp(path.join(tmpdir(), 'codelab-retention-test-'));
    try {
      const store = new ArtifactStore({ root: directory });
      await store.storeManifest(baseManifest, baseManifest.evidence.map(e => ({
        evidenceId: e.evidenceId, encoding: 'base64' as const, data: Buffer.from(contents.get(e.evidenceId)!).toString('base64'),
      })));
      await writeFile(path.join(directory, 'unregistered.txt'), 'keep this diagnostic');
      const before = await review();
      const result = await auditRetentionV2(db, store);
      expect(result.complete, JSON.stringify(result.issues)).toBe(true);
      expect(result.deletionAuthorized).toBe(false);
      expect(result.counts.referencedFiles).toBe(baseManifest.evidence.length);
      expect(result.counts.unreferencedFiles).toBe(1);
      const holdRequest = { action: 'hold', targetId: runId, requestId: randomUUID(), reason: '保留团队评测材料' };
      const held = await changeRetentionHoldV2(db, holdRequest);
      expect((await changeRetentionHoldV2(db, holdRequest)).replayed).toBe(true);
      await expect(changeRetentionHoldV2(db, { ...holdRequest, reason: '不同保留原因' })).rejects.toThrow('RETENTION_REQUEST_CONFLICT');
      const heldAudit = await auditRetentionV2(db, store);
      expect(heldAudit.counts.activeHolds).toBe(1);
      expect(heldAudit.files.filter(f => f.state === 'referenced_verified').every(f => f.reasons.includes(`retention_hold:${held.eventId}`))).toBe(true);
      const release = { action: 'release', targetId: held.eventId, requestId: randomUUID(), reason: '团队评测登记结束' };
      await changeRetentionHoldV2(db, release);
      expect((await changeRetentionHoldV2(db, release)).replayed).toBe(true);
      await expect(changeRetentionHoldV2(db, { ...release, requestId: randomUUID() })).rejects.toThrow('RETENTION_HOLD_ALREADY_RELEASED');
      const releasedAudit = await auditRetentionV2(db, store);
      expect(releasedAudit.counts).toMatchObject({ activeHolds: 0, releasedHolds: 1 });
      expect(releasedAudit.deletionAuthorized).toBe(false);
      expect(releasedAudit.files.every(f => !f.reasons.includes(`retention_hold:${held.eventId}`))).toBe(true);
      for (const table of ['retention_holds', 'retention_hold_releases']) {
        await expect(db.query(`UPDATE ${table} SET reason='篡改历史记录'`)).rejects.toThrow();
        await expect(db.query(`DELETE FROM ${table}`)).rejects.toThrow();
      }
      await expect(changeRetentionHoldV2(db, { ...holdRequest, requestId: randomUUID(), targetId: randomUUID() })).rejects.toThrow('RETENTION_RUN_NOT_FOUND');
      await expect(changeRetentionHoldV2(db, { ...release, requestId: randomUUID(), targetId: randomUUID() })).rejects.toThrow('RETENTION_HOLD_NOT_FOUND');
      await expect(changeRetentionHoldV2(db, { ...release, requestId: holdRequest.requestId })).rejects.toThrow('RETENTION_REQUEST_CONFLICT');
      expect(result.files.find(f => f.path === 'unregistered.txt')?.state).toBe('unreferenced_retained');
      const publicId = publication.publication.publicEvidenceIds[0];
      const evidence = baseManifest.evidence.find(e => e.evidenceId === publicId)!;
      expect(result.files.find(f => f.path === evidence.storageKey)?.reasons).toContain(`publication:${publication.publication.publicationId}`);
      expect(result.files.find(f => f.path === evidence.storageKey)?.reasons.some(r => r.startsWith('revision:'))).toBe(true);
      expect((await review()).revision).toEqual(before.revision);
      expect(await readFile(path.join(directory, 'unregistered.txt'), 'utf8')).toBe('keep this diagnostic');
      await writeFile(path.join(directory, evidence.storageKey), 'damaged fixture');
      const damaged = await auditRetentionV2(db, store);
      expect(damaged.complete).toBe(false);
      expect(damaged.issues).toContainEqual({ code: 'EVIDENCE_UNREADABLE_OR_CORRUPT', source: evidence.storageKey });
      expect(damaged.deletionAuthorized).toBe(false);
      await rm(path.join(directory, evidence.storageKey));
      const missing = await auditRetentionV2(db, store);
      expect(missing.issues).toContainEqual({ code: 'REFERENCED_FILE_NOT_VERIFIED', source: evidence.storageKey });
      await symlink(path.join(directory, 'runs'), path.join(directory, 'linked-runs'), process.platform === 'win32' ? 'junction' : 'dir');
      const linked = await auditRetentionV2(db, store);
      expect(linked.issues).toContainEqual({ code: 'UNSAFE_EVIDENCE_ENTRY', source: 'linked-runs' });
      expect(linked.files.some(f => f.path.startsWith('linked-runs/'))).toBe(false);
      expect(JSON.stringify(linked)).not.toContain('ui_fixture');
      await db.query("INSERT INTO events(run_id,kind,payload) VALUES($1,'v2_invalid_partial_quarantined','{}')", [runId]);
      expect((await auditRetentionV2(db, store)).issues.some(i => i.code === 'QUARANTINED_MATERIAL_REQUIRES_REVIEW')).toBe(true);
    } finally {
      if (path.dirname(directory) === tmpdir() && path.basename(directory).startsWith('codelab-retention-test-'))
        await rm(directory, { recursive: true, force: true });
    }
  });
  it('exports cancelled pairs over authenticated HTTP without attributing an existing publication', async () => {
    const original = await request();
    const first = await enqueueReanalysisV2(db, { ...original, body: { ...original.body, strategy: 'summary' } });
    expect((await db.query('SELECT configuration FROM analysis_attempts WHERE id=$1', [first.analysis.analysisAttemptId])).rows[0].configuration.promptVersion).toBe('sealed-text-summary-v4-observation-bounds');
    await cancelReanalysisV2(db, { ...identity(), analysisAttemptId: first.analysis.analysisAttemptId });
    const second = await enqueueReanalysisV2(db, { ...original, idempotencyKey: randomUUID(), body: {
      ...original.body, strategy: 'agent', pairedWithAnalysisId: first.analysis.analysisAttemptId,
    } });
    const input = { runId, actorId: teacherId, analysisId: second.analysis.analysisAttemptId };
    await expect(exportAnalysisPairV2(db, input, reader)).rejects.toMatchObject({ code: 'ANALYSIS_PAIR_INCOMPATIBLE' });
    await cancelReanalysisV2(db, { ...identity(), analysisAttemptId: input.analysisId });
    const published = await firstPublication();
    const app = await createApp(db, { origin: 'http://localhost:5173', secure: false, executionApproved: false,
      businessVersion: 2, model: 'synthetic', image: 'fixture', evidenceReader: reader });
    openApps.push(app);
    const sid = randomUUID(), studentSid = randomUUID();
    for (const [token, user] of [[sid, teacherId], [studentSid, studentId]])
      await db.query("INSERT INTO sessions(id,user_id,csrf,expires_at) VALUES($1,$2,'fixture-csrf',now()+interval '1 day')", [digest(token), user]);
    const url = `/api/v2/runs/${runId}/analyses/${input.analysisId}/export`;
    expect((await app.inject({ url })).statusCode).toBe(401);
    expect((await app.inject({ url, headers: { cookie: `sid=${studentSid}` } })).statusCode).toBe(404);
    const result = await app.inject({ url, headers: { cookie: `sid=${sid}` } });
    expect(result.statusCode, result.body).toBe(200);
    expect(result.headers['cache-control']).toBe('private, no-store');
    expect(result.headers['content-type']).toBe('application/zip');
    const files = unzipSync(result.rawPayload);
    const material = JSON.parse(Buffer.from(files['evaluation-materials.json']).toString());
    expect(material.arms.every((a: any) => a.analysisStatus === 'cancelled' && a.modelOperations.length === 0 && a.publication === null)).toBe(true);
    expect(JSON.parse(Buffer.from(files['context/latest-publication.json']).toString()).id).toBe(published.publication.publicationId);
    expect(material.contextOnly.attributionToEitherArm).toBeNull();
    expect(Buffer.from(files['evaluation-materials.json']).toString()).not.toContain('lease_token');
    await db.query(`UPDATE analysis_attempts SET configuration=jsonb_set(configuration,'{baseInputHash}','"changed"') WHERE id=$1`, [input.analysisId]);
    await expect(exportAnalysisPairV2(db, input, reader)).rejects.toMatchObject({ code: 'ANALYSIS_PAIR_INCOMPATIBLE' });
  });
  it.each(['candidate', 'unknown', 'invalid', 'cancelled', 'lost-owner', 'aborted'] as const)(
    'runs one archived summary (%s), keeps base/teacher data and never replays a call', async mode => {
      const original = await request();
      const input = { ...original, body: { ...original.body, strategy: 'summary' } };
      const queued = await enqueueReanalysisV2(db, input);
      await releaseFixtureExecution();
      const claim = (await claimNextV2(db))!;
      const before = (await db.query('SELECT base_results,base_manifest FROM execution_attempts WHERE id=$1', [executionId])).rows[0];
      let calls = 0;
      const controller = new AbortController();
      const provider: SummaryProviderV2 = { configuration: input.configuration, complete: async payload => {
        calls++;
        const material = JSON.parse(payload.user);
        expect(material.baseManifestId).toBe(baseManifest.manifestId);
        expect(material.cases).toEqual(baseResults);
        expect(material.initial).toBeUndefined();
        const current = await review();
        await editReviewV2(db, identity(), { expectedRevisionId: current.revision.revisionId,
          feedbackChanges: [{ ...current.revision.feedback[0], nextStep: '教师修改不被总结覆盖' }] });
        if (mode === 'unknown') throw new ModelRequestError('MODEL_TRANSPORT_UNKNOWN', 'unknown');
        if (mode === 'cancelled') await cancelReanalysisV2(db, { ...input, analysisAttemptId: claim.identity.id });
        if (mode === 'lost-owner') await db.query("UPDATE analysis_attempts SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [claim.identity.id]);
        if (mode === 'aborted') controller.abort();
        expect(payload.maxOutputTokens).toBe(2200);
        expect(material.baseFeedback.every((item: any) => !('reproductionSteps' in item) && !('observationEvidenceRefs' in item))).toBe(true);
        const feedback = material.baseFeedback;
        if (mode === 'invalid') feedback[0].causeSupport = 'limited';
        const content = JSON.stringify({ feedback });
        return { content, raw: content, requestId: 'synthetic-summary', usage: { inputTokens: 100, outputTokens: 100 } };
      } };
      const args = { db, owner: claim.identity, provider, signal: controller.signal };
      if (['cancelled', 'lost-owner'].includes(mode)) await expect(runReanalysisSummaryV2(args)).rejects.toMatchObject({ code: 'OWNER_LOST' });
      else expect((await runReanalysisSummaryV2(args))?.status).toBe(mode === 'candidate' ? 'succeeded' : 'degraded');
      await expect(runReanalysisSummaryV2(args)).rejects.toMatchObject({ code: 'OWNER_LOST' });
      expect(calls).toBe(1);
      const current = await review();
      expect(current.revision.feedback[0].nextStep).toBe('教师修改不被总结覆盖');
      expect(current.candidates).toHaveLength(mode === 'candidate' ? 1 : 0);
      expect((await db.query('SELECT base_results,base_manifest FROM execution_attempts WHERE id=$1', [executionId])).rows[0]).toEqual(before);
      expect((await db.query('SELECT kind FROM analysis_operations WHERE analysis_attempt_id=$1', [queued.analysis.analysisAttemptId])).rows).toEqual([{ kind: 'model_summary' }]);
    });

  it('pairs independent summary and agent on the exact sealed source without incorporating teacher edits', async () => {
    const original = await request();
    const first = await enqueueReanalysisV2(db, { ...original, body: { ...original.body, strategy: 'summary' } });
    await releaseFixtureExecution();
    const claim = (await claimNextV2(db))!;
    let summaryFeedback: unknown;
    await runReanalysisSummaryV2({ db, owner: claim.identity, provider: { configuration: original.configuration,
      complete: async payload => {
        summaryFeedback = JSON.parse(payload.user).baseFeedback;
        const content = JSON.stringify({ feedback: summaryFeedback });
        return { content, raw: content, requestId: null, usage: null };
      } } });
    await db.query(`UPDATE analysis_attempts SET owner_phase='closed',cleanup_state='clean',cleanup_receipt='{"source":"ui_fixture"}' WHERE id=$1`, [claim.identity.id]);
    const current = await review();
    const edited = await editReviewV2(db, identity(), { expectedRevisionId: current.revision.revisionId,
      feedbackChanges: [{ ...current.revision.feedback[0], nextStep: '不发送给对照模型的教师新建议' }] });
    const pairInput = { ...original, idempotencyKey: randomUUID(), body: { expectedRevisionId: edited.revision.revisionId,
      strategy: 'agent', pairedWithAnalysisId: first.analysis.analysisAttemptId } };
    const second = await enqueueReanalysisV2(db, pairInput);
    expect((await db.query('SELECT configuration FROM analysis_attempts WHERE id=$1', [second.analysis.analysisAttemptId])).rows[0].configuration.promptVersion).toBe('restricted-text-agent-v4-explicit-support');
    expect((await enqueueReanalysisV2(db, pairInput)).replayed).toBe(true);
    const next = (await claimNextV2(db))!;
    const result = await runReanalysisAgentV2({ db, owner: next.identity, artifacts: {} as ArtifactStore, runner: {} as RunnerClientV2,
      provider: { configuration: original.configuration, complete: async payload => {
        const material = JSON.parse(payload.user);
        expect(material.initial.baseFeedback.map((item: any) => item.criterionId)).toEqual((summaryFeedback as any[]).map((item: any) => item.criterionId));
        expect(payload.maxOutputTokens).toBe(2200);
        expect(material.initial.baseFeedback.every((item: any) => !('reproductionSteps' in item) && !('observationEvidenceRefs' in item))).toBe(true);
        expect(payload.user).not.toContain('不发送给对照模型的教师新建议');
        const content = JSON.stringify({ type: 'final', feedback: material.initial.baseFeedback });
        return { content, raw: content, requestId: null, usage: null };
      } } });
    expect(result.status, JSON.stringify((await db.query('SELECT usage FROM analysis_attempts WHERE id=$1', [next.identity.id])).rows)).toBe('succeeded');
    const configs = (await db.query('SELECT configuration FROM analysis_attempts WHERE run_id=$1 ORDER BY created_at', [runId])).rows.map(r => r.configuration);
    expect(configs[0].baseInputHash).toMatch(/^[a-f0-9]{64}$/);
    expect(configs[1].baseInputHash).toBe(configs[0].baseInputHash);
    expect(configs[1].pairedWithAnalysisId).toBe(first.analysis.analysisAttemptId);
    expect(second.analysis.strategy).toBe('agent');
    expect((await review()).candidates).toHaveLength(2);
    expect((await review()).revision.revisionId).toBe(edited.revision.revisionId);
    const exported = await exportAnalysisPairV2(db, { runId, actorId: teacherId, analysisId: second.analysis.analysisAttemptId }, reader);
    const files = unzipSync(exported.bytes);
    const json = (name: string) => JSON.parse(Buffer.from(files[name]).toString('utf8'));
    const manifest = json('manifest.json');
    expect(Object.keys(files).length).toBe(manifest.files.length + 1);
    for (const file of manifest.files) {
      expect(files[file.path].length).toBe(file.byteSize);
      expect(await sha256(files[file.path])).toBe(file.sha256);
    }
    const materials = json('evaluation-materials.json');
    expect(materials.ledgerReady).toBe(false);
    expect(materials.arms.map((arm: any) => arm.group)).toEqual(['S', 'A']);
    expect(materials.arms.every((arm: any) => arm.modelOperations.length === 1 && arm.rating === null && arm.publication === null)).toBe(true);
    expect(materials.baseInputHash).toBe(configs[0].baseInputHash);
    expect(json('context/teacher-revision.json').revisionId).toBe(edited.revision.revisionId);
    expect(materials.contextOnly.publicationSnapshot).toBe(null);
    expect(Object.keys(files).filter(name => name.startsWith('evidence/'))).toHaveLength(baseManifest.evidence.length);
    for (const actorId of [studentId, peerId, outsiderId])
      await expect(exportAnalysisPairV2(db, { runId, actorId, analysisId: second.analysis.analysisAttemptId }, reader)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(exportAnalysisPairV2(db, { runId, actorId: teacherId, analysisId: randomUUID() }, reader)).rejects.toMatchObject({ code: 'ANALYSIS_PAIR_REQUIRED' });
    await expect(exportAnalysisPairV2(db, { runId, actorId: teacherId, analysisId: second.analysis.analysisAttemptId }, async () => Buffer.from('corrupt'))).rejects.toMatchObject({ code: 'EVIDENCE_HASH_MISMATCH' });
    await expect(exportAnalysisPairV2(db, { runId, actorId: teacherId, analysisId: second.analysis.analysisAttemptId })).rejects.toMatchObject({ code: 'EVIDENCE_UNAVAILABLE' });
    await db.query('UPDATE analysis_private_io SET response=$2 WHERE analysis_attempt_id=$1', [next.identity.id, 'tampered']);
    await expect(exportAnalysisPairV2(db, { runId, actorId: teacherId, analysisId: second.analysis.analysisAttemptId }, reader)).rejects.toMatchObject({ code: 'ANALYSIS_RESPONSE_HASH_MISMATCH' });
  });

  it.each(['same-strategy', 'other-id', 'changed-model', 'changed-temperature', 'changed-thinking', 'changed-base'] as const)(
    'rejects an incompatible pair (%s) without enqueueing a second analysis', async variation => {
      const original = await request();
      const first = await enqueueReanalysisV2(db, { ...original, body: { ...original.body, strategy: 'summary' } });
      await cancelReanalysisV2(db, { ...original, analysisAttemptId: first.analysis.analysisAttemptId });
      if (variation === 'changed-base') await db.query("UPDATE analysis_attempts SET configuration=jsonb_set(configuration,'{baseInputHash}','\"wrong\"') WHERE id=$1", [first.analysis.analysisAttemptId]);
      await expect(enqueueReanalysisV2(db, { ...original, idempotencyKey: randomUUID(),
        configuration: { ...original.configuration, ...(variation === 'changed-model' ? { model: 'different' } : {}),
          ...(variation === 'changed-temperature' ? { temperature: 0 } : {}), ...(variation === 'changed-thinking' ? { enableThinking: false } : {}) },
        body: { ...original.body, strategy: variation === 'same-strategy' ? 'summary' : 'agent',
          pairedWithAnalysisId: variation === 'other-id' ? randomUUID() : first.analysis.analysisAttemptId },
      })).rejects.toMatchObject({ code: 'ANALYSIS_PAIR_INCOMPATIBLE' });
      expect((await db.query("SELECT id FROM analysis_attempts WHERE mode='reanalysis'")).rows).toHaveLength(1);
    });

  it('enforces summary strategy and one-call budget at the operation gateway', async () => {
    const original = await request();
    await enqueueReanalysisV2(db, { ...original, body: { ...original.body, strategy: 'summary' } });
    await releaseFixtureExecution();
    const claim = (await claimNextV2(db))!;
    await beginReanalysisV2(db, claim.identity);
    const operation = { db, owner: claim.identity, analysisAttemptId: claim.identity.id, operationId: randomUUID() };
    await expect(reserveAnalysisOperationV2({ ...operation, kind: 'read_check_result', request: {}, budget: { toolCalls: 1 } }))
      .rejects.toMatchObject({ code: 'ANALYSIS_STRATEGY_MISMATCH' });
    await reserveAnalysisOperationV2({ ...operation, kind: 'model_summary', request: {}, budget: { modelCalls: 1 } });
    await expect(reserveAnalysisOperationV2({ ...operation, operationId: randomUUID(), kind: 'model_summary', request: {}, budget: { modelCalls: 1 } }))
      .rejects.toMatchObject({ code: 'ANALYSIS_BUDGET_EXCEEDED' });
  });
  it('refuses a queued summary after model configuration changes and treats changed strategy as a new request', async () => {
    const original = await request();
    const input = { ...original, body: { ...original.body, strategy: 'summary' } };
    await enqueueReanalysisV2(db, input);
    await expect(enqueueReanalysisV2(db, { ...input, body: { ...input.body, strategy: 'agent' } }))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await releaseFixtureExecution();
    const claim = (await claimNextV2(db))!;
    let calls = 0;
    await expect(runReanalysisSummaryV2({ db, owner: claim.identity,
      provider: { configuration: { ...original.configuration, model: 'changed-model' },
        complete: async () => { calls++; throw new Error('must not call'); } },
    })).rejects.toThrow('ANALYSIS_CONFIGURATION_CHANGED');
    expect(calls).toBe(0);
  });
    it.each(['temperature', 'enableThinking'] as const)('freezes %s and rejects changed sampling configuration before calls', async field => {
      const original = await request();
      const input = { ...original, configuration: { ...original.configuration, ...(field === 'temperature' ? {temperature: 0} : {enableThinking: false}) } };
      const queued = await enqueueReanalysisV2(db, input);
      expect((await db.query('SELECT configuration FROM analysis_attempts WHERE id=$1', [queued.analysis.analysisAttemptId])).rows[0].configuration[field]).toBe(field === 'temperature' ? 0 : false);
      await releaseFixtureExecution();
      const claimed = (await claimNextV2(db))!;
      let calls = 0;
      await expect(runReanalysisAgentV2({ db, owner: claimed.identity,
        provider: { configuration: { ...input.configuration, ...(field === 'temperature' ? {temperature: 1} : {enableThinking: true}) }, complete: async () => { calls++; throw new Error('must not call'); } },
        artifacts: {} as ArtifactStore, runner: {} as RunnerClientV2,
      })).rejects.toThrow('ANALYSIS_CONFIGURATION_CHANGED');
      expect(calls).toBe(0);
    });
  it('blocks a new analysis on low capacity without preventing replay', async () => {
    const input = await request();
    const storageAdmission = async () => { throw new Error('synthetic low capacity'); };
    await expect(enqueueReanalysisV2(db, { ...input, storageAdmission })).rejects.toMatchObject({ code: 'STORAGE_CAPACITY_UNKNOWN' });
    expect((await db.query("SELECT id FROM analysis_attempts WHERE mode='reanalysis'")).rows).toHaveLength(0);
    const first = await enqueueReanalysisV2(db, input);
    const replay = await enqueueReanalysisV2(db, { ...input, storageAdmission });
    expect(replay.replayed).toBe(true);
    expect(replay.analysis.analysisAttemptId).toBe(first.analysis.analysisAttemptId);
  });
  async function request() {
    const current=await ready();
    return {...identity(),body:{expectedRevisionId:current.revision.revisionId},
      configuration:{provider:"test-only",model:"synthetic",endpoint:"http://127.0.0.1/fixture"}};
  }
  async function releaseFixtureExecution() {
    await db.query(`UPDATE execution_attempts SET owner_phase='closed',cleanup_state='clean',cleanup_receipt='{"source":"ui_fixture"}' WHERE id=$1`,[executionId]);
  }
  async function independent() {
    const input=await request(),queued=await enqueueReanalysisV2(db,input);
    await releaseFixtureExecution();
    const claim=await claimNextV2(db);
    if(!claim || claim.kind!=="reanalysis") throw new Error("FIXTURE_REANALYSIS_CLAIM_FAILED");
    await beginReanalysisV2(db,claim.identity);
    return {input,queued,claim,operation:{db,owner:claim.identity,analysisAttemptId:queued.analysis.analysisAttemptId,operationId:randomUUID()}};
  }
  it("persists LangGraph checkpoints across saver instances and fences identity and late writes",async()=>{
    const emptyCheckpoint=()=>({v:4,id:randomUUID(),ts:new Date().toISOString(),channel_values:{} as Record<string,unknown>,channel_versions:{},versions_seen:{}});
    const {input,queued,claim}=await independent(),id=queued.analysis.analysisAttemptId;
    const saver=new AnalysisCheckpointSaverV2(db,claim.identity,id);
    const config={configurable:{thread_id:id,checkpoint_ns:""}};
    const checkpoint=emptyCheckpoint();checkpoint.channel_values={turn:1,done:false,history:[{result:"private synthetic source"}]};
    const stored=await saver.put(config,checkpoint,{source:"loop",step:1,parents:{}},{});
    await saver.putWrites(stored,[["history",["private write"]]],"synthetic-task");
    const reloaded=new AnalysisCheckpointSaverV2(db,claim.identity,id);
    const tuple=await reloaded.getTuple(config);
    expect(tuple!.checkpoint).toEqual(checkpoint);
    expect(tuple!.pendingWrites).toEqual([["synthetic-task","history",["private write"]]]);
    await expect(reloaded.getTuple({configurable:{thread_id:runId}})).rejects.toThrow("CHECKPOINT_IDENTITY_MISMATCH");
    await expect(reloaded.put({...config,configurable:{thread_id:id,checkpoint_ns:"other"}},checkpoint,{source:"loop",step:1,parents:{}},{})).rejects.toThrow("CHECKPOINT_IDENTITY_MISMATCH");
    await expect(new AnalysisCheckpointSaverV2(db,{...claim.identity,token:randomUUID()},id).put(config,emptyCheckpoint(),{source:"loop",step:2,parents:{}},{})).rejects.toMatchObject({code:"OWNER_LOST"});
    await cancelReanalysisV2(db,{...input,analysisAttemptId:id});
    await expect(saver.put(config,emptyCheckpoint(),{source:"loop",step:2,parents:{}},{})).rejects.toMatchObject({code:"OWNER_LOST"});
    await expect(saver.putWrites(stored,[["history",["late write"]]],"late-task")).rejects.toMatchObject({code:"OWNER_LOST"});
    expect((await reloaded.getTuple(config))!.checkpoint).toEqual(checkpoint);
    expect((await db.query("SELECT analysis_attempt_id FROM analysis_checkpoints")).rows).toEqual([{analysis_attempt_id:id}]);
    await expect(saver.deleteThread(id)).rejects.toThrow("CHECKPOINT_AUDIT_DELETE_FORBIDDEN");
  });
  it("authorizes the owning teacher, refuses unconfigured requests and rejects extra input",async()=>{
    const input=await request();
    for(const actorId of [studentId,peerId,outsiderId])
      await expect(enqueueReanalysisV2(db,{...input,actorId})).rejects.toMatchObject({code:"NOT_FOUND"});
    await expect(enqueueReanalysisV2(db,{...input,configuration:undefined})).rejects.toMatchObject({code:"MODEL_NOT_CONFIGURED"});
    await expect(enqueueReanalysisV2(db,{...input,body:{...input.body,runId:randomUUID()}})).rejects.toThrow();
    expect((await db.query("SELECT id FROM analysis_attempts")).rows).toHaveLength(0);
  });
  it('requires the teachers own key at the HTTP boundary even when platform and student providers exist', async () => {
    const input = await request();
    let calls = 0;
    const userModels = createUserModelService(db, randomBytes(32), env => ({ configuration:{ provider:'fixture', model:env.MODEL_NAME!, endpoint:env.MODEL_BASE_URL! }, complete:async()=>{calls++;throw new Error('NO_PAID_CALLS_EXPECTED');} }));
    await userModels.save(studentId, { vendor:'deepseek', model:'student-model', apiKey:'fixture-student-key' });
    const app = await createApp(db, { origin:'http://localhost:5173', secure:false, executionApproved:false, businessVersion:2, model:'synthetic', image:'fixture', analysisConfiguration:input.configuration, userModels });
    openApps.push(app);
    const sid=randomUUID();
    await db.query("INSERT INTO sessions(id,user_id,csrf,expires_at) VALUES($1,$2,'fixture-csrf',now()+interval '1 day')",[digest(sid),teacherId]);
    const headers={cookie:`sid=${sid}`,origin:'http://localhost:5173','x-csrf-token':'fixture-csrf','idempotency-key':input.idempotencyKey};
    const url=`/api/v2/runs/${runId}/analyses`;
    expect((await app.inject({url:`/api/v2/runs/${runId}/review`,headers})).json()).toMatchObject({analysisAvailable:false,personalModelBilling:true});
    const denied=await app.inject({method:'POST',url,headers,payload:input.body});
    expect(denied.statusCode,denied.body).toBe(409);
    expect(denied.json().error.code).toBe('MODEL_NOT_CONFIGURED');
    await userModels.save(teacherId,{vendor:'deepseek',model:'teacher-model',apiKey:'fixture-teacher-key'});
    const accepted=await app.inject({method:'POST',url,headers,payload:input.body});
    expect(accepted.statusCode,accepted.body).toBe(201);
    const row=(await db.query('SELECT configuration,requested_by FROM analysis_attempts WHERE id=$1',[accepted.json().analysis.analysisAttemptId])).rows[0];
    expect(row).toMatchObject({requested_by:teacherId,configuration:{model:'teacher-model',billingUserId:teacherId}});
    expect(accepted.body).not.toContain('fixture-teacher-key');
    expect(calls).toBe(0);
    await db.query("UPDATE user_model_settings SET encrypted_key=(CASE WHEN left(encrypted_key,1)='A' THEN 'B' ELSE 'A' END)||substring(encrypted_key from 2) WHERE user_id=$1",[teacherId]);
    const damaged=await app.inject({url:`/api/v2/runs/${runId}/review`,headers});
    expect(damaged.statusCode,damaged.body).toBe(200);
    expect(damaged.json()).toMatchObject({analysisAvailable:false,personalModelBilling:true});
    expect(damaged.json().revision.revisionId).toBe(input.body.expectedRevisionId);
  });
  it("protects analysis HTTP writes with session, CSRF, teacher ownership and request identity",async()=>{
    const input=await request();
    const app=await createApp(db,{origin:"http://localhost:5173",secure:false,executionApproved:false,businessVersion:2,
      model:"synthetic",image:"fixture",analysisConfiguration:input.configuration});openApps.push(app);
    const sid=randomUUID(),studentSid=randomUUID();
    for(const [token,user] of [[sid,teacherId],[studentSid,studentId]]) await db.query("INSERT INTO sessions(id,user_id,csrf,expires_at) VALUES($1,$2,'fixture-csrf',now()+interval '1 day')",[digest(token),user]);
    const url=`/api/v2/runs/${runId}/analyses`;
    const headers={cookie:`sid=${sid}`,origin:"http://localhost:5173","x-csrf-token":"fixture-csrf","idempotency-key":input.idempotencyKey};
    expect((await app.inject({method:"POST",url,payload:input.body,headers:{origin:"http://localhost:5173"}})).statusCode).toBe(401);
    expect((await app.inject({method:"POST",url,payload:input.body,headers:{...headers,"x-csrf-token":"wrong"}})).statusCode).toBe(403);
    expect((await app.inject({method:"POST",url,payload:input.body,headers:{...headers,cookie:`sid=${studentSid}`}})).statusCode).toBe(404);
    const first=await app.inject({method:"POST",url,payload:input.body,headers});expect(first.statusCode,first.body).toBe(201);
    expect((await app.inject({method:"POST",url,payload:input.body,headers})).statusCode).toBe(200);
    const reviewResponse=await app.inject({url:`/api/v2/runs/${runId}/review`,headers:{cookie:`sid=${sid}`}});
    expect(reviewResponse.json().analysisAvailable).toBe(true);
    expect(reviewResponse.body).not.toContain(input.configuration.endpoint);
    const cancelUrl=`${url}/${first.json().analysis.analysisAttemptId}/cancel`;
    const canonicalCancelUrl=`/api/v2/analyses/${first.json().analysis.analysisAttemptId}/cancel`;
    expect((await app.inject({method:"POST",url:canonicalCancelUrl,payload:{},headers:{origin:"http://localhost:5173"}})).statusCode).toBe(401);
    expect((await app.inject({method:"POST",url:canonicalCancelUrl,payload:{},headers:{...headers,"x-csrf-token":"wrong"}})).statusCode).toBe(403);
    expect((await app.inject({method:"POST",url:canonicalCancelUrl,payload:{},headers:{...headers,"idempotency-key":"bad"}})).statusCode).toBe(400);
    expect((await app.inject({method:"POST",url:canonicalCancelUrl,payload:{runId:randomUUID()},headers})).statusCode).toBe(400);
    const deniedCancel=await app.inject({method:"POST",url:canonicalCancelUrl,payload:{},headers:{...headers,cookie:`sid=${studentSid}`}});
    const missingCancel=await app.inject({method:"POST",url:`/api/v2/analyses/${randomUUID()}/cancel`,payload:{},headers});
    expect(deniedCancel.statusCode).toBe(404);
    expect(missingCancel.statusCode).toBe(404);
    expect(deniedCancel.json().error.code).toBe(missingCancel.json().error.code);
    expect((await db.query('SELECT status FROM analysis_attempts WHERE id=$1',[first.json().analysis.analysisAttemptId])).rows[0].status).toBe('queued');
    const cancelled=await app.inject({method:"POST",url:canonicalCancelUrl,payload:{},headers});
    expect(cancelled.statusCode,cancelled.body).toBe(200);
    expect(cancelled.json().analysis.status).toBe("cancelled");
    expect((await app.inject({method:"POST",url:canonicalCancelUrl,payload:{},headers})).json()).toEqual(cancelled.json());
    expect((await app.inject({method:"POST",url:cancelUrl,payload:{},headers:{...headers,cookie:`sid=${studentSid}`}})).statusCode).toBe(404);
    expect((await app.inject({method:"POST",url:cancelUrl,payload:{},headers})).json()).toEqual(cancelled.json());
  });
  it("deduplicates simultaneous requests, rejects changed bodies and preserves original queued revision",async()=>{
    const input=await request();
    const results=await Promise.all([enqueueReanalysisV2(db,input),enqueueReanalysisV2(db,input)]);
    expect(results.map(r=>r.replayed).sort()).toEqual([false,true]);
    expect(results[0].analysis.analysisAttemptId).toBe(results[1].analysis.analysisAttemptId);
    await expect(enqueueReanalysisV2(db,{...input,body:{expectedRevisionId:randomUUID()}})).rejects.toMatchObject({code:"IDEMPOTENCY_CONFLICT"});
    const current=await review();
    await editReviewV2(db,identity(),{expectedRevisionId:current.revision.revisionId,feedbackChanges:[{...current.revision.feedback[0],nextStep:"较新的教师编辑"}]});
    expect((await enqueueReanalysisV2(db,{...input,configuration:undefined})).analysis.selectedAtStartRevisionId).toBe(input.body.expectedRevisionId);
    await expect(enqueueReanalysisV2(db,{...input,idempotencyKey:randomUUID()})).rejects.toMatchObject({code:"REVISION_CONFLICT"});
  });
  it("keeps queued analysis out of the resource slot and starts its 60/90 second clock only on claim",async()=>{
    const input=await request(),queued=await enqueueReanalysisV2(db,input);
    expect(await claimNextV2(db)).toBeNull(); // The original execution is still unclosed.
    const waiting=(await db.query("SELECT * FROM analysis_attempts WHERE id=$1",[queued.analysis.analysisAttemptId])).rows[0];
    expect(waiting.lease_token).toBeNull();expect(waiting.work_deadline_at).toBeNull();
    await releaseFixtureExecution();
    const claim=await claimNextV2(db);
    expect(claim?.kind).toBe("reanalysis");
    expect(new Date(claim!.owner.hard_deadline_at).getTime()-new Date(claim!.owner.work_deadline_at).getTime()).toBe(30000);
    expect(new Date(claim!.owner.work_deadline_at).getTime()-new Date(claim!.owner.heartbeat_at).getTime()).toBe(60000);
    expect(await claimNextV2(db)).toBeNull();
  });
  it("cancels a queued request without an owner and allocates a fresh identity only for an explicit new request",async()=>{
    const input=await request(),first=await enqueueReanalysisV2(db,input);
    const cancel={...input,analysisAttemptId:first.analysis.analysisAttemptId};
    await expect(cancelReanalysisV2(db,{...cancel,actorId:studentId})).rejects.toMatchObject({code:"NOT_FOUND"});
    expect((await cancelReanalysisV2(db,cancel)).status).toBe("cancelled");
    expect((await cancelReanalysisV2(db,cancel)).status).toBe("cancelled");
    expect((await enqueueReanalysisV2(db,input)).analysis.status).toBe("cancelled");
    const second=await enqueueReanalysisV2(db,{...input,idempotencyKey:randomUUID()});
    expect(second.analysis.analysisAttemptId).not.toBe(first.analysis.analysisAttemptId);
    expect((await review()).revision.revisionId).toBe(input.body.expectedRevisionId);
  });
  it("reserves independent operations and fences late output on cancellation without releasing resources",async()=>{
    const {input,queued,operation}=await independent();
    await reserveAnalysisOperationV2({...operation,kind:"model_agent",request:{private:"synthetic"},budget:{modelCalls:1,outputTokens:100}});
    await sendAnalysisOperationV2(operation);
    await cancelReanalysisV2(db,{...input,analysisAttemptId:queued.analysis.analysisAttemptId});
    await expect(finishAnalysisOperationV2({...operation,state:"completed",response:"late candidate"})).rejects.toMatchObject({code:"OWNER_LOST"});
    const op=(await db.query("SELECT state,reserved_budget FROM analysis_operations WHERE operation_id=$1",[operation.operationId])).rows[0];
    expect(op).toMatchObject({state:"unknown",reserved_budget:{modelCalls:1,outputTokens:100}});
    expect(await claimNextV2(db)).toBeNull();
    expect((await db.query("SELECT owner_phase FROM analysis_attempts WHERE id=$1",[queued.analysis.analysisAttemptId])).rows[0].owner_phase).toBe("analyzing");
  });
  it.each(["expired","wrong-token","wrong-attempt","deadline"])("rejects independent tool writes for %s",async reason=>{
    const {operation,queued}=await independent();
    if(reason==="expired") await db.query("UPDATE analysis_attempts SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[queued.analysis.analysisAttemptId]);
    if(reason==="wrong-token") operation.owner={...operation.owner,token:randomUUID()};
    if(reason==="wrong-attempt") operation.analysisAttemptId=randomUUID();
    if(reason==="deadline") await db.query("UPDATE analysis_attempts SET deadlines=jsonb_set(deadlines,'{analysisDeadlineAt}',to_jsonb(clock_timestamp()-interval '1 second')) WHERE id=$1",[queued.analysis.analysisAttemptId]);
    await expect(reserveAnalysisOperationV2({...operation,kind:"read_check_result",request:{},budget:{toolCalls:1}})).rejects.toThrow();
    expect((await db.query("SELECT * FROM analysis_operations")).rows).toHaveLength(0);
  });
  it.each(["candidate","cancelled","unknown","deadline"])("runs independent archived analysis (%s) without changing the sealed base or newer teacher text",async mode=>{
    const input=await request(),queued=await enqueueReanalysisV2(db,input);
    await releaseFixtureExecution();
    const claim=(await claimNextV2(db))!;
    const directory=await mkdtemp(path.join(tmpdir(),"codelab-reanalysis-"));
    let calls=0;
    try {
      const artifacts=new ArtifactStore({root:directory});
      const before=(await db.query("SELECT base_results,base_manifest FROM execution_attempts WHERE id=$1",[executionId])).rows[0];
      const provider:SummaryProviderV2={configuration:input.configuration,complete:async request=>{
        calls++;
        if(mode==="unknown") throw new ModelRequestError("MODEL_TRANSPORT_UNKNOWN","unknown");
        const material=JSON.parse(request.user);
        if(mode==="deadline") {
          await db.query("UPDATE analysis_attempts SET deadlines=jsonb_set(deadlines,'{analysisDeadlineAt}',to_jsonb(clock_timestamp()-interval '1 second')) WHERE id=$1",[queued.analysis.analysisAttemptId]);
          const text=JSON.stringify({type:"final",feedback:material.initial.baseFeedback});
          return {content:text,raw:text,requestId:"synthetic-late",usage:{inputTokens:100,outputTokens:100}};
        }
        let action:unknown;
        if(calls===1) action={type:"tool",name:"read_source_excerpt",args:{path:"src/App.vue",startLine:1,lineCount:10}};
        else {
          const current=await review();
          await editReviewV2(db,identity(),{expectedRevisionId:current.revision.revisionId,feedbackChanges:[{...current.revision.feedback[0],nextStep:"分析期间教师新写的内容"}]});
          if(mode==="cancelled") await cancelReanalysisV2(db,{...input,analysisAttemptId:queued.analysis.analysisAttemptId});
          const feedback=material.initial.baseFeedback.map((f:any)=>({...f}));
          feedback[0].possibleCause="合成测试源码供复核";feedback[0].causeSupport="limited";
          feedback[0].causeEvidenceRefs=[material.history[0].result.data.evidenceRef];
          action={type:"final",feedback};
        }
        const text=JSON.stringify(action);
        return {content:text,raw:text,requestId:"synthetic-independent",usage:{inputTokens:100,outputTokens:100}};
      }};
      const args={db,owner:claim.identity,provider,artifacts,runner:{} as RunnerClientV2};
      if(mode==="cancelled") await expect(runReanalysisAgentV2(args)).rejects.toMatchObject({code:"OWNER_LOST"});
      else expect((await runReanalysisAgentV2(args)).status).toBe(mode==="candidate" ? "succeeded":"degraded");
      expect(calls).toBe(["unknown","deadline"].includes(mode) ? 1:2);
      await expect(runReanalysisAgentV2(args)).rejects.toMatchObject({code:"OWNER_LOST"});
      expect(calls).toBe(["unknown","deadline"].includes(mode) ? 1:2);
      const after=await review();
      const saver=new AnalysisCheckpointSaverV2(db,claim.identity,queued.analysis.analysisAttemptId);
      const saved=await saver.getTuple({configurable:{thread_id:queued.analysis.analysisAttemptId}});
      expect(saved).toBeDefined();
      if(mode==="candidate") {
        expect(saved!.checkpoint.channel_values).toMatchObject({turn:2,done:true});
        expect(saved!.checkpoint.channel_values.candidate).toBeTruthy();
      }
      expect(JSON.stringify(after)).not.toContain("checkpoint_data");
      if(!["unknown","deadline"].includes(mode)) expect(after.revision.feedback[0].nextStep).toBe("分析期间教师新写的内容");
      if(mode==="deadline") expect((await db.query("SELECT state FROM analysis_operations WHERE analysis_attempt_id=$1",[queued.analysis.analysisAttemptId])).rows).toEqual([{state:"unknown"}]);
      expect(after.candidates).toHaveLength(mode==="candidate" ? 1:0);
      expect((await db.query("SELECT base_results,base_manifest FROM execution_attempts WHERE id=$1",[executionId])).rows[0]).toEqual(before);
    } finally {await rm(directory,{recursive:true,force:true});}
  });
});

describe("T09 initial analysis isolation (synthetic provider, not model quality)", () => {
  async function setupAnalysis(complete?: SummaryProviderV2["complete"]) {
    const current = await ready();
    const token = randomUUID();
    await db.query(
      "UPDATE execution_attempts SET lease_token=$2,lease_until=clock_timestamp()+interval '30 seconds' WHERE id=$1",
      [executionId, token],
    );
    const provider: SummaryProviderV2 = {
      configuration: {
        provider: "test-only",
        model: "synthetic",
        endpoint: "http://127.0.0.1/fixture",
      },
      complete:
        complete ??
        (async () => ({
          raw: "private synthetic response",
          content: JSON.stringify({
            feedback: current.revision.feedback.map((item) => ({
              ...item,
              needsTeacherReview: true,
              nextStep: "synthetic suggestion",
            })),
          }),
          requestId: "fixture-request",
          usage: { inputTokens: 100, outputTokens: 50 },
        })),
    };
    return {
      db,
      owner: { kind: "execution" as const, id: executionId, token },
      provider,
    };
  }
  it.skipIf(!process.env.CODELAB_TEST_POSTGRES_URL).each([
    ...['summary', 'agent'].flatMap(strategy => ['http-dispatch', 'candidate-commit', 'candidate-committed'].map(stage => ({ strategy, stage }))),
    { strategy: 'agent', stage: 'after-tool-dispatch' },
  ].flatMap(scenario => ['initial', 'reanalysis'].map(mode => ({ ...scenario, mode }))))("recovers an actual killed analysis process ($mode / $strategy / $stage) without replay", async ({ strategy, stage, mode }) => {
    const input = await setupAnalysis();
    const before = await review();
    const baseBefore = (await db.query('SELECT base_results,base_manifest FROM execution_attempts WHERE id=$1', [executionId])).rows;
    const url = new URL(process.env.CODELAB_TEST_POSTGRES_URL!);
    const schema = (await db.query('SELECT current_schema() AS name')).rows[0].name;
    url.searchParams.set('options', `-c search_path=${schema},pg_catalog`);
    let requests = 0;
    let received!: () => void;
    const barrier = new Promise<void>(resolve => { received = resolve; });
    const server = createServer((request, response) => {
      requests++;
      request.resume();
      request.once('end', () => {
        if (stage === 'http-dispatch' || (stage === 'after-tool-dispatch' && requests === 2)) received();
        else if (stage === 'after-tool-dispatch') response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: {
          content: JSON.stringify({ type: 'tool', name: 'read_check_result', args: {} }),
        } }], usage: { prompt_tokens: 100, completion_tokens: 50 } }));
        else response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
          ...(strategy === 'agent' ? { type: 'final' } : {}),
          feedback: before.revision.feedback.map(({ criterionId, observation, possibleCause, nextStep }) => ({
            criterionId, observation, possibleCause, nextStep, causeSupport: 'insufficient', causeEvidenceRefs: [],
          })),
        }) } }], usage: { prompt_tokens: 100, completion_tokens: 50 } }));
      });
      // Keep the response pending until the process is forcibly terminated.
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('FIXTURE_PORT_MISSING');
    const endpoint = `http://127.0.0.1:${address.port}`;
    let owner: OwnerIdentity = input.owner;
    if (mode === 'reanalysis') {
      await db.query(`UPDATE execution_attempts SET owner_phase='closed',cleanup_state='clean',cleanup_receipt='{"source":"ui_fixture"}' WHERE id=$1`, [executionId]);
      await enqueueReanalysisV2(db, { ...identity(), body: { expectedRevisionId: before.revision.revisionId, strategy },
        configuration: { provider: 'openai-compatible', model: 'crash-fixture', endpoint: `${endpoint}/chat/completions` } });
      const claim = await claimNextV2(db);
      if (!claim || claim.kind !== 'reanalysis') throw new Error('FIXTURE_REANALYSIS_CLAIM_FAILED');
      owner = claim.identity;
    }
    await editReviewV2(db, identity(), {
      expectedRevisionId: before.revision.revisionId,
      feedbackChanges: [{ ...before.revision.feedback[0], nextStep: '故障恢复测试：保留教师最新编辑' }],
    });
    const teacherRevision = (await review()).revision;
    expect(teacherRevision.revisionId).not.toBe(before.revision.revisionId);
    const child = fork(path.resolve('tests/helpers/analysis-crash-child.ts'), [], {
      execArgv: ['--import', 'tsx'], windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const exited = once(child, 'exit');
    child.on('message', message => {
      if ((message as { state?: string }).state === stage) received();
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      child.send({ url: url.toString(), owner, endpoint, stage, strategy });
      await Promise.race([barrier, exited.then(() => { throw new Error('CHILD_EXITED_BEFORE_DISPATCH'); }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('DISPATCH_TIMEOUT')), 15000); })]);
      clearTimeout(timer);
      const committed = stage === 'candidate-committed';
      const durableResponse = committed || (strategy === 'agent' && stage === 'candidate-commit');
      const afterTool = stage === 'after-tool-dispatch';
      const expectedStates = afterTool ? ['completed', 'completed', 'sent'] : [durableResponse ? 'completed' : 'sent'];
      expect((await db.query('SELECT state FROM analysis_operations ORDER BY started_at')).rows.map(row => row.state)).toEqual(expectedStates);
      expect(requests).toBe(afterTool ? 2 : 1);
      const checkpoints = (await db.query('SELECT * FROM analysis_checkpoints ORDER BY checkpoint_id')).rows;
      const writes = (await db.query('SELECT * FROM analysis_checkpoint_writes ORDER BY checkpoint_id,task_id,write_index')).rows;
      const budgets = (await db.query('SELECT operation_id,reserved_budget,actual_usage FROM analysis_operations ORDER BY started_at')).rows;
      if (strategy === 'agent') expect(checkpoints.length).toBeGreaterThan(0);
      if (afterTool) expect((await db.query('SELECT kind FROM analysis_operations ORDER BY started_at')).rows.map(row => row.kind))
        .toEqual(['model_agent', 'read_check_result', 'model_agent']);
      const candidateBefore = (await db.query('SELECT candidate FROM analysis_attempts')).rows[0].candidate;
      if (committed) expect(candidateBefore).not.toBeNull();
      expect(child.kill('SIGKILL')).toBe(true);
      await exited;
      const ownerTable = mode === 'initial' ? 'execution_attempts' : 'analysis_attempts';
      await db.query(`UPDATE ${ownerTable} SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1`, [owner.id]);
      await recoverExpiredV2(db);
      await recoverExpiredV2(db);
      expect((await db.query('SELECT status,candidate FROM analysis_attempts')).rows)
        .toEqual([{ status: committed ? 'succeeded' : 'interrupted', candidate: committed ? candidateBefore : null }]);
      expect((await db.query('SELECT state FROM analysis_operations ORDER BY started_at')).rows.map(row => row.state))
        .toEqual(expectedStates.map(state => state === 'sent' ? 'unknown' : state));
      const responses = (await db.query('SELECT response FROM analysis_private_io ORDER BY created_at')).rows;
      // Both the completed model reply and read-tool result have private I/O.
      if (afterTool) expect(responses.filter(row => row.response !== null)).toHaveLength(2);
      else expect(responses[0].response !== null).toBe(durableResponse);
      expect((await db.query('SELECT * FROM analysis_checkpoints ORDER BY checkpoint_id')).rows).toEqual(checkpoints);
      expect((await db.query('SELECT * FROM analysis_checkpoint_writes ORDER BY checkpoint_id,task_id,write_index')).rows).toEqual(writes);
      expect((await db.query('SELECT operation_id,reserved_budget,actual_usage FROM analysis_operations ORDER BY started_at')).rows).toEqual(budgets);
      const summary = mode === 'initial' ? runInitialAnalysisV2 : runReanalysisSummaryV2;
      const agent = mode === 'initial' ? runInitialAgentV2 : runReanalysisAgentV2;
      const restart = strategy === 'summary' ? summary({ ...input, owner }) : agent({ ...input, owner,
        runner: {} as RunnerClientV2, artifacts: { storeManifest: async () => { throw new Error('UNEXPECTED_WRITE'); },
          readEvidence: async () => { throw new Error('UNEXPECTED_READ'); } } });
      await expect(restart).rejects.toMatchObject({ code: 'OWNER_LOST' });
      expect(await claimNextV2(db)).toBeNull();
      expect(requests).toBe(afterTool ? 2 : 1);
      expect((await review()).revision).toEqual(teacherRevision);
      expect((await review()).candidates).toHaveLength(committed ? 1 : 0);
      expect((await db.query('SELECT base_results,base_manifest FROM execution_attempts WHERE id=$1', [executionId])).rows).toEqual(baseBefore);
      expect((await db.query(`SELECT owner_phase,cleanup_state FROM ${ownerTable} WHERE id=$1`, [owner.id])).rows)
        .toEqual([{ owner_phase: 'lost', cleanup_state: 'cleanup_pending' }]);
      const next = await enqueueReanalysisV2(db, { ...identity(),
        body: { expectedRevisionId: teacherRevision.revisionId, strategy }, configuration: input.provider.configuration });
      expect(next.analysis.status).toBe('queued');
      // A nonempty queue is essential: null on an empty queue proves no admission guard.
      expect(await claimNextV2(db)).toBeNull();
      expect((await db.query('SELECT status,lease_token FROM analysis_attempts WHERE id=$1', [next.analysis.analysisAttemptId])).rows)
        .toEqual([{ status: 'queued', lease_token: null }]);
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  }, 25000);
  it("reserves before sending, keeps teacher edits, and explicitly adopts one candidate", async () => {
    const input = await setupAnalysis();
    const original = input.provider.complete;
    input.provider.complete = async (request) => {
      const op = (
        await db.query("SELECT state,reserved_budget FROM analysis_operations")
      ).rows[0];
      expect(op.state).toBe("sent");
      expect(op.reserved_budget.modelCalls).toBe(1);
      const current = await review();
      await editReviewV2(db, identity(), {
        expectedRevisionId: current.revision.revisionId,
        feedbackChanges: [
          { ...current.revision.feedback[0], nextStep: "教师正在编辑" },
        ],
      });
      return original(request);
    };
    expect((await runInitialAnalysisV2(input))?.status).toBe("succeeded");
    const current = await review();
    expect(current.revision.feedback[0].nextStep).toBe("教师正在编辑");
    expect(current.candidates).toHaveLength(1);
    const adopted = await adoptReviewV2(db, identity(), {
      expectedRevisionId: current.revision.revisionId,
      candidateId: current.candidates[0].candidateId,
      criterionIds: ["create"],
    });
    expect(
      adopted.revision.feedback.find((item) => item.criterionId === "create")
        ?.nextStep,
    ).toBe("synthetic suggestion");
    const persisted = (await db.query("SELECT * FROM analysis_private_io"))
      .rows[0];
    expect(persisted.response).toBe("private synthetic response");
    expect(JSON.stringify(current)).not.toContain("private synthetic response");
  });
  it("never retries uncertain requests, retains unknown usage and a publishable base", async () => {
    let calls = 0;
    const input = await setupAnalysis(async () => {
      calls++;
      throw new ModelRequestError("MODEL_TRANSPORT_UNKNOWN", "unknown");
    });
    expect((await runInitialAnalysisV2(input))?.status).toBe("degraded");
    await runInitialAnalysisV2(input);
    expect(calls).toBe(1);
    const op = (
      await db.query("SELECT state,actual_usage FROM analysis_operations")
    ).rows[0];
    expect(op.state).toBe("unknown");
    expect(op.actual_usage.tokens).toBeNull();
    expect((await review()).candidates).toHaveLength(0);
    expect((await firstPublication()).publication.publicationId).toBeTruthy();
  });
  it.each(['bounded', 'overconfident'])('keeps a %s summary separate from teacher work and preserves its response', async mode => {
    const input = await setupAnalysis(), before = await review();
    let calls = 0;
    const feedback = before.revision.feedback.map(({ criterionId, observation }) => ({
      criterionId, observation, causeSupport: 'insufficient', causeEvidenceRefs: [],
      possibleCause: '本次案例未观察到偏差，尚不能判断其他条件下的行为。',
      nextStep: mode === 'overconfident' ? '无需进一步操作，当前观察已满足要求。' : '教师核对本次操作步骤和实际观察；其他条件另行检查。',
    }));
    const content = JSON.stringify({ feedback });
    input.provider.complete = async () => { calls++; return { content, raw: content, requestId: 'synthetic-summary-boundary', usage: { inputTokens: 100, outputTokens: 50 } }; };
    expect((await runInitialAnalysisV2(input))?.status).toBe(mode === 'bounded' ? 'succeeded' : 'degraded');
    await runInitialAnalysisV2(input);
    expect(calls).toBe(1);
    const after = await review();
    expect(after.revision).toEqual(before.revision);
    expect(after.candidates).toHaveLength(mode === 'bounded' ? 1 : 0);
    const operation = (await db.query('SELECT state,actual_usage,error FROM analysis_operations')).rows[0];
    expect(operation.state).toBe(mode === 'bounded' ? 'completed' : 'failed');
    expect(operation.actual_usage.tokens).toEqual({ inputTokens: 100, outputTokens: 50 });
    expect(operation.error).toEqual(mode === 'bounded' ? null : { code: 'MODEL_DRAFT_INVALID' });
    expect((await db.query('SELECT response FROM analysis_private_io')).rows[0].response).toBe(content);
  });
  it("rejects invented evidence/steps and keeps the invalid response private", async () => {
    const input = await setupAnalysis();
    const current = await review();
    const feedback = structuredClone(current.revision.feedback);
    feedback[0].observationEvidenceRefs = [
      {
        scope: "current",
        manifestId: baseManifest.manifestId,
        evidenceId: randomUUID(),
      },
    ];
    input.provider.complete = async () => ({
      raw: "invalid private response",
      content: JSON.stringify({ feedback }),
      requestId: null,
      usage: null,
    });
    expect((await runInitialAnalysisV2(input))?.status).toBe("degraded");
    expect((await review()).candidates).toHaveLength(0);
    expect(
      (await db.query("SELECT error FROM analysis_operations")).rows[0].error
        .code,
    ).toBe("MODEL_DRAFT_INVALID");
  });
  it("rejects a late owner's output without changing a teacher revision", async () => {
    const input = await setupAnalysis();
    const current = await review();
    const original = input.provider.complete;
    input.provider.complete = async (request) => {
      await db.query(
        "UPDATE execution_attempts SET lease_token=$2,lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
        [executionId, randomUUID()],
      );
      return original(request);
    };
    await expect(runInitialAnalysisV2(input)).rejects.toMatchObject({
      code: "OWNER_LOST",
    });
    expect((await review()).revision.revisionId).toBe(
      current.revision.revisionId,
    );
    expect((await review()).candidates).toHaveLength(0);
    expect(
      (await db.query("SELECT candidate FROM analysis_attempts")).rows[0]
        .candidate,
    ).toBeNull();
    await recoverExpiredV2(db);
    expect((await db.query("SELECT status FROM analysis_attempts")).rows[0].status).toBe("interrupted");
    expect((await db.query("SELECT state FROM analysis_operations")).rows[0].state).toBe("unknown");
    expect((await review()).revision.revisionId).toBe(current.revision.revisionId);
  });
  it("allows only one call when two workers attempt initial analysis concurrently", async () => {
    let calls = 0;
    const input = await setupAnalysis();
    const original = input.provider.complete;
    input.provider.complete = async (request) => {
      calls++;
      return original(request);
    };
    await Promise.all([
      runInitialAnalysisV2(input),
      runInitialAnalysisV2(input),
    ]);
    expect(calls).toBe(1);
    expect(
      (await db.query("SELECT id FROM analysis_attempts")).rows,
    ).toHaveLength(1);
  });
  it("serializes seven simultaneous reservations into the six-tool budget and retains uncertain probes",async()=>{
    const input=await setupAnalysis(),original=input.provider.complete;
    input.provider.complete=async request=>{
      const analysisAttemptId=(await db.query("SELECT id FROM analysis_attempts")).rows[0].id;
      const operationId=randomUUID();
      const probe={...input,analysisAttemptId,operationId,kind:"run_probe",request:{probeId:"FILTER_ORDER_CHECK"},budget:{toolCalls:1,probes:1}};
      expect((await reserveAnalysisOperationV2(probe)).created).toBe(true);
      expect(await sendAnalysisOperationV2(probe)).toBe(true);
      expect(await sendAnalysisOperationV2(probe)).toBe(false);
      await finishAnalysisOperationV2({...probe,state:"unknown",errorCode:"TEST_LOST_RESPONSE"});
      expect((await reserveAnalysisOperationV2(probe)).created).toBe(false);
      await expect(reserveAnalysisOperationV2({...probe,request:{probeId:"CHANGED"}})).rejects.toMatchObject({code:"OPERATION_PAYLOAD_CONFLICT"});
      await expect(reserveAnalysisOperationV2({...probe,operationId:randomUUID()})).rejects.toMatchObject({code:"ANALYSIS_BUDGET_EXCEEDED"});
      const requests=Array.from({length:7},()=>reserveAnalysisOperationV2({...input,analysisAttemptId,operationId:randomUUID(),kind:"read_check_result",request:{},budget:{toolCalls:1}}));
      const results=await Promise.allSettled(requests);
      expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(5);
      expect(results.filter(r=>r.status==="rejected")).toHaveLength(2);
      return original(request);
    };
    expect((await runInitialAnalysisV2(input))?.status).toBe("succeeded");
    expect(Number((await db.query("SELECT count(*) AS n FROM analysis_operations WHERE kind<>'model_summary'")).rows[0].n)).toBe(6);
  });
  it.each([null, 2455, 6001, 'input-overrun'] as const)('preserves summary usage %s and rejects only total-budget overflow', async value => {
    const outputTokens = value === 'input-overrun' ? 100 : value;
    const inputTokens = value === 'input-overrun' ? 32001 : 100;
    const exceeded = value === 'input-overrun' || outputTokens === 6001;
    const input = await setupAnalysis(), original = input.provider.complete;
    const before = await review();
    input.provider.complete = async request => {
      expect(request.maxOutputTokens).toBe(2200);
      return { ...await original(request), usage: outputTokens === null ? null : { inputTokens, outputTokens } };
    };
    const result = await runInitialAnalysisV2(input);
    expect(result?.status).toBe(exceeded ? 'degraded' : 'succeeded');
    const operation = (await db.query("SELECT * FROM analysis_operations WHERE kind='model_summary'")).rows[0];
    expect(operation.reserved_budget.outputTokens).toBe(2200);
    expect(operation.actual_usage.tokens).toEqual(outputTokens === null ? null : { inputTokens, outputTokens });
    expect(operation.error).toEqual(exceeded ? { code: 'ANALYSIS_BUDGET_EXCEEDED' } : null);
    expect((await db.query('SELECT response FROM analysis_private_io WHERE operation_id=$1', [operation.operation_id])).rows[0].response).toBe('private synthetic response');
    expect((await review()).revision).toEqual(before.revision);
    if (exceeded) expect((await review()).candidates).toHaveLength(0);
  });
  it("keeps unknown token reservations and refuses cumulative input or output excess",async()=>{
    const input=await setupAnalysis(),original=input.provider.complete;
    input.provider.complete=async request=>{
      const analysisAttemptId=(await db.query("SELECT id FROM analysis_attempts")).rows[0].id;
      // The summary reserves its 2200 request cap; unknown usage retains it.
      await expect(reserveAnalysisOperationV2({...input,analysisAttemptId,operationId:randomUUID(),kind:"model_agent",request:{},budget:{modelCalls:1,outputTokens:3801}})).rejects.toMatchObject({code:"ANALYSIS_BUDGET_EXCEEDED"});
      const initial=(await db.query("SELECT reserved_budget FROM analysis_operations WHERE kind='model_summary'")).rows[0].reserved_budget.inputTokenUpperBound;
      const op={...input,analysisAttemptId,operationId:randomUUID(),kind:"read_check_result",request:{},budget:{toolCalls:1,inputTokenUpperBound:32000-initial-1000}};
      await reserveAnalysisOperationV2(op);
      await sendAnalysisOperationV2(op);
      await finishAnalysisOperationV2({...op,state:"unknown"});
      await expect(reserveAnalysisOperationV2({...op,operationId:randomUUID(),budget:{toolCalls:1,inputTokenUpperBound:5000}})).rejects.toMatchObject({code:"ANALYSIS_BUDGET_EXCEEDED"});
      return original(request);
    };
    expect((await runInitialAnalysisV2(input))?.status).toBe("succeeded");
  });
  it("fences reserved tool dispatch and supplemental writes after lease loss",async()=>{
    const input=await setupAnalysis();
    input.provider.complete=async()=>{
      const analysisAttemptId=(await db.query("SELECT id FROM analysis_attempts")).rows[0].id;
      const op={...input,analysisAttemptId,operationId:randomUUID(),kind:"read_check_result",request:{},budget:{toolCalls:1}};
      await reserveAnalysisOperationV2(op);
      await db.query("UPDATE execution_attempts SET lease_token=$2 WHERE id=$1",[executionId,randomUUID()]);
      await expect(sendAnalysisOperationV2(op)).rejects.toMatchObject({code:"OWNER_LOST"});
      await expect(finishAnalysisOperationV2({...op,state:"completed",response:"late"})).rejects.toMatchObject({code:"OWNER_LOST"});
      expect((await db.query("SELECT state FROM analysis_operations WHERE operation_id=$1",[op.operationId])).rows[0].state).toBe("reserved");
      throw new ModelRequestError("TEST_LOST_OWNER","unknown");
    };
    await expect(runInitialAnalysisV2(input)).rejects.toMatchObject({code:"OWNER_LOST"});
  });
  it("settles known model usage while enforcing four calls and one format repair",async()=>{
    const input=await setupAnalysis(),original=input.provider.complete;
    input.provider.complete=async request=>{
      const analysisAttemptId=(await db.query("SELECT id FROM analysis_attempts")).rows[0].id;
      const initial=(await db.query("SELECT reserved_budget FROM analysis_operations WHERE kind='model_summary'")).rows[0].reserved_budget.inputTokenUpperBound;
      const op={...input,analysisAttemptId,operationId:randomUUID(),kind:"model_agent",request:{testOnly:true},budget:{modelCalls:1,inputTokenUpperBound:32000-initial}};
      await reserveAnalysisOperationV2(op);await sendAnalysisOperationV2(op);
      await finishAnalysisOperationV2({...op,state:"completed",usage:{tokens:{inputTokens:20,outputTokens:0}},response:"synthetic"});
      const repair={...op,operationId:randomUUID(),kind:"model_repair",budget:{modelCalls:1,formatRepairs:1,inputTokenUpperBound:1000}};
      await reserveAnalysisOperationV2(repair);
      await expect(reserveAnalysisOperationV2({...repair,operationId:randomUUID()})).rejects.toMatchObject({code:"ANALYSIS_BUDGET_EXCEEDED"});
      await reserveAnalysisOperationV2({...op,operationId:randomUUID(),budget:{modelCalls:1}});
      await expect(reserveAnalysisOperationV2({...op,operationId:randomUUID(),budget:{modelCalls:1}})).rejects.toMatchObject({code:"ANALYSIS_BUDGET_EXCEEDED"});
      return original(request);
    };
    expect((await runInitialAnalysisV2(input))?.status).toBe("succeeded");
  });
  it("serves five bounded read tools from current sealed data and archives verified source",async()=>{
    const directory=await mkdtemp(path.join(tmpdir(),"codelab-read-tools-"));
    try {
      const artifacts=new ArtifactStore({root:directory});
      await artifacts.storeManifest(baseManifest,baseManifest.evidence.map(e=>({evidenceId:e.evidenceId,encoding:"base64" as const,data:Buffer.from(contents.get(e.evidenceId)!).toString("base64")})));
      const input=await setupAnalysis(),original=input.provider.complete;
      input.provider.complete=async request=>{
        const analysisAttemptId=(await db.query("SELECT id FROM analysis_attempts")).rows[0].id;
        const tool=async(call:unknown)=>runAnalysisReadToolV2({...input,analysisAttemptId,operationId:randomUUID(),call,artifacts});
        const source:any=await tool({name:"read_source_excerpt",args:{path:"src/App.vue",startLine:1,lineCount:100}});
        expect(source.data.text).toBe("<template>ui_fixture</template>");
        expect(source.data.startLine).toBe(1);
        expect(source.data.endLine).toBe(1);
        const manifest=(await review()).supplementalManifests[0];
        expect(manifest.evidence[0]).toMatchObject({scope:"run",phase:"source_excerpt",collector:"business_extractor"});
        expect(JSON.parse(Buffer.from(await artifacts.readEvidence(manifest.evidence[0])).toString()).fileSha256).toBe(source.data.fileSha256);
        const checks:any=await tool({name:"read_check_result",args:{caseId:"FILTER-03"}});
        expect(checks.data.cases).toHaveLength(1);expect(checks.data.cases[0].verdict).toBe("not_run");
        const page:any=await tool({name:"inspect_page_evidence",args:{caseId:"NEW-01"}});
        expect(page.data.pixelsRead).toBe(false);expect(page.data.observations[0].text).toContain("ui_fixture");
        const comparison:any=await tool({name:"compare_submission",args:{}});
        expect(comparison.data.status).toBe("unavailable");
        const log:any=await tool({name:"read_console_evidence",args:{evidenceId:baseManifest.evidence[0].evidenceId}});
        expect(log.data.error).toBe("NOT_CONSOLE_EVIDENCE");
        const pathResult:any=await tool({name:"read_source_excerpt",args:{path:"src/../../.env",startLine:1,lineCount:1}});
        expect(pathResult.data.error).toBe("SOURCE_PATH_NOT_ALLOWED");
        return original(request);
      };
      expect((await runInitialAnalysisV2(input))?.status).toBe("succeeded");
    } finally {await rm(directory,{recursive:true,force:true});}
  });
  it("bounds multilingual and control-character tool output including JSON escaping",()=>{
    for(const text of ["中文😀".repeat(10000),"\u0001\n\"".repeat(10000)]) {
      const result=boundedAnalysisToolResultV2("read_console_evidence",{text});
      expect(result.truncated).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(12288);
    }
  });
  it.each(['total-overrun', 'input-overrun', 'cumulative-input-overrun', 'request-overrun', 'unknown-usage', 'remaining-cap'])("accounts provider usage before continuing (%s)", async mode => {
    const directory = await mkdtemp(path.join(tmpdir(), 'codelab-budget-'));
    try {
      const input = await setupAnalysis(), before = await review();
      let calls = 0, previousRemainingWorkMs = Infinity;
      input.provider.complete = async request => {
        calls++;
        expect(request.maxOutputTokens).toBe(mode === 'remaining-cap' && calls === 3 ? 1600 : 2200);
        const material = JSON.parse(request.user);
        expect(material.remainingWorkMs).toBeGreaterThan(0);
        expect(material.remainingWorkMs).toBeLessThanOrEqual(previousRemainingWorkMs);
        previousRemainingWorkMs = material.remainingWorkMs;
        expect(material.maxOutputTokens).toBe(request.maxOutputTokens);
        expect(material.remainingModelCalls).toBe(5 - calls);
        expect(material.remainingOutputTokens).toBe(calls === 1 ? 6000
          : mode === 'remaining-cap' ? 6000 - (calls - 1) * 2200
          : mode === 'unknown-usage' ? 3800 : 2941);
        const action = calls === 1 || (mode === 'remaining-cap' && calls === 2)
          ? { type: 'tool', name: 'read_check_result', args: {} }
          : { type: 'final', feedback: material.initial.baseFeedback };
        const content = JSON.stringify(action);
        return { content, raw: content, requestId: 'synthetic-budget', usage: mode === 'unknown-usage' ? null
          : { inputTokens: mode === 'input-overrun' ? 32001 : mode === 'cumulative-input-overrun' ? (calls === 1 ? 100 : 31901) : 100, outputTokens: mode === 'remaining-cap' ? (calls === 3 ? 1600 : 2200)
            : calls === 1 ? (mode === 'total-overrun' ? 6001 : 3059) : 100 } };
      };
      const result = await runInitialAgentV2({ ...input, artifacts: new ArtifactStore({ root: directory }), runner: {} as RunnerClientV2 });
      const exceeded = ['total-overrun', 'input-overrun', 'cumulative-input-overrun'].includes(mode);
      expect(result?.status).toBe(exceeded ? 'degraded' : 'succeeded');
      expect(calls).toBe(['total-overrun', 'input-overrun'].includes(mode) ? 1 : mode === 'remaining-cap' ? 3 : 2);
      const operations = (await db.query('SELECT kind,state,actual_usage FROM analysis_operations ORDER BY started_at')).rows;
      expect(operations[0].state).toBe('completed');
      expect(operations[0].actual_usage.tokens).toEqual(mode === 'unknown-usage' ? null
        : { inputTokens: mode === 'input-overrun' ? 32001 : 100, outputTokens: mode === 'total-overrun' ? 6001 : mode === 'remaining-cap' ? 2200 : 3059 });
      if (exceeded) {
        expect(operations).toHaveLength(mode === 'cumulative-input-overrun' ? 3 : 1);
        expect((await review()).candidates).toHaveLength(0);
        expect((await db.query('SELECT usage FROM analysis_attempts')).rows[0].usage.code).toBe('ANALYSIS_BUDGET_EXCEEDED');
      }
      expect((await review()).revision).toEqual(before.revision);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it.each(["source","repair","support-repair","unknown","illegal-tool","invalid-tool-args"])("runs the persisted agent loop (%s) without replacing teacher revisions",async mode=>{
    const directory=await mkdtemp(path.join(tmpdir(),"codelab-agent-v2-"));
    try {
      const artifacts=new ArtifactStore({root:directory}),input=await setupAnalysis(),before=await review();
      let calls=0;
      input.provider.complete=async request=>{
        calls++;
        const material=JSON.parse(request.user);
        expect((await db.query("SELECT state FROM analysis_operations WHERE kind LIKE 'model_%' ORDER BY started_at DESC LIMIT 1")).rows[0].state).toBe("sent");
        if(mode==="unknown") throw new ModelRequestError("MODEL_TRANSPORT_UNKNOWN","unknown");
        let action:unknown;
        if(calls===1 && mode==="repair") return {content:"not-json",raw:"not-json",requestId:"test-invalid",usage:{inputTokens:100,outputTokens:10}};
        if(mode==='support-repair') {
          expect(request.system).toContain('"direct"、"limited"、"insufficient"');
          if(calls===1) {
            const content=JSON.stringify({type:'final',feedback:material.initial.baseFeedback.map((f:any)=>({...f,causeSupport:'source'}))});
            return {content,raw:content,requestId:'synthetic-invalid-support',usage:{inputTokens:100,outputTokens:100}};
          }
          expect(material.history.at(-1).instruction).toContain('不能是source或manual');
        }
        if(calls===1 && mode==="source") action={type:"tool",name:"read_source_excerpt",args:{path:"src/App.vue",startLine:1,lineCount:20}};
        else if(mode==="illegal-tool") action={type:"tool",name:"shell",args:{command:"whoami"}};
        else if(mode==="invalid-tool-args") action={type:"tool",name:"run_probe",args:{probeId:"FILTER_ORDER_CHECK",parameters:{url:"https://not-allowed.invalid"}}};
        else {
          const feedback=material.initial.baseFeedback.map((item:any)=>({...item}));
          if(mode==="source") {
            const ref=material.history[0].result.data.evidenceRef;
            feedback[0].possibleCause="合成测试：源码片段供教师判断";feedback[0].causeSupport="limited";feedback[0].causeEvidenceRefs=[ref];
          }
          action={type:"final",feedback};
        }
        const content=JSON.stringify(action);
        return {content,raw:content,requestId:`test-${calls}`,usage:{inputTokens:100,outputTokens:100}};
      };
      const result=await runInitialAgentV2({...input,artifacts,runner:{} as RunnerClientV2});
      expect(result?.status).toBe(["source","repair","support-repair"].includes(mode) ? "succeeded":"degraded");
      expect((await review()).revision.revisionId).toBe(before.revision.revisionId);
      expect(calls).toBe(["source","repair","support-repair"].includes(mode) ? 2:1);
      if(mode==="source") {
        const current=await review();
        expect(current.analyses[0].operations.map((o:any)=>o.kind)).toEqual(["model_agent","read_source_excerpt","model_agent"]);
        expect(current.analyses[0].operations[1].hasSupplementalEvidence).toBe(true);
        expect(Object.keys(current.analyses[0].operations[1]).sort()).toEqual(["operationId","kind","state","startedAt","finishedAt","hasSupplementalEvidence"].sort());
        expect(JSON.stringify(current.analyses[0])).not.toContain("<template>ui_fixture</template>");
        const adopted=await adoptReviewV2(db,identity(),{expectedRevisionId:before.revision.revisionId,candidateId:current.candidates[0].candidateId,criterionIds:["create"]});
        expect(adopted.revision.selectedSupplementalManifestIds).toHaveLength(1);
        expect(adopted.revision.feedback[0].causeSupport).toBe("limited");
      }
      if(mode==="repair"||mode==='support-repair') expect((await db.query("SELECT kind FROM analysis_operations WHERE kind='model_repair'")).rows).toHaveLength(1);
      if(mode==="unknown") expect((await db.query("SELECT state FROM analysis_operations")).rows[0].state).toBe("unknown");
      if(mode==="invalid-tool-args") {
        const rejected=(await db.query("SELECT state,reserved_budget,error FROM analysis_operations WHERE kind='run_probe'")).rows[0];
        expect(rejected).toMatchObject({state:"failed",reserved_budget:{toolCalls:1,probes:1},error:{code:"TOOL_ARGUMENTS_INVALID"}});
      }
    } finally {await rm(directory,{recursive:true,force:true});}
  });
  it.each(["stored","storage-failure","conflicting"])("archives synthetic probe bytes (%s), resolves a lost reply and keeps teacher/base data immutable",async mode=>{
    if (mode === "conflicting") {
      await db.close();
      await setupReportFixture(true);
    }
    const directory=await mkdtemp(path.join(tmpdir(),"codelab-analysis-probe-"));
    try {
      const artifacts=new ArtifactStore({root:directory});
      if(mode==="storage-failure") artifacts.storeManifest=async()=>{throw new Error("synthetic disk failure");};
      const input=await setupAnalysis(),original=input.provider.complete;
      const before=await review();
      let sends=0,queries=0;
      input.provider.complete=async modelRequest=>{
        const analysisAttemptId=(await db.query("SELECT id FROM analysis_attempts")).rows[0].id;
        const execution=(await db.query("SELECT * FROM execution_attempts WHERE id=$1",[executionId])).rows[0];
        const operationId=randomUUID();
        const request:RunnerProbeRequest={protocolVersion:2,context:baseManifest.context,
          owner:{runId,ownerKind:"execution",ownerId:executionId,ownerToken:input.owner.token},analysisAttemptId,operationId,requestId:randomUUID(),requestHash:fixtureHash,
          probeId:"FILTER_ORDER_CHECK",parameters:{},budgetConfigVersion:"desktop-team-limits-v1",remainingWorkMs:20000,
          workDeadlineAt:new Date(execution.work_deadline_at).toISOString(),hardDeadlineAt:new Date(execution.pipeline_deadline_at).toISOString()};
        request.requestHash=await hashProbeRequest(request);
        const manifestId=randomUUID(),evidenceId=randomUUID(),bytes=Buffer.from(JSON.stringify({testOnly:true,baseResultsModified:false,
          ...(mode === "conflicting" ? {caseId:"FILTER-03",observed:"补查顺序符合要求",verdict:"passed"} : {})}));
        const evidence:Evidence={...baseManifest.evidence.find(e=>e.caseId==="FILTER-03")!,manifestId,evidenceId,analysisAttemptId,operationId,
          phase:"probe",collector:"runner",contentOrigin:"checker_observation",mediaType:"application/json",sha256:await sha256(bytes),byteSize:bytes.length,
          storageKey:`runs/${runId}/${manifestId}/${evidenceId}.json`};
        const manifest=await createArtifactManifest({manifestId,context:baseManifest.context,source:"supplemental",analysisAttemptId,operationId,evidence:[evidence],completeness:"complete"});
        const response:RunnerProbeResponse={protocolVersion:2,context:baseManifest.context,analysisAttemptId,operationId,requestHash:request.requestHash,
          probeId:"FILTER_ORDER_CHECK",supplementalManifest:manifest,artifacts:[{evidenceId,encoding:"base64",data:bytes.toString("base64")}],resourceState:"retained_for_initial_analysis"};
        const runner={probe:async()=>{sends++;throw new Error("synthetic lost response");},
          query:async()=>{queries++;return {record:{state:"completed"},response};}} as unknown as RunnerClientV2;
        const args={...input,analysisAttemptId,operationId,request,rule,runner,artifacts};
        expect((await runAnalysisProbeV2(args)).state).toBe(mode!=="storage-failure" ? "completed":"failed");
        expect((await runAnalysisProbeV2(args)).replayed).toBe(true);
        if(mode!=="storage-failure") {
          expect(Buffer.from(await artifacts.readEvidence(evidence))).toEqual(bytes);
          expect((await review()).supplementalManifests.map(m=>m.manifestId)).toContain(manifestId);
          contents.set(evidenceId, bytes);
        } else {
          expect((await review()).supplementalManifests).toHaveLength(0);
          expect((await db.query("SELECT error FROM analysis_operations WHERE operation_id=$1",[operationId])).rows[0].error.code).toBe("PROBE_ARTIFACT_INVALID");
        }
        expect((await review()).revision.revisionId).toBe(before.revision.revisionId);
        expect((await db.query("SELECT base_manifest FROM execution_attempts WHERE id=$1",[executionId])).rows[0].base_manifest).toEqual(baseManifest);
        return original(modelRequest);
      };
      expect((await runInitialAnalysisV2(input))?.status).toBe("succeeded");
      expect([sends,queries]).toEqual([1,1]);
      if (mode === "conflicting") {
        const current = await review();
        const supplemental = current.supplementalManifests[0];
        expect(baseResults.find(item => item.caseId === "FILTER-03")?.verdict).toBe("failed");
        expect(current.revision.revisionId).toBe(before.revision.revisionId);
        await editReviewV2(db, identity(), { expectedRevisionId: current.revision.revisionId,
          selectedSupplementalManifestIds: [supplemental.manifestId] });
        const confirmed = await confirmAll();
        const published = await publishReportV2(db, identity(), {
          ...publicationBody(confirmed.revision.revisionId),
          publicEvidenceIds: [...publicationBody(confirmed.revision.revisionId).publicEvidenceIds, ...supplemental.evidence.map(e => e.evidenceId)],
        }, reader);
        const student = await getPublicationV2(db, { publicationId: published.publication.publicationId, actorId: studentId });
        expect(student.publication.snapshot.reviewedResults.find(item => item.criterionId === "filter"))
          .toMatchObject({ automaticVerdict: "failed", reviewedVerdict: "failed" });
        const exposed = await readPublicationEvidenceV2(db, { publicationId: published.publication.publicationId,
          evidenceId: supplemental.evidence[0].evidenceId, actorId: studentId }, reader);
        expect(JSON.parse(Buffer.from(exposed.bytes).toString())).toMatchObject({caseId:"FILTER-03",verdict:"passed"});
        const sealed = (await db.query("SELECT base_manifest,base_results FROM execution_attempts WHERE id=$1", [executionId])).rows[0];
        expect(sealed.base_manifest).toEqual(baseManifest);
        expect(sealed.base_results).toEqual(baseResults);
      }
    } finally {await rm(directory,{recursive:true,force:true});}
  });
});

describe("T06 immutable review and confirmation (ui_fixture)", () => {
  it("comparison requires the owning teacher and reports missing history without inventing a change", async () => {
    expect(await getRunComparisonV2(db, identity())).toEqual({
      status: "unavailable",
      reasonCode: "NO_PREVIOUS_SEALED_SUBMISSION",
      caseDiffs: [],
    });
    for (const actorId of [studentId, peerId, outsiderId])
      await expect(
        getRunComparisonV2(db, { runId, actorId }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("creates a deterministic no-model report once, keeps GET read-only and preserves later revisions", async () => {
    await expect(review()).rejects.toMatchObject({ code: "REPORT_NOT_READY" });
    const base = await ensureBaseReportV2(db, runId);
    expect(base.source).toBe("base");
    expect(base.feedback).toHaveLength(3);
    expect(
      base.feedback
        .find((item) => item.criterionId === "filter")!
        .reproductionSteps.every((step) => step.stepId.startsWith("setup:")),
    ).toBe(true);
    expect(base.feedback.every((item) => !item.possibleCause)).toBe(true);
    expect(await ensureBaseReportV2(db, runId)).toEqual(base);
    const edited = await editReviewV2(db, identity(), {
      expectedRevisionId: base.revisionId,
      feedbackChanges: [
        { ...base.feedback[0], nextStep: "ui_fixture teacher next step" },
      ],
    });
    expect((await ensureBaseReportV2(db, runId)).revisionId).toBe(
      edited.revision.revisionId,
    );
    await expect(
      db.query("UPDATE report_revisions SET feedback='[]' WHERE id=$1", [
        base.revisionId,
      ]),
    ).rejects.toThrow("immutable");
  });

  it("records independent case and manual judgments without changing blocked automatic facts", async () => {
    const current = await ready();
    const edited = await editReviewV2(db, identity(), {
      expectedRevisionId: current.revision.revisionId,
      teacherJudgments: [
        manualJudgment("FILTER-03"),
        {
          ...manualJudgment("readability", "manualCriterion"),
          verdict: "passed",
        },
      ],
    });
    expect(
      edited.reviewedResults.find((item) => item.criterionId === "filter"),
    ).toMatchObject({ automaticVerdict: "not_run", reviewedVerdict: "failed" });
    expect(
      edited.reviewedResults.find((item) => item.criterionId === "readability"),
    ).toMatchObject({ automaticVerdict: "manual", reviewedVerdict: "passed" });
    expect(
      edited.revision.teacherJudgments.every(
        (item) => item.judgedBy === teacherId,
      ),
    ).toBe(true);
    expect(
      (
        await db.query(
          "SELECT base_results FROM execution_attempts WHERE id=$1",
          [executionId],
        )
      ).rows[0].base_results,
    ).toEqual(baseResults);
    await expect(
      editReviewV2(db, identity(), {
        expectedRevisionId: edited.revision.revisionId,
        teacherJudgments: [
          { ...manualJudgment("FILTER-03"), judgedBy: outsiderId },
        ],
      }),
    ).rejects.toThrow();
  });

  it("enforces CAS and idempotency even after the head advances", async () => {
    const base = await ready(),
      request = identity();
    const body = {
      expectedRevisionId: base.revision.revisionId,
      feedbackChanges: [
        { ...base.revision.feedback[0], nextStep: "ui_fixture edit A" },
      ],
    };
    const changed = await editReviewV2(db, request, body);
    const later = await editReviewV2(db, identity(), {
      expectedRevisionId: changed.revision.revisionId,
      feedbackChanges: [
        { ...changed.revision.feedback[0], nextStep: "ui_fixture edit B" },
      ],
    });
    expect((await editReviewV2(db, request, body)).revision).toEqual(
      changed.revision,
    );
    await expect(
      editReviewV2(db, request, { ...body, feedbackChanges: [] }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(editReviewV2(db, identity(), body)).rejects.toMatchObject({
      code: "REVISION_CONFLICT",
    });
    expect((await review()).revision.revisionId).toBe(
      later.revision.revisionId,
    );
    await expect(
      confirmReviewV2(db, identity(), {
        expectedRevisionId: later.revision.revisionId,
        items: [{ criterionId: "create", contentHash: fixtureHash }],
      }),
    ).rejects.toMatchObject({ code: "CONTENT_HASH_CONFLICT" });
  });

  it("binds confirmations to content and invalidates only the edited criterion", async () => {
    await ready();
    const confirmed = await confirmAll();
    expect(confirmed.revision.confirmations).toHaveLength(3);
    expect(
      confirmed.reviewedResults.find((item) => item.criterionId === "filter")!
        .reviewedVerdict,
    ).toBe("not_run");
    const changed = await editReviewV2(db, identity(), {
      expectedRevisionId: confirmed.revision.revisionId,
      feedbackChanges: [
        {
          ...confirmed.revision.feedback.find(
            (item) => item.criterionId === "create",
          )!,
          nextStep: "ui_fixture revised instruction",
        },
      ],
    });
    expect(
      changed.revision.confirmations.map((item) => item.criterionId).sort(),
    ).toEqual(["filter", "readability"]);
    await expect(
      publishReportV2(
        db,
        identity(),
        publicationBody(changed.revision.revisionId),
        reader,
      ),
    ).rejects.toThrow("CONFIRMATION_REQUIRED");
  });

  it("leaves late candidates separate and adopts selected feedback while retaining teacher judgments", async () => {
    const base = await ready();
    const edited = await editReviewV2(db, identity(), {
      expectedRevisionId: base.revision.revisionId,
      teacherJudgments: [manualJudgment("FILTER-03")],
    });
    const candidateId = randomUUID(),
      feedback = base.revision.feedback.map((item) => ({
        ...item,
        nextStep: "ui_fixture model suggestion",
      }));
    await db.query(
      `INSERT INTO analysis_attempts(id,run_id,base_manifest_id,mode,owner_execution_attempt_id,status,candidate,selected_at_start_revision_id)
      VALUES($1,$2,$3,'initial',$4,'succeeded',$5,$6)`,
      [
        candidateId,
        runId,
        baseManifest.manifestId,
        executionId,
        JSON.stringify({ feedback }),
        base.revision.revisionId,
      ],
    );
    expect((await review()).revision.revisionId).toBe(
      edited.revision.revisionId,
    );
    expect((await review()).candidates[0].candidateId).toBe(candidateId);
    await expect(
      adoptReviewV2(db, identity(), {
        expectedRevisionId: base.revision.revisionId,
        candidateId,
        criterionIds: ["create"],
      }),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    const adopted = await adoptReviewV2(db, identity(), {
      expectedRevisionId: edited.revision.revisionId,
      candidateId,
      criterionIds: ["create"],
    });
    expect(adopted.revision.teacherJudgments).toEqual(
      edited.revision.teacherJudgments,
    );
    expect(
      adopted.revision.feedback.find((item) => item.criterionId === "create")!
        .nextStep,
    ).toBe("ui_fixture model suggestion");
    expect(
      adopted.revision.feedback.find((item) => item.criterionId === "filter"),
    ).toEqual(
      edited.revision.feedback.find((item) => item.criterionId === "filter"),
    );
  });

  it("rejects wrong actors, cross-case references and invented executed steps", async () => {
    const current = await ready();
    for (const actorId of [studentId, peerId, outsiderId]) {
      await expect(getReviewV2(db, { runId, actorId })).rejects.toMatchObject({
        code: "NOT_FOUND",
        statusCode: 404,
      });
      await expect(
        editReviewV2(
          db,
          { ...identity(), actorId },
          { expectedRevisionId: current.revision.revisionId },
        ),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    const create = current.revision.feedback.find(
        (item) => item.criterionId === "create",
      )!,
      filter = current.revision.feedback.find(
        (item) => item.criterionId === "filter",
      )!;
    await expect(
      editReviewV2(db, identity(), {
        expectedRevisionId: current.revision.revisionId,
        feedbackChanges: [
          {
            ...create,
            observationEvidenceRefs: filter.observationEvidenceRefs,
          },
        ],
      }),
    ).rejects.toThrow("EVIDENCE_SCOPE_MISMATCH");
    await expect(
      editReviewV2(db, identity(), {
        expectedRevisionId: current.revision.revisionId,
        feedbackChanges: [
          {
            ...filter,
            reproductionSteps: [
              {
                caseId: "FILTER-03",
                stepId: "ui-fixture-invented",
                description: "未实际执行的步骤",
              },
            ],
          },
        ],
      }),
    ).rejects.toThrow("REPRODUCTION_STEP_NOT_EXECUTED");
  });
});

describe("T06 publication boundary and history (ui_fixture)", () => {
  it('compares explicit run pairs using student publications and separate teacher judgments', async () => {
    const unpublishedRun = runId;
    await ready();
    const first = await nextComparisonPublication();
    const second = await nextComparisonPublication();
    const input = { beforeRunId: first.runId, afterRunId: second.runId, actorId: studentId };
    const snapshot = await getExplicitRunComparisonV2(db, input);
    expect(snapshot).toMatchObject({ source: 'publications', beforeRunId: first.runId, afterRunId: second.runId,
      before: { publicationId: first.publicationId }, after: { publicationId: second.publicationId }, automatic: { status: 'compatible' } });
    const current = await createCorrectionV2(db, {publicationId:second.publicationId,actorId:teacherId,idempotencyKey:randomUUID()},
      {expectedRevisionId:second.revisionId,expectedLatestPublicationId:second.publicationId,correctionReason:'ui_fixture private comparison edit'});
    await editReviewV2(db, identity(), { expectedRevisionId: current.revision.revisionId,
      feedbackChanges: [{ ...current.revision.feedback[0], nextStep: 'PRIVATE_COMPARISON_DRAFT' }],
      teacherJudgments: [manualJudgment('FILTER-03')] });
    expect(await getExplicitRunComparisonV2(db, input)).toEqual(snapshot);
    const teacher = await getExplicitRunComparisonV2(db, { ...input, actorId: teacherId });
    expect(teacher.source).toBe('sealed_results');
    expect(teacher.automatic.status).toBe('compatible');
    expect(teacher.teacherJudgments).not.toEqual(snapshot.teacherJudgments);
    const confirmed = await confirmAll();
    const correction = await publishReportV2(db, identity(), {
      ...publicationBody(confirmed.revision.revisionId), purpose:'historical_correction',
      expectedLatestPublicationId:second.publicationId, correctionReason:'ui_fixture corrected comparison',
    }, reader);
    const corrected = await getExplicitRunComparisonV2(db, input);
    expect(corrected).toMatchObject({after:{publicationId:correction.publication.publicationId}});
    expect(JSON.stringify(corrected)).toContain('PRIVATE_COMPARISON_DRAFT'); // Now explicitly published.
    expect(JSON.stringify(await getPublicationV2(db,{publicationId:second.publicationId,actorId:studentId}))).not.toContain('PRIVATE_COMPARISON_DRAFT');
    await expect(getExplicitRunComparisonV2(db, { ...input, beforeRunId: unpublishedRun })).rejects.toMatchObject({code:'NOT_FOUND'});
    expect((await getExplicitRunComparisonV2(db, { ...input, beforeRunId: unpublishedRun, actorId: teacherId })).automatic.status).toBe('unknown');
    await expect(getExplicitRunComparisonV2(db, { ...input, actorId: outsiderId })).rejects.toMatchObject({code:'NOT_FOUND'});
    await expect(getExplicitRunComparisonV2(db, { ...input, beforeRunId: second.runId })).rejects.toMatchObject({code:'COMPARISON_SAME_RUN'});
    const changed = await nextComparisonPublication({locale:'en-US'});
    for (const actorId of [studentId, teacherId]) {
      expect((await getExplicitRunComparisonV2(db, { ...input, afterRunId: changed.runId, actorId })).automatic)
        .toMatchObject({status:'incompatible',reasonCode:'MEASUREMENT_DIFFERENT',caseDiffs:[]});
    }
    const alien = await nextComparisonPublication({student:peerId});
    await expect(getExplicitRunComparisonV2(db, { ...input, afterRunId: alien.runId })).rejects.toMatchObject({code:'NOT_FOUND'});
    await expect(getExplicitRunComparisonV2(db, { ...input, afterRunId: alien.runId, actorId:teacherId })).rejects.toMatchObject({code:'COMPARISON_SCOPE_MISMATCH'});
  });

  it('validates explicit comparison HTTP queries and authenticates both runs', async () => {
    const first = await nextComparisonPublication(), second = await nextComparisonPublication();
    const app = await createApp(db,{origin:'http://localhost:5173',secure:false,executionApproved:false,businessVersion:2,model:'synthetic',image:'fixture'});
    openApps.push(app);
    const sid = randomUUID();
    await db.query("INSERT INTO sessions(id,user_id,csrf,expires_at) VALUES($1,$2,'fixture-csrf',now()+interval '1 day')",[digest(sid),studentId]);
    const headers = {cookie:`sid=${sid}`}, url=`/api/v2/compare?before=${first.runId}&after=${second.runId}`;
    expect((await app.inject({url})).statusCode).toBe(401);
    for (const query of ['before=bad&after=bad',`before=${first.runId}`,`before=${first.runId}&after=${second.runId}&actorId=${teacherId}`])
      expect((await app.inject({url:'/api/v2/compare?'+query,headers})).statusCode).toBe(400);
    const result = await app.inject({url,headers});
    expect(result.statusCode,result.body).toBe(200);
    expect(result.json()).toMatchObject({source:'publications',automatic:{status:'compatible'}});
    expect(result.body).not.toContain('actualFingerprint');
    expect((await app.inject({url:`/api/v2/compare?before=${randomUUID()}&after=${second.runId}`,headers})).statusCode).toBe(404);
  });

  it('keeps different rule versions readable but never labels their automatic results as progress', async()=>{
    const first=await nextComparisonPublication();
    const oldRule=rule.ruleId;
    const second=await nextComparisonPublication({nextRule:true});
    expect(rule.ruleId).not.toBe(oldRule);
    const options=await getPublicationComparisonOptionsV2(db,{publicationId:second.publicationId,actorId:studentId});
    expect(options.items.map(item=>item.publicationId)).toContain(first.publicationId);
    for(const actorId of [studentId,teacherId]){
      const compared=await getPublicationComparisonV2(db,{publicationId:second.publicationId,beforePublicationId:first.publicationId,actorId});
      expect(compared.sameSubmission).toBe(false);
      expect(compared.automatic).toEqual({status:'incompatible',reasonCode:'COMPARISON_SCOPE_MISMATCH',caseDiffs:[]});
      expect(compared.before.publicationId).toBe(first.publicationId);
      expect(compared.after.publicationId).toBe(second.publicationId);
    }
    expect((await getPublicationV2(db,{publicationId:first.publicationId,actorId:studentId})).publication.snapshot.ruleSnapshot.ruleId).toBe(oldRule);
  });
  it('pages more than fifty published versions without duplicates when new feedback arrives', async()=>{
    const publications: string[]=[];
    for(let i=0;i<53;i++)publications.push((await nextComparisonPublication()).publicationId);
    const target=publications.at(-1)!;
    const first=await getPublicationComparisonOptionsV2(db,{publicationId:target,actorId:studentId});
    expect(first.items).toHaveLength(50);
    expect(first.nextCursor).toBe(first.items.at(-1)!.publicationId);
    const inserted=(await nextComparisonPublication()).publicationId;
    const second=await getPublicationComparisonOptionsV2(db,{publicationId:target,actorId:studentId,after:first.nextCursor!});
    expect(second.items).toHaveLength(2);
    expect(second.nextCursor).toBe(null);
    const all=[...first.items,...second.items].map(item=>item.publicationId);
    expect(new Set(all).size).toBe(52);
    expect(new Set(all)).toEqual(new Set(publications.slice(0,-1)));
    expect(all).not.toContain(inserted);
    const refreshed=await getPublicationComparisonOptionsV2(db,{publicationId:target,actorId:studentId});
    expect(refreshed.items[0].publicationId).toBe(inserted);
    const alien=(await nextComparisonPublication({student:peerId})).publicationId;
    await expect(getPublicationComparisonOptionsV2(db,{publicationId:target,actorId:studentId,after:alien})).rejects.toMatchObject({code:'NOT_FOUND'});
  },60000);
  it('compares distinct published submissions with complete measurements and rejects cross-scope pairs', async()=>{
    const first=await nextComparisonPublication();
    const second=await nextComparisonPublication();
    const input={publicationId:second.publicationId,beforePublicationId:first.publicationId,actorId:studentId};
    const compared=await getPublicationComparisonV2(db,input);
    expect(compared.sameSubmission).toBe(false);
    expect(compared.automatic.status).toBe('compatible');
    expect(compared.automatic.caseDiffs).toEqual(expect.arrayContaining([
      expect.objectContaining({caseId:'NEW-01',change:'unchanged'}),
      expect.objectContaining({caseId:'FILTER-03',change:'unknown'}),
    ]));
    const differentEnvironment=await nextComparisonPublication({locale:'en-US'});
    expect((await getPublicationComparisonV2(db,{...input,publicationId:differentEnvironment.publicationId})).automatic)
      .toEqual({status:'incompatible',reasonCode:'MEASUREMENT_DIFFERENT',caseDiffs:[]});
    const anotherStudent=await nextComparisonPublication({student:peerId});
    await expect(getPublicationComparisonV2(db,{...input,actorId:teacherId,publicationId:anotherStudent.publicationId})).rejects.toMatchObject({code:'COMPARISON_SCOPE_MISMATCH'});
    await expect(getPublicationComparisonOptionsV2(db,{actorId:teacherId,publicationId:anotherStudent.publicationId,after:first.publicationId})).rejects.toMatchObject({code:'INVALID_CURSOR'});
    const otherTask=await nextComparisonPublication({differentTask:true});
    await expect(getPublicationComparisonV2(db,{actorId:teacherId,publicationId:otherTask.publicationId,beforePublicationId:anotherStudent.publicationId})).rejects.toMatchObject({code:'COMPARISON_SCOPE_MISMATCH'});
    expect((await getPublicationComparisonOptionsV2(db,{actorId:teacherId,publicationId:otherTask.publicationId})).items).toEqual([]);
  });
  it("requires confirmations and a valid public whitelist; students only read a published immutable snapshot", async () => {
    const base = await ready();
    await expect(
      publishReportV2(
        db,
        identity(),
        publicationBody(base.revision.revisionId),
        reader,
      ),
    ).rejects.toThrow("CONFIRMATION_REQUIRED");
    const confirmed = await confirmAll(),
      body = publicationBody(confirmed.revision.revisionId);
    await expect(
      publishReportV2(
        db,
        identity(),
        { ...body, publicEvidenceIds: [] },
        reader,
      ),
    ).rejects.toThrow("REFERENCED_EVIDENCE_NOT_PUBLIC");
    await expect(
      publishReportV2(
        db,
        identity(),
        {
          ...body,
          publicEvidenceIds: [...body.publicEvidenceIds, randomUUID()],
        },
        reader,
      ),
    ).rejects.toThrow("PUBLIC_EVIDENCE_NOT_SELECTED");
    const diagnostic = baseManifest.evidence.find(
      (item) => item.phase === "diagnostic",
    )!;
    await expect(
      publishReportV2(
        db,
        identity(),
        {
          ...body,
          publicEvidenceIds: [...body.publicEvidenceIds, diagnostic.evidenceId],
        },
        reader,
      ),
    ).rejects.toThrow("INTERNAL_EVIDENCE_NOT_PUBLIC");
    const published = await publishReportV2(db, identity(), body, reader),
      publicationId = published.publication.publicationId;
    const student = await getPublicationV2(db, {
      publicationId,
      actorId: studentId,
    });
    expect(student.publication).toEqual(published.publication);
    expect(
      student.publication.snapshot.reviewedResults.find(
        (item) => item.criterionId === "filter",
      )!.reviewedVerdict,
    ).toBe("not_run");
    expect(JSON.stringify(student)).not.toContain("private diagnostic");
    const exposed = await readPublicationEvidenceV2(
      db,
      {
        publicationId,
        evidenceId: body.publicEvidenceIds[0],
        actorId: studentId,
      },
      reader,
    );
    expect(exposed.bytes).toEqual(contents.get(body.publicEvidenceIds[0]));
    await expect(
      readPublicationEvidenceV2(
        db,
        {
          publicationId,
          evidenceId: diagnostic.evidenceId,
          actorId: studentId,
        },
        reader,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      readReviewEvidenceV2(
        db,
        { runId, evidenceId: diagnostic.evidenceId, actorId: studentId },
        reader,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(
      (
        await readReviewEvidenceV2(
          db,
          { runId, evidenceId: diagnostic.evidenceId, actorId: teacherId },
          reader,
        )
      ).bytes,
    ).toEqual(contents.get(diagnostic.evidenceId));
    for (const actorId of [peerId, outsiderId])
      await expect(
        getPublicationV2(db, { publicationId, actorId }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      db.query(
        "UPDATE publications SET correction_reason='changed' WHERE id=$1",
        [publicationId],
      ),
    ).rejects.toThrow("immutable");
  });

  it.each(['content', 'digest'])("rejects a damaged publication %s before serving report or evidence", async (damage) => {
    await ready();
    const confirmed = await confirmAll();
    const body = publicationBody(confirmed.revision.revisionId);
    const published = await publishReportV2(db, identity(), body, reader);
    const publicationId = published.publication.publicationId;
    // Simulate corrupt restore/read data without disabling immutable database guards.
    const damaged: DB = {
      ...db,
      query: async (sql, params) => {
        const result = await db.query(sql, params);
        return { rows: result.rows.map(row => {
          if (row.id !== publicationId || !row.snapshot) return row;
          const copy = structuredClone(row);
          if (damage === 'digest') copy.snapshot.contentHash = '0'.repeat(64);
          else copy.snapshot.revision.feedback[0].nextStep += ' changed after publication';
          return copy;
        }) };
      },
    };
    await expect(getPublicationV2(damaged, { publicationId, actorId: studentId }))
      .rejects.toMatchObject({ code: 'PUBLICATION_HASH_MISMATCH' });
    let fileReads = 0;
    await expect(readPublicationEvidenceV2(damaged, {
      publicationId, evidenceId: body.publicEvidenceIds[0], actorId: studentId,
    }, async evidence => { fileReads++; return reader(evidence); }))
      .rejects.toMatchObject({ code: 'PUBLICATION_HASH_MISMATCH' });
    expect(fileReads).toBe(0);
    await expect(getPublicationV2(damaged, { publicationId, actorId: outsiderId }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await getPublicationV2(db, { publicationId, actorId: studentId })).publication)
      .toEqual(published.publication);
  });

  it("publishes only selected supplemental evidence and keeps later source material private", async () => {
    await ready();
    const confirmed = await confirmAll();
    const selected = await supplementalFixture(),
      unselected = await supplementalFixture(),
      diagnostic = await supplementalFixture("diagnostic");
    const feedback = {
      ...confirmed.revision.feedback.find(
        (item) => item.criterionId === "create",
      )!,
      possibleCause: "ui_fixture source-supported statement",
      causeSupport: "direct" as const,
      causeEvidenceRefs: [
        {
          scope: "current" as const,
          manifestId: selected.manifestId,
          evidenceId: selected.evidence[0].evidenceId,
        },
      ],
    };
    await expect(
      editReviewV2(db, identity(), {
        expectedRevisionId: confirmed.revision.revisionId,
        feedbackChanges: [feedback],
      }),
    ).rejects.toThrow("EVIDENCE_SCOPE_MISMATCH");
    const edited = await editReviewV2(db, identity(), {
      expectedRevisionId: confirmed.revision.revisionId,
      feedbackChanges: [feedback],
      selectedSupplementalManifestIds: [
        selected.manifestId,
        diagnostic.manifestId,
      ],
    });
    expect(
      edited.revision.confirmations.map((item) => item.criterionId).sort(),
    ).toEqual(["filter", "readability"]);
    const reconfirmed = await confirmAll(),
      body = {
        ...publicationBody(reconfirmed.revision.revisionId),
        publicEvidenceIds: [
          ...publicationBody(reconfirmed.revision.revisionId).publicEvidenceIds,
          selected.evidence[0].evidenceId,
        ],
      };
    await expect(
      publishReportV2(
        db,
        identity(),
        {
          ...body,
          publicEvidenceIds: [
            ...body.publicEvidenceIds,
            unselected.evidence[0].evidenceId,
          ],
        },
        reader,
      ),
    ).rejects.toThrow("PUBLIC_EVIDENCE_NOT_SELECTED");
    await expect(
      publishReportV2(
        db,
        identity(),
        {
          ...body,
          publicEvidenceIds: [
            ...body.publicEvidenceIds,
            diagnostic.evidence[0].evidenceId,
          ],
        },
        reader,
      ),
    ).rejects.toThrow("INTERNAL_EVIDENCE_NOT_PUBLIC");
    const published = await publishReportV2(db, identity(), body, reader);
    const publicationId = published.publication.publicationId;
    expect(
      (
        await readPublicationEvidenceV2(
          db,
          {
            publicationId,
            actorId: studentId,
            evidenceId: selected.evidence[0].evidenceId,
          },
          reader,
        )
      ).bytes,
    ).toEqual(contents.get(selected.evidence[0].evidenceId));
    const later = await supplementalFixture();
    for (const manifest of [unselected, diagnostic, later]) {
      await expect(
        readPublicationEvidenceV2(
          db,
          {
            publicationId,
            actorId: studentId,
            evidenceId: manifest.evidence[0].evidenceId,
          },
          reader,
        ),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
  });

  it("blocks missing, unreadable or hash-mismatched artifacts without creating a publication", async () => {
    await ready();
    const current = await confirmAll(),
      body = publicationBody(current.revision.revisionId);
    await expect(publishReportV2(db, identity(), body)).rejects.toMatchObject({
      code: "EVIDENCE_STORAGE_UNAVAILABLE",
      statusCode: 503,
    });
    await expect(
      publishReportV2(db, identity(), body, async () => {
        throw new Error("removed");
      }),
    ).rejects.toMatchObject({ code: "EVIDENCE_UNREADABLE", statusCode: 503 });
    await expect(
      publishReportV2(db, identity(), body, async () => new Uint8Array([0])),
    ).rejects.toMatchObject({
      code: "EVIDENCE_INTEGRITY_FAILED",
      statusCode: 503,
    });
    expect((await db.query("SELECT id FROM publications")).rows).toHaveLength(
      0,
    );
  });

  it("refuses a stale submission and prevents historical-purpose forgery before a first publication", async () => {
    await ready();
    const current = await confirmAll();
    await addSubmission();
    await expect(
      publishReportV2(
        db,
        identity(),
        publicationBody(current.revision.revisionId),
        reader,
      ),
    ).rejects.toMatchObject({ code: "STALE_SUBMISSION" });
    await expect(
      publishReportV2(
        db,
        identity(),
        {
          ...publicationBody(current.revision.revisionId),
          purpose: "historical_correction",
          expectedLatestPublicationId: randomUUID(),
          correctionReason: "伪造更正来源",
        },
        reader,
      ),
    ).rejects.toMatchObject({ code: "CORRECTION_ORIGIN_CONFLICT" });
  });

  it("refuses a stale run of the newest submission", async () => {
    await ready();
    const current = await confirmAll();
    await addRun();
    await expect(
      publishReportV2(
        db,
        identity(),
        publicationBody(current.revision.revisionId),
        reader,
      ),
    ).rejects.toMatchObject({ code: "STALE_RUN" });
  });

  it("requires explicit current-publication corrections, reconfirmation and an immutable readable chain", async () => {
    await ready();
    const confirmed = await confirmAll(),
      originalIdentity = identity(),
      originalBody = publicationBody(confirmed.revision.revisionId);
    const first = await publishReportV2(
        db,
        originalIdentity,
        originalBody,
        reader,
      ),
      firstId = first.publication.publicationId;
    await expect(
      publishReportV2(db, identity(), originalBody, reader),
    ).rejects.toMatchObject({ code: "CORRECTION_REQUIRED" });
    await expect(
      editReviewV2(db, identity(), {
        expectedRevisionId: confirmed.revision.revisionId,
      }),
    ).rejects.toMatchObject({ code: "CORRECTION_REQUIRED" });
    await expect(
      createCorrectionV2(
        db,
        {
          publicationId: firstId,
          actorId: teacherId,
          idempotencyKey: randomUUID(),
        },
        {
          expectedRevisionId: confirmed.revision.revisionId,
          expectedLatestPublicationId: randomUUID(),
          correctionReason: "ui_fixture correction",
        },
      ),
    ).rejects.toMatchObject({ code: "CORRECTION_ORIGIN_CONFLICT" });
    const correctionIdentity = {
      publicationId: firstId,
      actorId: teacherId,
      idempotencyKey: randomUUID(),
    };
    const correctionBody = {
      expectedRevisionId: confirmed.revision.revisionId,
      expectedLatestPublicationId: firstId,
      correctionReason: "ui_fixture correction",
    };
    const correction = await createCorrectionV2(
      db,
      correctionIdentity,
      correctionBody,
    );
    expect(correction.revision.originPublicationId).toBe(firstId);
    expect(correction.revision.confirmations).toEqual([]);
    expect(
      (await createCorrectionV2(db, correctionIdentity, correctionBody))
        .revision,
    ).toEqual(correction.revision);
    await expect(
      publishReportV2(
        db,
        identity(),
        {
          ...publicationBody(correction.revision.revisionId),
          purpose: "historical_correction",
          expectedLatestPublicationId: firstId,
          correctionReason: "ui_fixture correction",
        },
        reader,
      ),
    ).rejects.toThrow("CONFIRMATION_REQUIRED");
    await addSubmission(); // A correction must stay readable even after a newer ordinary submission exists.
    const edited = await editReviewV2(db, identity(), {
      expectedRevisionId: correction.revision.revisionId,
      teacherJudgments: [manualJudgment("FILTER-03")],
    });
    expect(edited.revision.originPublicationId).toBe(firstId);
    const reconfirmed = await confirmAll();
    const second = await publishReportV2(
      db,
      identity(),
      {
        ...publicationBody(reconfirmed.revision.revisionId),
        purpose: "historical_correction",
        expectedLatestPublicationId: firstId,
        correctionReason: "ui_fixture documented independent verification",
      },
      reader,
    );
    expect(second.publication).toMatchObject({
      publicationNo: 2,
      supersedesPublicationId: firstId,
      purpose: "historical_correction",
    });
    const compareInput = {publicationId: second.publication.publicationId, beforePublicationId: firstId, actorId: studentId};
    const diff = await getPublicationComparisonV2(db, compareInput);
    const options = await getPublicationComparisonOptionsV2(db,{publicationId:compareInput.publicationId,actorId:studentId});
    expect(options.items.map(item=>item.publicationId)).toEqual([firstId]);
    expect(options.nextCursor).toBe(null);
    expect((await getPublicationComparisonOptionsV2(db,{publicationId:compareInput.publicationId,actorId:studentId,after:firstId})).items).toEqual([]);
    for(const actorId of [peerId,outsiderId])
      await expect(getPublicationComparisonOptionsV2(db,{publicationId:compareInput.publicationId,actorId})).rejects.toMatchObject({code:'NOT_FOUND'});
    expect(diff.before.publicationId).toBe(firstId);
    expect(diff.after.publicationId).toBe(second.publication.publicationId);
    expect(diff.sameSubmission).toBe(true);
    expect(diff.automatic).toEqual({status:'unknown',reasonCode:'MEASUREMENT_UNKNOWN',caseDiffs:[]});
    expect(diff.teacherJudgments).toContainEqual({targetType:'case',targetId:'FILTER-03',before:null,after:'failed',changed:true});
    expect(JSON.stringify(diff)).not.toContain('actual_fingerprint');
    for (const actorId of [peerId, outsiderId])
      await expect(getPublicationComparisonV2(db,{...compareInput,actorId})).rejects.toMatchObject({code:'NOT_FOUND'});
    await expect(getPublicationComparisonV2(db,{...compareInput,beforePublicationId:randomUUID()})).rejects.toMatchObject({code:'NOT_FOUND'});
    await expect(getPublicationComparisonV2(db,{...compareInput,beforePublicationId:second.publication.publicationId})).rejects.toMatchObject({code:'COMPARISON_SAME_PUBLICATION'});
    const comparisonApp = await createApp(db,{origin:'http://localhost:5173',secure:false,executionApproved:false,businessVersion:2,model:'ui_fixture',image:'ui_fixture',packs:[],evidenceReader:reader});
    openApps.push(comparisonApp);
    const comparisonUrl=`/api/v2/publications/${compareInput.publicationId}/comparison?before=${firstId}`;
    expect((await comparisonApp.inject(comparisonUrl)).statusCode).toBe(401);
    const comparisonSession=randomUUID();
    await db.query("INSERT INTO sessions(id,user_id,csrf,expires_at) VALUES($1,$2,'comparison_test',now()+interval '1 day')",[digest(comparisonSession),studentId]);
    const comparisonHeaders={cookie:`sid=${comparisonSession}`};
    const viaHttp=await comparisonApp.inject({url:comparisonUrl,headers:comparisonHeaders});
    expect(viaHttp.statusCode).toBe(200);
    expect(viaHttp.json()).toEqual(diff);
    expect((await comparisonApp.inject({url:`/api/v2/publications/${compareInput.publicationId}/comparison?before=invalid`,headers:comparisonHeaders})).statusCode).toBe(400);
    expect(
      await getPublicationV2(db, {
        publicationId: firstId,
        actorId: studentId,
      }),
    ).toMatchObject({
      publication: first.publication,
      supersededByPublicationId: second.publication.publicationId,
    });
    expect(
      (await publishReportV2(db, originalIdentity, originalBody, reader))
        .publication,
    ).toEqual(first.publication);
    await expect(
      publishReportV2(
        db,
        originalIdentity,
        { ...originalBody, publicEvidenceIds: [] },
        reader,
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(
      createCorrectionV2(
        db,
        { ...correctionIdentity, idempotencyKey: randomUUID() },
        {
          ...correctionBody,
          expectedRevisionId: reconfirmed.revision.revisionId,
        },
      ),
    ).rejects.toMatchObject({ code: "CORRECTION_ORIGIN_CONFLICT" });
    expect(
      (
        await db.query(
          "SELECT base_results FROM execution_attempts WHERE id=$1",
          [executionId],
        )
      ).rows[0].base_results,
    ).toEqual(baseResults);
  });

  it("serializes concurrent CAS edits so exactly one succeeds", async () => {
    const base = await ready();
    const results = await Promise.allSettled(
      ["A", "B"].map((value) =>
        editReviewV2(db, identity(), {
          expectedRevisionId: base.revision.revisionId,
          feedbackChanges: [
            {
              ...base.revision.feedback[0],
              nextStep: `ui_fixture concurrent ${value}`,
            },
          ],
        }),
      ),
    );
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const rejection = results.find(
      (result) => result.status === "rejected",
    ) as PromiseRejectedResult;
    expect(rejection.reason.code).toBe("REVISION_CONFLICT");
    expect((await review()).revision.revisionNo).toBe(2);
  });

  it("preserves global unauthenticated and CSRF failures under the report-route error handler", async () => {
    const app = await createApp(db, {
      origin: "http://localhost:5173",
      secure: false,
      executionApproved: false,
      businessVersion: 2,
      model: "ui_fixture",
      image: "ui_fixture",
      packs: [],
      evidenceReader: reader,
    });
    openApps.push(app);
    const anonymous = await app.inject(`/api/v2/runs/${runId}/review`);
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json().error.requestId).toBeTypeOf("string");
    const sid = randomUUID();
    await db.query(
      "INSERT INTO sessions(id,user_id,csrf,expires_at) VALUES($1,$2,'ui_fixture_csrf',now()+interval '1 day')",
      [digest(sid), teacherId],
    );
    const csrf = await app.inject({
      method: "POST",
      url: `/api/v2/runs/${runId}/review/confirm`,
      headers: { cookie: `sid=${sid}`, origin: "http://localhost:5173" },
      payload: {},
    });
    expect(csrf.statusCode).toBe(403);
    expect(csrf.json().error.code).toBe("FORBIDDEN");
    await ready();
    const response = await app.inject({
      method: "GET",
      url: `/api/v2/runs/${runId}/review`,
      headers: { cookie: `sid=${sid}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().revision.source).toBe("base");
    const mutationKey = randomUUID(),
      current = response.json();
    const request = {
      method: "POST" as const,
      url: `/api/v2/runs/${runId}/review/confirm`,
      headers: {
        cookie: `sid=${sid}`,
        origin: "http://localhost:5173",
        "x-csrf-token": "ui_fixture_csrf",
        "idempotency-key": mutationKey,
      },
      payload: {
        expectedRevisionId: current.revision.revisionId,
        items: [
          {
            criterionId: "create",
            contentHash: current.criterionContentHashes.create,
          },
        ],
      },
    };
    const confirmed = await app.inject(request),
      replayed = await app.inject(request);
    expect(confirmed.statusCode, confirmed.body).toBe(201);
    expect(replayed.statusCode).toBe(200);
    expect(replayed.json().revision.revisionId).toBe(
      confirmed.json().revision.revisionId,
    );
  });
});

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function waitForAdvisoryWait(pid: number) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const waiting = (
      await db.query(
        "SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND NOT granted",
        [pid],
      )
    ).rows;
    if (waiting.length) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    "Expected publication/upload to wait for the student/task advisory lock",
  );
}
describe.skipIf(!process.env.CODELAB_TEST_POSTGRES_URL)(
  "T06 real PostgreSQL publication/upload races (isolated ui_fixture)",
  () => {
    it("lets a publication linearize first while a concurrent upload waits on the same student/task lock", async () => {
      await ready();
      const confirmed = await confirmAll();
      const reading = barrier(),
        release = barrier(),
        entered = barrier();
      const peer = db.connectPeer();
      let pid = 0;
      const publication = publishReportV2(
        db,
        identity(),
        publicationBody(confirmed.revision.revisionId),
        async (evidence) => {
          reading.resolve();
          await release.promise;
          return reader(evidence);
        },
      );
      await reading.promise;
      const uploading = peer.transaction(async (tx) => {
        pid = Number(
          (await tx.query("SELECT pg_backend_pid() AS pid")).rows[0].pid,
        );
        entered.resolve();
        await lockStudentTask(tx, taskId, studentId);
        return addSubmission(tx);
      });
      try {
        await entered.promise;
        await waitForAdvisoryWait(pid);
        release.resolve();
        const result = await publication;
        const newer = await uploading;
        expect(result.publication.snapshot.baseContext.submissionId).toBe(
          submissionId,
        );
        expect(newer).not.toBe(submissionId);
      } finally {
        release.resolve();
        await Promise.allSettled([publication, uploading]);
        await peer.close();
      }
    });

    it("rejects publication when an earlier concurrent upload commits a newer submission", async () => {
      await ready();
      const confirmed = await confirmAll();
      const inserted = barrier(),
        release = barrier(),
        entered = barrier();
      const peer = db.connectPeer();
      let pid = 0;
      const uploading = peer.transaction(async (tx) => {
        await lockStudentTask(tx, taskId, studentId);
        await addSubmission(tx);
        inserted.resolve();
        await release.promise;
      });
      await inserted.promise;
      const observed: DB = {
        ...db,
        transaction: (fn) =>
          db.transaction(async (tx) => {
            pid = Number(
              (await tx.query("SELECT pg_backend_pid() AS pid")).rows[0].pid,
            );
            entered.resolve();
            return fn(tx);
          }),
      };
      const publication = publishReportV2(
        observed,
        identity(),
        publicationBody(confirmed.revision.revisionId),
        reader,
      );
      const outcome = publication.then(
        () => "unexpected-success",
        (error: any) => error.code,
      );
      try {
        await entered.promise;
        await waitForAdvisoryWait(pid);
        release.resolve();
        await uploading;
        expect(await outcome).toBe("STALE_SUBMISSION");
        expect(
          (await db.query("SELECT id FROM publications")).rows,
        ).toHaveLength(0);
      } finally {
        release.resolve();
        await Promise.allSettled([publication, uploading]);
        await peer.close();
      }
    });
  },
);
