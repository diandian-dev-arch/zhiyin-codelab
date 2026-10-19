import { it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FeedbackItem } from '../packages/contracts/src/v2/index.js';
import { expandModelFeedbackV2 } from '../apps/api/src/model-feedback-v2.js';

const base: FeedbackItem[] = [{ criterionId: 'FILTER', caseIds: ['FILTER-01'], observation: '基础观察',
  reproductionSteps: [{ caseId: 'FILTER-01', stepId: 'select', description: '选择筛选项' }],
  observationEvidenceRefs: [{ scope: 'current', manifestId: randomUUID(), evidenceId: randomUUID() }],
  possibleCause: '', causeSupport: 'insufficient', causeEvidenceRefs: [], nextStep: '', needsTeacherReview: true }];
const compact = { criterionId: 'FILTER', observation: '筛选行为已有封存观察', possibleCause: '原因待确认',
  nextStep: '教师核查条件组合', causeSupport: 'insufficient', causeEvidenceRefs: [] };
it('expands compact prose while preserving real execution steps and evidence without mutating the baseline', () => {
  const original = structuredClone(base);
  expect(expandModelFeedbackV2([compact], base).feedback[0]).toEqual({ ...base[0], ...compact });
  expect(base).toEqual(original);
});
it('rejects missing, duplicated, foreign criteria and attempts to overwrite immutable fields in compact drafts', () => {
  for (const value of [[], [compact, compact], [{ ...compact, criterionId: 'OTHER' }],
    [{ ...compact, observationEvidenceRefs: [] }], [{ ...compact, needsTeacherReview: false }],
    [{ ...compact, causeSupport: 'direct' }], [{ ...compact, causeEvidenceRefs: [{ evidenceId: 'bad' }] }]])
    expect(() => expandModelFeedbackV2(value, base)).toThrow();
});
it('preserves complete legacy drafts for the existing downstream provenance validation', () => {
  expect(expandModelFeedbackV2(base, base).feedback).toEqual(base);
});
it('rejects implementation verdicts that exceed the observed evidence', () => {
  expect(() => expandModelFeedbackV2([{ ...compact, possibleCause: '功能实现正确。' }], base)).toThrow('UNSUPPORTED_MODEL_CERTAINTY');
});
