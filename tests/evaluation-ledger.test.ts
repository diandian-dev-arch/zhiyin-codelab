import { expect, it } from 'vitest';
import { validateEvaluationLedger } from '../scripts/evaluation-ledger';
import type { EvaluationLedger } from '../packages/contracts/src/evaluation';
import { classifyProbeOpportunity, probeOpportunitySchema } from '../packages/contracts/src/evaluation';
const hash = 'a'.repeat(64), artifact = { path: '.data/eval/example.json', sha256: hash };
const registry = { samples: [{ sampleId: 'sample', familyId: 'family', partition: 'development',
  originalZipSha256: hash, archivePath: 'fixtures/sample.zip', frozenEvaluationEligible: false }] };
function opportunity() {
  const known = (value: boolean | null) => ({ value, evidence: [artifact] });
  return { probeId: 'FILTER_ORDER_CHECK' as const, ruleEnabled: known(true), filterFailed: known(true),
    preparationPossible: known(true), pathBCoveredByBase: known(false) };
}
it('requires all four opportunity conditions and distinguishes absence from exclusion', () => {
  for (const enabled of [true, false, null]) for (const failed of [true, false, null])
    for (const preparation of [true, false, null]) for (const covered of [true, false, null]) {
      const value = opportunity();
      value.ruleEnabled.value = enabled; value.filterFailed.value = failed;
      value.preparationPossible.value = preparation; value.pathBCoveredByBase.value = covered;
      const excluded = enabled === false || failed === false || preparation === false || covered === true;
      const complete = enabled === true && failed === true && preparation === true && covered === false;
      expect(classifyProbeOpportunity(probeOpportunitySchema.parse(value))).toBe(excluded ? 'ineligible' : complete ? 'eligible' : 'unknown');
    }
  expect(classifyProbeOpportunity()).toBe('unknown');
});
it('requires evidence for known opportunity conditions and exact trial provenance', () => {
  const ledger = fixture(); ledger.trials[0].probeOpportunity = opportunity();
  expect(() => validateEvaluationLedger(ledger, registry)).not.toThrow();
  ledger.trials[0].probeOpportunity.ruleEnabled.evidence = [];
  expect(() => validateEvaluationLedger(ledger, registry)).toThrow();
  ledger.trials[0].probeOpportunity = opportunity();
  ledger.trials[0].probeOpportunity.preparationPossible.evidence = [{ ...artifact, path: '.data/other.json' }];
  expect(() => validateEvaluationLedger(ledger, registry)).toThrow('OPPORTUNITY_PROVENANCE_MISSING');
});
it('binds opportunity rule and base judgments to the actual trial input hashes', () => {
  const other = { path: '.data/eval/other.json', sha256: 'b'.repeat(64) };
  const ledger = fixture(); ledger.trials[0].evidence.push(other); ledger.trials[0].probeOpportunity = opportunity();
  ledger.trials[0].probeOpportunity.ruleEnabled.evidence = [other];
  expect(() => validateEvaluationLedger(ledger, registry)).toThrow('OPPORTUNITY_RULE_MISMATCH');
  ledger.trials[0].probeOpportunity.ruleEnabled.evidence = [artifact];
  ledger.trials[0].probeOpportunity.pathBCoveredByBase.evidence = [other];
  expect(() => validateEvaluationLedger(ledger, registry)).toThrow('OPPORTUNITY_BASE_MISMATCH');
});
it('separates synthetic opportunity claims from reviewer records and keeps old records unknown', () => {
  const ledger = fixture();
  expect(validateEvaluationLedger(ledger, registry).summary.groups[1].probeOpportunity).toEqual({
    synthetic: { eligible: 0, ineligible: 0, unknown: 1 }, 'reviewer-recorded': { eligible: 0, ineligible: 0, unknown: 0 },
  });
  ledger.trials[0].probeOpportunity = opportunity();
  const summary = validateEvaluationLedger(ledger, registry).summary;
  expect(summary.groups[1].probeOpportunity.synthetic.eligible).toBe(1);
  expect(summary.groups[1].probeOpportunity['reviewer-recorded'].eligible).toBe(0);
  expect(summary.qualityEvaluationCompleted).toBe(false);
});
function fixture(): EvaluationLedger {
  return { version: 'evaluation-ledger-v1', experimentId: 'synthetic-test', plannedAt: '2026-09-28T00:00:00Z',
    registrySha256: hash, protocol: artifact,
    plannedTrials: [{ trialId: 'trial', group: 'R', sampleId: 'sample', reviewerCode: 'synthetic', repetition: 1, comparisonBlock: 'block' }],
    trials: [{ trialId: 'trial', source: 'synthetic', status: 'completed',
      startedAt: '2026-09-28T01:00:00Z', endedAt: '2026-09-28T01:01:00Z', priorExposure: 'unknown', blinded: false,
      input: { zipSha256: hash, ruleSha256: hash, environmentSha256: hash, baseEvidenceSha256: hash },
      phaseMs: { setup: 0, executionWait: 10000, reading: 10000, editing: 10000, publication: 10000 },
      runId: '11111111-1111-4111-8111-111111111111', analysisAttemptId: null,
      candidate: null, teacherRevision: artifact, publication: artifact, failureCode: null,
      evidence: [artifact], pixelsRead: false, model: null, rating: null }] };
}
it('retains missing, failed and aborted trials in the planned denominator', () => {
  const ledger = fixture();
  for (const [trialId, status] of [['failed', 'failed'], ['aborted', 'aborted']] as const) {
    ledger.plannedTrials.push({ ...ledger.plannedTrials[0], trialId, repetition: ledger.plannedTrials.length + 1 });
    ledger.trials.push({ ...ledger.trials[0], trialId, status, publication: null, failureCode: 'NOT_PUBLISHED' });
  }
  ledger.plannedTrials.push({ ...ledger.plannedTrials[0], trialId: 'missing', repetition: 4 });
  const { summary } = validateEvaluationLedger(ledger, registry);
  expect(summary.state).toBe('incomplete_records');
  expect(summary.groups[1]).toMatchObject({ planned: 4, recorded: 3, completed: 1, failed: 1, aborted: 1, missing: 1, synthetic: 3 });
  expect(summary.qualityEvaluationCompleted).toBe(false);
});
it('does not count a candidate as the completed publication endpoint', () => {
  const ledger = fixture(); ledger.trials[0].publication = null;
  expect(() => validateEvaluationLedger(ledger, registry)).toThrow('PUBLICATION_ENDPOINT_REQUIRED');
});
it('rejects unplanned, duplicate and changed-sample observations', () => {
  const ledger = fixture(); ledger.trials[0].trialId = 'unplanned';
  expect(() => validateEvaluationLedger(ledger, registry)).toThrow('UNPLANNED_TRIAL');
  const duplicate = fixture(); duplicate.trials.push(duplicate.trials[0]);
  expect(() => validateEvaluationLedger(duplicate, registry)).toThrow('DUPLICATE_RECORDED_TRIAL');
  const changed = fixture(); changed.trials[0].input.zipSha256 = 'b'.repeat(64);
  expect(() => validateEvaluationLedger(changed, registry)).toThrow('TRIAL_SAMPLE_HASH_MISMATCH');
});
it('rejects family leakage and relabelled development fixtures', () => {
  const contaminated = structuredClone(registry);
  contaminated.samples.push({ ...contaminated.samples[0], sampleId: 'second', partition: 'validation' });
  expect(() => validateEvaluationLedger(fixture(), contaminated)).toThrow('FAMILY_PARTITION_LEAK');
  contaminated.samples = [{ ...registry.samples[0], partition: 'frozen' }];
  expect(() => validateEvaluationLedger(fixture(), contaminated)).toThrow('DEVELOPMENT_SAMPLE_NOT_FROZEN_ELIGIBLE');
});
function modelFixture() {
  const ledger = fixture(); ledger.plannedTrials[0].group = 'S';
  ledger.trials[0].analysisAttemptId = ledger.trials[0].runId;
  ledger.trials[0].model = { configuration: artifact, calls: 1, requests: [artifact], responses: [],
    inputTokens: null, outputTokens: null, cost: null, currency: 'USD', pricing: null };
  return ledger;
}
it('keeps unknown usage and cost unknown including lost-response calls', () => {
  const { summary } = validateEvaluationLedger(modelFixture(), registry);
  expect(summary.groups[2]).toMatchObject({ unknownCost: 1, knownCostByCurrency: { CNY: null, USD: null } });
});
it('rejects different S/A baselines and different model configurations', () => {
  const ledger = modelFixture();
  ledger.plannedTrials.push({ ...ledger.plannedTrials[0], trialId: 'agent', group: 'A' });
  ledger.trials.push({ ...structuredClone(ledger.trials[0]), trialId: 'agent' });
  expect(() => validateEvaluationLedger(ledger, registry)).not.toThrow();
  ledger.trials[1].input.baseEvidenceSha256 = 'b'.repeat(64);
  ledger.trials[1].evidence.push({ ...artifact, sha256: 'b'.repeat(64) });
  expect(() => validateEvaluationLedger(ledger, registry)).toThrow('SA_BASELINE_MISMATCH');
  ledger.trials[1].input.baseEvidenceSha256 = hash;
  ledger.trials[1].model!.configuration = { ...artifact, sha256: 'b'.repeat(64) };
  expect(() => validateEvaluationLedger(ledger, registry)).toThrow('SA_BASELINE_MISMATCH');
});
it('rejects model data in R, multiple S calls and cost without pricing provenance', () => {
  const ledger = modelFixture(); ledger.plannedTrials[0].group = 'R';
  expect(() => validateEvaluationLedger(ledger, registry)).toThrow('MODEL_IN_NONMODEL_ARM');
  ledger.plannedTrials[0].group = 'S'; ledger.trials[0].model!.calls = 2; ledger.trials[0].model!.requests.push(artifact);
  expect(() => validateEvaluationLedger(ledger, registry)).toThrow('SUMMARY_ARM_MULTIPLE_CALLS');
  const cost = modelFixture(); cost.trials[0].model!.cost = 0;
  expect(() => validateEvaluationLedger(cost, registry)).toThrow('PRICING_PROVENANCE_REQUIRED');
});
it('rejects reversed clocks, observations before plan and impossible phase sums', () => {
  const ledger = fixture(); ledger.trials[0].endedAt = '2026-09-28T00:30:00Z';
  expect(() => validateEvaluationLedger(ledger, registry)).toThrow('TRIAL_CLOCK_INVALID');
  const early = fixture(); early.plannedAt = '2026-09-28T02:00:00Z';
  expect(() => validateEvaluationLedger(early, registry)).toThrow('TRIAL_CLOCK_INVALID');
  const long = fixture(); long.trials[0].phaseMs.reading = 60001;
  expect(() => validateEvaluationLedger(long, registry)).toThrow('PHASE_TIME_EXCEEDS_ELAPSED');
});
it('never treats an empty ledger as a completed evaluation', () => {
  const ledger = fixture(); ledger.plannedTrials = []; ledger.trials = [];
  const { summary } = validateEvaluationLedger(ledger, registry);
  expect(summary.state).toBe('no_observations');
  expect(summary.qualityEvaluationCompleted).toBe(false);
});
it('requires material references for the recorded input identities', () => {
  const ledger = fixture(); ledger.trials[0].evidence = [];
  expect(() => validateEvaluationLedger(ledger, registry)).toThrow('INPUT_PROVENANCE_MISSING');
});
