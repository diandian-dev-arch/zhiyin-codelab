import {
  canonicalJson,
  validateProbeRequest,
  validateProbeResponse,
  type RunnerProbeRequest,
  type RuleSnapshot,
} from "@codelab/contracts/v2";
import type { ArtifactStore } from "./artifacts-v2.js";
import type { RunnerClientV2 } from "./runner-client-v2.js";
import {
  reserveAnalysisOperationV2,
  sendAnalysisOperationV2,
  finishAnalysisOperationV2,
  type AnalysisOperationIdentityV2,
} from "./analysis-operations-v2.js";

/** Trusted service input only. The model never provides an owner, rule, operation ID or deadline. */
export async function runAnalysisProbeV2(
  input: AnalysisOperationIdentityV2 & {
    request: RunnerProbeRequest;
    rule: RuleSnapshot;
    runner: RunnerClientV2;
    artifacts: Pick<ArtifactStore, "storeManifest" | "readEvidence">;
    signal?: AbortSignal;
    prepare?: () => Promise<void>;
  },
) {
  const request = await validateProbeRequest(input.request, input.rule);
  if (
    request.analysisAttemptId !== input.analysisAttemptId ||
    request.operationId !== input.operationId ||
    request.owner.ownerKind !==
      (input.owner.kind === "execution" ? "execution" : "analysis") ||
    request.owner.ownerId !== input.owner.id ||
    request.owner.ownerToken !== input.owner.token
  )
    throw new Error("ANALYSIS_PROBE_IDENTITY_MISMATCH");
  const reserved = await reserveAnalysisOperationV2({
    ...input,
    kind: "run_probe",
    request,
    budget: { toolCalls: 1, probes: 1 },
  });
  if (!reserved.created)
    return { state: reserved.operation.state, replayed: true };
  if (!(await sendAnalysisOperationV2(input)))
    return { state: "sent", replayed: true };
  if (input.owner.kind === "reanalysis") {
    try {
      if (!input.prepare) throw new Error("PROBE_PREPARATION_UNAVAILABLE");
      await input.prepare();
    } catch {
      await finishAnalysisOperationV2({
        ...input,
        state: "failed",
        errorCode: "PROBE_PREPARATION_UNAVAILABLE",
      });
      return { state: "failed", replayed: false };
    }
  }
  const remaining = Math.min(
    request.remainingWorkMs,
    reserved.deadline - Date.now(),
  );
  const signal = AbortSignal.any([
    AbortSignal.timeout(Math.max(1, remaining)),
    ...(input.signal ? [input.signal] : []),
  ]);
  let response;
  try {
    signal.throwIfAborted();
    response = await input.runner.probe(request, input.rule, {
      signal,
      timeoutMs: Math.max(1, remaining),
    });
  } catch {
    // Resolve an uncertain transport outcome by reading the original operation, never dispatching twice.
    try {
      signal.throwIfAborted();
      const saved = await input.runner.query(
        {
          protocolVersion: 2,
          owner: request.owner,
          operationId: request.operationId,
          requestHash: request.requestHash,
        },
        {
          signal,
          timeoutMs: Math.max(
            1,
            Math.min(5000, reserved.deadline - Date.now()),
          ),
        },
      );
      if (saved.record.state === "completed" && saved.response)
        response = await validateProbeResponse(
          saved.response,
          request,
          input.rule,
        );
    } catch {
      /* Unknown stays unknown and consumes its original reservation. */
    }
  }
  if (!response) {
    await finishAnalysisOperationV2({
      ...input,
      state: "unknown",
      errorCode: "PROBE_OUTCOME_UNKNOWN",
    });
    return { state: "unknown", replayed: false };
  }
  let validated;
  try {
    validated = await validateProbeResponse(response, request, input.rule);
    // Publish bytes before DB references. A lost owner can leave unreferenced files, never visible evidence.
    await input.artifacts.storeManifest(
      validated.supplementalManifest,
      validated.artifacts,
    );
  } catch {
    await finishAnalysisOperationV2({
      ...input,
      state: "failed",
      errorCode: "PROBE_ARTIFACT_INVALID",
    });
    return { state: "failed", replayed: false };
  }
  await finishAnalysisOperationV2({
    ...input,
    state: "completed",
    response: canonicalJson(validated),
    supplementalManifest: validated.supplementalManifest,
  });
  return {
    state: "completed",
    replayed: false,
    manifest: validated.supplementalManifest,
  };
}
