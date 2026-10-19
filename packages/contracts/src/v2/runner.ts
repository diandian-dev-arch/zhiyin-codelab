import { z } from "zod";
import {
  LIMITS_V1,
  assertContextMatches,
  assertJsonByteLimit,
  businessIdSchema,
  canonicalJson,
  executionContextSchema,
  fail,
  refineWith,
  sha256,
  sha256Schema,
  utcDateTimeSchema,
  uuidSchema,
  versionSchema,
  type ExecutionContext,
} from "./primitives";
import { caseResultSchema, validateCaseResults } from "./cases";
import {
  artifactManifestSchema,
  artifactPayloadSchema,
  validateArtifactManifest,
  validateArtifactPayloads,
  validateCaseEvidenceReferences,
} from "./evidence";
import {
  compareMeasurements,
  measuredEnvironmentSchema,
  measurementFingerprintSchema,
  type MeasurementFingerprint,
} from "./measurement";
import {
  hashRuleSnapshot,
  ruleSnapshotSchema,
  validateParameterValues,
  validateRuleSnapshot,
  type RuleSnapshot,
} from "./task-packs";
import { createSourceManifest, validateSourceFiles } from "./source";

export const runnerOperationContextSchema = executionContextSchema
  .extend({ operationId: uuidSchema, requestHash: sha256Schema })
  .strict();
export type RunnerOperationContext = z.infer<
  typeof runnerOperationContextSchema
>;
export const runnerResponseContextSchema = runnerOperationContextSchema
  .extend({
    observedSourceManifestSha256: sha256Schema.nullable(),
    sourceVerificationReason: z.string().min(1).max(500).nullable(),
  })
  .strict()
  .superRefine((context, ctx) =>
    refineWith(ctx, () => {
      if (
        context.observedSourceManifestSha256 === null &&
        !context.sourceVerificationReason
      )
        fail("SOURCE_VERIFICATION_REASON_REQUIRED", context.runId);
      if (
        context.observedSourceManifestSha256 !== null &&
        context.sourceVerificationReason !== null
      )
        fail("SOURCE_VERIFICATION_STATE_INVALID", context.runId);
      if (
        context.observedSourceManifestSha256 !== null &&
        context.observedSourceManifestSha256 !== context.sourceManifestSha256
      )
        fail("SOURCE_HASH_MISMATCH", context.runId);
    }),
  );

const deadlineShape = {
  workDeadlineAt: utcDateTimeSchema,
  hardDeadlineAt: utcDateTimeSchema,
  remainingWorkMs: z.number().int().positive().max(270_000),
  budgetConfigVersion: versionSchema,
};
type Deadline = {
  workDeadlineAt: string;
  hardDeadlineAt: string;
  remainingWorkMs: number;
};
function checkDeadlineOrder(deadline: Deadline): void {
  if (
    Date.parse(deadline.hardDeadlineAt) - Date.parse(deadline.workDeadlineAt) <
    30_000
  )
    fail(
      "CLEANUP_RESERVE_MISSING",
      "Reserve at least 30 seconds after the work deadline",
    );
}

/** The receiver supplies its measured clock offset; elapsed time cannot renew a deadline. */
export function runnerRemainingWorkMs(
  deadline: Deadline,
  nowMs: number,
  allowedWorkMs: number,
  clockOffsetMs = 0,
): number {
  checkDeadlineOrder(deadline);
  if (
    !Number.isFinite(nowMs) ||
    !Number.isFinite(clockOffsetMs) ||
    !Number.isSafeInteger(allowedWorkMs) ||
    allowedWorkMs <= 0
  )
    fail(
      "INVALID_CLOCK_CONFIGURATION",
      "Supply measured clock and a positive stage budget",
    );
  const absoluteRemaining =
    Date.parse(deadline.workDeadlineAt) - (nowMs + clockOffsetMs);
  if (
    absoluteRemaining > allowedWorkMs ||
    deadline.remainingWorkMs > allowedWorkMs
  )
    fail(
      "DEADLINE_EXCEEDS_BUDGET",
      "Caller cannot extend the approved work budget",
    );
  return Math.max(
    0,
    Math.min(absoluteRemaining, deadline.remainingWorkMs, allowedWorkMs),
  );
}

export const runnerExecuteRequestSchema = z
  .object({
    protocolVersion: z.literal(2),
    context: executionContextSchema,
    ownerToken: z.string().min(16).max(512),
    operationId: uuidSchema,
    requestHash: sha256Schema,
    requestId: uuidSchema,
    files: z.record(z.string()),
    ruleSnapshot: ruleSnapshotSchema,
    approvedFingerprint: measurementFingerprintSchema,
    startedAt: utcDateTimeSchema,
    leaseUntil: utcDateTimeSchema,
    ...deadlineShape,
  })
  .strict()
  .superRefine((request, ctx) =>
    refineWith(ctx, () => {
      checkDeadlineOrder(request);
      const started = Date.parse(request.startedAt);
      const work = Date.parse(request.workDeadlineAt);
      const hard = Date.parse(request.hardDeadlineAt);
      const lease = Date.parse(request.leaseUntil);
      if (
        work <= started ||
        hard - started > 300_000 ||
        request.remainingWorkMs > work - started ||
        lease <= started ||
        lease > hard
      )
        fail("OWNER_DEADLINES_INVALID", request.context.runId);
      const { files, ...metadata } = request;
      assertJsonByteLimit(
        metadata,
        LIMITS_V1.runnerMetadataMaxBytes,
        "runner request metadata",
      );
      assertJsonByteLimit(
        request,
        LIMITS_V1.runnerRequestMaxBytes,
        "runner request including base64",
      );
      validateSourceFiles(files);
    }),
  );
export type RunnerExecuteRequest = z.infer<typeof runnerExecuteRequestSchema>;

/** Lease/trace fields do not identify an action. Only a separate authenticated heartbeat may renew a lease. */
export async function hashExecuteRequest(
  request: Omit<RunnerExecuteRequest, "requestHash"> | RunnerExecuteRequest,
): Promise<string> {
  const {
    requestHash: _self,
    requestId: _trace,
    ownerToken: _token,
    leaseUntil: _lease,
    ...action
  } = request as RunnerExecuteRequest;
  return sha256(canonicalJson(action));
}

function assertFingerprintRule(
  fingerprint: Partial<MeasurementFingerprint>,
  rule: RuleSnapshot,
  context: ExecutionContext,
): void {
  const required = {
    ruleHash: context.ruleHash,
    packManifestHash: rule.packManifestHash,
    templateHash: rule.packManifest.templateHash,
    dependencyLockHash: rule.packManifest.dependencyLockHash,
    initializationVersion: rule.packManifest.initializationVersion,
    parametersHash: rule.parametersHash,
    aggregationVersion: rule.packManifest.aggregationVersion,
  };
  for (const key of Object.keys(required) as (keyof typeof required)[])
    if (fingerprint[key] !== undefined && fingerprint[key] !== required[key])
      fail("FINGERPRINT_RULE_MISMATCH", key);
}

async function assertRuleContext(
  rule: RuleSnapshot,
  context: ExecutionContext,
): Promise<void> {
  if (
    rule.ruleId !== context.ruleId ||
    rule.packManifestHash !== context.packManifestHash ||
    rule.packManifest.templateHash !== context.templateHash ||
    (await hashRuleSnapshot(rule)) !== context.ruleHash
  )
    fail("RULE_CONTEXT_MISMATCH", context.runId);
}

export async function validateRunRequest(
  value: unknown,
): Promise<RunnerExecuteRequest> {
  const request = runnerExecuteRequestSchema.parse(value);
  const rule = await validateRuleSnapshot(request.ruleSnapshot);
  await assertRuleContext(rule, request.context);
  assertFingerprintRule(request.approvedFingerprint, rule, request.context);
  if (
    (await createSourceManifest(request.files)).sourceManifestSha256 !==
    request.context.sourceManifestSha256
  )
    fail("SOURCE_HASH_MISMATCH", "runner request files");
  if ((await hashExecuteRequest(request)) !== request.requestHash)
    fail("REQUEST_HASH_MISMATCH", request.operationId);
  return request;
}

export const stageTimingSchema = z
  .object({
    stage: z.enum([
      "prepare",
      "build",
      "page_service",
      "base_checks",
      "probe",
      "cleanup",
    ]),
    startedAt: utcDateTimeSchema,
    finishedAt: utcDateTimeSchema,
    durationMs: z.number().int().nonnegative().max(300_000),
  })
  .strict()
  .superRefine((timing, ctx) =>
    refineWith(ctx, () => {
      if (Date.parse(timing.finishedAt) < Date.parse(timing.startedAt))
        fail("INVALID_STAGE_TIME", timing.stage);
    }),
  );
export const resourceStateSchema = z.enum([
  "retained_for_initial_analysis",
  "cleaning",
  "clean",
  "cleanup_pending",
]);
export const runnerExecuteResponseSchema = z
  .object({
    protocolVersion: z.literal(2),
    context: runnerResponseContextSchema,
    actualFingerprint: measuredEnvironmentSchema,
    outcome: z.enum([
      "complete",
      "build_error",
      "infra_error",
      "interrupted",
      "cancelled",
    ]),
    caseResults: z.array(caseResultSchema).max(64),
    baseManifest: artifactManifestSchema,
    artifacts: z
      .array(artifactPayloadSchema)
      .max(LIMITS_V1.manifestMaxEvidence),
    timings: z.array(stageTimingSchema).max(20),
    resourceState: resourceStateSchema,
  })
  .strict()
  .superRefine((response, ctx) =>
    refineWith(ctx, () => {
      assertJsonByteLimit(
        response,
        LIMITS_V1.runnerResponseMaxBytes,
        "runner response including base64",
      );
      if (
        response.outcome === "complete" &&
        (response.actualFingerprint.completeness !== "complete" ||
          response.context.observedSourceManifestSha256 === null ||
          response.baseManifest.completeness !== "complete")
      )
        fail("NORMAL_MEASUREMENT_INCOMPLETE", response.context.runId);
      if (response.baseManifest.source !== "base")
        fail("BASE_MANIFEST_REQUIRED", response.context.runId);
    }),
  );
export type RunnerExecuteResponse = z.infer<typeof runnerExecuteResponseSchema>;

export async function validateRunResponse(
  value: unknown,
  options: {
    rule: RuleSnapshot;
    expectedContext: RunnerOperationContext;
    approvedFingerprint?: MeasurementFingerprint;
  },
): Promise<RunnerExecuteResponse> {
  const response = runnerExecuteResponseSchema.parse(value);
  const expected = runnerOperationContextSchema.parse(options.expectedContext);
  const actualContext = executionContextSchema.parse(
    Object.fromEntries(
      Object.keys(executionContextSchema.shape).map((key) => [
        key,
        response.context[key as keyof ExecutionContext],
      ]),
    ),
  );
  const expectedBase = executionContextSchema.parse(
    Object.fromEntries(
      Object.keys(executionContextSchema.shape).map((key) => [
        key,
        expected[key as keyof ExecutionContext],
      ]),
    ),
  );
  assertContextMatches(expectedBase, actualContext);
  if (
    response.context.operationId !== expected.operationId ||
    response.context.requestHash !== expected.requestHash
  )
    fail("OPERATION_CONTEXT_MISMATCH", expected.operationId);
  const rule = await validateRuleSnapshot(options.rule);
  await assertRuleContext(rule, expectedBase);
  validateCaseResults(rule, response.caseResults);
  assertFingerprintRule(response.actualFingerprint.values, rule, expectedBase);
  const manifest = await validateArtifactManifest(response.baseManifest, {
    rule,
    expectedContext: expectedBase,
  });
  validateCaseEvidenceReferences(response.caseResults, manifest);
  await validateArtifactPayloads(manifest, response.artifacts);
  if (options.approvedFingerprint) {
    const approved = measurementFingerprintSchema.parse(
      options.approvedFingerprint,
    );
    assertFingerprintRule(approved, rule, expectedBase);
    // Partial failures retain their observed subset, but cannot contradict approval.
    for (const key of Object.keys(
      response.actualFingerprint.values,
    ) as (keyof MeasurementFingerprint)[])
      if (
        canonicalJson(response.actualFingerprint.values[key]) !==
        canonicalJson(approved[key])
      )
        fail("ACTUAL_ENVIRONMENT_MISMATCH", key);
    if (
      response.outcome === "complete" &&
      compareMeasurements(response.actualFingerprint, {
        completeness: "complete",
        values: approved,
        missingFields: [],
      }).status !== "compatible"
    )
      fail("ACTUAL_ENVIRONMENT_MISMATCH", expected.runId);
  }
  if (
    response.outcome === "build_error" &&
    response.caseResults.some(
      (result) =>
        result.verdict !== "not_run" ||
        result.executedSteps.length > 0 ||
        result.reasonCode !== "BUILD_ERROR",
    )
  )
    fail("BUILD_ERROR_RESULT_INVALID", expected.runId);
  return response;
}

export const ownerIdentitySchema = z
  .object({
    runId: uuidSchema,
    ownerKind: z.enum(["execution", "analysis"]),
    ownerId: uuidSchema,
    ownerToken: z.string().min(16).max(512),
  })
  .strict();
export type OwnerIdentity = z.infer<typeof ownerIdentitySchema>;

/** The store checks owner/token, current lease, receiver time and fixed hard deadline. */
export const runnerHeartbeatRequestSchema = z
  .object({
    protocolVersion: z.literal(2),
    owner: ownerIdentitySchema,
    leaseUntil: utcDateTimeSchema,
  })
  .strict();
export type RunnerHeartbeatRequest = z.infer<
  typeof runnerHeartbeatRequestSchema
>;
export const runnerHeartbeatResponseSchema = z
  .object({
    protocolVersion: z.literal(2),
    leaseUntil: utcDateTimeSchema,
  })
  .strict();
export type RunnerHeartbeatResponse = z.infer<
  typeof runnerHeartbeatResponseSchema
>;

export const runnerCleanupRequestSchema = z
  .object({
    protocolVersion: z.literal(2),
    owner: ownerIdentitySchema,
    operationId: uuidSchema,
    requestHash: sha256Schema,
    requestId: uuidSchema,
  })
  .strict();
export type RunnerCleanupRequest = z.infer<typeof runnerCleanupRequestSchema>;

export async function hashCleanupRequest(
  request: Omit<RunnerCleanupRequest, "requestHash"> | RunnerCleanupRequest,
): Promise<string> {
  const {
    requestHash: _self,
    requestId: _trace,
    owner,
    ...action
  } = request as RunnerCleanupRequest;
  const { ownerToken: _token, ...ownerIdentity } = owner;
  return sha256(canonicalJson({ ...action, owner: ownerIdentity }));
}

export const runnerCleanupResponseSchema = z
  .object({
    protocolVersion: z.literal(2),
    runId: uuidSchema,
    ownerKind: z.enum(["execution", "analysis"]),
    ownerId: uuidSchema,
    operationId: uuidSchema,
    requestHash: sha256Schema,
    state: z.enum(["clean", "cleanup_pending"]),
    residualResourceIds: z.array(z.string().min(1).max(160)).max(50),
    completedAt: utcDateTimeSchema,
  })
  .strict()
  .superRefine((response, ctx) =>
    refineWith(ctx, () => {
      if (response.state === "clean" && response.residualResourceIds.length)
        fail(
          "CLEANUP_RECEIPT_INVALID",
          "A clean receipt cannot contain residual resources",
        );
    }),
  );
export type RunnerCleanupResponse = z.infer<typeof runnerCleanupResponseSchema>;

export const runnerOperationStateSchema = z.enum([
  "accepted",
  "running",
  "completed",
  "failed",
  "unknown",
]);
export const runnerOperationRecordSchema = z
  .object({
    operationId: uuidSchema,
    requestHash: sha256Schema,
    runId: uuidSchema,
    ownerKind: z.enum(["execution", "analysis"]),
    ownerId: uuidSchema,
    kind: z.enum(["execute", "probe", "prepare_probe", "cleanup"]),
    state: runnerOperationStateSchema,
    responseHash: sha256Schema.nullable(),
  })
  .strict();
export type RunnerOperationRecord = z.infer<typeof runnerOperationRecordSchema>;

export const runnerOperationQueryRequestSchema = z
  .object({
    protocolVersion: z.literal(2),
    owner: ownerIdentitySchema,
    operationId: uuidSchema,
    requestHash: sha256Schema.optional(),
  })
  .strict();
export type RunnerOperationQueryRequest = z.infer<
  typeof runnerOperationQueryRequestSchema
>;
export type RunnerOperationQueryResponse = {
  record: RunnerOperationRecord;
  response: unknown | null;
};
export const runnerOperationQueryResponseSchema = z
  .object({
    record: runnerOperationRecordSchema,
    response: z.unknown(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.response === undefined)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["response"],
        message: "An operation query must contain a response or explicit null",
      });
  })
  .transform(
    (value): RunnerOperationQueryResponse => ({
      record: value.record,
      response: value.response,
    }),
  );

/** A replay decision never performs an action. Authentication/ownership must run first. */
export function validateReplayIdentity(
  existingValue: RunnerOperationRecord,
  incomingValue: Pick<
    RunnerOperationRecord,
    "operationId" | "requestHash" | "runId" | "ownerKind" | "ownerId" | "kind"
  >,
): {
  decision: "return_existing";
  state: RunnerOperationRecord["state"];
  operationId: string;
} {
  const existing = runnerOperationRecordSchema.parse(existingValue);
  const incoming = runnerOperationRecordSchema
    .omit({ state: true, responseHash: true })
    .parse(incomingValue);
  for (const key of [
    "operationId",
    "runId",
    "ownerKind",
    "ownerId",
    "kind",
  ] as const)
    if (existing[key] !== incoming[key]) fail("OPERATION_SCOPE_MISMATCH", key);
  if (existing.requestHash !== incoming.requestHash)
    fail(
      "OPERATION_PAYLOAD_CONFLICT",
      "Same operationId with a different action payload must return HTTP 409",
    );
  return {
    decision: "return_existing",
    state: existing.state,
    operationId: existing.operationId,
  };
}

export const runnerProbeRequestSchema = z
  .object({
    protocolVersion: z.literal(2),
    context: executionContextSchema,
    owner: ownerIdentitySchema,
    analysisAttemptId: uuidSchema,
    operationId: uuidSchema,
    requestHash: sha256Schema,
    requestId: uuidSchema,
    probeId: businessIdSchema,
    parameters: z.record(
      z.union([z.string(), z.boolean(), z.number().finite()]),
    ),
    ...deadlineShape,
  })
  .strict()
  .superRefine((request, ctx) =>
    refineWith(ctx, () => {
      checkDeadlineOrder(request);
      if (
        request.owner.runId !== request.context.runId ||
        (request.owner.ownerKind === "execution" &&
          request.owner.ownerId !== request.context.executionAttemptId) ||
        (request.owner.ownerKind === "analysis" &&
          request.owner.ownerId !== request.analysisAttemptId)
      )
        fail("PROBE_OWNER_MISMATCH", request.operationId);
      assertJsonByteLimit(
        request,
        LIMITS_V1.runnerMetadataMaxBytes,
        "probe request",
      );
    }),
  );
export type RunnerProbeRequest = z.infer<typeof runnerProbeRequestSchema>;

export async function hashProbeRequest(
  request: Omit<RunnerProbeRequest, "requestHash"> | RunnerProbeRequest,
): Promise<string> {
  const {
    requestHash: _self,
    requestId: _trace,
    owner,
    ...action
  } = request as RunnerProbeRequest;
  const { ownerToken: _lease, ...ownerIdentity } = owner;
  return sha256(canonicalJson({ ...action, owner: ownerIdentity }));
}

export async function validateProbeRequest(
  value: unknown,
  ruleValue: RuleSnapshot,
): Promise<RunnerProbeRequest> {
  const request = runnerProbeRequestSchema.parse(value);
  const rule = await validateRuleSnapshot(ruleValue);
  await assertRuleContext(rule, request.context);
  const probe = rule.packManifest.probes.find(
    (entry) => entry.probeId === request.probeId,
  );
  if (
    !probe ||
    !probe.applicableCriterionIds.some((id) =>
      rule.enabledCriterionIds.includes(id),
    )
  )
    fail("PROBE_NOT_ENABLED", request.probeId);
  validateParameterValues(probe.parameterSchema, request.parameters);
  if ((await hashProbeRequest(request)) !== request.requestHash)
    fail("REQUEST_HASH_MISMATCH", request.operationId);
  return request;
}

export const runnerCapabilitiesSchema = z
  .object({
    protocolVersion: z.literal(2),
    limitsVersion: z.literal("limits-v1"),
    state: z.enum(["ready", "busy", "cleanup_pending", "unavailable"]),
    templateHashes: z.array(sha256Schema).max(10),
    packManifestHashes: z.array(sha256Schema).max(50),
    actualEnvironment: measuredEnvironmentSchema,
    activeOwner: z
      .object({
        runId: uuidSchema,
        ownerKind: z.enum(["execution", "analysis"]),
        ownerId: uuidSchema,
      })
      .strict()
      .nullable(),
    residualResourceIds: z.array(z.string().min(1).max(160)).max(50),
    admissionRecordVersion: versionSchema,
  })
  .strict()
  .superRefine((capabilities, ctx) =>
    refineWith(ctx, () => {
      if (
        capabilities.state === "ready" &&
        (capabilities.activeOwner !== null ||
          capabilities.residualResourceIds.length)
      )
        fail(
          "RUNNER_NOT_CLEAN",
          "Ready requires no active owner or known residue",
        );
    }),
  );
