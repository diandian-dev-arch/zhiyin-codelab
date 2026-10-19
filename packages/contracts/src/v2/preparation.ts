import { z } from "zod";
import {
  canonicalJson,
  sha256,
  sha256Schema,
  uuidSchema,
  utcDateTimeSchema,
  executionContextSchema,
  assertContextMatches,
} from "./primitives";
import { measurementFingerprintSchema } from "./measurement";
import { ruleSnapshotSchema } from "./task-packs";
import {
  runnerProbeRequestSchema,
  validateProbeRequest,
  validateRunRequest,
  hashExecuteRequest,
} from "./runner";

/** Server-only reconstruction request; the model supplies none of these fields. */
export const runnerPreparationRequestSchema = z
  .object({
    protocolVersion: z.literal(2),
    operationId: uuidSchema,
    requestId: uuidSchema,
    requestHash: sha256Schema,
    probe: runnerProbeRequestSchema,
    files: z.record(z.string()),
    ruleSnapshot: ruleSnapshotSchema,
    approvedFingerprint: measurementFingerprintSchema,
    startedAt: utcDateTimeSchema,
    leaseUntil: utcDateTimeSchema,
  })
  .strict();
export type RunnerPreparationRequest = z.infer<
  typeof runnerPreparationRequestSchema
>;
export async function hashPreparationRequest(
  value:
    | Omit<RunnerPreparationRequest, "requestHash">
    | RunnerPreparationRequest,
) {
  const {
    requestHash: _hash,
    requestId: _trace,
    probe,
    ...rest
  } = value as RunnerPreparationRequest;
  const { requestId: _probeTrace, owner, ...action } = probe;
  const { ownerToken: _token, ...identity } = owner;
  return sha256(
    canonicalJson({ ...rest, probe: { ...action, owner: identity } }),
  );
}
export async function validatePreparationRequest(value: unknown) {
  const request = runnerPreparationRequestSchema.parse(value),
    probe = request.probe;
  await validateProbeRequest(probe, request.ruleSnapshot);
  if (
    probe.owner.ownerKind !== "analysis" ||
    request.operationId === probe.operationId
  )
    throw new Error("PREPARATION_OWNER_INVALID");
  if (
    Date.parse(probe.hardDeadlineAt) - Date.parse(request.startedAt) > 90_000 ||
    probe.remainingWorkMs > 60_000
  )
    throw new Error("PREPARATION_BUDGET_INVALID");
  // Reuse full source/rule/fingerprint validation, without executing or creating a base Run.
  const execution = {
    protocolVersion: 2 as const,
    context: probe.context,
    ownerToken: probe.owner.ownerToken,
    operationId: request.operationId,
    requestId: request.requestId,
    files: request.files,
    ruleSnapshot: request.ruleSnapshot,
    approvedFingerprint: request.approvedFingerprint,
    startedAt: request.startedAt,
    leaseUntil: request.leaseUntil,
    workDeadlineAt: probe.workDeadlineAt,
    hardDeadlineAt: probe.hardDeadlineAt,
    remainingWorkMs: probe.remainingWorkMs,
    budgetConfigVersion: probe.budgetConfigVersion,
  };
  await validateRunRequest({
    ...execution,
    requestHash: await hashExecuteRequest(execution),
  });
  if ((await hashPreparationRequest(request)) !== request.requestHash)
    throw new Error("REQUEST_HASH_MISMATCH");
  return request;
}
export const runnerPreparationResponseSchema = z
  .object({
    protocolVersion: z.literal(2),
    context: executionContextSchema,
    analysisAttemptId: uuidSchema,
    operationId: uuidSchema,
    requestHash: sha256Schema,
    observedSourceManifestSha256: sha256Schema,
    actualFingerprint: measurementFingerprintSchema,
    state: z.literal("ready"),
  })
  .strict();
export type RunnerPreparationResponse = z.infer<
  typeof runnerPreparationResponseSchema
>;
export function validatePreparationResponse(
  value: unknown,
  request: RunnerPreparationRequest,
) {
  const response = runnerPreparationResponseSchema.parse(value);
  assertContextMatches(request.probe.context, response.context);
  if (
    response.operationId !== request.operationId ||
    response.requestHash !== request.requestHash ||
    response.analysisAttemptId !== request.probe.analysisAttemptId ||
    response.observedSourceManifestSha256 !==
      request.probe.context.sourceManifestSha256 ||
    canonicalJson(response.actualFingerprint) !==
      canonicalJson(request.approvedFingerprint)
  )
    throw new Error("PREPARATION_RESPONSE_MISMATCH");
  return response;
}
