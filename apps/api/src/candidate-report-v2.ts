import { z } from "zod";

/**
 * The model's output is a review candidate. It never represents a published
 * report and every item must remain explicitly reviewable by a teacher.
 */
export const candidateSupportSchema = z.enum([
  "observed",
  "hypothesis",
  "insufficient",
]);
export const candidateConfidenceSchema = z.enum(["high", "medium", "low"]);

export const candidateFeedbackSchema = z
  .object({
    criterionId: z.string().min(1).max(80),
    observation: z.string().min(1).max(3000),
    evidenceIds: z.array(z.string().min(1).max(120)).max(20),
    possibleCause: z.string().max(2000),
    support: candidateSupportSchema,
    nextStep: z.string().min(1).max(2000),
    confidence: candidateConfidenceSchema,
    needsReview: z.literal(true),
  })
  .strict();

export const candidateReportSchema = z
  .object({
    contractVersion: z.literal(2),
    analysisAttemptId: z.string().uuid(),
    baseRevisionId: z.string().uuid(),
    feedback: z.array(candidateFeedbackSchema).max(15),
    unresolvedQuestions: z.array(z.string().min(1).max(1000)).max(20),
    newEvidenceIds: z.array(z.string().min(1).max(120)).max(40),
    source: z.enum(["agent", "fallback"]),
    generatedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type CandidateFeedback = z.infer<typeof candidateFeedbackSchema>;
export type CandidateReport = z.infer<typeof candidateReportSchema>;

export type CandidateReportContext = {
  criterionIds: readonly string[];
  evidenceIds: ReadonlySet<string>;
  analysisAttemptId: string;
  baseRevisionId: string;
};

/**
 * Parse and enforce the cross-object rules that JSON schema alone cannot
 * express: one feedback item per enabled criterion and no cross-run evidence.
 */
export function validateCandidateReport(
  input: unknown,
  context: CandidateReportContext,
): CandidateReport {
  const report = candidateReportSchema.parse(input);
  if (report.analysisAttemptId !== context.analysisAttemptId)
    throw new Error("CANDIDATE_ANALYSIS_ID_MISMATCH");
  if (report.baseRevisionId !== context.baseRevisionId)
    throw new Error("CANDIDATE_BASE_REVISION_MISMATCH");

  const enabled = new Set(context.criterionIds);
  if (enabled.size !== context.criterionIds.length)
    throw new Error("CANDIDATE_CONTEXT_DUPLICATE_CRITERION");
  const seen = new Set<string>();
  for (const item of report.feedback) {
    if (!enabled.has(item.criterionId))
      throw new Error("CANDIDATE_CRITERION_NOT_ENABLED");
    if (seen.has(item.criterionId))
      throw new Error("CANDIDATE_CRITERION_DUPLICATE");
    seen.add(item.criterionId);
    for (const evidenceId of item.evidenceIds)
      if (!context.evidenceIds.has(evidenceId))
        throw new Error("CANDIDATE_EVIDENCE_OUT_OF_SCOPE");
    if (item.support === "observed" && item.possibleCause.trim())
      throw new Error("CANDIDATE_OBSERVED_HAS_UNSUPPORTED_CAUSE");
  }
  if (seen.size !== enabled.size)
    throw new Error("CANDIDATE_CRITERIA_INCOMPLETE");
  for (const evidenceId of report.newEvidenceIds)
    if (!context.evidenceIds.has(evidenceId))
      throw new Error("CANDIDATE_NEW_EVIDENCE_OUT_OF_SCOPE");
  return report;
}
