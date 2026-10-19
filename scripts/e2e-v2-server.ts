// This isolated server seeds ui_fixture reports. It never runs student code.
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { testDB } from "../tests/db.js";
import { migrate } from "../apps/api/src/db.js";
import { seed } from "../apps/api/src/seed.js";
import { createApp } from "../apps/api/src/app.js";
import { createUserModelService } from "../apps/api/src/user-model-settings.js";
import { hashTemplateFiles, templateFiles } from '../apps/api/src/template.js';
import { ArtifactStore } from "../apps/api/src/artifacts-v2.js";
import { ensureBaseReportV2 } from "../apps/api/src/reports-v2.js";
import {
  createDevelopmentPack,
  createRuleSnapshot,
  createSourceManifest,
  createArtifactManifest,
  hashRuleSnapshot,
  hashTaskPack,
  sha256,
  encodeBase64,
  unknownMeasuredEnvironment,
  type CaseResult,
  type Evidence,
  type ArtifactPayload,
} from "../packages/contracts/src/v2/index.js";

if (process.env.CODELAB_UI_FIXTURE !== "1")
  throw new Error("This test-only server requires CODELAB_UI_FIXTURE=1");
const db = await testDB();
await migrate(db);
await seed(db, "Browser-test-only-2904!");
const directory = await mkdtemp(path.join(os.tmpdir(), "codelab-e2e-v2-"));
const store = new ArtifactStore({ root: path.join(directory, "evidence") });
const task = (await db.query("SELECT * FROM tasks LIMIT 1")).rows[0];
const teacher = (await db.query("SELECT id FROM users WHERE role='teacher'"))
  .rows[0].id;
const student = (await db.query("SELECT id FROM users WHERE role='student'"))
  .rows[0].id;
await db.query("UPDATE tasks SET description=$2 WHERE id=$1", [
  task.id,
  "ui_fixture：只用于验证教师复核、人工判断、发布和学生读取。所有检查观察均为合成数据，不代表项目实际运行结果。",
]);
const digest = await sha256("ui_fixture:not-a-measured-template-or-image");
const pack = await createDevelopmentPack("new-filter", {
  packVersion: "ui-fixture-e2e-v1",
  templateVersion: "vue-board-v1",
  templateHash: hashTemplateFiles(await templateFiles()),
  dependencyLockHash: digest,
  initializationVersion: "ui-fixture-initialization",
  caseImplementationHashes: { "NEW-01": digest, "FILTER-03": digest },
});
pack.criteria.push({
  criterionId: "readability",
  displayCode: "CK-06",
  title: "人工可读性",
  mode: "manual",
  expectedBehavior: "由教师阅读源码与说明，记录模块命名和职责划分是否清楚。",
});
pack.contentHash = await hashTaskPack(pack);
const now = new Date().toISOString();
const rule = await createRuleSnapshot({
  ruleId: randomUUID(),
  taskId: task.id,
  version: 2,
  packManifest: pack,
  enabledCriterionIds: pack.criteria.map((c) => c.criterionId),
  parameterValues: {},
  confirmedBy: teacher,
  confirmedAt: now,
});
await db.query(
  `INSERT INTO rules(id,task_id,version,template_version,criteria,contract_version,rule_snapshot,idempotency_key,request_hash)
  VALUES($1,$2,2,'vue-board-v1','[]',2,$3,$4,$5)`,
  [rule.ruleId, task.id, JSON.stringify(rule), randomUUID(), digest],
);
const submissionId = randomUUID(),
  runId = "00000000-0000-4000-8000-000000000003",
  executionAttemptId = randomUUID();
const files = {
  "src/App.vue": Buffer.from(
    "<template>ui_fixture report only</template>",
  ).toString("base64"),
};
const source = await createSourceManifest(files);
await db.query(
  `INSERT INTO submissions(id,task_id,user_id,rule_id,sha256,files,request_id,contract_version,
  source_manifest,source_manifest_sha256,source_manifest_version) VALUES($1,$2,$3,$4,$5,$6,$7,2,$8,$9,$10)`,
  [
    submissionId,
    task.id,
    student,
    rule.ruleId,
    digest,
    JSON.stringify(files),
    randomUUID(),
    JSON.stringify(source),
    source.sourceManifestSha256,
    source.algorithmVersion,
  ],
);
await db.query(
  `INSERT INTO runs(id,submission_id,rule_id,status,contract_version,execution_config,request_id,idempotency_key,request_hash)
  VALUES($1,$2,$3,'completed',2,$4,$5,$6,$7)`,
  [
    runId,
    submissionId,
    rule.ruleId,
    JSON.stringify({ source: "ui_fixture" }),
    randomUUID(),
    randomUUID(),
    digest,
  ],
);
const context = {
  runId,
  submissionId,
  executionAttemptId,
  originalZipSha256: digest,
  sourceManifestSha256: source.sourceManifestSha256,
  ruleId: rule.ruleId,
  ruleHash: await hashRuleSnapshot(rule),
  packManifestHash: pack.contentHash,
  templateHash: pack.templateHash,
};
const manifestId = randomUUID(),
  evidence: Evidence[] = [],
  artifacts: ArtifactPayload[] = [],
  results: CaseResult[] = [];
for (const definition of pack.cases) {
  const blocked = definition.caseId === "FILTER-03";
  const observed = `ui_fixture 合成观察：${blocked ? "准备完成任务时受阻，尚未检查筛选行为。" : "模拟新增后数量加一、标题唯一。"}不代表实际执行结果。`;
  const bytes = new TextEncoder().encode(observed),
    evidenceId = randomUUID();
  evidence.push({
    evidenceId,
    manifestId,
    runId,
    submissionId,
    executionAttemptId,
    originalZipSha256: digest,
    sourceManifestSha256: source.sourceManifestSha256,
    ruleHash: context.ruleHash,
    packManifestHash: pack.contentHash,
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
    capturedAt: now,
  });
  artifacts.push({ evidenceId, encoding: "base64", data: encodeBase64(bytes) });
  const performed = blocked
    ? definition.plannedSteps.slice(0, 1)
    : definition.plannedSteps;
  results.push({
    caseId: definition.caseId,
    criterionId: definition.criterionId,
    expected: definition.expected,
    observed,
    verdict: blocked ? "not_run" : "passed",
    preconditionStatus: blocked ? "blocked" : "satisfied",
    reasonCode: blocked ? "SETUP_BLOCKED" : "ASSERTION_SATISFIED",
    evidenceIds: [evidenceId],
    executedSteps: performed.map((step) => ({
      stepId: step.stepId,
      phase: step.phase,
      startedAt: now,
      finishedAt: now,
      state: blocked ? "failed" : "completed",
      observation: `ui_fixture 合成步骤：${step.description}`,
      evidenceIds: [evidenceId],
    })),
    unexecutedStepIds: definition.plannedSteps
      .slice(performed.length)
      .map((step) => step.stepId),
    blockedBy: blocked
      ? [
          {
            kind: "setup_step",
            id: performed[0].stepId,
            reasonCode: "SETUP_BLOCKED",
          },
        ]
      : [],
  });
}
const manifest = await createArtifactManifest({
  manifestId,
  context,
  source: "base",
  analysisAttemptId: null,
  operationId: null,
  evidence,
  completeness: "complete",
});
await store.storeManifest(manifest, artifacts);
await db.query(
  `INSERT INTO execution_attempts(id,run_id,attempt_no,owner_phase,pipeline_started_at,work_deadline_at,pipeline_deadline_at,
  base_sealed_at,base_results,base_manifest,actual_fingerprint) VALUES($1,$2,1,'initial_analysis',$3,$4,$5,$3,$6,$7,$8)`,
  [
    executionAttemptId,
    runId,
    now,
    new Date(Date.parse(now) + 270000),
    new Date(Date.parse(now) + 300000),
    JSON.stringify(results),
    JSON.stringify(manifest),
    JSON.stringify(unknownMeasuredEnvironment()),
  ],
);
await db.query("UPDATE runs SET accepted_execution_attempt_id=$2 WHERE id=$1", [
  runId,
  executionAttemptId,
]);
const baseRevision = await ensureBaseReportV2(db, runId);
// Opt-in, labelled synthetic candidate for adoption UI tests only. No model call.
if (process.env.CODELAB_UI_CANDIDATE === '1') {
  await db.query(`INSERT INTO analysis_attempts(id,run_id,base_manifest_id,mode,
    owner_execution_attempt_id,status,configuration,candidate,selected_at_start_revision_id,finished_at)
    VALUES($1,$2,$3,'initial',$4,'succeeded',$5,$6,$7,$8)`, [
    randomUUID(),runId,manifestId,executionAttemptId,
    JSON.stringify({strategy:'summary',provider:'test-only',model:'ui_fixture'}),
    JSON.stringify({feedback:baseRevision.feedback.map(item=>({...item,
      nextStep:'ui_fixture 候选建议：先核对新增任务的输入边界。'}))}),
    baseRevision.revisionId,now,
  ]);
}
let userModels: ReturnType<typeof createUserModelService> | undefined;
if (process.env.CODELAB_UI_SOURCE === '1' || process.env.CODELAB_UI_COURSEWORK === '1') {
  const fixtureProvider = process.env.CODELAB_UI_COURSEWORK === '1'
    ? (await import('../tests/fixtures/coursework-ui-provider.js')).courseworkUIProvider
    : (await import('../tests/fixtures/source-ui-provider.js')).sourceUIProvider;
  // This in-memory vault and fixed factory never read credentials from disk or
  // construct an external model client, regardless of the ambient environment.
  userModels = createUserModelService(db, randomBytes(32), () => ({
    ...fixtureProvider,
    configuration: { ...fixtureProvider.configuration },
  }));
  for (const userId of [teacher, student]) {
    await userModels.save(userId, {
      vendor: 'deepseek',
      model: fixtureProvider.configuration.model,
      apiKey: 'synthetic-browser-fixture-key-only',
      contextWindowTokens: null,
      maxOutputTokens: 12000,
    });
  }
}
const app = await createApp(db, {
  userModels,
  origin: process.env.APP_ORIGIN ?? "http://localhost:5318",
  secure: false,
  executionApproved: false,
  businessVersion: 2,
  packs: [pack],
  model: "unconfigured",
  // Course analysis remains a queue/cancel fixture with no execution worker.
  // CODELAB_UI_SOURCE opts into the source worker with the fixed fake above.
  analysisConfiguration: {provider:"test-only",model:"ui_fixture",endpoint:"http://127.0.0.1/unused-fixture"},
  image: "ui_fixture-not-an-image",
  evidenceReader: (item) => store.readEvidence(item),
});
await app.listen({
  host: "127.0.0.1",
  port: Number(process.env.API_PORT ?? 3311),
});
let closing = false;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, async () => {
    if (closing) return;
    closing = true;
    try {
      await app.close();
      await db.close();
    } finally {
      // This exact path was created by this process under the temporary directory.
      if (
        path.dirname(directory) === path.resolve(os.tmpdir()) &&
        path.basename(directory).startsWith("codelab-e2e-v2-")
      )
        await rm(directory, { recursive: true, force: true });
      process.exit(0);
    }
  });
