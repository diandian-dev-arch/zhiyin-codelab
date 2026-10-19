import { randomUUID, createHash } from "node:crypto";
import type { DB } from "./db.js";
import { freezeCourseModel, type CourseModelSnapshot } from './course-model-v2.js';
import type { SourceProviderResolver } from './user-model-settings.js';
import { admitReservedStorageV2 } from './storage-reservations-v2.js';
import type { StorageAdmission } from '../../runner/src/storage-admission.js';
import { parseInitialAnalysisModeV2, type InitialAnalysisModeV2 } from './analysis-mode-v2.js';
import {
  createArtifactManifest,
  hashRuleSnapshot,
  unknownMeasuredEnvironment,
  validateRuleSnapshot,
  validateCaseResult,
  validateCaseResults,
  validateArtifactManifest,
  validateCaseEvidenceReferences,
  measuredEnvironmentSchema,
  validateRunResponse,
  measurementFingerprintSchema,
  type ExecutionContext,
  type CaseResult,
  type RunnerOperationContext,
  type MeasurementFingerprint,
  type ArtifactManifest,
  type MeasuredEnvironment,
  canonicalJson,
  runnerCleanupResponseSchema,
  uuidSchema,
  sha256Schema,
} from "@codelab/contracts/v2";

export const QUEUE_LOCK = 41722;
export const QUEUE_LIMIT = 30;
export const HEARTBEAT_MS = 10_000;
export const LEASE_MS = 30_000;
const TERMINAL = [
  "completed",
  "build_error",
  "infra_error",
  "interrupted",
  "cancelled",
];
type OwnerKind = "execution" | "reanalysis";
export type OwnerIdentity = { kind: OwnerKind; id: string; token: string };
export type CleanupReceipt = ReturnType<
  typeof runnerCleanupResponseSchema.parse
>;
export class LifecycleError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode = 409,
  ) {
    super(message);
  }
}
const fail = (code: string, message: string, status = 409): never => {
  throw new LifecycleError(code, message, status);
};
const table = (kind: OwnerKind) =>
  kind === "execution" ? "execution_attempts" : "analysis_attempts";
const hardColumn = (kind: OwnerKind) =>
  kind === "execution" ? "pipeline_deadline_at" : "hard_deadline_at";
const hash = (input: unknown) =>
  createHash("sha256").update(canonicalJson(input)).digest("hex");
const iso = (date: Date, offset = 0) =>
  new Date(date.getTime() + offset).toISOString();
export async function lockQueue(tx: DB) {
  await tx.query("SELECT pg_advisory_xact_lock($1)", [QUEUE_LOCK]);
}
export async function lockStudentTask(
  tx: DB,
  taskId: string,
  studentId: string,
) {
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    `codelab:student-task:${taskId}:${studentId}`,
  ]);
}
async function now(tx: DB): Promise<Date> {
  return new Date(
    (await tx.query("SELECT clock_timestamp() AS time")).rows[0].time,
  );
}
async function waiting(tx: DB) {
  return Number(
    (
      await tx.query(`SELECT
    (SELECT count(*) FROM runs WHERE status='queued') +
    (SELECT count(*) FROM analysis_attempts WHERE mode='reanalysis' AND status='queued') AS total`)
    ).rows[0].total,
  );
}
async function hasOwner(tx: DB) {
  return (
    (
      await tx.query(`SELECT 1 WHERE
    EXISTS(SELECT 1 FROM execution_attempts WHERE owner_phase<>'closed') OR
    EXISTS(SELECT 1 FROM analysis_attempts WHERE mode='reanalysis' AND owner_phase IS NOT NULL AND owner_phase<>'closed') OR
    EXISTS(SELECT 1 FROM runs WHERE contract_version=1 AND status IN ('building','analyzing'))`)
    ).rows.length > 0
  );
}
async function authorizedSubmission(
  tx: DB,
  submissionId: string,
  actorId: string,
) {
  const row = (
    await tx.query(
      `SELECT s.*,c.teacher_id FROM submissions s
    JOIN tasks t ON t.id=s.task_id JOIN classes c ON c.id=t.class_id
    WHERE s.id=$1 AND (c.teacher_id=$2 OR (s.user_id=$2 AND EXISTS(
      SELECT 1 FROM memberships m WHERE m.class_id=c.id AND m.user_id=$2)))`,
      [submissionId, actorId],
    )
  ).rows[0];
  if (!row) fail("NOT_FOUND", "提交不存在", 404);
  if (row.contract_version !== 2)
    fail("CLIENT_UPGRADE_REQUIRED", "历史提交仅供旧协议读取");
  return row;
}
function businessKey(actorId: string, action: string, key: string) {
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(key))
    fail("INVALID_IDEMPOTENCY_KEY", "幂等键格式无效", 400);
  return `${actorId}:${action}:${key}`;
}

/** Authorized caller creates a new immutable execution identity, never reopens a terminal run. */
export async function enqueueRunV2(
  db: DB,
  input: {
    submissionId: string;
    actorId: string;
    idempotencyKey: string;
    executionApproved: boolean;
    storageAdmission?: StorageAdmission;
    initialAnalysisMode?: InitialAnalysisModeV2;
    personalModels?: SourceProviderResolver;
    personalAnalysisMode?: InitialAnalysisModeV2;
    retryOfRunId?: string;
    approvedFingerprint?: MeasurementFingerprint;
  },
) {
  return db.transaction(async (tx) => {
    const submission = await authorizedSubmission(
      tx,
      input.submissionId,
      input.actorId,
    );
    await lockStudentTask(tx, submission.task_id, submission.user_id);
    await lockQueue(tx);
    const key = businessKey(input.actorId, "create_run", input.idempotencyKey);
    const requestHash = hash({
      submissionId: input.submissionId,
      retryOfRunId: input.retryOfRunId ?? null,
      ...(input.personalAnalysisMode === undefined ? {} : { personalAnalysisMode: input.personalAnalysisMode }),
    });
    const replay = (
      await tx.query(
        "SELECT * FROM runs WHERE submission_id=$1 AND idempotency_key=$2",
        [input.submissionId, key],
      )
    ).rows[0];
    if (replay) {
      if (replay.request_hash !== requestHash)
        fail("IDEMPOTENCY_CONFLICT", "幂等键的请求内容已变化");
      return { run: replay, replayed: true };
    }
    if (!input.executionApproved)
      fail("EXECUTION_DISABLED", "提交已保存，真实执行入口尚未启用", 503);
    await admitReservedStorageV2(tx, input.storageAdmission, true);
    if (input.retryOfRunId) {
      const prior = (
        await tx.query(
          "SELECT status FROM runs WHERE id=$1 AND submission_id=$2 AND contract_version=2",
          [input.retryOfRunId, input.submissionId],
        )
      ).rows[0];
      if (!prior || !TERMINAL.includes(prior.status))
        fail("INVALID_RETRY", "只能为已结束的同一提交运行创建复查");
    }
    if ((await waiting(tx)) >= QUEUE_LIMIT)
      fail("QUEUE_FULL", "等待队列已满，提交保留，可稍后创建运行", 429);
    let initialModel: CourseModelSnapshot | undefined;
    const mode = input.personalModels ? parseInitialAnalysisModeV2(input.personalAnalysisMode ?? 'off') : input.initialAnalysisMode;
    if (input.personalModels && mode !== 'off') initialModel = await freezeCourseModel(tx, input.personalModels, input.actorId);
    const run = (
      await tx.query(
        `INSERT INTO runs
      (id,submission_id,rule_id,contract_version,status,execution_config,request_id,idempotency_key,request_hash,retry_of_run_id,created_at)
      VALUES($1,$2,$3,2,'queued',$8,$4,$5,$6,$7,clock_timestamp()) RETURNING *`,
        [
          randomUUID(),
          submission.id,
          submission.rule_id,
          randomUUID(),
          key,
          requestHash,
          input.retryOfRunId ?? null,
          JSON.stringify(
            {
              ...(input.approvedFingerprint ? { approvedFingerprint: measurementFingerprintSchema.parse(input.approvedFingerprint) } : {}),
              ...(mode === undefined ? {} : { initialAnalysisMode: parseInitialAnalysisModeV2(mode) }),
              ...(initialModel ? { initialModel } : {}),
            },
          ),
        ],
      )
    ).rows[0];
    return { run, replayed: false };
  });
}

/** Execution and independent analysis share one claim transaction and one queue. */
export async function claimNextV2(db: DB, storageAdmission?: StorageAdmission) {
  return db.transaction(async (tx) => {
    await lockQueue(tx);
    if (await hasOwner(tx)) return null;
    const next = (
      await tx.query(`SELECT * FROM (
      SELECT 'execution' AS kind,id,created_at FROM runs WHERE contract_version=2 AND status='queued'
      UNION ALL SELECT 'reanalysis' AS kind,id,created_at FROM analysis_attempts WHERE mode='reanalysis' AND status='queued'
    ) candidates ORDER BY created_at,id LIMIT 1`)
    ).rows[0];
    if (!next) return null;
    await admitReservedStorageV2(tx, storageAdmission, false);
    const started = await now(tx),
      token = randomUUID();
    if (next.kind === "execution") {
      const id = randomUUID(),
        deadline = iso(started, 300_000),
        workDeadline = iso(started, 270_000);
      await tx.query(
        `UPDATE runs SET status='preparing',pipeline_started_at=$2,pipeline_deadline_at=$3 WHERE id=$1 AND status='queued'`,
        [next.id, iso(started), deadline],
      );
      const owner = (
        await tx.query(
          `INSERT INTO execution_attempts
        (id,run_id,attempt_no,owner_phase,lease_token,lease_until,heartbeat_at,pipeline_started_at,pipeline_deadline_at,work_deadline_at,cleanup_state)
        VALUES($1,$2,1,'preparing',$3,$4,$5,$5,$6,$7,'pending') RETURNING *`,
          [
            id,
            next.id,
            token,
            iso(started, LEASE_MS),
            iso(started),
            deadline,
            workDeadline,
          ],
        )
      ).rows[0];
      return {
        kind: "execution" as const,
        owner,
        identity: { kind: "execution", id, token } as OwnerIdentity,
      };
    }
    const owner = (
      await tx.query(
        `UPDATE analysis_attempts SET status='running',owner_phase='preparing',
      lease_token=$2,lease_until=$3,heartbeat_at=$4,work_deadline_at=$5,hard_deadline_at=$6,cleanup_state='pending',
      deadlines=$7 WHERE id=$1 AND status='queued' RETURNING *`,
        [
          next.id,
          token,
          iso(started, LEASE_MS),
          iso(started),
          iso(started, 60_000),
          iso(started, 90_000),
          JSON.stringify({
            startedAt: iso(started),
            workDeadlineAt: iso(started, 60_000),
            hardDeadlineAt: iso(started, 90_000),
          }),
        ],
      )
    ).rows[0];
    return {
      kind: "reanalysis" as const,
      owner,
      identity: { kind: "reanalysis", id: next.id, token } as OwnerIdentity,
    };
  });
}

async function currentOwner(
  tx: DB,
  identity: OwnerIdentity,
  requireLease = true,
) {
  const owner = (
    await tx.query(
      `SELECT *,lease_until>clock_timestamp() AND ${hardColumn(identity.kind)}>clock_timestamp() AS lease_valid
    FROM ${table(identity.kind)} WHERE id=$1 FOR UPDATE`,
      [identity.id],
    )
  ).rows[0];
  if (
    !owner ||
    (identity.kind === "reanalysis" && owner.mode !== "reanalysis") ||
    owner.lease_token !== identity.token ||
    owner.owner_phase === "closed"
  )
    fail("OWNER_LOST", "资源所有权已失效");
  if (
    requireLease &&
    (!owner.lease_valid ||
      ["lost", "recovering", "cleanup_pending"].includes(owner.owner_phase))
  )
    fail("OWNER_LOST", "租约或执行期限已失效");
  return owner;
}
export async function heartbeatOwnerV2(db: DB, identity: OwnerIdentity) {
  return db.transaction(async (tx) => {
    await lockQueue(tx);
    const owner=await currentOwner(tx, identity);
    if(identity.kind==="reanalysis" && ["preparing","analyzing"].includes(owner.owner_phase) && owner.status!=="running")
      fail("ANALYSIS_STOPPED","分析已停止，等待回收");
    const row = (
      await tx.query(
        `UPDATE ${table(identity.kind)} SET heartbeat_at=clock_timestamp(),
      lease_until=LEAST(${hardColumn(identity.kind)},clock_timestamp()+interval '30 seconds') WHERE id=$1 RETURNING lease_until`,
        [identity.id],
      )
    ).rows[0];
    return row.lease_until;
  });
}
export async function advanceBaseV2(
  db: DB,
  identity: OwnerIdentity,
  phase: "building" | "checking",
) {
  if (identity.kind !== "execution")
    fail("INVALID_PHASE", "分析拥有者不能推进基础检查");
  return db.transaction(async (tx) => {
    await lockQueue(tx);
    const owner = await currentOwner(tx, identity);
    const expected = phase === "building" ? "preparing" : "building";
    if (owner.base_sealed_at || owner.owner_phase !== expected)
      fail("INVALID_PHASE", "基础阶段转换不合法");
    if (new Date(owner.work_deadline_at).getTime() <= (await now(tx)).getTime())
      fail("TIME_BUDGET", "工作期限已过");
    await tx.query("UPDATE execution_attempts SET owner_phase=$2 WHERE id=$1", [
      identity.id,
      phase,
    ]);
    await tx.query(
      "UPDATE runs SET status=$2 WHERE id=$1 AND contract_version=2",
      [owner.run_id, phase],
    );
  });
}

export async function cancelQueuedV2(db: DB, runId: string, actorId: string) {
  return db.transaction(async (tx) => {
    const run = (
      await tx.query(
        "SELECT submission_id FROM runs WHERE id=$1 AND contract_version=2",
        [runId],
      )
    ).rows[0];
    if (!run) fail("NOT_FOUND", "运行不存在", 404);
    const submission = await authorizedSubmission(
      tx,
      run.submission_id,
      actorId,
    ).catch((error) => {
      if (error instanceof LifecycleError && error.statusCode === 404)
        fail("NOT_FOUND", "运行不存在", 404);
      throw error;
    });
    await lockStudentTask(tx, submission.task_id, submission.user_id);
    await lockQueue(tx);
    const current = (
      await tx.query("SELECT * FROM runs WHERE id=$1 FOR UPDATE", [runId])
    ).rows[0];
    if (current.status === "cancelled") return current;
    if (current.status !== "queued")
      fail("RUN_ALREADY_STARTED", "任务已经领取，需请求当前拥有者停止并回收");
    return (
      await tx.query(
        "UPDATE runs SET status='cancelled',finished_at=clock_timestamp() WHERE id=$1 RETURNING *",
        [runId],
      )
    ).rows[0];
  });
}

export async function beginCleanupV2(db: DB, identity: OwnerIdentity) {
  return db.transaction(async (tx) => {
    await lockQueue(tx);
    const owner = await currentOwner(tx, identity);
    if (identity.kind === "execution" && !owner.base_sealed_at)
      fail("BASE_NOT_SEALED", "先封存真实结果或故障说明，再回收");
    const activeAnalysis =
      identity.kind === "execution"
        ? (
            await tx.query(
              "SELECT 1 FROM analysis_attempts WHERE owner_execution_attempt_id=$1 AND status IN ('queued','running')",
              [identity.id],
            )
          ).rows.length > 0
        : ["queued", "running"].includes(owner.status);
    if (activeAnalysis)
      fail("ANALYSIS_ACTIVE", "先终止或完成分析，再回收其资源");
    await tx.query(
      `UPDATE ${table(identity.kind)} SET owner_phase='cleaning',cleanup_state='cleaning' WHERE id=$1`,
      [identity.id],
    );
  });
}
export async function interruptInitialAnalysisV2(
  db: DB,
  identity: OwnerIdentity,
) {
  return db.transaction(async (tx) => {
    await lockQueue(tx);
    await currentOwner(tx, identity);
    if (identity.kind !== "execution")
      fail("OWNER_LOST", "初次分析需要执行所有者");
    await tx.query(
      `UPDATE analysis_attempts SET status='interrupted',finished_at=clock_timestamp()
      WHERE owner_execution_attempt_id=$1 AND status IN ('queued','running')`,
      [identity.id],
    );
    await tx.query(
      `UPDATE analysis_operations o SET state=CASE WHEN o.state='sent' THEN 'unknown' ELSE 'failed' END,
      error='{"code":"ANALYSIS_INTERRUPTED"}',finished_at=clock_timestamp()
      FROM analysis_attempts a WHERE o.analysis_attempt_id=a.id AND a.owner_execution_attempt_id=$1
      AND a.status='interrupted' AND o.state IN ('reserved','sent')`,
      [identity.id],
    );
  });
}
function assertReceipt(
  receipt: CleanupReceipt,
  identity: Pick<OwnerIdentity, "kind" | "id">,
  owner: Record<string, any>,
) {
  runnerCleanupResponseSchema.parse(receipt);
  const operation = owner.control_operations?.cleanup;
  // The database calls independent resource owners reanalysis; the runner wire calls them analysis.
  const wireKind = identity.kind === "execution" ? "execution" : "analysis";
  if (
    receipt.ownerKind !== wireKind ||
    receipt.ownerId !== identity.id ||
    receipt.runId !== owner.run_id ||
    !operation ||
    receipt.operationId !== operation.operationId ||
    receipt.requestHash !== operation.requestHash
  )
    fail("INVALID_CLEANUP_RECEIPT", "回收回执归属或操作身份不符");
}
/** Register a cleanup request before sending. recovering is restricted to the trusted reaper. */
export async function reserveCleanupOperationV2(
  db: DB,
  identity: OwnerIdentity | Pick<OwnerIdentity, "kind" | "id">,
  operationId: string,
  requestHash: string,
  recovering = false,
) {
  uuidSchema.parse(operationId);
  sha256Schema.parse(requestHash);
  return db.transaction(async (tx) => {
    await lockQueue(tx);
    const owner = recovering
      ? (
          await tx.query(
            `SELECT * FROM ${table(identity.kind)} WHERE id=$1 FOR UPDATE`,
            [identity.id],
          )
        ).rows[0]
      : "token" in identity
        ? await currentOwner(tx, identity)
        : fail("OWNER_LOST", "缺少拥有者令牌");
    if (
      !owner ||
      (identity.kind === "reanalysis" && owner.mode !== "reanalysis")
    )
      fail("NOT_FOUND", "资源记录不存在", 404);
    if (
      !(
        recovering ? ["lost", "recovering", "cleanup_pending"] : ["cleaning"]
      ).includes(owner.owner_phase)
    )
      fail("INVALID_PHASE", "当前阶段不可登记回收");
    const previous = owner.control_operations?.cleanup;
    if (previous) {
      if (
        previous.operationId !== operationId ||
        previous.requestHash !== requestHash
      )
        fail("OPERATION_CONFLICT", "回收操作身份不可替换");
      return { operation: previous, replayed: true };
    }
    const operation = {
      operationId,
      requestHash,
      reservedAt: iso(await now(tx)),
    };
    await tx.query(
      `UPDATE ${table(identity.kind)} SET control_operations=$2 WHERE id=$1`,
      [
        identity.id,
        JSON.stringify({ ...owner.control_operations, cleanup: operation }),
      ],
    );
    return { operation, replayed: false };
  });
}
async function saveCleanup(
  tx: DB,
  identity: Pick<OwnerIdentity, "kind" | "id">,
  receipt: CleanupReceipt,
) {
  await tx.query(
    `UPDATE ${table(identity.kind)} SET owner_phase=$2,cleanup_state=$3,cleanup_receipt=$4,
    finished_at=CASE WHEN $2='closed' THEN clock_timestamp() ELSE finished_at END WHERE id=$1`,
    [
      identity.id,
      receipt.state === "clean" ? "closed" : "cleanup_pending",
      receipt.state,
      JSON.stringify(receipt),
    ],
  );
}
export async function recordCleanupV2(
  db: DB,
  identity: OwnerIdentity,
  receipt: CleanupReceipt,
) {
  return db.transaction(async (tx) => {
    await lockQueue(tx);
    const owner = await currentOwner(tx, identity);
    assertReceipt(receipt, identity, owner);
    if (owner.owner_phase !== "cleaning")
      fail("INVALID_PHASE", "拥有者尚未进入回收阶段");
    await saveCleanup(tx, identity, receipt);
  });
}

/** Trusted reaper only. This entry point cannot write case results or reopen an owner. */
export async function recordRecoveredCleanupV2(
  db: DB,
  identity: Pick<OwnerIdentity, "kind" | "id">,
  receipt: CleanupReceipt,
) {
  return db.transaction(async (tx) => {
    await lockQueue(tx);
    const owner = (
      await tx.query(
        `SELECT * FROM ${table(identity.kind)} WHERE id=$1 FOR UPDATE`,
        [identity.id],
      )
    ).rows[0];
    if (
      !owner ||
      (identity.kind === "reanalysis" && owner.mode !== "reanalysis")
    )
      fail("NOT_FOUND", "资源记录不存在", 404);
    assertReceipt(receipt, identity, owner);
    if (owner.owner_phase === "closed") {
      if (hash(owner.cleanup_receipt) !== hash(receipt))
        fail("CLEANUP_CONFLICT", "已关闭资源的回执不可替换");
      return;
    }
    if (!["lost", "recovering", "cleanup_pending"].includes(owner.owner_phase))
      fail("INVALID_PHASE", "恢复器不能接管仍有效的拥有者");
    if (identity.kind === "execution" && !owner.base_sealed_at)
      fail("BASE_NOT_SEALED", "故障终结尚未完成");
    if (
      identity.kind === "reanalysis" &&
      ["queued", "running"].includes(owner.status)
    )
      fail("ANALYSIS_ACTIVE", "故障分析尚未终结");
    await saveCleanup(tx, identity, receipt);
  });
}

async function baseContext(db: DB, attemptId: string) {
  const row = (
    await db.query(
      `SELECT e.*,r.submission_id,r.rule_id,r.status AS run_status,r.execution_config,
    s.sha256,s.source_manifest_sha256,s.task_id,ru.rule_snapshot
    FROM execution_attempts e JOIN runs r ON r.id=e.run_id
    JOIN submissions s ON s.id=r.submission_id JOIN rules ru ON ru.id=r.rule_id
    WHERE e.id=$1 AND r.contract_version=2 AND s.contract_version=2 AND ru.contract_version=2`,
      [attemptId],
    )
  ).rows[0];
  if (!row) fail("NOT_FOUND", "执行上下文不存在", 404);
  const rule = await validateRuleSnapshot(row.rule_snapshot);
  if (rule.ruleId !== row.rule_id || rule.taskId !== row.task_id)
    fail("RULE_CONTEXT_MISMATCH", "持久规则归属错误");
  const context: ExecutionContext = {
    runId: row.run_id,
    executionAttemptId: row.id,
    submissionId: row.submission_id,
    originalZipSha256: row.sha256,
    sourceManifestSha256: row.source_manifest_sha256,
    ruleId: row.rule_id,
    ruleHash: await hashRuleSnapshot(rule),
    packManifestHash: rule.packManifestHash,
    templateHash: rule.packManifest.templateHash,
  };
  return { row, rule, context };
}

/** Reserve execute identity before sending an external request. Replays do not permit a second send. */
export async function reserveBaseOperationV2(
  db: DB,
  identity: OwnerIdentity,
  operationId: string,
  requestHash: string,
) {
  if (
    identity.kind !== "execution" ||
    !uuidSchema.safeParse(operationId).success ||
    !sha256Schema.safeParse(requestHash).success
  )
    fail("INVALID_OPERATION", "执行操作身份无效", 400);
  return db.transaction(async (tx) => {
    await lockQueue(tx);
    const owner = await currentOwner(tx, identity);
    if (owner.base_sealed_at) fail("BASE_ALREADY_SEALED", "基础结果已经封存");
    const existing = owner.control_operations?.execute;
    if (existing) {
      if (
        existing.operationId !== operationId ||
        existing.requestHash !== requestHash
      )
        fail("OPERATION_CONFLICT", "已登记的执行身份不能替换");
      return { operation: existing, replayed: true };
    }
    const operation = {
      operationId,
      requestHash,
      state: "reserved",
      reservedAt: iso(await now(tx)),
    };
    await tx.query(
      "UPDATE execution_attempts SET control_operations=$2 WHERE id=$1",
      [
        identity.id,
        JSON.stringify({ ...owner.control_operations, execute: operation }),
      ],
    );
    return { operation, replayed: false };
  });
}

/** Caller stores validated artifacts durably first; this function atomically seals their index and facts. */
export async function sealBaseV2(
  db: DB,
  identity: OwnerIdentity,
  responseValue: unknown,
  verifyStoredEvidence: (
    storageKey: string,
    sha256: string,
    byteSize: number,
  ) => Promise<void>,
) {
  if (identity.kind !== "execution")
    fail("INVALID_OWNER", "分析不能封存基础结果");
  const initial = await baseContext(db, identity.id);
  const operation = initial.row.control_operations?.execute;
  if (!operation) fail("OPERATION_MISSING", "执行操作尚未持久登记");
  const expectedContext: RunnerOperationContext = {
    ...initial.context,
    operationId: operation.operationId,
    requestHash: operation.requestHash,
  };
  const approvedFingerprint = initial.row.execution_config.approvedFingerprint
    ? measurementFingerprintSchema.parse(
        initial.row.execution_config.approvedFingerprint,
      )
    : undefined;
  const response = await validateRunResponse(responseValue, {
    rule: initial.rule,
    expectedContext,
    approvedFingerprint,
  });
  if (response.outcome === "complete" && !approvedFingerprint)
    fail(
      "ENVIRONMENT_NOT_APPROVED",
      "没有登记可核对的执行环境，不能接受正常测量结果",
    );
  for (const evidence of response.baseManifest.evidence)
    await verifyStoredEvidence(
      evidence.storageKey,
      evidence.sha256,
      evidence.byteSize,
    );
  return db.transaction(async (tx) => {
    await lockQueue(tx);
    const owner = await currentOwner(tx, identity);
    const run = (
      await tx.query("SELECT * FROM runs WHERE id=$1 FOR UPDATE", [
        owner.run_id,
      ])
    ).rows[0];
    if (owner.base_sealed_at || TERMINAL.includes(run.status))
      fail("BASE_ALREADY_SEALED", "已封存结果不可覆盖");
    if (!["preparing", "building", "checking"].includes(owner.owner_phase))
      fail("INVALID_PHASE", "当前阶段不可封存基础结果");
    if (response.outcome === "complete" && owner.owner_phase !== "checking")
      fail("INVALID_PHASE", "正常结果必须来自检查阶段");
    if (
      response.outcome === "complete" &&
      new Date(owner.work_deadline_at).getTime() <= (await now(tx)).getTime()
    )
      fail("TIME_BUDGET", "正常结果超过工作截止，不可封存为成功执行");
    if (
      owner.control_operations.execute.operationId !== operation.operationId ||
      owner.control_operations.execute.requestHash !== operation.requestHash
    )
      fail("OPERATION_CONFLICT", "执行身份发生变化");
    const runStatus =
      response.outcome === "complete" ? "completed" : response.outcome;
    await tx.query(
      `UPDATE execution_attempts SET base_sealed_at=clock_timestamp(),base_results=$2,
      base_manifest=$3,actual_fingerprint=$4,owner_phase='initial_analysis',control_operations=$5 WHERE id=$1`,
      [
        identity.id,
        JSON.stringify(response.caseResults),
        JSON.stringify(response.baseManifest),
        JSON.stringify(response.actualFingerprint),
        JSON.stringify({
          ...owner.control_operations,
          execute: {
            ...operation,
            state: "completed",
            resultContext: response.context,
          },
        }),
      ],
    );
    await tx.query(
      `UPDATE runs SET status=$2,outcome=$3,accepted_execution_attempt_id=$4,finished_at=clock_timestamp() WHERE id=$1`,
      [owner.run_id, runStatus, response.outcome, identity.id],
    );
    return {
      runId: owner.run_id,
      status: runStatus,
      baseManifestId: response.baseManifest.manifestId,
    };
  });
}

function unexecuted(definition: {
  caseId: string;
  criterionId: string;
  expected: string;
  plannedSteps: { stepId: string }[];
}): CaseResult {
  return {
    caseId: definition.caseId,
    criterionId: definition.criterionId,
    expected: definition.expected,
    verdict: "not_run",
    preconditionStatus: "uncertain",
    reasonCode: "INTERRUPTED",
    observed: "资源拥有者失联或超过截止；未取得可确认的执行结果。",
    executedSteps: [],
    unexecutedStepIds: definition.plannedSteps.map((step) => step.stepId),
    blockedBy: [
      { kind: "execution_stage", id: "connection", reasonCode: "INTERRUPTED" },
    ],
    evidenceIds: [],
  };
}

/** Restricted recovery finalizer: preserves real persisted facts and records unknown fields honestly. */
export async function recoverExpiredV2(db: DB) {
  return db.transaction(async (tx) => {
    await lockQueue(tx);
    const expired = (
      await tx.query(`SELECT id FROM execution_attempts WHERE owner_phase<>'closed'
      AND owner_phase NOT IN ('lost','recovering','cleanup_pending')
      AND (lease_until<=clock_timestamp() OR pipeline_deadline_at<=clock_timestamp()) FOR UPDATE`)
    ).rows;
    const recovered: { kind: OwnerKind; id: string; runId: string }[] = [];
    for (const entry of expired) {
      const { row: owner, rule, context } = await baseContext(tx, entry.id);
      // Revoke the old owner's write qualification in the same lock as ordinary sealing.
      await tx.query(
        "UPDATE execution_attempts SET owner_phase='lost',cleanup_state='cleanup_pending' WHERE id=$1",
        [owner.id],
      );
      if (!owner.base_sealed_at) {
        let recoveredBase: {
          results: CaseResult[];
          manifest: ArtifactManifest;
          measured: MeasuredEnvironment;
        };
        let invalidPartial: Record<string, unknown> | undefined;
        try {
          const partial = (owner.base_results ?? []) as CaseResult[];
          const seen = new Set<string>();
          for (const result of partial) {
            const definition = rule.packManifest.cases.find(
              (item) =>
                item.caseId === result.caseId &&
                rule.requiredCaseIds.includes(item.caseId),
            );
            if (!definition || seen.has(result.caseId))
              throw new LifecycleError(
                "INVALID_PERSISTED_PARTIAL",
                "部分结果不是当前规则中的唯一案例",
              );
            validateCaseResult(definition, result);
            seen.add(result.caseId);
          }
          const results = validateCaseResults(
            rule,
            rule.requiredCaseIds.map(
              (id) =>
                partial.find((result) => result.caseId === id) ??
                unexecuted(
                  rule.packManifest.cases.find((item) => item.caseId === id)!,
                ),
            ),
          );
          const manifest = owner.base_manifest
            ? await validateArtifactManifest(owner.base_manifest, {
                rule,
                expectedContext: context,
              })
            : await createArtifactManifest({
                manifestId: randomUUID(),
                context,
                source: "base",
                analysisAttemptId: null,
                operationId: null,
                evidence: [],
                completeness: "partial",
              });
          validateCaseEvidenceReferences(results, manifest);
          const measured =
            owner.actual_fingerprint &&
            Object.keys(owner.actual_fingerprint).length
              ? measuredEnvironmentSchema.parse(owner.actual_fingerprint)
              : unknownMeasuredEnvironment();
          recoveredBase = { results, manifest, measured };
        } catch {
          // Keep invalid, unsealed input privately for diagnosis. It is not trusted
          // evidence and must not prevent the owner from entering resource cleanup.
          invalidPartial = {
            executionAttemptId: owner.id,
            baseResults: owner.base_results,
            baseManifest: owner.base_manifest,
            measuredEnvironment: owner.actual_fingerprint,
          };
          recoveredBase = {
            results: rule.requiredCaseIds.map((id) => ({
              ...unexecuted(
                rule.packManifest.cases.find((item) => item.caseId === id)!,
              ),
              observed:
                "执行记录未通过一致性校验，无法确认本案例已执行；异常记录已保留供核查，请重新检查。",
            })),
            manifest: await createArtifactManifest({
              manifestId: randomUUID(),
              context,
              source: "base",
              analysisAttemptId: null,
              operationId: null,
              evidence: [],
              completeness: "partial",
            }),
            measured: unknownMeasuredEnvironment(),
          };
        }
        if (invalidPartial)
          await tx.query(
            "INSERT INTO events(run_id,kind,payload) VALUES($1,'v2_invalid_partial_quarantined',$2)",
            [owner.run_id, JSON.stringify(invalidPartial)],
          );
        const { results, manifest, measured } = recoveredBase;
        await tx.query(
          `UPDATE execution_attempts SET base_sealed_at=clock_timestamp(),base_results=$2,base_manifest=$3,actual_fingerprint=$4 WHERE id=$1`,
          [
            owner.id,
            JSON.stringify(results),
            JSON.stringify(manifest),
            JSON.stringify(measured),
          ],
        );
        await tx.query(
          `UPDATE runs SET status='interrupted',outcome='interrupted',accepted_execution_attempt_id=$2,finished_at=clock_timestamp() WHERE id=$1`,
          [owner.run_id, owner.id],
        );
      }
      await tx.query(
        `UPDATE analysis_attempts SET status='interrupted',finished_at=clock_timestamp() WHERE owner_execution_attempt_id=$1 AND status IN ('queued','running')`,
        [owner.id],
      );
      await tx.query(
        `INSERT INTO events(run_id,kind,payload) VALUES($1,'v2_owner_expired',$2)`,
        [
          owner.run_id,
          JSON.stringify({
            executionAttemptId: owner.id,
            basePreserved: Boolean(owner.base_sealed_at),
            cleanupState: "cleanup_pending",
          }),
        ],
      );
      recovered.push({ kind: "execution", id: owner.id, runId: owner.run_id });
    }
    const analyses = (
      await tx.query(`UPDATE analysis_attempts SET status=CASE WHEN status='running' THEN 'interrupted' ELSE status END,
      owner_phase='lost',cleanup_state='cleanup_pending',finished_at=COALESCE(finished_at,clock_timestamp())
      WHERE mode='reanalysis' AND owner_phase IS NOT NULL AND owner_phase NOT IN ('closed','lost','recovering','cleanup_pending')
      AND (lease_until<=clock_timestamp() OR hard_deadline_at<=clock_timestamp()) RETURNING id,run_id`)
    ).rows;
    for (const analysis of analyses)
      recovered.push({
        kind: "reanalysis",
        id: analysis.id,
        runId: analysis.run_id,
      });
    await tx.query(`UPDATE analysis_operations o SET state=CASE WHEN o.state='sent' THEN 'unknown' ELSE 'failed' END,
      error='{"code":"OWNER_EXPIRED"}',finished_at=clock_timestamp()
      FROM analysis_attempts a WHERE o.analysis_attempt_id=a.id AND a.status='interrupted'
      AND o.state IN ('reserved','sent')`);
    return recovered;
  });
}
