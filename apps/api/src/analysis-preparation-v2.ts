import { randomUUID } from "node:crypto";
import {
  canonicalJson,
  hashPreparationRequest,
  validatePreparationRequest,
  validatePreparationResponse,
  measurementFingerprintSchema,
  validateReplayIdentity,
  type RunnerProbeRequest,
} from "@codelab/contracts/v2";
import type { DB } from "./db.js";
import { assertAnalysisOwnerV2 } from "./analysis-operations-v2.js";
import { analysisContextV2 } from "./reports-v2.js";
import { heartbeatOwnerV2, type OwnerIdentity } from "./lifecycle-v2.js";
import type { RunnerClientV2 } from "./runner-client-v2.js";

/** Internal preparation is part of the already reserved probe, not a second model tool. */
export async function prepareAnalysisProbeV2(input: {
  db: DB;
  owner: OwnerIdentity;
  runner: RunnerClientV2;
  probe: RunnerProbeRequest;
  signal: AbortSignal;
  onDispatch: () => void;
}) {
  if (!input.runner.prepareProbe || input.owner.kind !== "reanalysis")
    throw new Error("PROBE_PREPARATION_UNAVAILABLE");
  input.signal.throwIfAborted();
  const leaseUntil = new Date(
    await heartbeatOwnerV2(input.db, input.owner),
  ).toISOString();
  const request = await input.db.transaction(async (tx) => {
    const owner = await assertAnalysisOwnerV2(tx, input.owner);
    if (
      new Date(owner.work_deadline_at).getTime() -
        new Date(owner.db_now).getTime() <
      20_000
    )
      throw new Error("PREPARATION_TIME_BUDGET");
    if (owner.control_operations?.prepareProbe)
      throw new Error("PREPARATION_ALREADY_DISPATCHED");
    const { context } = await analysisContextV2(tx, owner.run_id);
    if (
      canonicalJson(input.probe.context) !==
        canonicalJson(context.baseManifest.context) ||
      input.probe.analysisAttemptId !== owner.id ||
      input.probe.owner.ownerId !== owner.id ||
      input.probe.owner.ownerToken !== input.owner.token
    )
      throw new Error("PREPARATION_CONTEXT_MISMATCH");
    const operation = (
      await tx.query(
        "SELECT state FROM analysis_operations WHERE analysis_attempt_id=$1 AND operation_id=$2 AND kind='run_probe'",
        [owner.id, input.probe.operationId],
      )
    ).rows[0];
    if (operation?.state !== "sent")
      throw new Error("PROBE_RESERVATION_REQUIRED");
    const archive = (
      await tx.query(
        `SELECT s.files,e.actual_fingerprint FROM runs r JOIN submissions s ON s.id=r.submission_id
      JOIN execution_attempts e ON e.id=r.accepted_execution_attempt_id WHERE r.id=$1 AND e.base_sealed_at IS NOT NULL`,
        [owner.run_id],
      )
    ).rows[0];
    if (archive?.actual_fingerprint?.completeness !== "complete")
      throw new Error("PREPARATION_BASE_ENVIRONMENT_UNKNOWN");
    const files = Object.fromEntries(
      Object.entries(archive.files as Record<string, string>).filter(
        ([name]) => name.startsWith("src/") || name.startsWith("public/"),
      ),
    );
    const body = {
      protocolVersion: 2 as const,
      operationId: randomUUID(),
      requestId: randomUUID(),
      probe: input.probe,
      files,
      ruleSnapshot: context.rule,
      approvedFingerprint: measurementFingerprintSchema.parse(
        archive.actual_fingerprint.values,
      ),
      startedAt: owner.deadlines.startedAt,
      leaseUntil,
    };
    const checked = await validatePreparationRequest({
      ...body,
      requestHash: await hashPreparationRequest(body),
    });
    await tx.query(
      "UPDATE analysis_attempts SET control_operations=$2 WHERE id=$1",
      [
        owner.id,
        JSON.stringify({
          ...owner.control_operations,
          prepareProbe: {
            operationId: checked.operationId,
            requestHash: checked.requestHash,
            probeOperationId: input.probe.operationId,
            state: "sent",
          },
        }),
      ],
    );
    return checked;
  });
  const deadline = Math.min(
    Date.parse(input.probe.workDeadlineAt),
    Date.now() + input.probe.remainingWorkMs,
  );
  input.onDispatch();
  let response;
  try {
    response = await input.runner.prepareProbe(request, {
      signal: input.signal,
      timeoutMs: Math.max(1, deadline - Date.now()),
    });
  } catch {
    // Read the original operation only; never resend a potentially executed build.
    while (!input.signal.aborted && Date.now() < deadline) {
      try {
        const saved = await input.runner.query(
          {
            protocolVersion: 2,
            owner: input.probe.owner,
            operationId: request.operationId,
            requestHash: request.requestHash,
          },
          {
            signal: input.signal,
            timeoutMs: Math.max(1, Math.min(5000, deadline - Date.now())),
          },
        );
        validateReplayIdentity(saved.record, {
          operationId: request.operationId,
          requestHash: request.requestHash,
          runId: input.probe.context.runId,
          ownerKind: "analysis",
          ownerId: input.owner.id,
          kind: "prepare_probe",
        });
        if (saved.record.state === "completed") {
          response = saved.response;
          break;
        }
        if (!["accepted", "running"].includes(saved.record.state)) break;
      } catch {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  let valid;
  try {
    input.signal.throwIfAborted();
    valid = validatePreparationResponse(response, request);
  } catch {
    await input.db
      .transaction(async (tx) => {
        const owner = await assertAnalysisOwnerV2(tx, input.owner);
        await tx.query(
          "UPDATE analysis_attempts SET control_operations=$2 WHERE id=$1",
          [
            owner.id,
            JSON.stringify({
              ...owner.control_operations,
              prepareProbe: {
                ...owner.control_operations.prepareProbe,
                state: "unknown",
                errorCode: "PREPARATION_OUTCOME_UNKNOWN",
              },
            }),
          ],
        );
      })
      .catch(() => {}); // A lost owner must not write; its durable sent identity remains for cleanup diagnosis.
    throw new Error("PREPARATION_OUTCOME_UNKNOWN");
  }
  await input.db.transaction(async (tx) => {
    const owner = await assertAnalysisOwnerV2(tx, input.owner);
    if (
      new Date(owner.work_deadline_at).getTime() <=
      new Date(owner.db_now).getTime()
    )
      throw new Error("ANALYSIS_DEADLINE");
    await tx.query(
      "UPDATE analysis_attempts SET control_operations=$2 WHERE id=$1",
      [
        owner.id,
        JSON.stringify({
          ...owner.control_operations,
          prepareProbe: {
            ...owner.control_operations.prepareProbe,
            state: "completed",
            response: valid,
          },
        }),
      ],
    );
  });
}
