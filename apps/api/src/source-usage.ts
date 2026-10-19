import { randomUUID } from "node:crypto";
import type { DB } from "./db.js";
import type {
  SourceCallBudget,
  SourceCallReceipt,
  SourceUsageSummary,
} from "@codelab/contracts/source";

/** A durable intent, not proof that the provider received the network request. */
export async function registerSourceCall(
  db: DB,
  analysisId: string,
  number: number,
  budget: SourceCallBudget,
) {
  const id = randomUUID();
  const result = await db.query(
    `INSERT INTO source_model_calls(id,analysis_id,call_no,state,budget)
     SELECT $1,id,$3,'started',$4 FROM source_analyses
     WHERE id=$2 AND status='running' AND deadline>now() RETURNING id`,
    [id, analysisId, number, JSON.stringify(budget)],
  );
  if (!result.rows.length) throw new Error("OWNER_EXPIRED");
  return id;
}

/** Late receipts may account for costs; they cannot write reports or revive cancelled jobs. */
export async function finishSourceCall(
  db: DB,
  id: string,
  receipt: SourceCallReceipt,
) {
  const result = await db.query(
    `UPDATE source_model_calls SET state=$2,finished_at=now(),duration_ms=$3,usage=$4,request_id=$5,error_code=$6
     WHERE id=$1 AND state='started' RETURNING id`,
    [
      id,
      receipt.state,
      receipt.durationMs,
      receipt.usage === null ? null : JSON.stringify(receipt.usage),
      receipt.requestId,
      receipt.errorCode,
    ],
  );
  if (!result.rows.length) throw new Error("SOURCE_CALL_RECEIPT_CONFLICT");
}

export function summarizeSourceUsage(
  recordingVersion: number | null,
  analysisStatus: string,
  calls: { state: string; usage: SourceCallReceipt["usage"] }[],
): SourceUsageSummary {
  const known = calls.filter((c) => c.usage !== null);
  const sum = (field: "inputTokens" | "outputTokens") => {
    if (!known.length) return null;
    const total = known.reduce((n, c) => n + c.usage![field], 0);
    return Number.isSafeInteger(total) ? total : null;
  };
  const open = calls.filter((c) => c.state === "started").length;
  const active = analysisStatus === "running";
  return {
    recording: recordingVersion === 1 ? "available" : "historical-unavailable",
    registeredCalls: calls.length,
    returnedCalls: calls.filter((c) => c.state === "returned").length,
    failedCalls: calls.filter((c) => c.state === "failed").length,
    pendingCalls: active ? open : 0,
    unknownCalls:
      calls.filter((c) => c.state === "unknown").length + (active ? 0 : open),
    callsWithUsage: known.length,
    callsWithoutUsage: calls.length - known.length,
    knownInputTokens: sum("inputTokens"),
    knownOutputTokens: sum("outputTokens"),
  };
}
