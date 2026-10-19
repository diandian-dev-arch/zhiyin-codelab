import { z } from 'zod';
import { sourceReportQuality } from './source.js';

const id = z.string().min(1).max(120);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const quality = z.object({
  reportQuality: z.enum(['complete', 'limited']).optional(),
  reportLimitReasons: z.array(z.enum(['EVIDENCE_FLOW_REJECTED', 'COUNTEREVIDENCE_PLAN_INVALID'])).max(2).optional(),
  // Import only the existence of old warnings, never private warning text.
  legacyWarningPresent: z.boolean(),
}).strict();
export const sourceEvaluationSchema = z.object({
  version: z.literal(1),
  execution: z.enum(['offline-fixture', 'real-model']),
  buildSha256: sha,
  modelConfigSha256: sha,
  mode: z.enum(['quick', 'deep']),
  planned: z.array(z.object({ trialId: id, sampleSha256: sha }).strict()).max(10000),
  observations: z.array(z.object({
    trialId: id,
    taskId: id,
    sampleSha256: sha,
    status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']),
    report: quality.nullable(),
    knownCostCny: z.number().finite().nonnegative().nullable(),
    costComplete: z.boolean(),
  }).strict()).max(10000),
}).strict();

/** Metadata accounting only; does not attest sample provenance or semantic quality. */
export function summarizeSourceEvaluation(input: unknown) {
  const ledger = sourceEvaluationSchema.parse(input);
  const plans = new Map(ledger.planned.map(row => [row.trialId, row.sampleSha256]));
  if (plans.size !== ledger.planned.length) throw new Error('DUPLICATE_PLANNED_TRIAL');
  const seenTrials = new Set<string>(), seenTasks = new Set<string>();
  const counts = { complete: 0, limited: 0, historicalUnknown: 0, failed: 0, cancelled: 0, pending: 0 };
  let knownCostCny = 0, unknownCostTasks = 0;
  for (const row of ledger.observations) {
    if (plans.get(row.trialId) !== row.sampleSha256) throw new Error('UNPLANNED_OR_CHANGED_SAMPLE');
    // Never select the most favorable duplicate. A refreshed snapshot must
    // replace its previous row, not count as another successful trial.
    if (seenTrials.has(row.trialId) || seenTasks.has(row.taskId)) throw new Error('DUPLICATE_ANALYSIS_OBSERVATION');
    seenTrials.add(row.trialId); seenTasks.add(row.taskId);
    if ((row.status === 'succeeded') !== (row.report !== null)) throw new Error('REPORT_STATUS_MISMATCH');
    if (row.costComplete && row.knownCostCny === null) throw new Error('MISSING_COMPLETE_COST');
    knownCostCny += row.knownCostCny ?? 0;
    if (!row.costComplete) unknownCostTasks++;
    if (row.status === 'succeeded') {
      const report = row.report!;
      const state = sourceReportQuality({ ...report, analysisWarnings: report.legacyWarningPresent ? ['legacy'] : [] });
      counts[state === 'unknown' ? 'historicalUnknown' : state]++;
    } else if (row.status === 'queued' || row.status === 'running') counts.pending++;
    else counts[row.status]++;
  }
  const accepted = ledger.observations.length;
  const terminal = accepted - counts.pending;
  const readable = counts.complete + counts.limited + counts.historicalUnknown;
  return {
    execution: ledger.execution, mode: ledger.mode,
    planned: ledger.planned.length, accepted, missing: ledger.planned.length - accepted,
    counts, terminal,
    // All terminal tasks, including cancellation, stay in this denominator.
    completeRate: terminal ? counts.complete / terminal : null,
    limitedRate: terminal ? counts.limited / terminal : null,
    readableRate: terminal ? readable / terminal : null,
    knownCostCny, unknownCostTasks,
    evaluationComplete: ledger.planned.length > 0 && accepted === ledger.planned.length && counts.pending === 0,
    semanticQualityVerified: false,
  };
}
