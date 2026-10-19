import type { FeedbackItem } from '@codelab/contracts/v2';

export type ReviewDraft = {
  id: string; revisionId: string; savedAt: string; feedback: FeedbackItem[];
  judgments: Record<string, any>; publicEvidenceIds: string[]; correctionReason: string;
};
export type DraftBundle = { current: ReviewDraft | null; preserved: ReviewDraft[] };
const MAX_BYTES = 1_000_000, MAX_AGE = 7 * 24 * 3600_000;
const key = (userId: string, runId: string) => `codelab:review-draft:v1:${userId}:${runId}`;
const text = (value: unknown) => typeof value === 'string' && value.length <= 20000;
function validDraft(value: any): value is ReviewDraft {
  return value && text(value.id) && text(value.revisionId) && Number.isFinite(Date.parse(value.savedAt))
    && text(value.correctionReason) && Array.isArray(value.feedback) && value.feedback.length <= 15
    && value.feedback.every((f: any) => f && text(f.criterionId) && text(f.observation) && text(f.possibleCause) && text(f.nextStep))
    && value.judgments && typeof value.judgments === 'object' && !Array.isArray(value.judgments)
    && Object.keys(value.judgments).length <= 80
    && Object.values(value.judgments).every((j: any) => j && typeof j.enabled === 'boolean'
      && ['case','manualCriterion'].includes(j.targetType) && text(j.targetId)
      && ['passed','failed','not_run','manual'].includes(j.verdict) && text(j.reason) && text(j.verificationNote)
      && ['evidence_review','manual_reproduction','other_documented'].includes(j.verificationMethod)
      && Array.isArray(j.evidenceRefs) && j.evidenceRefs.length <= 100)
    && Array.isArray(value.publicEvidenceIds) && value.publicEvidenceIds.length <= 1000
    && value.publicEvidenceIds.every(text);
}

/** Account/run scoping protects app navigation, not other users of this browser profile. */
export function reviewDraftStore(storage: Storage, userId: string, runId: string) {
  const storageKey = key(userId, runId);
  let observed: string | null = null;
  return {
    read(): DraftBundle | null {
      observed = storage.getItem(storageKey);
      if (!observed) return null;
      if (new TextEncoder().encode(observed).length > MAX_BYTES) throw new Error('DRAFT_TOO_LARGE');
      const value = JSON.parse(observed, (name, item) => {
        if (['__proto__','constructor','prototype'].includes(name)) throw new Error('DRAFT_INVALID');
        return item;
      });
      if (value.version !== 1 || value.userId !== userId || value.runId !== runId
        || !Number.isFinite(value.updatedAt) || value.updatedAt > Date.now() + 60000
        || !(value.current === null || validDraft(value.current))
        || !Array.isArray(value.preserved) || value.preserved.length > 10 || !value.preserved.every(validDraft))
        throw new Error('DRAFT_INVALID');
      if (Date.now() - value.updatedAt > MAX_AGE) { storage.removeItem(storageKey); observed = null; return null; }
      return { current: value.current, preserved: value.preserved };
    },
    write(bundle: DraftBundle) {
      // Detect another tab's save. Do not silently erase its recovery copy.
      if (storage.getItem(storageKey) !== observed) throw new Error('DRAFT_CHANGED_IN_OTHER_TAB');
      if (!bundle.current && !bundle.preserved.length) { storage.removeItem(storageKey); observed = null; return; }
      if ((bundle.current && !validDraft(bundle.current)) || bundle.preserved.length > 10 || !bundle.preserved.every(validDraft))
        throw new Error('DRAFT_INVALID');
      const encoded = JSON.stringify({version:1,userId,runId,updatedAt:Date.now(),...bundle});
      if (new TextEncoder().encode(encoded).length > MAX_BYTES) throw new Error('DRAFT_TOO_LARGE');
      storage.setItem(storageKey, encoded); observed = encoded;
    },
  };
}
