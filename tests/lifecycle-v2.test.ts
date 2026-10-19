import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate, type DB } from "../apps/api/src/db.js";
import { isolatedTestDB, type IsolatedTestDatabase } from "./isolated-db.js";
import { reservedStorageBytesV2 } from '../apps/api/src/storage-reservations-v2.js';
import { STORAGE_WORK_BYTES, StorageAdmissionError } from '../apps/runner/src/storage-admission.js';
import {
  enqueueRunV2,
  claimNextV2,
  heartbeatOwnerV2,
  advanceBaseV2,
  cancelQueuedV2,
  beginCleanupV2,
  recordCleanupV2,
  recordRecoveredCleanupV2,
  recoverExpiredV2,
  reserveBaseOperationV2,
  reserveCleanupOperationV2,
  sealBaseV2,
  type OwnerIdentity,
  type CleanupReceipt,
} from "../apps/api/src/lifecycle-v2.js";
import { claim as legacyClaim } from "../apps/api/src/queue.js";
import { ensureBaseReportV2, getReviewV2, editReviewV2, confirmReviewV2, publishReportV2, getPublicationV2 } from "../apps/api/src/reports-v2.js";
import {
  createDevelopmentPack,
  createRuleSnapshot,
  createSourceManifest,
  hashRuleSnapshot,
  createArtifactManifest,
  unknownMeasuredEnvironment,
  sha256,
  encodeBase64,
  type RuleSnapshot,
  type ExecutionContext,
  type CaseResult,
  type MeasurementFingerprint,
} from "../packages/contracts/src/v2/index.js";

// Synthetic persistence and concurrency fixtures, never real checker or runner measurements.
const digest = "a".repeat(64);
let db: DB;
let teacher: string,
  student: string,
  taskId: string,
  submissionId: string,
  rule: RuleSnapshot;
let sourceHash: string;
let fingerprint: MeasurementFingerprint;
beforeEach(async () => {
  db = await isolatedTestDB();
  await migrate(db);
  teacher = randomUUID();
  student = randomUUID();
  taskId = randomUUID();
  submissionId = randomUUID();
  const classId = randomUUID();
  const pack = await createDevelopmentPack("new-only", {
    packVersion: "synthetic-lifecycle-v1",
    templateVersion: "synthetic-template-v1",
    templateHash: digest,
    dependencyLockHash: digest,
    initializationVersion: "synthetic-init-v1",
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
  const files = {
    "src/App.vue": Buffer.from(
      "<template>synthetic persistence fixture</template>",
    ).toString("base64"),
  };
  const manifest = await createSourceManifest(files);
  sourceHash = manifest.sourceManifestSha256;
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
    "INSERT INTO rules(id,task_id,version,template_version,criteria,contract_version,rule_snapshot,idempotency_key,request_hash) VALUES($1,$2,1,'synthetic-template-v1','[]',2,$3,'fixture-rule',$4)",
    [rule.ruleId, taskId, JSON.stringify(rule), digest],
  );
  await db.query(
    "INSERT INTO submissions(id,task_id,user_id,rule_id,sha256,files,request_id,contract_version,source_manifest,source_manifest_sha256,source_manifest_version) VALUES($1,$2,$3,$4,$5,$6,$7,2,$8,$9,'source-manifest-v1')",
    [
      submissionId,
      taskId,
      student,
      rule.ruleId,
      digest,
      JSON.stringify(files),
      randomUUID(),
      JSON.stringify(manifest),
      sourceHash,
    ],
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
    playwrightVersion: "synthetic-1",
    chromiumVersion: "synthetic-1",
    viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
    locale: "zh-CN",
    timezone: "Asia/Shanghai",
    clockPolicy: "synthetic-v1",
    randomPolicy: "synthetic-v1",
    pageServerPolicy: "synthetic-v1",
    resourceTimeoutConfigVersion: "synthetic-v1",
  };
});
afterEach(async () => {
  await db?.close();
});

const enqueue = (key = randomUUID()) =>
  enqueueRunV2(db, {
    submissionId,
    actorId: student,
    idempotencyKey: key,
    executionApproved: true,
    approvedFingerprint: fingerprint,
  });
async function claimed() {
  await enqueue();
  const result = await claimNextV2(db);
  if (!result || result.kind !== "execution")
    throw new Error("fixture claim failed");
  return result;
}
async function faultResponse(identity: OwnerIdentity) {
  const owner = (
    await db.query("SELECT * FROM execution_attempts WHERE id=$1", [
      identity.id,
    ])
  ).rows[0];
  const context: ExecutionContext = {
    runId: owner.run_id,
    executionAttemptId: owner.id,
    submissionId,
    originalZipSha256: digest,
    sourceManifestSha256: sourceHash,
    ruleId: rule.ruleId,
    ruleHash: await hashRuleSnapshot(rule),
    packManifestHash: rule.packManifestHash,
    templateHash: rule.packManifest.templateHash,
  };
  const operationId = randomUUID(),
    requestHash = digest;
  await reserveBaseOperationV2(db, identity, operationId, requestHash);
  const definition = rule.packManifest.cases[0];
  const result: CaseResult = {
    caseId: definition.caseId,
    criterionId: definition.criterionId,
    verdict: "not_run",
    preconditionStatus: "uncertain",
    reasonCode: "INTERRUPTED",
    expected: definition.expected,
    observed: "合成中断夹具：尚未发生检查",
    executedSteps: [],
    unexecutedStepIds: definition.plannedSteps.map((step) => step.stepId),
    blockedBy: [
      { kind: "execution_stage", id: "connection", reasonCode: "INTERRUPTED" },
    ],
    evidenceIds: [],
  };
  return {
    protocolVersion: 2 as const,
    context: {
      ...context,
      operationId,
      requestHash,
      observedSourceManifestSha256: null,
      sourceVerificationReason: "尚未连接",
    },
    outcome: "interrupted" as const,
    actualFingerprint: unknownMeasuredEnvironment(),
    caseResults: [result],
    baseManifest: await createArtifactManifest({
      manifestId: randomUUID(),
      context,
      source: "base",
      analysisAttemptId: null,
      operationId: null,
      evidence: [],
      completeness: "partial",
    }),
    artifacts: [],
    timings: [],
    resourceState: "cleanup_pending" as const,
  };
}
async function publishRecoveredFault(runId: string) {
  const mutation = () => ({ runId, actorId: teacher, idempotencyKey: randomUUID() });
  const base = await ensureBaseReportV2(db, runId);
  const explanation = "合成验收：执行连接中断，本次未完成检查，请重新执行；不能据此判断功能失败。";
  const edited = await editReviewV2(db, mutation(), {
    expectedRevisionId: base.revisionId,
    feedbackChanges: base.feedback.map(item => ({ ...item, nextStep: explanation })),
  });
  const confirmed = await confirmReviewV2(db, mutation(), {
    expectedRevisionId: edited.revision.revisionId,
    items: Object.entries(edited.criterionContentHashes).map(([criterionId, contentHash]) => ({ criterionId, contentHash })),
  });
  const published = await publishReportV2(db, mutation(), {
    expectedRevisionId: confirmed.revision.revisionId, purpose: "latest", publicEvidenceIds: [],
  }, async () => { throw new Error("Recovered empty evidence must not be read"); });
  const studentView = await getPublicationV2(db, { publicationId: published.publication.publicationId, actorId: student });
  expect(studentView.publication).toEqual(published.publication);
  expect(studentView.publication.snapshot.reviewedResults).toEqual(expect.arrayContaining([
    expect.objectContaining({ automaticVerdict: "not_run", reviewedVerdict: "not_run" }),
  ]));
  expect(studentView.publication.snapshot.revision.feedback.every(item => item.nextStep === explanation)).toBe(true);
  expect(JSON.stringify(studentView)).not.toContain("invalid-unsealed-record");
  await expect(getReviewV2(db, { runId, actorId: student })).rejects.toMatchObject({ code: "NOT_FOUND" });
}
async function cleanup(
  identity: OwnerIdentity,
  state: "clean" | "cleanup_pending" = "clean",
  recovered = false,
) {
  const owner = (
    await db.query(
      `SELECT * FROM ${identity.kind === "execution" ? "execution_attempts" : "analysis_attempts"} WHERE id=$1`,
      [identity.id],
    )
  ).rows[0];
  const operation = owner.control_operations.cleanup ?? {
    operationId: randomUUID(),
    requestHash: digest,
  };
  if (!recovered) await beginCleanupV2(db, identity);
  await reserveCleanupOperationV2(
    db,
    identity,
    operation.operationId,
    operation.requestHash,
    recovered,
  );
  const receipt: CleanupReceipt = {
    protocolVersion: 2,
    runId: owner.run_id,
    ownerKind: identity.kind === "execution" ? "execution" : "analysis",
    ownerId: identity.id,
    operationId: operation.operationId,
    requestHash: operation.requestHash,
    state,
    residualResourceIds: state === "clean" ? [] : ["synthetic-residual"],
    completedAt: new Date().toISOString(),
  };
  if (recovered) await recordRecoveredCleanupV2(db, identity, receipt);
  else await recordCleanupV2(db, identity, receipt);
  return receipt;
}

describe("v2 execution identity, ownership and recovery", () => {
  it('freezes the initial analysis strategy and preserves it on request replay', async () => {
    const request = { submissionId, actorId: student, idempotencyKey: randomUUID(), executionApproved: true };
    const first = await enqueueRunV2(db, { ...request, initialAnalysisMode: 'summary' });
    expect(first.run.execution_config.initialAnalysisMode).toBe('summary');
    const replay = await enqueueRunV2(db, { ...request, initialAnalysisMode: 'agent' });
    expect(replay.replayed).toBe(true);
    expect(replay.run.execution_config.initialAnalysisMode).toBe('summary');
  });
  it('keeps durable storage reservations across claim, expiry and cleanup; queued cancellation releases only its own', async () => {
    const first = await enqueue(), second = await enqueue();
    expect(await reservedStorageBytesV2(db)).toBe(2 * STORAGE_WORK_BYTES);
    await expect(claimNextV2(db, async bytes => {
      expect(bytes).toBe(2 * STORAGE_WORK_BYTES);
      throw new StorageAdmissionError('STORAGE_CAPACITY_LOW');
    })).rejects.toMatchObject({ code: 'STORAGE_CAPACITY_LOW' });
    expect((await db.query('SELECT id FROM execution_attempts')).rows).toHaveLength(0);
    const claimed = await claimNextV2(db);
    expect(claimed?.owner.run_id).toBe(first.run.id);
    await cancelQueuedV2(db, second.run.id, student);
    expect(await reservedStorageBytesV2(db)).toBe(STORAGE_WORK_BYTES);
    await db.query("UPDATE execution_attempts SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [claimed!.identity.id]);
    await recoverExpiredV2(db);
    expect(await reservedStorageBytesV2(db)).toBe(STORAGE_WORK_BYTES);
    await cleanup(claimed!.identity, 'clean', true);
    expect(await reservedStorageBytesV2(db)).toBe(0);
  });

  it('counts queued reanalysis separately but not initial analysis twice', async () => {
    const { owner, identity } = await claimed();
    const initial = randomUUID();
    await db.query("INSERT INTO analysis_attempts(id,run_id,mode,status,owner_execution_attempt_id) VALUES($1,$2,'initial','queued',$3)", [initial, owner.run_id, identity.id]);
    expect(await reservedStorageBytesV2(db)).toBe(STORAGE_WORK_BYTES);
    await db.query("UPDATE analysis_attempts SET status='cancelled' WHERE id=$1", [initial]);
    await db.query("INSERT INTO analysis_attempts(id,run_id,mode,status) VALUES($1,$2,'reanalysis','queued')", [randomUUID(), owner.run_id]);
    expect(await reservedStorageBytesV2(db)).toBe(2 * STORAGE_WORK_BYTES);
  });

  it.skipIf(!process.env.CODELAB_TEST_POSTGRES_URL)('serializes independent API connections competing for the last storage reservation', async () => {
    const otherStudent = randomUUID(), otherSubmission = randomUUID();
    await db.query("INSERT INTO users(id,email,name,role,password_hash) VALUES($1,$2,'Peer','student','x')", [otherStudent, `${otherStudent}@test`]);
    await db.query('INSERT INTO memberships SELECT class_id,$1 FROM tasks WHERE id=$2', [otherStudent, taskId]);
    await db.query(`INSERT INTO submissions(id,task_id,user_id,rule_id,sha256,files,request_id,contract_version,source_manifest,source_manifest_sha256,source_manifest_version)
      SELECT $1,task_id,$2,rule_id,sha256,files,$3,contract_version,source_manifest,source_manifest_sha256,source_manifest_version FROM submissions WHERE id=$4`,
      [otherSubmission, otherStudent, randomUUID(), submissionId]);
    const peer = (db as IsolatedTestDatabase).connectPeer();
    const observed: number[] = [];
    const storageAdmission = async (bytes = 0) => {
      observed.push(bytes);
      if (bytes > STORAGE_WORK_BYTES) throw new StorageAdmissionError('STORAGE_CAPACITY_LOW');
    };
    try {
      const results = await Promise.allSettled([
        enqueueRunV2(db, { submissionId, actorId: student, idempotencyKey: randomUUID(), executionApproved: true, storageAdmission }),
        enqueueRunV2(peer, { submissionId: otherSubmission, actorId: otherStudent, idempotencyKey: randomUUID(), executionApproved: true, storageAdmission }),
      ]);
      expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.find(r => r.status === 'rejected')).toMatchObject({ reason: { code: 'STORAGE_CAPACITY_LOW' } });
      expect(observed).toEqual([STORAGE_WORK_BYTES, 2 * STORAGE_WORK_BYTES]);
      expect(await reservedStorageBytesV2(peer)).toBe(STORAGE_WORK_BYTES);
    } finally { await peer.close(); }
  });

  it("checks authorization before replay and rejects same-key changed intent", async () => {
    const key = randomUUID(),
      first = await enqueue(key);
    expect((await enqueue(key)).run.id).toBe(first.run.id);
    await expect(
      enqueueRunV2(db, {
        submissionId,
        actorId: randomUUID(),
        idempotencyKey: key,
        executionApproved: true,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      enqueueRunV2(db, {
        submissionId,
        actorId: student,
        idempotencyKey: key,
        executionApproved: true,
        retryOfRunId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(
      (
        await enqueueRunV2(db, {
          submissionId,
          actorId: student,
          idempotencyKey: key,
          executionApproved: false,
        })
      ).replayed,
    ).toBe(true);
  });

  it("preserves a submission when disabled and shares the queue cap with analysis", async () => {
    await expect(
      enqueueRunV2(db, {
        submissionId,
        actorId: student,
        idempotencyKey: randomUUID(),
        executionApproved: false,
      }),
    ).rejects.toMatchObject({ code: "EXECUTION_DISABLED" });
    const { run } = await enqueue();
    await db.query(
      "INSERT INTO analysis_attempts(id,run_id,mode,status) VALUES($1,$2,'reanalysis','queued')",
      [randomUUID(), run.id],
    );
    for (let n = 0; n < 28; n++) await enqueue();
    await expect(enqueue()).rejects.toMatchObject({ code: "QUEUE_FULL" });
    expect(
      (await db.query("SELECT id FROM submissions WHERE id=$1", [submissionId]))
        .rows,
    ).toHaveLength(1);
  });

  it("serializes competing claims and isolates the legacy worker", async () => {
    await enqueue();
    await enqueue();
    expect(await legacyClaim(db)).toBeNull();
    const winners = (
      await Promise.all([claimNextV2(db), claimNextV2(db)])
    ).filter(Boolean);
    expect(winners).toHaveLength(1);
    const owner = winners[0]!.owner;
    expect(
      new Date(owner.pipeline_deadline_at).getTime() -
        new Date(owner.pipeline_started_at).getTime(),
    ).toBe(300_000);
    expect(
      new Date(owner.pipeline_deadline_at).getTime() -
        new Date(owner.work_deadline_at).getTime(),
    ).toBe(30_000);
    await expect(
      advanceBaseV2(db, winners[0]!.identity, "checking"),
    ).rejects.toMatchObject({ code: "INVALID_PHASE" });
    await advanceBaseV2(db, winners[0]!.identity, "building");
    await advanceBaseV2(db, winners[0]!.identity, "checking");
    expect(await legacyClaim(db)).toBeNull();
  });

  it("rejects stolen and expired leases without extending fixed deadlines", async () => {
    const { identity, owner } = await claimed();
    await expect(
      heartbeatOwnerV2(db, { ...identity, token: randomUUID() }),
    ).rejects.toMatchObject({ code: "OWNER_LOST" });
    const lease = await heartbeatOwnerV2(db, identity);
    expect(new Date(lease).getTime()).toBeLessThanOrEqual(
      new Date(owner.pipeline_deadline_at).getTime(),
    );
    await db.query(
      "UPDATE execution_attempts SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
      [identity.id],
    );
    await expect(heartbeatOwnerV2(db, identity)).rejects.toMatchObject({
      code: "OWNER_LOST",
    });
    await expect(advanceBaseV2(db, identity, "building")).rejects.toMatchObject(
      { code: "OWNER_LOST" },
    );
  });

  it("cancels only queued runs, and a retry uses a new identity", async () => {
    const { run } = await enqueue();
    await expect(
      cancelQueuedV2(db, run.id, randomUUID()),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "运行不存在" });
    expect((await cancelQueuedV2(db, run.id, student)).status).toBe(
      "cancelled",
    );
    expect((await cancelQueuedV2(db, run.id, student)).status).toBe(
      "cancelled",
    );
    await expect(
      db.query("UPDATE runs SET status='queued' WHERE id=$1", [run.id]),
    ).rejects.toThrow("terminal run");
    const next = await enqueueRunV2(db, {
      submissionId,
      actorId: student,
      idempotencyKey: randomUUID(),
      executionApproved: true,
      retryOfRunId: run.id,
    });
    expect(next.run.id).not.toBe(run.id);
    await claimNextV2(db);
    await expect(
      cancelQueuedV2(db, next.run.id, student),
    ).rejects.toMatchObject({ code: "RUN_ALREADY_STARTED" });
  });

  it("seals facts once but retains the resource slot until a verified cleanup receipt", async () => {
    const { identity } = await claimed();
    const response = await faultResponse(identity);
    await sealBaseV2(db, identity, response, async () => {
      throw new Error("No artifact expected");
    });
    await enqueue();
    expect(await claimNextV2(db)).toBeNull();
    await expect(
      sealBaseV2(db, identity, response, async () => {}),
    ).rejects.toMatchObject({ code: "BASE_ALREADY_SEALED" });
    await expect(
      db.query("UPDATE execution_attempts SET base_results='[]' WHERE id=$1", [
        identity.id,
      ]),
    ).rejects.toThrow("sealed base");
    await cleanup(identity, "cleanup_pending");
    expect(await claimNextV2(db)).toBeNull();
    await cleanup(identity, "clean", true);
    expect(await claimNextV2(db)).not.toBeNull();
  });

  it("recovers an unsealed lost owner as unknown/not_run and fences late writes", async () => {
    const { identity } = await claimed();
    const response = await faultResponse(identity);
    await db.query(
      "UPDATE execution_attempts SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
      [identity.id],
    );
    expect(await recoverExpiredV2(db)).toHaveLength(1);
    const saved = (
      await db.query("SELECT * FROM execution_attempts WHERE id=$1", [
        identity.id,
      ])
    ).rows[0];
    expect(saved.base_results[0]).toMatchObject({
      verdict: "not_run",
      executedSteps: [],
    });
    expect(saved.actual_fingerprint).toEqual(unknownMeasuredEnvironment());
    expect(saved.owner_phase).toBe("lost");
    await expect(
      sealBaseV2(db, identity, response, async () => {}),
    ).rejects.toMatchObject({ code: "OWNER_LOST" });
    expect(await recoverExpiredV2(db)).toEqual([]);
    const receipt = await cleanup(identity, "clean", true);
    await recordRecoveredCleanupV2(db, identity, receipt);
    await publishRecoveredFault(saved.run_id);
    await expect(
      recordRecoveredCleanupV2(db, identity, {
        ...receipt,
        completedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "CLEANUP_CONFLICT" });
  });

  it.each(["case", "manifest", "environment"])(
    "quarantines an invalid unsealed %s and still permits verified cleanup",
    async (kind) => {
      const { identity } = await claimed();
      const response = await faultResponse(identity);
      const invalid = { fixture: "invalid-unsealed-record" };
      await db.query(
        `UPDATE execution_attempts SET base_results=$2,base_manifest=$3,actual_fingerprint=$4,
      lease_until=clock_timestamp()-interval '1 second' WHERE id=$1`,
        [
          identity.id,
          JSON.stringify(kind === "case" ? [invalid] : response.caseResults),
          JSON.stringify(kind === "manifest" ? invalid : response.baseManifest),
          JSON.stringify(
            kind === "environment" ? invalid : unknownMeasuredEnvironment(),
          ),
        ],
      );
      const before = (
        await db.query(
          "SELECT base_results,base_manifest,actual_fingerprint FROM execution_attempts WHERE id=$1",
          [identity.id],
        )
      ).rows[0];
      expect(await recoverExpiredV2(db)).toHaveLength(1);
      const after = (
        await db.query("SELECT * FROM execution_attempts WHERE id=$1", [
          identity.id,
        ])
      ).rows[0];
      expect(after).toMatchObject({
        owner_phase: "lost",
        cleanup_state: "cleanup_pending",
        actual_fingerprint: unknownMeasuredEnvironment(),
      });
      expect(
        after.base_results.every(
          (result: CaseResult) =>
            result.verdict === "not_run" &&
            !result.executedSteps.length &&
            !result.evidenceIds.length,
        ),
      ).toBe(true);
      const event = (
        await db.query(
          "SELECT payload FROM events WHERE run_id=$1 AND kind='v2_invalid_partial_quarantined'",
          [after.run_id],
        )
      ).rows[0];
      expect(event.payload).toEqual({
        executionAttemptId: identity.id,
        baseResults: before.base_results,
        baseManifest: before.base_manifest,
        measuredEnvironment: before.actual_fingerprint,
      });
      await expect(
        sealBaseV2(db, identity, response, async () => {}),
      ).rejects.toMatchObject({ code: "OWNER_LOST" });
      await publishRecoveredFault(after.run_id);
      await enqueue();
      expect(await claimNextV2(db)).toBeNull();
      await cleanup(identity, "clean", true);
      expect(await claimNextV2(db)).not.toBeNull();
    },
  );

  it.each(['quarantine', 'seal'])(
    'rolls back recovery on a real SQL failure during %s and permits a later recovery',
    async (stage) => {
      const { identity } = await claimed();
      await db.query(
        `UPDATE execution_attempts SET base_results=$2,
        lease_until=clock_timestamp()-interval '1 second' WHERE id=$1`,
        [identity.id, JSON.stringify([{ fixture: 'invalid-private-partial' }])],
      );
      const snapshot = async () => ({
        owner: (await db.query('SELECT * FROM execution_attempts WHERE id=$1', [identity.id])).rows,
        runs: (await db.query('SELECT * FROM runs ORDER BY id')).rows,
        events: (await db.query('SELECT * FROM events ORDER BY id')).rows,
      });
      const before = await snapshot();
      let injected = false;
      const failing: DB = {
        ...db,
        transaction: fn => db.transaction(tx => fn({
          ...tx,
          query: (sql, params) => {
            const target = stage === 'quarantine'
              ? sql.includes("'v2_invalid_partial_quarantined'")
              : sql.includes('SET base_sealed_at=');
            if (target) {
              injected = true;
              return tx.query('SELECT 1 / 0');
            }
            return tx.query(sql, params);
          },
        })),
      };
      await expect(recoverExpiredV2(failing)).rejects.toMatchObject({ code: '22012' });
      expect(injected).toBe(true);
      expect(await snapshot()).toEqual(before);
      await expect(heartbeatOwnerV2(db, identity)).rejects.toMatchObject({ code: 'OWNER_LOST' });
      expect(await recoverExpiredV2(db)).toHaveLength(1);
      const after = await snapshot();
      expect(after.owner[0].owner_phase).toBe('lost');
      expect(after.owner[0].base_results.every((item: CaseResult) => item.verdict === 'not_run')).toBe(true);
      expect(after.events.filter(item => item.kind === 'v2_invalid_partial_quarantined')).toHaveLength(1);
      await cleanup(identity, 'clean', true);
    },
  );

  it("accepts a normal result only after checking and durable artifact verification", async () => {
    const { identity } = await claimed();
    const fault = await faultResponse(identity);
    const definition = rule.packManifest.cases[0],
      at = new Date().toISOString();
    const manifestId = randomUUID(),
      evidenceId = randomUUID();
    const bytes = new TextEncoder().encode(
      '{"synthetic":true,"observed":"one created"}',
    );
    const context = fault.baseManifest.context;
    const evidence = {
      evidenceId,
      manifestId,
      runId: context.runId,
      submissionId,
      originalZipSha256: digest,
      sourceManifestSha256: sourceHash,
      executionAttemptId: identity.id,
      analysisAttemptId: null,
      operationId: null,
      scope: "case" as const,
      criterionId: "create",
      caseId: "NEW-01",
      phase: "base" as const,
      collector: "runner" as const,
      contentOrigin: "checker_observation" as const,
      ruleHash: context.ruleHash,
      packManifestHash: context.packManifestHash,
      sha256: await sha256(bytes),
      byteSize: bytes.byteLength,
      mediaType: "application/json" as const,
      storageKey: `runs/${context.runId}/${manifestId}/${evidenceId}.json`,
      capturedAt: at,
    };
    const result: CaseResult = {
      ...fault.caseResults[0],
      verdict: "passed",
      preconditionStatus: "satisfied",
      reasonCode: "ASSERTION_SATISFIED",
      observed: "Synthetic exact-one observation",
      unexecutedStepIds: [],
      blockedBy: [],
      evidenceIds: [evidenceId],
      executedSteps: definition.plannedSteps.map((step) => ({
        stepId: step.stepId,
        phase: step.phase,
        startedAt: at,
        finishedAt: at,
        state: "completed",
        observation: `Synthetic ${step.stepId}`,
        evidenceIds: [evidenceId],
      })),
    };
    const response = {
      ...fault,
      context: {
        ...fault.context,
        observedSourceManifestSha256: sourceHash,
        sourceVerificationReason: null,
      },
      outcome: "complete",
      resourceState: "retained_for_initial_analysis",
      caseResults: [result],
      actualFingerprint: {
        completeness: "complete",
        values: fingerprint,
        missingFields: [],
      },
      baseManifest: await createArtifactManifest({
        manifestId,
        context,
        source: "base",
        analysisAttemptId: null,
        operationId: null,
        evidence: [evidence],
        completeness: "complete",
      }),
      artifacts: [
        { evidenceId, encoding: "base64", data: encodeBase64(bytes) },
      ],
    };
    await expect(
      sealBaseV2(db, identity, response, async () => {}),
    ).rejects.toMatchObject({ code: "INVALID_PHASE" });
    await advanceBaseV2(db, identity, "building");
    await advanceBaseV2(db, identity, "checking");
    await expect(
      sealBaseV2(db, identity, response, async () => {
        throw new Error("artifact not durable");
      }),
    ).rejects.toThrow("artifact not durable");
    expect(
      (
        await db.query(
          "SELECT base_sealed_at FROM execution_attempts WHERE id=$1",
          [identity.id],
        )
      ).rows[0].base_sealed_at,
    ).toBeNull();
    let checked = false;
    expect(
      (
        await sealBaseV2(db, identity, response, async (key, hash, size) => {
          expect([key, hash, size]).toEqual([
            evidence.storageKey,
            evidence.sha256,
            evidence.byteSize,
          ]);
          checked = true;
        })
      ).status,
    ).toBe("completed");
    expect(checked).toBe(true);
  });

  it("preserves an already sealed manifest and outcomes when its owner expires", async () => {
    const { identity } = await claimed();
    const response = await faultResponse(identity);
    await sealBaseV2(db, identity, response, async () => {});
    const before = (
      await db.query(
        "SELECT base_results,base_manifest,actual_fingerprint,base_sealed_at FROM execution_attempts WHERE id=$1",
        [identity.id],
      )
    ).rows[0];
    await db.query(
      "UPDATE execution_attempts SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
      [identity.id],
    );
    await recoverExpiredV2(db);
    const after = (
      await db.query(
        "SELECT base_results,base_manifest,actual_fingerprint,base_sealed_at FROM execution_attempts WHERE id=$1",
        [identity.id],
      )
    ).rows[0];
    expect(after).toEqual(before);
  });

  it("registers execute and cleanup actions before accepting their results", async () => {
    const { identity } = await claimed();
    const operationId = randomUUID();
    expect(
      (await reserveBaseOperationV2(db, identity, operationId, digest))
        .replayed,
    ).toBe(false);
    expect(
      (await reserveBaseOperationV2(db, identity, operationId, digest))
        .replayed,
    ).toBe(true);
    await expect(
      reserveBaseOperationV2(db, identity, randomUUID(), digest),
    ).rejects.toMatchObject({ code: "OPERATION_CONFLICT" });
    await expect(beginCleanupV2(db, identity)).rejects.toMatchObject({
      code: "BASE_NOT_SEALED",
    });
    await expect(
      reserveCleanupOperationV2(db, identity, randomUUID(), digest),
    ).rejects.toMatchObject({ code: "INVALID_PHASE" });
  });

  it("claims queued reanalysis under the same lock and keeps analysis work and cleanup deadlines separate", async () => {
    const base = await claimed();
    await sealBaseV2(
      db,
      base.identity,
      await faultResponse(base.identity),
      async () => {},
    );
    await cleanup(base.identity);
    const analysisId = randomUUID();
    await db.query(
      "INSERT INTO analysis_attempts(id,run_id,mode,status) VALUES($1,$2,'reanalysis','queued')",
      [analysisId, base.owner.run_id],
    );
    await enqueue();
    const winners = (
      await Promise.all([claimNextV2(db), claimNextV2(db)])
    ).filter(Boolean);
    expect(winners).toHaveLength(1);
    expect(winners[0]!.kind).toBe("reanalysis");
    const { owner, identity } = winners[0]!;
    expect(
      new Date(owner.hard_deadline_at).getTime() -
        new Date(owner.work_deadline_at).getTime(),
    ).toBe(30_000);
    await expect(beginCleanupV2(db, identity)).rejects.toMatchObject({
      code: "ANALYSIS_ACTIVE",
    });
    await db.query(
      "UPDATE analysis_attempts SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
      [identity.id],
    );
    expect(await recoverExpiredV2(db)).toHaveLength(1);
    expect(await claimNextV2(db)).toBeNull();
    await cleanup(identity, "clean", true);
    expect((await claimNextV2(db))?.kind).toBe("execution");
  });
});
