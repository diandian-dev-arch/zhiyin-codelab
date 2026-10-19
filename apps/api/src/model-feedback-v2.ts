import { z } from 'zod';
import { modelFeedbackDraftSchema, type FeedbackItem } from '@codelab/contracts/v2';

export const MODEL_FEEDBACK_REQUEST_OUTPUT_TOKENS = 2200;
export const MODEL_FEEDBACK_PROMPT_VERSIONS = {
  summary: 'sealed-text-summary-v4-observation-bounds',
  agent: 'restricted-text-agent-v4-explicit-support',
} as const;
export function compactModelFeedbackV2(base: FeedbackItem[]) {
  return base.map(({ criterionId, observation, possibleCause, nextStep, causeSupport, causeEvidenceRefs }) => ({
    criterionId, observation, possibleCause, nextStep, causeSupport, causeEvidenceRefs,
  }));
}

// The model writes prose, not a second copy of immutable execution observations.
// Full drafts remain accepted for persisted v1 integrations, with existing downstream checks.
const compactItem = z.object({
  criterionId: z.string(),
  observation: z.string().trim().min(1).max(5000),
  possibleCause: z.string().trim().max(3000),
  nextStep: z.string().trim().max(3000),
  causeSupport: z.enum(['direct', 'limited', 'insufficient']),
  causeEvidenceRefs: z.array(z.unknown()).max(200),
}).strict();
export const modelFeedbackWireSchemaV2 = z.union([
  modelFeedbackDraftSchema.shape.feedback,
  z.array(compactItem).min(1).max(15),
]);

export function expandModelFeedbackV2(value: unknown, base: FeedbackItem[]) {
  const items = modelFeedbackWireSchemaV2.parse(value);
  if (items.length !== base.length || new Set(items.map(i => i.criterionId)).size !== base.length
    || items.some(i => !base.some(b => b.criterionId === i.criterionId)))
    throw new Error('MODEL_CRITERIA_MISMATCH');
  const draft = modelFeedbackDraftSchema.parse({ feedback: items.map(item => {
    if ('caseIds' in item) return item;
    const original = base.find(b => b.criterionId === item.criterionId)!;
    return { ...original, ...item, needsTeacherReview: true };
  }) });
  // A model may summarize observations, but it cannot turn an observed case
  // into a blanket implementation verdict or waive teacher review.
  const unsupported = /(功能实现正确|逻辑正确实现|机制正确实现|功能正常|无需进一步操作|实现正确)/;
  if (draft.feedback.some(item => unsupported.test(`${item.possibleCause} ${item.nextStep}`)))
    throw new Error('UNSUPPORTED_MODEL_CERTAINTY');
  return draft;
}
