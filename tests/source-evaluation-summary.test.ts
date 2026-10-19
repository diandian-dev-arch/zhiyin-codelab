import { expect, it } from 'vitest';
import { summarizeSourceEvaluation } from '../packages/contracts/src/source-evaluation';

const sha = 'a'.repeat(64);
const row = (taskId: string, status = 'succeeded', report: unknown = { reportQuality: 'complete', legacyWarningPresent: false }) => ({
  trialId: taskId, taskId, sampleSha256: sha, status, report, knownCostCny: null, costComplete: false,
});
const ledger = (observations: ReturnType<typeof row>[]) => ({ version: 1, execution: 'offline-fixture', mode: 'quick', buildSha256: sha, modelConfigSha256: sha,
  planned: observations.map(({ trialId }) => ({ trialId, sampleSha256: sha })), observations });

it('separates complete, limited, legacy, failures, cancellations and pending tasks', () => {
  const result = summarizeSourceEvaluation(ledger([
    row('complete'), row('limited', 'succeeded', { reportQuality: 'complete', legacyWarningPresent: true }),
    row('old', 'succeeded', { legacyWarningPresent: false }), row('failed', 'failed', null),
    row('cancelled', 'cancelled', null), row('pending', 'running', null),
  ]));
  expect(result.counts).toEqual({ complete: 1, limited: 1, historicalUnknown: 1, failed: 1, cancelled: 1, pending: 1 });
  expect(result).toMatchObject({ accepted: 6, terminal: 5, completeRate: .2, limitedRate: .2, readableRate: .6, unknownCostTasks: 6, evaluationComplete: false, semanticQualityVerified: false });
});

it('does not report empty or unobserved plans as successful evaluation', () => {
  expect(summarizeSourceEvaluation(ledger([]))).toMatchObject({ completeRate: null, evaluationComplete: false });
  const input = ledger([]); input.planned.push({ trialId: 'missing', sampleSha256: sha });
  expect(summarizeSourceEvaluation(input)).toMatchObject({ missing: 1, accepted: 0, evaluationComplete: false });
});

it('rejects duplicate tasks, changed samples, mismatched reports and incomplete cost claims', () => {
  expect(() => summarizeSourceEvaluation(ledger([row('a'), row('a')]))).toThrow('DUPLICATE_PLANNED_TRIAL');
  const duplicate = ledger([row('a'), row('b')]); duplicate.observations[1].taskId = 'a';
  expect(() => summarizeSourceEvaluation(duplicate)).toThrow('DUPLICATE_ANALYSIS_OBSERVATION');
  const changed = ledger([row('a')]); changed.observations[0].sampleSha256 = 'b'.repeat(64);
  expect(() => summarizeSourceEvaluation(changed)).toThrow('UNPLANNED_OR_CHANGED_SAMPLE');
  expect(() => summarizeSourceEvaluation(ledger([row('a', 'failed')]))).toThrow('REPORT_STATUS_MISMATCH');
  const cost = ledger([row('a')]); cost.observations[0].costComplete = true;
  expect(() => summarizeSourceEvaluation(cost)).toThrow('MISSING_COMPLETE_COST');
});

it('retains known partial costs and rejects unexpected private fields', () => {
  const input = ledger([row('a')]);
  expect(summarizeSourceEvaluation({ ...input, observations: [{ ...input.observations[0], knownCostCny: .12 }] })).toMatchObject({ knownCostCny: .12, unknownCostTasks: 1 });
  expect(() => summarizeSourceEvaluation({ ...input, apiKey: 'do-not-echo' })).toThrow();
});
