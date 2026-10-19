import { z } from "zod";
import {
  canonicalJson,
  sha256,
  uuidSchema,
  validateArtifactManifest,
  type ArtifactManifest,
} from "@codelab/contracts/v2";
import type { DB } from "./db.js";
import {
  lockQueue,
  LifecycleError,
  type OwnerIdentity,
} from "./lifecycle-v2.js";
import { analysisContextV2 } from "./reports-v2.js";

export async function assertInitialAnalysisParentV2(
  tx: DB,
  owner: OwnerIdentity,
) {
  if (owner.kind !== "execution")
    throw new LifecycleError("OWNER_LOST", "初次分析需要执行所有者");
  await lockQueue(tx);
  const row = (
    await tx.query(
      `SELECT *,lease_until>clock_timestamp() AND pipeline_deadline_at>clock_timestamp() AS valid,
    clock_timestamp() AS db_now FROM execution_attempts WHERE id=$1 FOR UPDATE`,
      [owner.id],
    )
  ).rows[0];
  if (
    !row ||
    row.lease_token !== owner.token ||
    !row.valid ||
    row.owner_phase !== "initial_analysis" ||
    !row.base_sealed_at
  )
    throw new LifecycleError("OWNER_LOST", "分析所有权已失效");
  return row;
}

/** Independent attempts use their own lease and absolute 60s work / 90s hard deadline. */
export async function assertAnalysisOwnerV2(tx: DB, owner: OwnerIdentity) {
  if (owner.kind === "execution")
    return assertInitialAnalysisParentV2(tx, owner);
  await lockQueue(tx);
  const row = (
    await tx.query(
      `SELECT *,lease_until>clock_timestamp() AND hard_deadline_at>clock_timestamp() AS valid,
    clock_timestamp() AS db_now FROM analysis_attempts WHERE id=$1 FOR UPDATE`,
      [owner.id],
    )
  ).rows[0];
  if (
    !row ||
    row.mode !== "reanalysis" ||
    row.status !== "running" ||
    row.owner_phase !== "analyzing" ||
    row.lease_token !== owner.token ||
    !row.valid
  )
    throw new LifecycleError("OWNER_LOST", "分析所有权已失效");
  return { ...row, pipeline_deadline_at: row.hard_deadline_at };
}

export const ANALYSIS_LIMITS_V2 = Object.freeze({
  modelCalls: 4,
  toolCalls: 6,
  probes: 1,
  formatRepairs: 1,
  inputTokenUpperBound: 32000,
  outputTokens: 6000,
});
const budgetSchema = z
  .object({
    modelCalls: z.number().int().min(0).max(1).default(0),
    toolCalls: z.number().int().min(0).max(1).default(0),
    probes: z.number().int().min(0).max(1).default(0),
    formatRepairs: z.number().int().min(0).max(1).default(0),
    inputTokenUpperBound: z.number().int().min(0).max(32000).default(0),
    outputTokens: z.number().int().min(0).max(6000).default(0),
  })
  .strict();
export type AnalysisReservationV2 = z.input<typeof budgetSchema>;
export interface AnalysisOperationIdentityV2 {
  db: DB;
  owner: OwnerIdentity;
  analysisAttemptId: string;
  operationId: string;
}

async function analysisGuard(tx: DB, input: AnalysisOperationIdentityV2) {
  uuidSchema.parse(input.analysisAttemptId);
  uuidSchema.parse(input.operationId);
  const execution = await assertAnalysisOwnerV2(tx, input.owner);
  const analysis = (
    await tx.query("SELECT * FROM analysis_attempts WHERE id=$1 FOR UPDATE", [
      input.analysisAttemptId,
    ])
  ).rows[0];
  const bound =
    analysis &&
    (input.owner.kind === "execution"
      ? analysis.mode === "initial" &&
        analysis.owner_execution_attempt_id === input.owner.id
      : analysis.mode === "reanalysis" && analysis.id === input.owner.id);
  if (
    !analysis ||
    analysis.status !== "running" ||
    !bound ||
    analysis.run_id !== execution.run_id
  )
    throw new LifecycleError("ANALYSIS_OWNER_LOST", "分析已结束或归属不一致");
  const deadline = Math.min(
    Date.parse(analysis.deadlines.analysisDeadlineAt),
    new Date(execution.work_deadline_at).getTime(),
  );
  if (
    !Number.isFinite(deadline) ||
    new Date(execution.db_now).getTime() >= deadline
  )
    throw new LifecycleError("ANALYSIS_DEADLINE", "分析期限已到");
  return { analysis, execution, deadline };
}

/** Counts failures and uncertain work, and refunds tokens only with known completed usage. */
export async function reserveAnalysisOperationV2(
  input: AnalysisOperationIdentityV2 & {
    kind: string;
    request: unknown;
    budget: AnalysisReservationV2;
  },
) {
  const budget = budgetSchema.parse(input.budget);
  const model =
    input.kind === "model_summary" ||
    input.kind === "model_agent" ||
    input.kind === "model_repair";
  const tool = [
    "read_check_result",
    "read_source_excerpt",
    "read_console_evidence",
    "inspect_page_evidence",
    "run_probe",
    "compare_submission",
  ].includes(input.kind);
  if (
    (!model && !tool) ||
    budget.modelCalls !== Number(model) ||
    budget.toolCalls !== Number(tool) ||
    budget.probes !== Number(input.kind === "run_probe") ||
    budget.formatRepairs !== Number(input.kind === "model_repair")
  )
    throw new Error("ANALYSIS_RESERVATION_INVALID");
  const requestHash = await sha256(
    canonicalJson({ kind: input.kind, request: input.request, budget }),
  );
  return input.db.transaction(async (tx) => {
    const guard = await analysisGuard(tx, input);
    if (guard.analysis.configuration.strategy === 'summary' && input.kind !== 'model_summary')
      throw new LifecycleError('ANALYSIS_STRATEGY_MISMATCH', '一次性总结不允许工具、调查或格式重试');
    const prior = (
      await tx.query(
        "SELECT * FROM analysis_operations WHERE analysis_attempt_id=$1 AND operation_id=$2",
        [input.analysisAttemptId, input.operationId],
      )
    ).rows[0];
    if (prior) {
      if (prior.request_hash !== requestHash)
        throw new LifecycleError(
          "OPERATION_PAYLOAD_CONFLICT",
          "操作内容发生变化",
        );
      return { created: false, operation: prior, deadline: guard.deadline };
    }
    const previous = (
      await tx.query(
        "SELECT kind,reserved_budget,actual_usage,state FROM analysis_operations WHERE analysis_attempt_id=$1",
        [input.analysisAttemptId],
      )
    ).rows;
    const totals = { ...budget };
    for (const op of previous) {
      for (const key of Object.keys(
        ANALYSIS_LIMITS_V2,
      ) as (keyof typeof ANALYSIS_LIMITS_V2)[]) {
        let amount = op.reserved_budget[key] ?? 0;
        const actual =
          op.actual_usage?.tokens?.[
            key === "inputTokenUpperBound" ? "inputTokens" : "outputTokens"
          ];
        if (
          op.state === "completed" &&
          op.kind.startsWith("model_") &&
          ["inputTokenUpperBound", "outputTokens"].includes(key) &&
          Number.isSafeInteger(actual) &&
          actual >= 0
        )
          amount = actual;
        if (!Number.isSafeInteger(amount) || amount < 0)
          throw new Error("ANALYSIS_BUDGET_CORRUPT");
        totals[key] += amount;
      }
    }
    if (
      (Object.keys(totals) as (keyof typeof totals)[]).some(
        (key) => totals[key] > (guard.analysis.configuration.strategy === 'summary'
          ? Math.min(ANALYSIS_LIMITS_V2[key], guard.analysis.budget[key] ?? ANALYSIS_LIMITS_V2[key])
          : ANALYSIS_LIMITS_V2[key]),
      )
    )
      throw new LifecycleError(
        "ANALYSIS_BUDGET_EXCEEDED",
        "本次分析预算已用尽",
      );
    const operation = (
      await tx.query(
        `INSERT INTO analysis_operations(analysis_attempt_id,operation_id,kind,request_hash,state,reserved_budget)
      VALUES($1,$2,$3,$4,'reserved',$5) RETURNING *`,
        [
          input.analysisAttemptId,
          input.operationId,
          input.kind,
          requestHash,
          JSON.stringify(budget),
        ],
      )
    ).rows[0];
    await tx.query(
      "INSERT INTO analysis_private_io(analysis_attempt_id,operation_id,input) VALUES($1,$2,$3)",
      [
        input.analysisAttemptId,
        input.operationId,
        JSON.stringify(input.request),
      ],
    );
    return { created: true, operation, deadline: guard.deadline };
  });
}

export async function sendAnalysisOperationV2(
  input: AnalysisOperationIdentityV2,
) {
  return input.db.transaction(async (tx) => {
    await analysisGuard(tx, input);
    const changed = await tx.query(
      "UPDATE analysis_operations SET state='sent' WHERE analysis_attempt_id=$1 AND operation_id=$2 AND state='reserved' RETURNING operation_id",
      [input.analysisAttemptId, input.operationId],
    );
    return changed.rows.length === 1;
  });
}

/** Artifacts must already be durably stored; this publishes only their validated manifest. */
export async function finishAnalysisOperationV2(
  input: AnalysisOperationIdentityV2 & {
    state: "completed" | "failed" | "unknown";
    response?: string;
    errorCode?: string;
    providerRequestId?: string | null;
    usage?: { tokens: { inputTokens: number; outputTokens: number } | null };
    supplementalManifest?: ArtifactManifest;
  },
) {
  return input.db.transaction(async (tx) => {
    const { analysis, execution } = await analysisGuard(tx, input);
    if (input.supplementalManifest) {
      if (input.state !== "completed")
        throw new Error("SUPPLEMENTAL_OPERATION_INCOMPLETE");
      const { context } = await analysisContextV2(tx, execution.run_id);
      const manifest = await validateArtifactManifest(
        input.supplementalManifest,
        { rule: context.rule, expectedContext: context.baseManifest.context },
      );
      if (
        manifest.source !== "supplemental" ||
        manifest.analysisAttemptId !== analysis.id ||
        manifest.operationId !== input.operationId
      )
        throw new Error("SUPPLEMENTAL_OWNER_MISMATCH");
    }
    const changed = await tx.query(
      `UPDATE analysis_operations SET state=$3,actual_usage=$4,response_hash=$5,supplemental_manifest=$6,error=$7,provider_request_id=$8,finished_at=clock_timestamp()
      WHERE analysis_attempt_id=$1 AND operation_id=$2 AND state='sent' RETURNING operation_id`,
      [
        input.analysisAttemptId,
        input.operationId,
        input.state,
        JSON.stringify(input.usage ?? { tokens: null }),
        input.response ? await sha256(input.response) : null,
        input.supplementalManifest
          ? JSON.stringify(input.supplementalManifest)
          : null,
        input.errorCode ? JSON.stringify({ code: input.errorCode }) : null,
        input.providerRequestId ?? null,
      ],
    );
    if (!changed.rows.length) throw new Error("ANALYSIS_OPERATION_NOT_SENT");
    if (input.response !== undefined)
      await tx.query(
        "UPDATE analysis_private_io SET response=$3 WHERE analysis_attempt_id=$1 AND operation_id=$2",
        [input.analysisAttemptId, input.operationId, input.response],
      );
  });
}
