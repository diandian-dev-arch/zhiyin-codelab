import { z } from 'zod';

const code = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const sha = z.string().regex(/^[0-9a-f]{64}$/);
const count = z.number().int().nonnegative().max(1e9);
export const evaluationArtifact = z.object({
  path: z.string().min(1).max(500), sha256: sha,
}).strict();
const opportunityCondition = z.object({
  value: z.boolean().nullable(),
  evidence: z.array(evaluationArtifact).max(20),
}).strict().refine(v => v.value === null || v.evidence.length > 0, 'Known conditions require evidence');
export const probeOpportunitySchema = z.object({
  probeId: z.literal('FILTER_ORDER_CHECK'),
  ruleEnabled: opportunityCondition,
  filterFailed: opportunityCondition,
  preparationPossible: opportunityCondition,
  pathBCoveredByBase: opportunityCondition,
}).strict();
/** Opportunity is a prerequisite, never proof of new facts or teaching benefit. */
export function classifyProbeOpportunity(value?: z.infer<typeof probeOpportunitySchema> | null) {
  if (!value) return 'unknown' as const;
  const conditions = [value.ruleEnabled.value, value.filterFailed.value,
    value.preparationPossible.value, value.pathBCoveredByBase.value === null ? null : !value.pathBCoveredByBase.value];
  if (conditions.includes(false)) return 'ineligible' as const;
  return conditions.includes(null) ? 'unknown' as const : 'eligible' as const;
}
export const evaluationLedgerSchema = z.object({
  version: z.literal('evaluation-ledger-v1'), experimentId: code,
  plannedAt: z.string().datetime({ offset: true }),
  registrySha256: sha,
  protocol: evaluationArtifact,
  plannedTrials: z.array(z.object({
    trialId: code, sampleId: code, reviewerCode: code,
    group: z.enum(['H', 'R', 'S', 'A']), repetition: z.number().int().min(1).max(100),
    comparisonBlock: code,
  }).strict()).max(10000),
  trials: z.array(z.object({
    trialId: code, source: z.enum(['synthetic', 'reviewer-recorded']),
    status: z.enum(['completed', 'failed', 'aborted']),
    startedAt: z.string().datetime({ offset: true }), endedAt: z.string().datetime({ offset: true }),
    priorExposure: z.enum(['none', 'same-family', 'same-sample', 'unknown']),
    blinded: z.boolean(),
    input: z.object({ zipSha256: sha, ruleSha256: sha, environmentSha256: sha, baseEvidenceSha256: sha.nullable() }).strict(),
    phaseMs: z.object({ setup: count, executionWait: count, reading: count, editing: count, publication: count }).strict(),
    runId: z.string().uuid().nullable(), analysisAttemptId: z.string().uuid().nullable(),
    candidate: evaluationArtifact.nullable(), teacherRevision: evaluationArtifact.nullable(),
    publication: evaluationArtifact.nullable(), failureCode: code.nullable(),
    evidence: z.array(evaluationArtifact).max(100), pixelsRead: z.boolean(),
    probeOpportunity: probeOpportunitySchema.nullable().optional(),
    model: z.object({
      configuration: evaluationArtifact, calls: count,
      requests: z.array(evaluationArtifact).max(10), responses: z.array(evaluationArtifact).max(10),
      inputTokens: count.nullable(), outputTokens: count.nullable(),
      cost: z.number().finite().nonnegative().nullable(), currency: z.enum(['CNY', 'USD']),
      pricing: evaluationArtifact.nullable(),
    }).strict().nullable(),
    rating: z.object({
      independentReview: evaluationArtifact,
      falsePositive: count.nullable(), falseNegative: count.nullable(), notRun: count.nullable(),
      factualErrors: count.nullable(), unsupportedCauses: count.nullable(), badReferences: count.nullable(),
      actionable: z.boolean().nullable(), editedCharacters: count.nullable(), reuseIntent: z.boolean().nullable(),
    }).strict().nullable(),
  }).strict()).max(10000),
}).strict();
export type EvaluationLedger = z.infer<typeof evaluationLedgerSchema>;

export const evaluationRegistrySchema = z.object({
  samples: z.array(z.object({
    sampleId: code, familyId: code, partition: z.enum(['development', 'validation', 'frozen']),
    originalZipSha256: sha, archivePath: z.string().min(1).max(500),
    frozenEvaluationEligible: z.boolean(),
  }).passthrough()).max(10000),
}).passthrough();
