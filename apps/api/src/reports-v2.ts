import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  businessIdSchema,
  canonicalJson,
  compareCaseResults,
  compareTeacherJudgments,
  hashPublicationSnapshot,
  MEASUREMENT_FIELDS,
  createPublicationSnapshot,
  buildBaseFeedback,
  confirmCriterion,
  deriveReviewedResults,
  feedbackItemSchema,
  hashCriterionContent,
  hashRuleSnapshot,
  modelFeedbackDraftSchema,
  publicationSchema,
  reportRevisionSchema,
  retainValidConfirmations,
  sha256,
  sha256Schema,
  uuidSchema,
  verdictSchema,
  evidenceRefSchema,
  validateArtifactManifest,
  validateCaseResults,
  validateReportRevision,
  validateRuleSnapshot,
  type ArtifactManifest,
  type Evidence,
  type FeedbackItem,
  type Publication,
  type ReportRevision,
  type ReportValidationContext,
  type TeacherJudgment,
} from "../../../packages/contracts/src/v2/index.js";
import type { DB } from "./db.js";
import { lockStudentTask } from "./lifecycle-v2.js";

export type EvidenceReader = (evidence: Evidence) => Promise<Uint8Array>;
export class ReportV2Error extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode = 409,
  ) {
    super(message);
  }
}
function fail(code: string, message: string, status = 409): never {
  throw new ReportV2Error(code, message, status);
}
const iso = (value: string | Date) => new Date(value).toISOString();
type Row = Record<string, any>;
type Identity = { runId: string; actorId: string };
type MutationIdentity = Identity & { idempotencyKey: string };
const judgmentTargetSchema = z
  .object({
    targetType: z.enum(["case", "manualCriterion"]),
    targetId: businessIdSchema,
  })
  .strict();
export const judgmentInputSchema = judgmentTargetSchema
  .extend({
    verdict: verdictSchema,
    reason: z.string().trim().min(1).max(3000),
    verificationMethod: z.enum([
      "evidence_review",
      "manual_reproduction",
      "other_documented",
    ]),
    evidenceRefs: z.array(evidenceRefSchema).max(100),
    verificationNote: z.string().trim().max(3000),
  })
  .strict();
export const editReviewRequestSchema = z
  .object({
    expectedRevisionId: uuidSchema,
    feedbackChanges: z.array(feedbackItemSchema).max(15).optional(),
    teacherJudgments: z.array(judgmentInputSchema).max(80).optional(),
    removeJudgments: z.array(judgmentTargetSchema).max(80).optional(),
    selectedSupplementalManifestIds: z.array(uuidSchema).max(50).optional(),
  })
  .strict();
export const confirmReviewRequestSchema = z
  .object({
    expectedRevisionId: uuidSchema,
    items: z
      .array(
        z
          .object({ criterionId: businessIdSchema, contentHash: sha256Schema })
          .strict(),
      )
      .min(1)
      .max(15),
  })
  .strict();
export const adoptReviewRequestSchema = z
  .object({
    expectedRevisionId: uuidSchema,
    candidateId: uuidSchema,
    criterionIds: z.array(businessIdSchema).min(1).max(15),
    selectedSupplementalManifestIds: z.array(uuidSchema).max(50).optional(),
  })
  .strict();
export const publishRequestSchema = z
  .object({
    expectedRevisionId: uuidSchema,
    purpose: z.enum(["latest", "historical_correction"]),
    publicEvidenceIds: z.array(uuidSchema).max(400),
    expectedLatestPublicationId: uuidSchema.optional(),
    correctionReason: z.string().trim().min(1).max(3000).optional(),
  })
  .strict();
export const correctionRequestSchema = z
  .object({
    expectedRevisionId: uuidSchema,
    expectedLatestPublicationId: uuidSchema,
    correctionReason: z.string().trim().min(1).max(3000),
  })
  .strict();

function unique(values: readonly string[], label: string) {
  if (new Set(values).size !== values.length)
    fail("DUPLICATE_REQUEST_ITEM", `${label}不能重复`, 400);
}
function requestIdentity(
  input: MutationIdentity,
  action: string,
  body: unknown,
) {
  uuidSchema.parse(input.runId);
  uuidSchema.parse(input.actorId);
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(input.idempotencyKey))
    fail("INVALID_IDEMPOTENCY_KEY", "幂等键格式无效", 400);
  return {
    key: `${input.actorId}:${action}:${input.idempotencyKey}`,
    hash: sha256(canonicalJson(body)),
  };
}
async function runAccess(
  db: DB,
  input: Identity,
  teacherOnly = true,
): Promise<Row> {
  const row = (
    await db.query(
      `SELECT r.*,s.task_id,s.user_id,s.sha256,s.source_manifest_sha256,
    c.teacher_id,t.class_id,ru.rule_snapshot FROM runs r JOIN submissions s ON s.id=r.submission_id
    JOIN tasks t ON t.id=s.task_id JOIN classes c ON c.id=t.class_id JOIN rules ru ON ru.id=r.rule_id
    JOIN users u ON u.id=$2 WHERE r.id=$1 AND r.contract_version=2 AND s.contract_version=2 AND ru.contract_version=2
    AND ((u.role='teacher' AND c.teacher_id=u.id) OR ($3=false AND u.role='student' AND s.user_id=u.id
      AND EXISTS(SELECT 1 FROM memberships m WHERE m.class_id=c.id AND m.user_id=u.id)))`,
      [input.runId, input.actorId, teacherOnly],
    )
  ).rows[0];
  if (!row)
    fail("NOT_FOUND", teacherOnly ? "复核报告不存在" : "已发布报告不存在", 404);
  return row;
}
async function lockedRun(tx: DB, input: Identity) {
  const access = await runAccess(tx, input);
  await lockStudentTask(tx, access.task_id, access.user_id);
  await tx.query("SELECT id FROM runs WHERE id=$1 FOR UPDATE", [input.runId]);
  return runAccess(tx, input);
}
async function contextFor(db: DB, run: Row): Promise<ReportValidationContext> {
  const rule = await validateRuleSnapshot(run.rule_snapshot);
  if (rule.ruleId !== run.rule_id || rule.taskId !== run.task_id)
    fail("RULE_CONTEXT_MISMATCH", "运行规则归属不一致");
  const owner = (
    await db.query(
      "SELECT * FROM execution_attempts WHERE id=$1 AND run_id=$2 AND base_sealed_at IS NOT NULL",
      [run.accepted_execution_attempt_id, run.id],
    )
  ).rows[0];
  if (!owner) fail("BASE_NOT_SEALED", "基础结果尚未封存");
  const baseManifest = await validateArtifactManifest(owner.base_manifest, {
    rule,
    expectedContext: {
      runId: run.id,
      executionAttemptId: owner.id,
      submissionId: run.submission_id,
      originalZipSha256: run.sha256,
      sourceManifestSha256: run.source_manifest_sha256,
      ruleId: run.rule_id,
      ruleHash: await hashRuleSnapshot(rule),
      packManifestHash: rule.packManifestHash,
      templateHash: rule.packManifest.templateHash,
    },
  });
  if (baseManifest.source !== "base")
    fail("BASE_MANIFEST_INVALID", "基础证据清单类型错误");
  const manifests = (
    await db.query(
      `SELECT o.supplemental_manifest,a.id AS analysis_id,o.operation_id
    FROM analysis_operations o JOIN analysis_attempts a ON a.id=o.analysis_attempt_id
    WHERE a.run_id=$1 AND a.base_manifest_id=$2 AND o.state='completed' AND o.supplemental_manifest IS NOT NULL
    ORDER BY o.started_at,o.operation_id`,
      [run.id, baseManifest.manifestId],
    )
  ).rows;
  const supplementalManifests: ArtifactManifest[] = [];
  for (const item of manifests) {
    const manifest = await validateArtifactManifest(
      item.supplemental_manifest,
      { rule, expectedContext: baseManifest.context },
    );
    if (
      manifest.source !== "supplemental" ||
      manifest.analysisAttemptId !== item.analysis_id ||
      manifest.operationId !== item.operation_id
    )
      fail("SUPPLEMENTAL_OWNER_MISMATCH", "补充证据来源不一致");
    supplementalManifests.push(manifest);
  }
  return {
    rule,
    baseManifest,
    baseResults: validateCaseResults(rule, owner.base_results),
    supplementalManifests,
  };
}
function revisionOf(row: Row): ReportRevision {
  return reportRevisionSchema.parse({
    contractVersion: 2,
    revisionId: row.id,
    runId: row.run_id,
    revisionNo: row.revision_no,
    parentRevisionId: row.parent_revision_id,
    baseManifestId: row.base_manifest_id,
    selectedSupplementalManifestIds: row.selected_supplemental_manifest_ids,
    feedback: row.feedback,
    teacherJudgments: row.teacher_judgments,
    confirmations: row.confirmations,
    source: row.source,
    originPublicationId: row.origin_publication_id ?? null,
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
  });
}
async function latestRevision(db: DB, runId: string) {
  const row = (
    await db.query(
      "SELECT * FROM report_revisions WHERE run_id=$1 ORDER BY revision_no DESC LIMIT 1",
      [runId],
    )
  ).rows[0];
  return row ? revisionOf(row) : null;
}
/** Internal worker context; never exposed as an unauthenticated HTTP endpoint. */
export async function analysisContextV2(db: DB, runId: string) {
  const run = (
    await db.query(
      `SELECT r.*,s.task_id,s.sha256,s.source_manifest_sha256,ru.rule_snapshot
    FROM runs r JOIN submissions s ON s.id=r.submission_id JOIN rules ru ON ru.id=r.rule_id
    WHERE r.id=$1 AND r.contract_version=2`,
      [runId],
    )
  ).rows[0];
  if (!run) fail("NOT_FOUND", "运行不存在", 404);
  const context = await contextFor(db, run);
  const revision = await latestRevision(db, runId);
  if (!revision) fail("REPORT_NOT_READY", "基础报告尚未生成");
  return { context, revision };
}
async function latestPublication(db: DB, runId: string) {
  return (
    await db.query(
      "SELECT * FROM publications WHERE run_id=$1 ORDER BY publication_no DESC LIMIT 1",
      [runId],
    )
  ).rows[0] as Row | undefined;
}
async function publicationOf(row: Row): Promise<Publication> {
  const publication = publicationSchema.parse({
    contractVersion: 2,
    publicationId: row.id,
    runId: row.run_id,
    publicationNo: row.publication_no,
    revisionId: row.revision_id,
    supersedesPublicationId: row.supersedes_publication_id,
    purpose: row.purpose,
    correctionReason: row.correction_reason,
    snapshot: row.snapshot,
    publicEvidenceIds: row.public_evidence_ids,
    publishedBy: row.published_by,
    publishedAt: iso(row.published_at),
    idempotencyKey: row.idempotency_key.split(":").at(-1),
  });
  if (await hashPublicationSnapshot(publication.snapshot) !== publication.snapshot.contentHash)
    fail('PUBLICATION_HASH_MISMATCH', '已发布快照完整性检查失败');
  return publication;
}
function publicationSummary(row: Row) {
  return {
    publicationId: row.id,
    publicationNo: row.publication_no,
    revisionId: row.revision_id,
    purpose: row.purpose,
    publishedAt: iso(row.published_at),
    supersedesPublicationId: row.supersedes_publication_id,
  };
}
async function appendRevision(
  tx: DB,
  revision: ReportRevision,
  context: ReportValidationContext,
  key: string,
  requestHash: string,
) {
  const valid = await validateReportRevision(revision, context);
  await tx.query(
    `INSERT INTO report_revisions(id,run_id,revision_no,parent_revision_id,base_manifest_id,
    selected_supplemental_manifest_ids,feedback,teacher_judgments,confirmations,source,created_by,created_at,idempotency_key,request_hash,origin_publication_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [
      valid.revisionId,
      valid.runId,
      valid.revisionNo,
      valid.parentRevisionId,
      valid.baseManifestId,
      JSON.stringify(valid.selectedSupplementalManifestIds),
      JSON.stringify(valid.feedback),
      JSON.stringify(valid.teacherJudgments),
      JSON.stringify(valid.confirmations),
      valid.source,
      valid.createdBy,
      valid.createdAt,
      key,
      requestHash,
      valid.originPublicationId,
    ],
  );
  return valid;
}
async function nextRevision(
  tx: DB,
  current: ReportRevision,
  actorId: string,
  source: ReportRevision["source"],
): Promise<ReportRevision> {
  return {
    ...current,
    revisionId: randomUUID(),
    revisionNo: current.revisionNo + 1,
    parentRevisionId: current.revisionId,
    source,
    createdBy: actorId,
    createdAt: iso(
      (await tx.query("SELECT clock_timestamp() AS time")).rows[0].time,
    ),
  };
}
function expectCurrent(
  current: ReportRevision | null,
  expected: string,
): ReportRevision {
  if (!current) fail("REPORT_NOT_READY", "基础报告尚未生成");
  if (current.revisionId !== expected)
    fail("REVISION_CONFLICT", "报告已更新，请重新读取后操作");
  return current;
}
async function requireCorrectionOrigin(tx: DB, revision: ReportRevision) {
  const publication = await latestPublication(tx, revision.runId);
  if (publication && revision.originPublicationId !== publication.id)
    fail("CORRECTION_REQUIRED", "已发布报告须先从最新发布创建更正修订");
}

/** Trusted worker entry point. An already-created draft is never overwritten. */
export async function ensureBaseReportV2(
  db: DB,
  runId: string,
): Promise<ReportRevision> {
  return db.transaction(async (tx) => {
    const run = (
      await tx.query(
        `SELECT r.*,s.task_id,s.user_id,s.sha256,s.source_manifest_sha256,ru.rule_snapshot
      FROM runs r JOIN submissions s ON s.id=r.submission_id JOIN rules ru ON ru.id=r.rule_id
      WHERE r.id=$1 AND r.contract_version=2 AND s.contract_version=2 AND ru.contract_version=2`,
        [runId],
      )
    ).rows[0];
    if (!run) fail("NOT_FOUND", "运行不存在", 404);
    await lockStudentTask(tx, run.task_id, run.user_id);
    const locked = (
      await tx.query(
        "SELECT accepted_execution_attempt_id FROM runs WHERE id=$1 FOR UPDATE",
        [runId],
      )
    ).rows[0];
    const prior = await latestRevision(tx, runId);
    if (prior) return prior;
    const context = await contextFor(tx, { ...run, ...locked });
    const revision: ReportRevision = {
      contractVersion: 2,
      revisionId: randomUUID(),
      runId,
      revisionNo: 1,
      parentRevisionId: null,
      baseManifestId: context.baseManifest.manifestId,
      selectedSupplementalManifestIds: [],
      feedback: buildBaseFeedback(
        context.rule,
        context.baseResults,
        context.baseManifest,
      ),
      teacherJudgments: [],
      confirmations: [],
      source: "base",
      originPublicationId: null,
      createdBy: null,
      createdAt: iso(
        (await tx.query("SELECT clock_timestamp() AS time")).rows[0].time,
      ),
    };
    return appendRevision(
      tx,
      revision,
      context,
      "system:base",
      await sha256(context.baseManifest.contentHash),
    );
  });
}

async function reviewDto(
  db: DB,
  run: Row,
  context: ReportValidationContext,
  revision: ReportRevision,
) {
  await validateReportRevision(revision, context);
  const criterionContentHashes: Record<string, string> = {};
  for (const id of context.rule.enabledCriterionIds)
    criterionContentHashes[id] = await hashCriterionContent(
      id,
      revision,
      context,
    );
  const publication = await latestPublication(db, run.id);
  const candidates = (
    await db.query(
      `SELECT id,status,candidate,configuration->>'strategy' AS strategy,configuration->>'promptVersion' AS prompt_version,
        configuration->>'pairedWithAnalysisId' AS paired_with_analysis_id FROM analysis_attempts
    WHERE run_id=$1 AND base_manifest_id=$2 AND status='succeeded' AND candidate IS NOT NULL ORDER BY created_at DESC,id DESC`,
      [run.id, context.baseManifest.manifestId],
    )
  ).rows.flatMap((row) => {
    const draft = modelFeedbackDraftSchema.safeParse(row.candidate);
    return draft.success
      ? [
          {
            candidateId: row.id,
            analysisAttemptId: row.id,
            status: row.status,
            strategy: row.strategy ?? (['sealed-text-summary-v1', 'sealed-text-summary-v2-compact'].includes(row.prompt_version) ? 'summary' : 'agent'),
            pairedWithAnalysisId: row.paired_with_analysis_id ?? null,
            feedback: draft.data.feedback,
          },
        ]
      : [];
  });
  return {
    contractVersion: 2 as const,
    runId: run.id,
    analyses: (
      await db.query(
        `SELECT id,status,mode,cleanup_state,configuration->>'model' AS model,
      COALESCE(configuration->>'strategy',CASE WHEN configuration->>'promptVersion' IN ('sealed-text-summary-v1','sealed-text-summary-v2-compact') THEN 'summary' ELSE 'agent' END) AS strategy,
      configuration->>'baseInputHash' AS base_input_hash,configuration->>'pairedWithAnalysisId' AS paired_with_analysis_id,
      configuration->>'promptVersion' AS prompt_version,usage->>'code' AS code,created_at,finished_at,
      COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'operationId',o.operation_id,'kind',o.kind,'state',o.state,
        'startedAt',o.started_at,'finishedAt',o.finished_at,
        'hasSupplementalEvidence',o.supplemental_manifest IS NOT NULL
      ) ORDER BY o.started_at,o.operation_id) FROM analysis_operations o WHERE o.analysis_attempt_id=a.id),'[]'::jsonb) AS operations
      FROM analysis_attempts a WHERE run_id=$1 AND base_manifest_id=$2 ORDER BY created_at DESC LIMIT 10`,
        [run.id, context.baseManifest.manifestId],
      )
    ).rows,
    rule: context.rule,
    baseResults: context.baseResults,
    baseManifest: context.baseManifest,
    supplementalManifests: context.supplementalManifests,
    revision,
    reviewedResults: deriveReviewedResults(
      context.rule,
      context.baseResults,
      revision.teacherJudgments,
    ),
    criterionContentHashes,
    latestPublication: publication ? publicationSummary(publication) : null,
    candidates,
  };
}
export async function getReviewV2(db: DB, input: Identity) {
  const run = await runAccess(db, input);
  const context = await contextFor(db, run);
  const revision = await latestRevision(db, run.id);
  if (!revision) fail("REPORT_NOT_READY", "基础报告尚未生成");
  return reviewDto(db, run, context, revision);
}

/** Explicit pairs never infer an unpublished student's outcome from teacher data. */
export async function getExplicitRunComparisonV2(
  db: DB, input: { beforeRunId: string; afterRunId: string; actorId: string },
) {
  const before = await runAccess(db, { runId: input.beforeRunId, actorId: input.actorId }, false);
  const after = await runAccess(db, { runId: input.afterRunId, actorId: input.actorId }, false);
  if (before.task_id !== after.task_id || before.user_id !== after.user_id)
    fail('COMPARISON_SCOPE_MISMATCH', '请选择同一学生、同一任务的两次运行', 400);
  if (before.id === after.id)
    fail('COMPARISON_SAME_RUN', '请选择不同的运行', 400);
  const identity = { beforeRunId: before.id, afterRunId: after.id };
  if (before.teacher_id !== input.actorId) {
    // Select both current publication identities in one statement, then use
    // those exact immutable snapshots even if a correction is published later.
    const rows = (await db.query(
      `SELECT DISTINCT ON (run_id) id,run_id FROM publications
       WHERE run_id IN ($1,$2) ORDER BY run_id,publication_no DESC`, [before.id, after.id],
    )).rows;
    const first = rows.find(row => row.run_id === before.id), last = rows.find(row => row.run_id === after.id);
    if (!first || !last) fail('NOT_FOUND', '已发布报告不存在', 404);
    return { ...await getPublicationComparisonV2(db, {
      beforePublicationId: first.id, publicationId: last.id, actorId: input.actorId,
    }), ...identity, source: 'publications' as const };
  }
  async function measured(run: Row) {
    const context = await contextFor(db, run);
    const owner = (await db.query(
      'SELECT actual_fingerprint FROM execution_attempts WHERE id=$1 AND run_id=$2 AND base_sealed_at IS NOT NULL',
      [run.accepted_execution_attempt_id, run.id],
    )).rows[0];
    return { contractVersion: 2 as const, studentId: run.user_id, taskId: run.task_id,
      ruleId: run.rule_id, actualFingerprint: owner?.actual_fingerprint ?? {
        completeness: 'unknown', values: {}, missingFields: MEASUREMENT_FIELDS,
      }, caseResults: context.baseResults };
  }
  const automatic = compareCaseResults(await measured(before), await measured(after));
  const beforeRevision = await latestRevision(db, before.id), afterRevision = await latestRevision(db, after.id);
  return { contractVersion: 2 as const, ...identity, source: 'sealed_results' as const, automatic,
    teacherJudgments: beforeRevision && afterRevision ? compareTeacherJudgments(beforeRevision, afterRevision) : null,
    beforeRevisionId: beforeRevision?.revisionId ?? null, afterRevisionId: afterRevision?.revisionId ?? null };
}

/** Teacher-only comparison reads sealed facts, never edited feedback as a test result. */
export async function getRunComparisonV2(db: DB, input: Identity) {
  const current = await runAccess(db, input);
  const previous = (
    await db.query(
      `SELECT r.id FROM runs r JOIN submissions s ON s.id=r.submission_id
     WHERE s.task_id=$1 AND s.user_id=$2 AND r.contract_version=2
       AND s.contract_version=2 AND s.id<>$3
       AND (s.created_at,s.id)<(SELECT created_at,id FROM submissions WHERE id=$3)
       AND r.accepted_execution_attempt_id IS NOT NULL
     ORDER BY s.created_at DESC,s.id DESC,r.created_at DESC,r.id DESC LIMIT 1`,
      [current.task_id, current.user_id, current.submission_id],
    )
  ).rows[0];
  if (!previous)
    return {
      status: "unavailable",
      reasonCode: "NO_PREVIOUS_SEALED_SUBMISSION",
      caseDiffs: [],
    };
  const before = await runAccess(db, { ...input, runId: previous.id });
  const asComparison = async (run: Row) => {
    const context = await contextFor(db, run);
    const owner = (
      await db.query(
        "SELECT actual_fingerprint FROM execution_attempts WHERE id=$1 AND run_id=$2 AND base_sealed_at IS NOT NULL",
        [run.accepted_execution_attempt_id, run.id],
      )
    ).rows[0];
    return {
      contractVersion: 2 as const,
      studentId: run.user_id,
      taskId: run.task_id,
      ruleId: run.rule_id,
      actualFingerprint: owner.actual_fingerprint,
      caseResults: context.baseResults,
    };
  };
  return {
    beforeRunId: before.id,
    afterRunId: current.id,
    ...compareCaseResults(
      await asComparison(before),
      await asComparison(current),
    ),
  };
}

async function mutateReview(
  db: DB,
  input: MutationIdentity,
  body: { expectedRevisionId: string },
  action: string,
  change: (
    tx: DB,
    revision: ReportRevision,
    context: ReportValidationContext,
  ) => Promise<ReportRevision>,
) {
  const identity = requestIdentity(input, action, body),
    requestHash = await identity.hash;
  return db.transaction(async (tx) => {
    const run = await lockedRun(tx, input);
    const context = await contextFor(tx, run);
    const prior = (
      await tx.query(
        "SELECT * FROM report_revisions WHERE run_id=$1 AND idempotency_key=$2",
        [run.id, identity.key],
      )
    ).rows[0];
    if (prior) {
      if (prior.request_hash !== requestHash)
        fail("IDEMPOTENCY_CONFLICT", "幂等键请求内容已变化");
      return {
        ...(await reviewDto(tx, run, context, revisionOf(prior))),
        replayed: true,
      };
    }
    const current = expectCurrent(
      await latestRevision(tx, run.id),
      body.expectedRevisionId,
    );
    await requireCorrectionOrigin(tx, current);
    const revision = await change(tx, current, context);
    revision.confirmations = await retainValidConfirmations(revision, context);
    await appendRevision(tx, revision, context, identity.key, requestHash);
    return {
      ...(await reviewDto(tx, run, context, revision)),
      replayed: false,
    };
  });
}
export async function editReviewV2(
  db: DB,
  input: MutationIdentity,
  value: unknown,
) {
  const body = editReviewRequestSchema.parse(value);
  unique(
    (body.feedbackChanges ?? []).map((item) => item.criterionId),
    "反馈条目",
  );
  const targetKey = (item: { targetType: string; targetId: string }) =>
    `${item.targetType}:${item.targetId}`;
  unique((body.teacherJudgments ?? []).map(targetKey), "教师判断目标");
  unique((body.removeJudgments ?? []).map(targetKey), "移除判断目标");
  if (
    (body.teacherJudgments ?? []).some((item) =>
      (body.removeJudgments ?? []).some(
        (removed) => targetKey(removed) === targetKey(item),
      ),
    )
  )
    fail(
      "JUDGMENT_CHANGE_CONFLICT",
      "同一次编辑不能同时添加和删除同一判断",
      400,
    );
  return mutateReview(db, input, body, "edit_review", async (tx, current) => {
    const revision = await nextRevision(
      tx,
      current,
      input.actorId,
      "teacher_edit",
    );
    const changed = body.feedbackChanges ?? [];
    if (
      changed.some(
        (item) =>
          !current.feedback.some((old) => old.criterionId === item.criterionId),
      )
    )
      fail("UNKNOWN_CRITERION", "反馈条目不属于本规则", 400);
    revision.feedback = current.feedback.map(
      (item) =>
        changed.find((entry) => entry.criterionId === item.criterionId) ?? item,
    );
    const replacements = body.teacherJudgments ?? [],
      removed = body.removeJudgments ?? [];
    revision.teacherJudgments = [
      ...current.teacherJudgments.filter(
        (item) =>
          ![...replacements, ...removed].some(
            (entry) => targetKey(entry) === targetKey(item),
          ),
      ),
      ...replacements.map(
        (item): TeacherJudgment => ({
          ...item,
          judgmentId: randomUUID(),
          judgedBy: input.actorId,
          judgedAt: revision.createdAt,
        }),
      ),
    ];
    if (body.selectedSupplementalManifestIds)
      revision.selectedSupplementalManifestIds =
        body.selectedSupplementalManifestIds;
    return revision;
  });
}
export async function confirmReviewV2(
  db: DB,
  input: MutationIdentity,
  value: unknown,
) {
  const body = confirmReviewRequestSchema.parse(value);
  unique(
    body.items.map((item) => item.criterionId),
    "确认条目",
  );
  return mutateReview(
    db,
    input,
    body,
    "confirm_review",
    async (tx, current, context) => {
      const revision = await nextRevision(
        tx,
        current,
        input.actorId,
        "confirmation",
      );
      const confirmed = [];
      for (const item of body.items) {
        const confirmation = await confirmCriterion(
          current,
          item.criterionId,
          { confirmedBy: input.actorId, confirmedAt: revision.createdAt },
          context,
        );
        if (confirmation.contentHash !== item.contentHash)
          fail("CONTENT_HASH_CONFLICT", "条目内容已经变化，请重新读取后确认");
        confirmed.push(confirmation);
      }
      revision.confirmations = [
        ...current.confirmations.filter(
          (item) =>
            !body.items.some(
              (requested) => requested.criterionId === item.criterionId,
            ),
        ),
        ...confirmed,
      ];
      return revision;
    },
  );
}
export async function adoptReviewV2(
  db: DB,
  input: MutationIdentity,
  value: unknown,
) {
  const body = adoptReviewRequestSchema.parse(value);
  unique(body.criterionIds, "采纳条目");
  return mutateReview(db, input, body, "adopt_review", async (tx, current) => {
    const candidate = (
      await tx.query(
        `SELECT candidate FROM analysis_attempts WHERE id=$1 AND run_id=$2
      AND base_manifest_id=$3 AND status='succeeded' AND candidate IS NOT NULL`,
        [body.candidateId, current.runId, current.baseManifestId],
      )
    ).rows[0];
    if (!candidate)
      fail(
        "CANDIDATE_NOT_AVAILABLE",
        "模型候选不存在或不属于本次基础结果",
        404,
      );
    const draft = modelFeedbackDraftSchema.parse(candidate.candidate);
    if (
      body.criterionIds.some(
        (id) =>
          !current.feedback.some((item) => item.criterionId === id) ||
          !draft.feedback.some((item) => item.criterionId === id),
      )
    )
      fail("CANDIDATE_CRITERION_MISSING", "候选没有包含所选反馈条目", 400);
    const revision = await nextRevision(
      tx,
      current,
      input.actorId,
      "model_adoption",
    );
    revision.feedback = current.feedback.map((item) =>
      body.criterionIds.includes(item.criterionId)
        ? draft.feedback.find(
            (entry) => entry.criterionId === item.criterionId,
          )!
        : item,
    );
    if (body.selectedSupplementalManifestIds)
      revision.selectedSupplementalManifestIds =
        body.selectedSupplementalManifestIds;
    else {
      const referenced=draft.feedback.filter(item=>body.criterionIds.includes(item.criterionId))
        .flatMap(item=>[...item.observationEvidenceRefs,...item.causeEvidenceRefs])
        .filter(ref=>ref.scope==="current" && ref.manifestId!==current.baseManifestId).map(ref=>ref.manifestId);
      revision.selectedSupplementalManifestIds=[...new Set([...current.selectedSupplementalManifestIds,...referenced])];
    }
    return revision;
  });
}

async function readable(evidence: Evidence, reader?: EvidenceReader) {
  if (!reader) fail("EVIDENCE_STORAGE_UNAVAILABLE", "证据存储尚未接入", 503);
  let bytes: Uint8Array;
  try {
    bytes = await reader(evidence);
  } catch {
    fail("EVIDENCE_UNREADABLE", "证据当前不可读，暂不能发布或查看", 503);
  }
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength !== evidence.byteSize ||
    (await sha256(bytes)) !== evidence.sha256
  )
    fail("EVIDENCE_INTEGRITY_FAILED", "证据字节与封存清单不一致", 503);
  return bytes;
}
export async function publishReportV2(
  db: DB,
  input: MutationIdentity,
  value: unknown,
  evidenceReader?: EvidenceReader,
) {
  const body = publishRequestSchema.parse(value);
  unique(body.publicEvidenceIds, "公开证据");
  const identity = requestIdentity(input, "publish_report", body),
    requestHash = await identity.hash;
  return db.transaction(async (tx) => {
    const run = await lockedRun(tx, input);
    const prior = (
      await tx.query(
        "SELECT * FROM publications WHERE run_id=$1 AND idempotency_key=$2",
        [run.id, identity.key],
      )
    ).rows[0];
    if (prior) {
      if (prior.request_hash !== requestHash)
        fail("IDEMPOTENCY_CONFLICT", "幂等键请求内容已变化");
      return {
        contractVersion: 2 as const,
        publication: await publicationOf(prior),
        replayed: true,
      };
    }
    const context = await contextFor(tx, run);
    const revision = expectCurrent(
      await latestRevision(tx, run.id),
      body.expectedRevisionId,
    );
    const previous = await latestPublication(tx, run.id);
    if (body.purpose === "latest") {
      if (
        previous ||
        revision.originPublicationId ||
        body.expectedLatestPublicationId ||
        body.correctionReason
      )
        fail("CORRECTION_REQUIRED", "已有发布须走带来源和理由的更正链");
      const newestSubmission = (
        await tx.query(
          `SELECT id FROM submissions WHERE task_id=$1 AND user_id=$2 AND contract_version=2
        ORDER BY created_at DESC,id DESC LIMIT 1`,
          [run.task_id, run.user_id],
        )
      ).rows[0];
      if (newestSubmission?.id !== run.submission_id)
        fail("STALE_SUBMISSION", "学生已有新提交，本次不能作为当前报告发布");
      const newestRun = (
        await tx.query(
          "SELECT id FROM runs WHERE submission_id=$1 AND contract_version=2 ORDER BY created_at DESC,id DESC LIMIT 1",
          [run.submission_id],
        )
      ).rows[0];
      if (newestRun?.id !== run.id)
        fail("STALE_RUN", "该提交已有更新运行，请复核最新运行");
    } else if (
      !previous ||
      previous.id !== body.expectedLatestPublicationId ||
      revision.originPublicationId !== previous.id ||
      !body.correctionReason
    ) {
      fail(
        "CORRECTION_ORIGIN_CONFLICT",
        "更正必须来自该运行的最新发布，并填写更正理由",
      );
    }
    const snapshot = await createPublicationSnapshot(
      revision,
      context,
      body.publicEvidenceIds,
    );
    const selected = [
      context.baseManifest,
      ...context.supplementalManifests.filter((manifest) =>
        revision.selectedSupplementalManifestIds.includes(manifest.manifestId),
      ),
    ];
    for (const evidence of selected.flatMap((manifest) => manifest.evidence))
      await readable(evidence, evidenceReader);
    const publication = (
      await tx.query(
        `INSERT INTO publications(id,run_id,publication_no,revision_id,supersedes_publication_id,purpose,
      correction_reason,snapshot,public_evidence_ids,published_by,published_at,idempotency_key,request_hash)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,clock_timestamp(),$11,$12) RETURNING *`,
        [
          randomUUID(),
          run.id,
          (previous?.publication_no ?? 0) + 1,
          revision.revisionId,
          previous?.id ?? null,
          body.purpose,
          body.correctionReason ?? null,
          JSON.stringify(snapshot),
          JSON.stringify(body.publicEvidenceIds),
          input.actorId,
          identity.key,
          requestHash,
        ],
      )
    ).rows[0];
    return {
      contractVersion: 2 as const,
      publication: await publicationOf(publication),
      replayed: false,
    };
  });
}
export async function createCorrectionV2(
  db: DB,
  input: { publicationId: string; actorId: string; idempotencyKey: string },
  value: unknown,
) {
  const body = correctionRequestSchema.parse(value);
  const publication = (
    await db.query("SELECT run_id FROM publications WHERE id=$1", [
      input.publicationId,
    ])
  ).rows[0];
  if (!publication) fail("NOT_FOUND", "已发布报告不存在", 404);
  const identityInput = { ...input, runId: publication.run_id };
  const identity = requestIdentity(identityInput, "create_correction", {
      publicationId: input.publicationId,
      ...body,
    }),
    requestHash = await identity.hash;
  return db.transaction(async (tx) => {
    const run = await lockedRun(tx, identityInput);
    const context = await contextFor(tx, run);
    const replay = (
      await tx.query(
        "SELECT * FROM report_revisions WHERE run_id=$1 AND idempotency_key=$2",
        [run.id, identity.key],
      )
    ).rows[0];
    if (replay) {
      if (replay.request_hash !== requestHash)
        fail("IDEMPOTENCY_CONFLICT", "幂等键请求内容已变化");
      return {
        ...(await reviewDto(tx, run, context, revisionOf(replay))),
        replayed: true,
      };
    }
    const current = expectCurrent(
      await latestRevision(tx, run.id),
      body.expectedRevisionId,
    );
    const previous = await latestPublication(tx, run.id);
    if (
      !previous ||
      previous.id !== input.publicationId ||
      previous.id !== body.expectedLatestPublicationId
    )
      fail("CORRECTION_ORIGIN_CONFLICT", "只能从该运行的最新发布创建更正");
    if (current.originPublicationId === previous.id)
      fail(
        "CORRECTION_ALREADY_STARTED",
        "已有基于该发布的更正草稿，请继续复核当前修订",
      );
    const revision = await nextRevision(
      tx,
      current,
      input.actorId,
      "historical_correction",
    );
    const sourceRevision = (await publicationOf(previous)).snapshot.revision;
    revision.feedback = sourceRevision.feedback;
    revision.teacherJudgments = sourceRevision.teacherJudgments;
    revision.selectedSupplementalManifestIds =
      sourceRevision.selectedSupplementalManifestIds;
    revision.confirmations = [];
    revision.originPublicationId = previous.id;
    await appendRevision(tx, revision, context, identity.key, requestHash);
    await tx.query(
      "INSERT INTO events(run_id,kind,payload) VALUES($1,'v2_correction_started',$2)",
      [
        run.id,
        JSON.stringify({
          revisionId: revision.revisionId,
          originPublicationId: previous.id,
          correctionReason: body.correctionReason,
          actorId: input.actorId,
        }),
      ],
    );
    return {
      ...(await reviewDto(tx, run, context, revision)),
      replayed: false,
    };
  });
}
async function publicationAccess(
  db: DB,
  publicationId: string,
  actorId: string,
) {
  const row = (
    await db.query("SELECT * FROM publications WHERE id=$1", [publicationId])
  ).rows[0];
  if (!row) fail("NOT_FOUND", "已发布报告不存在", 404);
  await runAccess(db, { runId: row.run_id, actorId }, false);
  return row;
}
export async function getPublicationV2(
  db: DB,
  input: { publicationId: string; actorId: string },
) {
  const row = await publicationAccess(db, input.publicationId, input.actorId);
  const newer = (
    await db.query(
      "SELECT id FROM publications WHERE supersedes_publication_id=$1",
      [row.id],
    )
  ).rows[0];
  return {
    contractVersion: 2 as const,
    publication: await publicationOf(row),
    supersededByPublicationId: newer?.id ?? null,
  };
}

/** Compare only immutable, authorized publications. Draft revisions never enter this DTO. */
export async function getPublicationComparisonOptionsV2(
  db: DB, input: {publicationId: string; actorId: string; after?: string},
) {
  const publication = await publicationAccess(db, input.publicationId, input.actorId);
  const run = await runAccess(db, {runId: publication.run_id, actorId: input.actorId}, false);
  if (input.after) {
    const cursor = await publicationAccess(db, input.after, input.actorId);
    const scope = await runAccess(db, {runId: cursor.run_id, actorId: input.actorId}, false);
    if (scope.task_id !== run.task_id || scope.user_id !== run.user_id || cursor.id === publication.id)
      fail('INVALID_CURSOR', '版本游标不属于此比较范围', 400);
  }
  const rows = (await db.query(`SELECT p.id,p.publication_no,p.revision_id,p.purpose,p.published_at,
    p.supersedes_publication_id,s.id AS submission_id,s.created_at AS submitted_at
    FROM publications p JOIN runs r ON r.id=p.run_id JOIN submissions s ON s.id=r.submission_id
    WHERE s.task_id=$1 AND s.user_id=$2 AND r.contract_version=2 AND s.contract_version=2 AND p.id<>$3
    AND ($4::uuid IS NULL OR (p.published_at,p.id)<(SELECT published_at,id FROM publications WHERE id=$4))
    ORDER BY p.published_at DESC,p.id DESC LIMIT 51`,
    [run.task_id,run.user_id,publication.id,input.after ?? null])).rows;
  return {items: rows.slice(0,50).map(row=>({...publicationSummary(row),submissionId:row.submission_id,submittedAt:iso(row.submitted_at)})),
    nextCursor: rows.length>50 ? rows[49].id : null};
}

export async function getPublicationComparisonV2(
  db: DB,
  input: { publicationId: string; beforePublicationId: string; actorId: string },
) {
  const afterRow = await publicationAccess(db, input.publicationId, input.actorId);
  const beforeRow = await publicationAccess(db, input.beforePublicationId, input.actorId);
  const afterRun = await runAccess(db, {runId: afterRow.run_id, actorId: input.actorId}, false);
  const beforeRun = await runAccess(db, {runId: beforeRow.run_id, actorId: input.actorId}, false);
  if (beforeRun.task_id !== afterRun.task_id || beforeRun.user_id !== afterRun.user_id)
    fail('COMPARISON_SCOPE_MISMATCH', '请选择同一学生、同一任务的两份已发布报告', 400);
  if (beforeRow.id === afterRow.id)
    fail('COMPARISON_SAME_PUBLICATION', '请选择不同的发布版本', 400);
  const before = await publicationOf(beforeRow), after = await publicationOf(afterRow);
  async function archived(publication: Publication, run: Row) {
    const snapshot = publication.snapshot;
    const owner = (await db.query(
      'SELECT base_manifest,actual_fingerprint FROM execution_attempts WHERE id=$1 AND run_id=$2 AND base_sealed_at IS NOT NULL',
      [snapshot.baseContext.executionAttemptId, publication.runId],
    )).rows[0];
    // Historical snapshots predate embedded measurements. Bind the sealed measurement to
    // the exact archived context, never to whichever execution is currently accepted.
    const bound = owner && canonicalJson(owner.base_manifest?.context) === canonicalJson(snapshot.baseContext);
    return {
      contractVersion: 2 as const, studentId: run.user_id, taskId: run.task_id,
      ruleId: snapshot.ruleSnapshot.ruleId,
      actualFingerprint: bound && owner.actual_fingerprint ? owner.actual_fingerprint : {
        completeness: 'unknown', values: {}, missingFields: MEASUREMENT_FIELDS,
      },
      caseResults: snapshot.baseResults,
    };
  }
  const automatic = compareCaseResults(await archived(before, beforeRun), await archived(after, afterRun));
  const criterionIds = [...new Set([
    ...before.snapshot.revision.feedback.map(item => item.criterionId),
    ...after.snapshot.revision.feedback.map(item => item.criterionId),
  ])];
  return {
    contractVersion: 2 as const,
    before: publicationSummary(beforeRow), after: publicationSummary(afterRow),
    sameSubmission: beforeRun.submission_id === afterRun.submission_id,
    // Do not expose internal environment values in a student-facing response.
    automatic: {status: automatic.status, caseDiffs: automatic.caseDiffs,
      ...('reasonCode' in automatic ? {reasonCode: automatic.reasonCode} : {})},
    teacherJudgments: compareTeacherJudgments(before.snapshot.revision, after.snapshot.revision),
    feedback: criterionIds.map(criterionId => {
      const a = before.snapshot.revision.feedback.find(item => item.criterionId === criterionId) ?? null;
      const b = after.snapshot.revision.feedback.find(item => item.criterionId === criterionId) ?? null;
      return {criterionId, before: a, after: b, changed: canonicalJson(a) !== canonicalJson(b)};
    }),
  };
}
export async function readPublicationEvidenceV2(
  db: DB,
  input: { publicationId: string; evidenceId: string; actorId: string },
  reader?: EvidenceReader,
) {
  const row = await publicationAccess(db, input.publicationId, input.actorId);
  const publication = await publicationOf(row);
  const evidence = publication.publicEvidenceIds.includes(input.evidenceId)
    ? publication.snapshot.publicEvidence.find(
        (item) => item.evidenceId === input.evidenceId,
      )
    : undefined;
  if (!evidence) fail("NOT_FOUND", "公开证据不存在", 404);
  return { evidence, bytes: await readable(evidence, reader) };
}
export async function readReviewEvidenceV2(
  db: DB,
  input: Identity & { evidenceId: string },
  reader?: EvidenceReader,
) {
  const run = await runAccess(db, input);
  const context = await contextFor(db, run);
  const evidence = [context.baseManifest, ...context.supplementalManifests]
    .flatMap((manifest) => manifest.evidence)
    .find((item) => item.evidenceId === input.evidenceId);
  if (!evidence) fail("NOT_FOUND", "复核证据不存在", 404);
  return { evidence, bytes: await readable(evidence, reader) };
}
