import { classifyProbeOpportunity, evaluationLedgerSchema, evaluationRegistrySchema } from '../packages/contracts/src/evaluation.js';

/** Validates provenance declarations, not their truth. Never infers teacher consent or quality. */
export function validateEvaluationLedger(input: unknown, registryInput: unknown) {
  const ledger = evaluationLedgerSchema.parse(input), registry = evaluationRegistrySchema.parse(registryInput);
  const reject = (code: string): never => { throw new Error(code); };
  const samples = new Map(registry.samples.map(s => [s.sampleId, s]));
  if (samples.size !== registry.samples.length) reject('DUPLICATE_SAMPLE');
  const families = new Map<string, string>();
  for (const sample of samples.values()) {
    if (families.has(sample.familyId) && families.get(sample.familyId) !== sample.partition) reject('FAMILY_PARTITION_LEAK');
    if (sample.partition === 'frozen' && !sample.frozenEvaluationEligible) reject('DEVELOPMENT_SAMPLE_NOT_FROZEN_ELIGIBLE');
    families.set(sample.familyId, sample.partition);
  }
  const plans = new Map(ledger.plannedTrials.map(p => [p.trialId, p]));
  if (plans.size !== ledger.plannedTrials.length) reject('DUPLICATE_PLANNED_TRIAL');
  const assignments = new Set<string>();
  for (const plan of plans.values()) {
    if (!samples.has(plan.sampleId)) reject('UNREGISTERED_SAMPLE');
    const key = JSON.stringify([plan.comparisonBlock, plan.sampleId, plan.group, plan.repetition]);
    if (assignments.has(key)) reject('DUPLICATE_GROUP_REPETITION');
    assignments.add(key);
  }
  const recorded = new Set<string>(), blocks = new Map<string, string>();
  for (const trial of ledger.trials) {
    const plan = plans.get(trial.trialId);
    if (!plan) reject('UNPLANNED_TRIAL');
    if (recorded.has(trial.trialId)) reject('DUPLICATE_RECORDED_TRIAL');
    recorded.add(trial.trialId);
    const sample = samples.get(plan!.sampleId)!;
    if (trial.input.zipSha256 !== sample.originalZipSha256) reject('TRIAL_SAMPLE_HASH_MISMATCH');
    const materialHashes = new Set(trial.evidence.map(e => e.sha256));
    if (trial.probeOpportunity) {
      const opportunity = trial.probeOpportunity;
      for (const condition of [opportunity.ruleEnabled, opportunity.filterFailed, opportunity.preparationPossible, opportunity.pathBCoveredByBase]) {
        for (const ref of condition.evidence) {
          if (!trial.evidence.some(e => e.path === ref.path && e.sha256 === ref.sha256)) reject('OPPORTUNITY_PROVENANCE_MISSING');
        }
      }
      if (opportunity.ruleEnabled.value !== null && !opportunity.ruleEnabled.evidence.some(e => e.sha256 === trial.input.ruleSha256)) reject('OPPORTUNITY_RULE_MISMATCH');
      for (const condition of [opportunity.filterFailed, opportunity.pathBCoveredByBase]) {
        if (condition.value !== null && (!trial.input.baseEvidenceSha256 || !condition.evidence.some(e => e.sha256 === trial.input.baseEvidenceSha256))) reject('OPPORTUNITY_BASE_MISMATCH');
      }
    }
    for (const sha of [trial.input.ruleSha256, trial.input.environmentSha256, trial.input.baseEvidenceSha256])
      if (sha && !materialHashes.has(sha)) reject('INPUT_PROVENANCE_MISSING');
    const started = Date.parse(trial.startedAt), ended = Date.parse(trial.endedAt);
    if (started < Date.parse(ledger.plannedAt) || ended < started) reject('TRIAL_CLOCK_INVALID');
    if (Object.values(trial.phaseMs).reduce((a, b) => a + b, 0) > ended - started) reject('PHASE_TIME_EXCEEDS_ELAPSED');
    if (trial.status === 'completed' && (!trial.publication || !trial.teacherRevision || trial.failureCode)) reject('PUBLICATION_ENDPOINT_REQUIRED');
    if (trial.status !== 'completed' && !trial.failureCode) reject('FAILURE_CLASSIFICATION_REQUIRED');
    const modeled = plan!.group === 'S' || plan!.group === 'A';
    if (!modeled && (trial.model || trial.candidate || trial.analysisAttemptId)) reject('MODEL_IN_NONMODEL_ARM');
    if (modeled && (!trial.model || !trial.input.baseEvidenceSha256)) reject('MODEL_ARM_RECORD_REQUIRED');
    if (modeled && trial.status === 'completed' && !trial.analysisAttemptId) reject('ANALYSIS_ID_REQUIRED');
    if (plan!.group !== 'H' && trial.status === 'completed' && !trial.runId) reject('RUN_ID_REQUIRED');
    if (trial.model) {
      if (trial.model.requests.length !== trial.model.calls || trial.model.responses.length > trial.model.calls) reject('MODEL_CALL_LEDGER_MISMATCH');
      if (trial.model.cost !== null && !trial.model.pricing) reject('PRICING_PROVENANCE_REQUIRED');
      if (plan!.group === 'S' && trial.model.calls > 1) reject('SUMMARY_ARM_MULTIPLE_CALLS');
    }
    if (modeled) {
      const key = JSON.stringify([plan!.comparisonBlock, plan!.sampleId, plan!.repetition]);
      const baseline = JSON.stringify([trial.input, trial.source, trial.model!.configuration.sha256]);
      if (blocks.has(key) && blocks.get(key) !== baseline) reject('SA_BASELINE_MISMATCH');
      blocks.set(key, baseline);
    }
  }
  const groups = (['H', 'R', 'S', 'A'] as const).map(group => {
    const planned = ledger.plannedTrials.filter(p => p.group === group);
    const results = ledger.trials.filter(t => plans.get(t.trialId)!.group === group);
    return {
      group, planned: planned.length, recorded: results.length, missing: planned.length - results.length,
      completed: results.filter(t => t.status === 'completed').length,
      failed: results.filter(t => t.status === 'failed').length, aborted: results.filter(t => t.status === 'aborted').length,
      synthetic: results.filter(t => t.source === 'synthetic').length,
      reviewerRecorded: results.filter(t => t.source === 'reviewer-recorded').length,
      unrated: results.filter(t => !t.rating).length,
      unknownCost: results.filter(t => t.model && t.model.cost === null).length,
      probeOpportunity: Object.fromEntries(['synthetic', 'reviewer-recorded'].map(source => [source,
        Object.fromEntries(['eligible', 'ineligible', 'unknown'].map(state => [state,
          results.filter(t => t.source === source && classifyProbeOpportunity(t.probeOpportunity) === state).length])),
      ])),
      knownCostByCurrency: Object.fromEntries(['CNY', 'USD'].map(currency => {
        const known = results.filter(t => t.model?.currency === currency && t.model.cost !== null);
        return [currency, known.length ? known.reduce((sum, t) => sum + t.model!.cost!, 0) : null];
      })),
      completedElapsedMs: results.filter(t => t.status === 'completed').map(t => Date.parse(t.endedAt) - Date.parse(t.startedAt)),
    };
  });
  return { ledger, registry, summary: {
    state: ledger.trials.length === 0 ? 'no_observations' : recorded.size < plans.size ? 'incomplete_records' : 'records_validated',
    groups, qualityEvaluationCompleted: false,
    limitation: 'Record integrity only; no independent confirmation of consent, human authorship, equal feedback quality, or model superiority. No accuracy or time-saving percentage inferred.',
  } };
}
