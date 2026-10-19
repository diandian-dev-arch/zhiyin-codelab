import { randomUUID } from "node:crypto";
import { parseInitialAnalysisModeV2, readInitialAnalysisModeV2, type InitialAnalysisModeV2 } from './analysis-mode-v2.js';
import { resolveCourseModel } from './course-model-v2.js';
import { createUserModelService, loadModelVaultKey, type SourceProviderResolver } from './user-model-settings.js';
import { createStorageAdmission, StorageAdmissionError, type StorageAdmission } from '../../runner/src/storage-admission.js';
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import {
  canonicalJson,
  createSourceManifest,
  hashCleanupRequest,
  hashExecuteRequest,
  hashRuleSnapshot,
  measurementFingerprintSchema,
  sha256,
  validateReplayIdentity,
  validateRuleSnapshot,
  validateRunRequest,
  validateRunResponse,
  validateSourceManifest,
  type ExecutionContext,
  type MeasurementFingerprint,
  type OwnerIdentity as RunnerOwner,
  type RuleSnapshot,
  type RunnerCleanupRequest,
  type RunnerCleanupResponse,
  type RunnerExecuteRequest,
  type RunnerExecuteResponse,
  type RunnerProbeRequest,
} from "@codelab/contracts/v2";
import { ArtifactStore } from "./artifacts-v2.js";
import { readWorkerConfig } from "./config.js";
import { postgres, type DB } from "./db.js";
import {
  HEARTBEAT_MS,
  LifecycleError,
  advanceBaseV2,
  beginCleanupV2,
  claimNextV2,
  heartbeatOwnerV2,
  interruptInitialAnalysisV2,
  recordCleanupV2,
  recordRecoveredCleanupV2,
  recoverExpiredV2,
  reserveBaseOperationV2,
  reserveCleanupOperationV2,
  sealBaseV2,
  type OwnerIdentity,
} from "./lifecycle-v2.js";
import { ensureBaseReportV2 } from "./reports-v2.js";
import { runInitialAnalysisV2, runReanalysisSummaryV2 } from "./analysis-v2.js";
import { runInitialAgentV2, runReanalysisAgentV2 } from "./agent-v2.js";
import { stopReanalysisV2 } from "./reanalysis-v2.js";
import { prepareAnalysisProbeV2 } from "./analysis-preparation-v2.js";
import {
  createSummaryProviderV2,
  type SummaryProviderV2,
} from "./model-provider-v2.js";
import { loadRuntimeCatalogV2 } from "./runtime-catalog-v2.js";
import {
  createRunnerClientV2,
  RunnerClientError,
  type RunnerClientV2,
} from "./runner-client-v2.js";

export interface WorkerIssueV2 {
  kind:
    | "database"
    | "database_lease"
    | "runner_lease"
    | "runner_transport"
    | "runner_protocol"
    | "storage"
    | "configuration"
    | "deadline"
    | "stopped";
  stage: string;
  code: string;
}
export interface WorkerResultV2 {
  state:
    | "idle"
    | "unavailable"
    | "completed"
    | "recovered"
    | "recovery_pending"
    | "cleanup_pending";
  runId?: string;
  ownerId?: string;
  baseSealed?: true;
  reportReady?: boolean;
  issues: WorkerIssueV2[];
}
export interface WorkerOptionsV2 {
  storageAdmission?: StorageAdmission;
  prepareAnalysisProbe?: (
    request: RunnerProbeRequest,
    signal: AbortSignal,
  ) => Promise<void>;
  analysisMode?: InitialAnalysisModeV2;
  summaryProvider?: SummaryProviderV2;
  personalModels?: SourceProviderResolver;
  db: DB;
  runner: RunnerClientV2;
  artifacts: Pick<ArtifactStore, "storeManifest" | "verifyEvidence"> &
    Partial<Pick<ArtifactStore, "readEvidence">>;
  /** A measured, approved configuration; the worker never invents image/browser identities. */
  approvedFingerprint:
    | MeasurementFingerprint
    | ((input: {
        runId: string;
        rule: RuleSnapshot;
        context: ExecutionContext;
      }) => MeasurementFingerprint | Promise<MeasurementFingerprint>);
  signal?: AbortSignal;
  heartbeatMs?: number;
  queryPollMs?: number;
}

class WorkerFailure extends Error {
  constructor(readonly issue: WorkerIssueV2) {
    super(issue.code);
  }
}
const iso = (value: string | Date) => new Date(value).toISOString();
const codeOf = (error: unknown) => {
  if (error instanceof Error && error.name === "ZodError")
    return "WORKER_SCHEMA_INVALID";
  const raw = (error as { code?: unknown })?.code;
  if (typeof raw === "string" && /^[A-Z][A-Z0-9_]{0,99}$/.test(raw)) return raw;
  const prefix = error instanceof Error ? error.message.split(":", 1)[0] : "";
  return /^[A-Z][A-Z0-9_]{0,99}$/.test(prefix) ? prefix : "WORKER_STAGE_FAILED";
};
function issueFor(error: unknown, stage: string): WorkerIssueV2 {
  if (error instanceof WorkerFailure) return error.issue;
  if (error instanceof LifecycleError)
    return {
      kind: error.code === "OWNER_LOST" ? "database_lease" : "database",
      stage,
      code: error.code,
    };
  if (error instanceof RunnerClientError)
    return {
      kind: /OWNER|LEASE|DEADLINE/.test(error.code)
        ? "runner_lease"
        : error.kind === "protocol"
          ? "runner_protocol"
          : "runner_transport",
      stage,
      code: error.code,
    };
  return {
    kind:
      stage === "archive"
        ? "storage"
        : stage === "context" || stage === "request_validation"
          ? "configuration"
          : stage === "validate_response" || stage === "execute"
            ? "runner_protocol"
            : "database",
    stage,
    code: codeOf(error),
  };
}
function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) throw signal.reason;
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", stop));
  });
}
async function delay(ms: number, signal?: AbortSignal) {
  if (signal?.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const done = () => {
      signal?.removeEventListener("abort", stop);
      resolve();
    };
    const timer = setTimeout(done, ms);
    const stop = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", stop, { once: true });
  });
}
function runnerOwner(
  row: Record<string, any>,
  identity: OwnerIdentity,
): RunnerOwner {
  return {
    runId: row.run_id,
    ownerKind: identity.kind === "execution" ? "execution" : "analysis",
    ownerId: identity.id,
    ownerToken: identity.token,
  };
}

function startHeartbeats(
  options: WorkerOptionsV2,
  identity: OwnerIdentity,
  owner: RunnerOwner,
  controller: AbortController,
  initiallyRenewRunner = true,
) {
  let stopped = false,
    renewRunner = initiallyRenewRunner;
  let awaitingRegistration = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void> = Promise.resolve();
  let failure: WorkerIssueV2 | undefined;
  const schedule = () => {
    if (stopped || controller.signal.aborted) return;
    timer = setTimeout(() => {
      pending = (async () => {
        let leaseUntil: string;
        try {
          leaseUntil = iso(await heartbeatOwnerV2(options.db, identity));
        } catch (error) {
          throw new WorkerFailure(issueFor(error, "database_heartbeat"));
        }
        // A delayed DB response after shutdown must never renew runner ownership.
        if (stopped || controller.signal.aborted || !renewRunner) return;
        try {
          await options.runner.heartbeat(
            { protocolVersion: 2, owner, leaseUntil },
            { timeoutMs: 5_000, signal: controller.signal },
          );
          awaitingRegistration = false;
        } catch (error) {
          if (awaitingRegistration && error instanceof RunnerClientError && error.code === "OWNER_NOT_FOUND") return;
          throw new WorkerFailure(issueFor(error, "runner_heartbeat"));
        }
      })()
        .catch((error) => {
          failure = issueFor(error, "heartbeat");
          controller.abort(new WorkerFailure(failure));
        })
        .then(schedule);
    }, options.heartbeatMs ?? HEARTBEAT_MS);
  };
  schedule();
  return {
    failure: () => failure,
    resumeRunner(allowPendingRegistration = false) {
      renewRunner = true;
      awaitingRegistration = allowPendingRegistration;
    },
    async pauseRunner() {
      renewRunner = false;
      await abortable(pending, controller.signal);
      throwIfAborted(controller.signal);
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      // The DB interface has no cancellation method; a late result is fenced above.
      await abortable(pending, AbortSignal.timeout(2_000)).catch(() => {});
    },
  };
}

async function queryResult(
  runner: RunnerClientV2,
  owner: RunnerOwner,
  operation: { operationId: string; requestHash: string },
  kind: "execute" | "cleanup",
  signal?: AbortSignal,
): Promise<{ pending: boolean; response?: unknown }> {
  const action = {
    operationId: operation.operationId,
    requestHash: operation.requestHash,
  };
  const queried = await runner.query(
    { protocolVersion: 2, owner, ...action },
    { timeoutMs: 5_000, signal },
  );
  validateReplayIdentity(queried.record, {
    ...action,
    runId: owner.runId,
    ownerKind: owner.ownerKind,
    ownerId: owner.ownerId,
    kind,
  });
  if (queried.response != null) {
    if (
      queried.record.state !== "completed" ||
      queried.record.responseHash !==
        (await sha256(canonicalJson(queried.response)))
    )
      throw new RunnerClientError(
        "protocol",
        "RUNNER_STORED_RESPONSE_MISMATCH",
      );
    return { pending: false, response: queried.response };
  }
  return { pending: ["accepted", "running"].includes(queried.record.state) };
}

async function executeOnce(
  options: WorkerOptionsV2,
  request: RunnerExecuteRequest,
  owner: RunnerOwner,
  signal: AbortSignal,
  remaining: () => number,
): Promise<unknown> {
  try {
    return await abortable(
      options.runner.execute(request, {
        timeoutMs: Math.max(1, Math.min(270_000, Math.ceil(remaining()))),
        signal,
      }),
      signal,
    );
  } catch (error) {
    throwIfAborted(signal);
    // The action may already have executed. Never POST execute again, even after 404.
    while (remaining() > 0) {
      const found = await abortable(
        queryResult(options.runner, owner, request, "execute", signal),
        signal,
      );
      if (found.response !== undefined) return found.response;
      if (!found.pending) throw error;
      await delay(
        Math.min(options.queryPollMs ?? 500, Math.max(1, remaining())),
        signal,
      );
    }
    throw new WorkerFailure({
      kind: "deadline",
      stage: "query_execute",
      code: "WORK_DEADLINE",
    });
  }
}

async function cleanupOwner(
  options: WorkerOptionsV2,
  row: Record<string, any>,
  identity: OwnerIdentity,
  recovering: boolean,
  signal?: AbortSignal,
) {
  const owner = runnerOwner(row, identity);
  if (!recovering) await beginCleanupV2(options.db, identity);
  const previous = row.control_operations?.cleanup;
  const operationId = previous?.operationId ?? randomUUID();
  const unsigned = {
    protocolVersion: 2 as const,
    owner,
    operationId,
    requestId: randomUUID(),
  };
  const request: RunnerCleanupRequest = {
    ...unsigned,
    requestHash: await hashCleanupRequest(unsigned),
  };
  if (previous && previous.requestHash !== request.requestHash)
    throw new RunnerClientError(
      "protocol",
      "CLEANUP_REQUEST_IDENTITY_MISMATCH",
    );
  await reserveCleanupOperationV2(
    options.db,
    identity,
    operationId,
    request.requestHash,
    recovering,
  );
  let receipt: RunnerCleanupResponse;
  try {
    // Cleanup is retryable only under its original durable operation identity.
    receipt = await options.runner.cleanup(request, {
      timeoutMs: 30_000,
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    const found = await queryResult(
      options.runner,
      owner,
      request,
      "cleanup",
      signal,
    );
    if (found.response === undefined) throw error;
    receipt = found.response as RunnerCleanupResponse;
  }
  if (recovering) await recordRecoveredCleanupV2(options.db, identity, receipt);
  else await recordCleanupV2(options.db, identity, receipt);
  return receipt;
}

async function runIndependentAnalysis(
  options: WorkerOptionsV2,
  row: Record<string, any>,
  identity: OwnerIdentity,
  issues: WorkerIssueV2[],
): Promise<WorkerResultV2> {
  const result = { runId: row.run_id as string, ownerId: identity.id, issues };
  const sampleStart = performance.now();
  const now = new Date(
    (await options.db.query("SELECT clock_timestamp() AS time")).rows[0].time,
  ).getTime();
  const elapsed = performance.now() - sampleStart;
  const workRemaining = Math.max(
    1,
    new Date(row.work_deadline_at).getTime() - now - elapsed,
  );
  const hardEnd =
    performance.now() +
    Math.max(1, new Date(row.hard_deadline_at).getTime() - now - elapsed);
  const controller = new AbortController();
  const stop = () => controller.abort(new Error("WORKER_STOPPING"));
  options.signal?.addEventListener("abort", stop, { once: true });
  if (options.signal?.aborted) stop();
  const timer = setTimeout(
    () => controller.abort(new Error("ANALYSIS_DEADLINE")),
    workRemaining,
  );
  const owner = runnerOwner(row, identity);
  const beats = startHeartbeats(options, identity, owner, controller, false);
  try {
    const provider = options.personalModels
      ? await resolveCourseModel(options.personalModels, { billingUserId: row.requested_by === row.configuration?.billingUserId ? row.requested_by : '', configuration: row.configuration })
      : options.summaryProvider;
    if (!provider) throw new Error("MODEL_NOT_CONFIGURED");
    if (row.configuration?.strategy === 'summary') {
      await abortable(runReanalysisSummaryV2({ db: options.db, owner: identity,
        provider, signal: controller.signal }), controller.signal);
    } else {
    if (!options.artifacts.readEvidence)
      throw new Error("ANALYSIS_ARTIFACT_READER_REQUIRED");
    await abortable(
      runReanalysisAgentV2({
        db: options.db,
        owner: identity,
        provider,
        runner: options.runner,
        artifacts: {
          storeManifest: options.artifacts.storeManifest.bind(
            options.artifacts,
          ),
          readEvidence: options.artifacts.readEvidence.bind(options.artifacts),
        },
        signal: controller.signal,
        prepareProbe: async (request, signal) => {
          if(options.prepareAnalysisProbe) await options.prepareAnalysisProbe(request, signal);
          else await prepareAnalysisProbeV2({db:options.db,owner:identity,runner:options.runner,probe:request,signal,
            onDispatch:()=>beats.resumeRunner(true)});
          throwIfAborted(controller.signal);
          beats.resumeRunner();
        },
      }),
      controller.signal,
    );
    }
  } catch (error) {
    issues.push(issueFor(error, "reanalysis"));
    try {
      await stopReanalysisV2(
        options.db,
        identity,
        codeOf(error),
        options.summaryProvider ? "interrupted" : "degraded",
      );
    } catch (failure) {
      issues.push(issueFor(failure, "reanalysis_stop"));
    }
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", stop);
    await beats.stop();
  }
  const cleanupController = new AbortController();
  const cleanupTimer = setTimeout(
    () => cleanupController.abort(new Error("HARD_DEADLINE")),
    Math.max(1, hardEnd - performance.now()),
  );
  let cleanupBeats: ReturnType<typeof startHeartbeats> | undefined;
  try {
    await beginCleanupV2(options.db, identity);
    await heartbeatOwnerV2(options.db, identity);
    cleanupBeats = startHeartbeats(
      options,
      identity,
      owner,
      cleanupController,
      false,
    );
    const receipt = await cleanupOwner(
      options,
      row,
      identity,
      false,
      cleanupController.signal,
    );
    return {
      ...result,
      state: receipt.state === "clean" ? "completed" : "cleanup_pending",
    };
  } catch (error) {
    issues.push(issueFor(error, "reanalysis_cleanup"));
    return { ...result, state: "recovery_pending" };
  } finally {
    clearTimeout(cleanupTimer);
    await cleanupBeats?.stop();
  }
}

/** One bounded dispatch/recovery cycle with separate base and independent analysis ownership. */
export async function runOneV2(
  options: WorkerOptionsV2,
): Promise<WorkerResultV2> {
  if (
    (options.heartbeatMs !== undefined &&
      (!Number.isInteger(options.heartbeatMs) ||
        options.heartbeatMs < 5 ||
        options.heartbeatMs > HEARTBEAT_MS)) ||
    (options.queryPollMs !== undefined &&
      (!Number.isInteger(options.queryPollMs) ||
        options.queryPollMs < 1 ||
        options.queryPollMs > 5_000))
  )
    throw new Error("WORKER_TIMING_INVALID");
  const issues: WorkerIssueV2[] = [];
  if (options.signal?.aborted)
    return {
      state: "unavailable",
      issues: [{ kind: "stopped", stage: "claim", code: "WORKER_STOPPING" }],
    };
  await recoverExpiredV2(options.db);
  // Retry draft creation independently of execution. A crash after sealing must not rerun code.
  const missingReport = (
    await options.db
      .query(`SELECT r.id FROM runs r WHERE r.contract_version=2 AND r.accepted_execution_attempt_id IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM report_revisions v WHERE v.run_id=r.id) ORDER BY r.created_at,r.id LIMIT 1`)
  ).rows[0];
  if (missingReport) {
    try {
      await ensureBaseReportV2(options.db, missingReport.id);
    } catch (error) {
      issues.push(issueFor(error, "report_recovery"));
    }
  }
  const recovery = (
    await options.db
      .query(`SELECT 'execution' AS kind,id,run_id,lease_token,control_operations,base_sealed_at FROM execution_attempts
      WHERE owner_phase IN ('lost','recovering','cleanup_pending')
    UNION ALL SELECT 'reanalysis' AS kind,id,run_id,lease_token,control_operations,NULL AS base_sealed_at FROM analysis_attempts
      WHERE mode='reanalysis' AND owner_phase IN ('lost','recovering','cleanup_pending') LIMIT 1`)
  ).rows[0];
  if (recovery) {
    const identity: OwnerIdentity = {
      kind: recovery.kind,
      id: recovery.id,
      token: recovery.lease_token,
    };
    try {
      const receipt = await cleanupOwner(
        options,
        recovery,
        identity,
        true,
        options.signal,
      );
      return {
        state: receipt.state === "clean" ? "recovered" : "cleanup_pending",
        runId: recovery.run_id,
        ownerId: recovery.id,
        ...(recovery.base_sealed_at ? { baseSealed: true as const } : {}),
        issues,
      };
    } catch (error) {
      issues.push(issueFor(error, "cleanup_recovery"));
      return {
        state: "cleanup_pending",
        runId: recovery.run_id,
        ownerId: recovery.id,
        ...(recovery.base_sealed_at ? { baseSealed: true as const } : {}),
        issues,
      };
    }
  }
  try {
    if (
      (await options.runner.capabilities({ signal: options.signal })).state !==
      "ready"
    )
      return { state: "unavailable", issues };
  } catch (error) {
    return {
      state: "unavailable",
      issues: [...issues, issueFor(error, "capabilities")],
    };
  }
  let claimed: Awaited<ReturnType<typeof claimNextV2>>;
  try { claimed = await claimNextV2(options.db, options.storageAdmission); }
  catch (error) {
    if (!(error instanceof StorageAdmissionError)) throw error;
    return { state: 'unavailable', issues: [...issues, { kind: 'storage', stage: 'claim', code: 'STORAGE_ADMISSION_BLOCKED' }] };
  }
  if (!claimed) return { state: "idle", issues };
  const { identity, owner: initialOwner } = claimed;
  const result = {
    runId: initialOwner.run_id as string,
    ownerId: identity.id,
    issues,
  };
  if (claimed.kind !== "execution")
    return runIndependentAnalysis(options, initialOwner, identity, issues);

  let stage = "context";
  let sealed = false,
    reportReady = false;
  let beats: ReturnType<typeof startHeartbeats> | undefined;
  const controller = new AbortController();
  const stopping = () =>
    controller.abort(
      new WorkerFailure({ kind: "stopped", stage, code: "WORKER_STOPPING" }),
    );
  options.signal?.addEventListener("abort", stopping, { once: true });
  if (options.signal?.aborted) stopping();
  let workTimer: ReturnType<typeof setTimeout> | undefined,
    hardTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const clockSampleStarted = performance.now();
    const row = (
      await options.db.query(
        `SELECT r.*,s.files,s.sha256,s.source_manifest,s.source_manifest_sha256,s.task_id,ru.rule_snapshot,clock_timestamp() AS database_now
      FROM runs r JOIN submissions s ON s.id=r.submission_id JOIN rules ru ON ru.id=r.rule_id
      WHERE r.id=$1 AND r.contract_version=2 AND s.contract_version=2 AND ru.contract_version=2`,
        [initialOwner.run_id],
      )
    ).rows[0];
    if (!row) throw new Error("EXECUTION_CONTEXT_MISSING");
    const rule = await validateRuleSnapshot(row.rule_snapshot);
    if (rule.ruleId !== row.rule_id || rule.taskId !== row.task_id)
      throw new Error("RULE_CONTEXT_MISMATCH");
    const context: ExecutionContext = {
      runId: row.id,
      executionAttemptId: identity.id,
      submissionId: row.submission_id,
      originalZipSha256: row.sha256,
      sourceManifestSha256: row.source_manifest_sha256,
      ruleId: row.rule_id,
      ruleHash: await hashRuleSnapshot(rule),
      packManifestHash: rule.packManifestHash,
      templateHash: rule.packManifest.templateHash,
    };
    const approved = measurementFingerprintSchema.parse(
      typeof options.approvedFingerprint === "function"
        ? await options.approvedFingerprint({ runId: row.id, rule, context })
        : options.approvedFingerprint,
    );
    const registered = measurementFingerprintSchema.parse(
      row.execution_config?.approvedFingerprint,
    );
    if (canonicalJson(approved) !== canonicalJson(registered))
      throw new Error("APPROVED_ENVIRONMENT_MISMATCH");
    const databaseNow = new Date(row.database_now).getTime();
    const clockSampleElapsed = performance.now() - clockSampleStarted;
    const workRemaining =
      new Date(initialOwner.work_deadline_at).getTime() -
      databaseNow -
      clockSampleElapsed;
    const hardRemaining =
      new Date(initialOwner.pipeline_deadline_at).getTime() -
      databaseNow -
      clockSampleElapsed;
    if (workRemaining <= 1_000 || hardRemaining > 300_000)
      throw new Error("EXECUTION_BUDGET_INVALID");
    const workEnd = performance.now() + workRemaining - 1_000;
    workTimer = setTimeout(
      () =>
        controller.abort(
          new WorkerFailure({ kind: "deadline", stage, code: "WORK_DEADLINE" }),
        ),
      Math.max(1, workRemaining - 1_000),
    );
    hardTimer = setTimeout(
      () =>
        controller.abort(
          new WorkerFailure({ kind: "deadline", stage, code: "HARD_DEADLINE" }),
        ),
      Math.max(1, hardRemaining),
    );
    stage = "database_heartbeat";
    const leaseUntil = iso(await heartbeatOwnerV2(options.db, identity));
    const owner = runnerOwner(initialOwner, identity);
    stage = "request_validation";
    if (!row.files || typeof row.files !== "object" || Array.isArray(row.files))
      throw new Error("SUBMISSION_FILES_INVALID");
    // The stored ZIP also contains trusted template files. Only editable source
    // bytes may cross the runner boundary; its template is owned by the runner.
    const files = Object.fromEntries(
      Object.entries(row.files as Record<string, string>).filter(
        ([name]) => name.startsWith("src/") || name.startsWith("public/"),
      ),
    );
    const sourceManifest = await createSourceManifest(files);
    const storedManifest = await validateSourceManifest(row.source_manifest);
    if (
      sourceManifest.sourceManifestSha256 !== context.sourceManifestSha256 ||
      storedManifest.sourceManifestSha256 !== context.sourceManifestSha256
    )
      throw new Error("SOURCE_HASH_MISMATCH");
    const unsigned = {
      protocolVersion: 2 as const,
      context,
      ownerToken: identity.token,
      operationId: randomUUID(),
      requestId: randomUUID(),
      files,
      ruleSnapshot: rule,
      approvedFingerprint: approved,
      startedAt: iso(initialOwner.pipeline_started_at),
      leaseUntil,
      workDeadlineAt: iso(initialOwner.work_deadline_at),
      hardDeadlineAt: iso(initialOwner.pipeline_deadline_at),
      remainingWorkMs: Math.max(
        1,
        Math.min(270_000, Math.floor(workRemaining)),
      ),
      budgetConfigVersion: approved.resourceTimeoutConfigVersion,
    };
    const request = await validateRunRequest({
      ...unsigned,
      requestHash: await hashExecuteRequest(unsigned),
    });
    stage = "reserve_execute";
    const reservation = await reserveBaseOperationV2(
      options.db,
      identity,
      request.operationId,
      request.requestHash,
    );
    if (reservation.replayed) throw new Error("EXECUTION_ALREADY_REGISTERED");
    await advanceBaseV2(options.db, identity, "building");
    beats = startHeartbeats(options, identity, owner, controller);
    stage = "execute";
    const responseValue = await executeOnce(
      options,
      request,
      owner,
      controller.signal,
      () => workEnd - performance.now(),
    );
    throwIfAborted(controller.signal);
    stage = "validate_response";
    const response: RunnerExecuteResponse = await validateRunResponse(
      responseValue,
      {
        rule,
        expectedContext: {
          ...context,
          operationId: request.operationId,
          requestHash: request.requestHash,
        },
        approvedFingerprint: approved,
      },
    );
    if (response.outcome === "complete")
      await advanceBaseV2(options.db, identity, "checking");
    stage = "archive";
    await abortable(
      options.artifacts.storeManifest(
        response.baseManifest,
        response.artifacts,
      ),
      controller.signal,
    );
    throwIfAborted(controller.signal);
    stage = "seal";
    await sealBaseV2(
      options.db,
      identity,
      response,
      async (key, hash, size) => {
        try {
          await options.artifacts.verifyEvidence(key, hash, size);
        } catch (error) {
          throw new WorkerFailure({
            kind: "storage",
            stage: "verify_archive",
            code: codeOf(error),
          });
        }
      },
    );
    sealed = true;
    clearTimeout(workTimer);
    stage = "report";
    try {
      await ensureBaseReportV2(options.db, row.id);
      reportReady = true;
    } catch (error) {
      issues.push(issueFor(error, stage));
    }
    if (reportReady && (options.personalModels || options.summaryProvider)) {
      stage = "initial_analysis";
      try {
        // New API runs freeze their strategy on enqueue. Legacy/library runs
        // retain their previous fallback; a restart cannot relabel a queued S as A.
        const mode = parseInitialAnalysisModeV2(row.execution_config?.initialAnalysisMode ?? (options.personalModels ? 'off' : options.analysisMode ?? 'summary'));
        const provider = mode === 'off' ? undefined : options.personalModels
          ? await resolveCourseModel(options.personalModels, row.execution_config?.initialModel)
          : options.summaryProvider;
        if (mode === "agent") {
          if (!options.artifacts.readEvidence)
            throw new Error("AGENT_EVIDENCE_READER_REQUIRED");
          await runInitialAgentV2({
            db: options.db,
            owner: identity,
            provider: provider!,
            runner: options.runner,
            artifacts: {
              storeManifest: (m, p) => options.artifacts.storeManifest(m, p),
              readEvidence: (e) => options.artifacts.readEvidence!(e),
            },
            signal: controller.signal,
          });
        } else if (mode === 'summary')
          await runInitialAnalysisV2({
            db: options.db,
            owner: identity,
            provider: provider!,
            signal: controller.signal,
          });
      } catch (error) {
        issues.push(issueFor(error, stage));
        await interruptInitialAnalysisV2(options.db, identity);
      }
    }
    stage = "cleanup";
    await beats.pauseRunner();
    const receipt = await cleanupOwner(
      options,
      initialOwner,
      identity,
      false,
      controller.signal,
    );
    return {
      ...result,
      state: receipt.state === "clean" ? "completed" : "cleanup_pending",
      baseSealed: true,
      reportReady,
    };
  } catch (error) {
    issues.push(beats?.failure() ?? issueFor(error, stage));
    // Stop lease renewal. Only the restricted expiry finalizer may fill unknown outcomes.
    // A sealed base is never reconstructed here, even if report creation or cleanup failed.
    return {
      ...result,
      state: sealed ? "cleanup_pending" : "recovery_pending",
      ...(sealed ? { baseSealed: true as const } : {}),
      reportReady,
    };
  } finally {
    if (workTimer) clearTimeout(workTimer);
    if (hardTimer) clearTimeout(hardTimer);
    options.signal?.removeEventListener("abort", stopping);
    await beats?.stop();
  }
}

export async function runWorkerV2Loop(
  options: WorkerOptionsV2 & {
    pollMs?: number;
    onResult?: (result: WorkerResultV2) => void;
    onError?: (issue: WorkerIssueV2) => void;
  },
) {
  const pause = options.pollMs ?? 1_500;
  if (!Number.isSafeInteger(pause) || pause < 10 || pause > 60_000)
    throw new Error("WORKER_POLL_INVALID");
  while (!options.signal?.aborted) {
    try {
      const result = await runOneV2(options);
      options.onResult?.(result);
    } catch (error) {
      options.onError?.(issueFor(error, "poll"));
    }
    try {
      await delay(pause, options.signal);
    } catch {
      break;
    }
  }
}

type FingerprintResolverV2 = Exclude<
  WorkerOptionsV2["approvedFingerprint"],
  MeasurementFingerprint
>;

/** A configured runtime catalog takes precedence and must never silently fall back. */
export async function loadWorkerApprovedFingerprintV2(
  env: NodeJS.ProcessEnv = process.env,
): Promise<FingerprintResolverV2> {
  if (env.CODELAB_V2_RUNTIME_FILE) {
    const runtime = await loadRuntimeCatalogV2(
      path.resolve(env.CODELAB_V2_RUNTIME_FILE),
    );
    return ({ rule }) => runtime.approvedFingerprint(rule);
  }
  const fingerprintFile = env.WORKER_V2_FINGERPRINT_FILE;
  if (!fingerprintFile)
    throw new Error("WORKER_V2_RUNTIME_OR_FINGERPRINT_FILE_REQUIRED");
  const file = JSON.parse(
    await readFile(path.resolve(fingerprintFile), "utf8"),
  ) as { fingerprints?: unknown };
  const fingerprints = measurementFingerprintSchema
    .array()
    .min(1)
    .max(50)
    .parse(file.fingerprints);
  if (
    new Set(fingerprints.map((entry) => entry.ruleHash)).size !==
    fingerprints.length
  )
    throw new Error("DUPLICATE_APPROVED_RULE_HASH");
  return ({ context }) => {
    const approved = fingerprints.find(
      (entry) => entry.ruleHash === context.ruleHash,
    );
    if (!approved) throw new Error("APPROVED_RULE_FINGERPRINT_MISSING");
    return approved;
  };
}

async function main() {
  const config = readWorkerConfig();
  const artifactDirectory = process.env.ARTIFACT_ROOT;
  if (!artifactDirectory) throw new Error("ARTIFACT_ROOT_REQUIRED");
  const approvedFingerprint = await loadWorkerApprovedFingerprintV2();
  const db = postgres(config.DATABASE_URL);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  const options: WorkerOptionsV2 = {
    storageAdmission: createStorageAdmission(path.resolve(artifactDirectory)),
    db,
    personalModels: createUserModelService(db, await loadModelVaultKey(db, process.env.DATA_DIR)).resolve,
    analysisMode: readInitialAnalysisModeV2(),
    signal: controller.signal,
    runner: createRunnerClientV2({
      baseUrl: config.RUNNER_URL,
      token: config.RUNNER_TOKEN,
    }),
    artifacts: new ArtifactStore({ root: path.resolve(artifactDirectory) }),
    approvedFingerprint,
  };
  try {
    if (process.argv.includes("--once"))
      console.log(JSON.stringify(await runOneV2(options)));
    else
      await runWorkerV2Loop({
        ...options,
        onResult: (result) => {
          if (result.state !== "idle") console.log(JSON.stringify(result));
        },
        onError: (issue) => console.error(JSON.stringify(issue)),
      });
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await db.close();
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  await main().catch((error) => {
    console.error(codeOf(error));
    process.exitCode = 1;
  });
