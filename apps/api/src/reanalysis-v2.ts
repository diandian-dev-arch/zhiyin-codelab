import { randomUUID } from "node:crypto";
import { z } from "zod";
import { canonicalJson, sha256, uuidSchema } from "@codelab/contracts/v2";
import type { DB } from "./db.js";
import { freezeCourseModel } from './course-model-v2.js';
import type { SourceProviderResolver } from './user-model-settings.js';
import { admitReservedStorageV2 } from './storage-reservations-v2.js';
import type { StorageAdmission } from '../../runner/src/storage-admission.js';
import {
  LifecycleError,
  lockQueue,
  lockStudentTask,
  QUEUE_LIMIT,
  type OwnerIdentity,
} from "./lifecycle-v2.js";
import { analysisContextV2 } from "./reports-v2.js";
import { ANALYSIS_LIMITS_V2 } from "./analysis-operations-v2.js";
import type { SummaryProviderV2 } from "./model-provider-v2.js";
import { providerConfigurationV2, sealedAnalysisInputHashV2 } from './analysis-input-v2.js';

const requestSchema = z.object({
  expectedRevisionId: uuidSchema,
  strategy: z.enum(['summary', 'agent']).optional(),
  pairedWithAnalysisId: uuidSchema.optional(),
}).strict();
const keySchema = z.string().regex(/^[a-zA-Z0-9_-]{8,100}$/);
async function teacherRun(tx: DB, runId: string, actorId: string) {
  uuidSchema.parse(runId);
  uuidSchema.parse(actorId);
  const row = (
    await tx.query(
      `SELECT r.id,s.task_id,s.user_id FROM runs r
    JOIN submissions s ON s.id=r.submission_id JOIN tasks t ON t.id=s.task_id
    JOIN classes c ON c.id=t.class_id JOIN users u ON u.id=c.teacher_id
    WHERE r.id=$1 AND r.contract_version=2 AND c.teacher_id=$2 AND u.role='teacher'`,
      [runId, actorId],
    )
  ).rows[0];
  if (!row) throw new LifecycleError("NOT_FOUND", "运行不存在", 404);
  return row;
}
export function analysisRequestSummaryV2(row: Record<string, any>) {
  return {
    analysisAttemptId: row.id,
    runId: row.run_id,
    mode: row.mode,
    status: row.status,
    baseManifestId: row.base_manifest_id,
    selectedAtStartRevisionId: row.selected_at_start_revision_id,
    cleanupState: row.cleanup_state,
    strategy: row.configuration?.strategy ?? 'agent',
    pairedWithAnalysisId: row.configuration?.pairedWithAnalysisId ?? null,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

/** Explicit teacher request; a repeated HTTP request never allocates a second budget. */
export async function enqueueReanalysisV2(
  db: DB,
  input: {
    runId: string;
    actorId: string;
    idempotencyKey: string;
    body: unknown;
    configuration?: SummaryProviderV2["configuration"];
    personalModels?: SourceProviderResolver;
    storageAdmission?: StorageAdmission;
  },
) {
  const body = requestSchema.parse(input.body),
    key = keySchema.parse(input.idempotencyKey);
  const requestHash = await sha256(canonicalJson(body));
  return db.transaction(async (tx) => {
    const run = await teacherRun(tx, input.runId, input.actorId);
    await lockStudentTask(tx, run.task_id, run.user_id);
    await lockQueue(tx);
    const prior = (
      await tx.query(
        `SELECT * FROM analysis_attempts WHERE run_id=$1 AND requested_by=$2 AND idempotency_key=$3`,
        [input.runId, input.actorId, key],
      )
    ).rows[0];
    if (prior) {
      if (prior.request_hash !== requestHash)
        throw new LifecycleError(
          "IDEMPOTENCY_CONFLICT",
          "同一请求的内容已变化",
        );
      return { analysis: analysisRequestSummaryV2(prior), replayed: true };
    }
    await admitReservedStorageV2(tx, input.storageAdmission, true);
    const personal = input.personalModels ? await freezeCourseModel(tx, input.personalModels, input.actorId) : undefined;
    const modelConfiguration = personal?.configuration ?? (input.personalModels ? undefined : input.configuration);
    if (!modelConfiguration)
      throw new LifecycleError(
        "MODEL_NOT_CONFIGURED",
        "模型尚未配置，基础报告仍可复核与发布",
        503,
      );
    const { context, revision } = await analysisContextV2(tx, input.runId);
    if (revision.revisionId !== body.expectedRevisionId)
      throw new LifecycleError(
        "REVISION_CONFLICT",
        "报告已更新，请刷新后重新分析",
      );
    if (
      (
        await tx.query(
          "SELECT id FROM analysis_attempts WHERE run_id=$1 AND status IN ('queued','running')",
          [input.runId],
        )
      ).rows.length
    )
      throw new LifecycleError("ANALYSIS_ACTIVE", "已有分析排队或执行中");
    const waiting = Number(
      (
        await tx.query(`SELECT (SELECT count(*) FROM runs WHERE status='queued') +
      (SELECT count(*) FROM analysis_attempts WHERE mode='reanalysis' AND status='queued') AS total`)
      ).rows[0].total,
    );
    if (waiting >= QUEUE_LIMIT)
      throw new LifecycleError("QUEUE_FULL", "等待队列已满，当前报告保留", 429);
    const id = randomUUID();
    const strategy = body.strategy ?? 'agent';
    const baseInputHash = await sealedAnalysisInputHashV2(context);
    if (body.pairedWithAnalysisId) {
      const previous = (await tx.query(
        "SELECT * FROM analysis_attempts WHERE id=$1 AND run_id=$2 AND mode='reanalysis'",
        [body.pairedWithAnalysisId, input.runId],
      )).rows[0];
      if (!previous || !['succeeded', 'degraded', 'interrupted', 'cancelled'].includes(previous.status)
        || !['summary', 'agent'].includes(previous.configuration.strategy)
        || previous.configuration.strategy === strategy
        || previous.configuration.baseInputHash !== baseInputHash
        || canonicalJson(providerConfigurationV2(previous.configuration)) !== canonicalJson(providerConfigurationV2(modelConfiguration)))
        throw new LifecycleError('ANALYSIS_PAIR_INCOMPATIBLE', '对照分析必须使用同一封存材料、相同模型配置和不同分析方式');
    }
    // Only server-selected non-secret provider metadata may enter this record.
    const configuration = {
      ...providerConfigurationV2(modelConfiguration),
      ...(personal ? { billingUserId: personal.billingUserId } : {}),
      strategy,
      baseInputHash,
      ...(body.pairedWithAnalysisId ? { pairedWithAnalysisId: body.pairedWithAnalysisId } : {}),
      checkpointId: id,
      promptVersion: MODEL_FEEDBACK_PROMPT_VERSIONS[strategy],
    };
    const row = (
      await tx.query(
        `INSERT INTO analysis_attempts(id,run_id,base_manifest_id,mode,status,configuration,budget,
      selected_at_start_revision_id,requested_by,idempotency_key,request_hash,created_at)
      VALUES($1,$2,$3,'reanalysis','queued',$4,$5,$6,$7,$8,$9,clock_timestamp()) RETURNING *`,
        [
          id,
          input.runId,
          context.baseManifest.manifestId,
          JSON.stringify(configuration),
          JSON.stringify(strategy === 'summary' ? { ...ANALYSIS_LIMITS_V2, modelCalls: 1, toolCalls: 0, probes: 0, formatRepairs: 0 } : ANALYSIS_LIMITS_V2),
          revision.revisionId,
          input.actorId,
          key,
          requestHash,
        ],
      )
    ).rows[0];
    return { analysis: analysisRequestSummaryV2(row), replayed: false };
  });
}

/** Cancellation fences future writes immediately; an acquired owner still occupies its slot until cleanup. */
export async function cancelReanalysisV2(
  db: DB,
  input: { runId: string; actorId: string; analysisAttemptId: string },
) {
  uuidSchema.parse(input.analysisAttemptId);
  return db.transaction(async (tx) => {
    const run = await teacherRun(tx, input.runId, input.actorId);
    await lockStudentTask(tx, run.task_id, run.user_id);
    await lockQueue(tx);
    const row = (
      await tx.query(
        "SELECT * FROM analysis_attempts WHERE id=$1 AND run_id=$2 AND mode='reanalysis' FOR UPDATE",
        [input.analysisAttemptId, input.runId],
      )
    ).rows[0];
    if (!row) throw new LifecycleError("NOT_FOUND", "分析不存在", 404);
    if (row.status === "cancelled") return analysisRequestSummaryV2(row);
    if (!["queued", "running"].includes(row.status))
      throw new LifecycleError("ANALYSIS_FINISHED", "分析已经结束");
    const cancelled = (
      await tx.query(
        `UPDATE analysis_attempts SET status='cancelled',finished_at=clock_timestamp(),
      usage=jsonb_set(usage,'{code}','"ANALYSIS_CANCELLED"') WHERE id=$1 RETURNING *`,
        [row.id],
      )
    ).rows[0];
    await tx.query(
      `UPDATE analysis_operations SET state=CASE WHEN state='sent' THEN 'unknown' ELSE 'failed' END,
      error='{"code":"ANALYSIS_CANCELLED"}',finished_at=clock_timestamp()
      WHERE analysis_attempt_id=$1 AND state IN ('reserved','sent')`,
      [row.id],
    );
    return analysisRequestSummaryV2(cancelled);
  });
}

/** Start from the exact saved base and selected revision; never adopt a candidate implicitly. */
export async function beginReanalysisV2(db: DB, owner: OwnerIdentity) {
  if (owner.kind !== "reanalysis")
    throw new LifecycleError("OWNER_LOST", "重新分析需要独立所有者");
  return db.transaction(async (tx) => {
    await lockQueue(tx);
    const row = (
      await tx.query(
        `SELECT *,lease_until>clock_timestamp() AND work_deadline_at>clock_timestamp() AS valid,
      clock_timestamp() AS db_now FROM analysis_attempts WHERE id=$1 FOR UPDATE`,
        [owner.id],
      )
    ).rows[0];
    if (
      !row ||
      row.mode !== "reanalysis" ||
      row.status !== "running" ||
      row.owner_phase !== "preparing" ||
      row.lease_token !== owner.token ||
      !row.valid
    )
      throw new LifecycleError("OWNER_LOST", "分析所有权或期限已失效");
    const { context, revision } = await analysisContextV2(tx, row.run_id);
    if (context.baseManifest.manifestId !== row.base_manifest_id)
      throw new Error("ANALYSIS_BASE_CHANGED");
    if (row.configuration.baseInputHash && row.configuration.baseInputHash !== await sealedAnalysisInputHashV2(context))
      throw new Error('ANALYSIS_BASE_CHANGED');
    await tx.query(
      `UPDATE analysis_attempts SET owner_phase='analyzing',deadlines=jsonb_set(deadlines,'{analysisDeadlineAt}',to_jsonb(work_deadline_at)) WHERE id=$1`,
      [row.id],
    );
    return {
      analysis: row,
      context,
      revision,
      deadline: new Date(row.work_deadline_at).getTime(),
    };
  });
}

/** Terminalize only the acquired attempt; cancelled/succeeded attempts are never reopened. */
export async function stopReanalysisV2(
  db: DB,
  owner: OwnerIdentity,
  code: string,
  status: "interrupted" | "degraded" = "interrupted",
) {
  if (owner.kind !== "reanalysis")
    throw new LifecycleError("OWNER_LOST", "重新分析需要独立所有者");
  return db.transaction(async (tx) => {
    await lockQueue(tx);
    const row = (
      await tx.query(
        `SELECT *,lease_until>clock_timestamp() AND hard_deadline_at>clock_timestamp() AS valid
      FROM analysis_attempts WHERE id=$1 FOR UPDATE`,
        [owner.id],
      )
    ).rows[0];
    if (
      !row ||
      row.mode !== "reanalysis" ||
      row.lease_token !== owner.token ||
      !row.valid ||
      !["preparing", "analyzing"].includes(row.owner_phase)
    )
      throw new LifecycleError("OWNER_LOST", "分析所有权已失效");
    if (row.status !== "running") return;
    await tx.query(
      "UPDATE analysis_attempts SET status=$2,usage=$3,finished_at=clock_timestamp() WHERE id=$1",
      [
        row.id,
        status,
        JSON.stringify({ code, cost: null, costStatus: "unknown_pricing" }),
      ],
    );
    await tx.query(
      `UPDATE analysis_operations SET state=CASE WHEN state='sent' THEN 'unknown' ELSE 'failed' END,
      error=$2,finished_at=clock_timestamp() WHERE analysis_attempt_id=$1 AND state IN ('reserved','sent')`,
      [row.id, JSON.stringify({ code })],
    );
  });
}
import { MODEL_FEEDBACK_PROMPT_VERSIONS } from './model-feedback-v2.js';
