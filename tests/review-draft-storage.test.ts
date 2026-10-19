import { describe, it, expect } from 'vitest';
import { reviewDraftStore, type ReviewDraft } from '../apps/web/src/review-draft-storage.js';
function storage() {
  const values = new Map<string,string>();
  return { getItem: (k:string) => values.get(k) ?? null, setItem: (k:string,v:string) => {values.set(k,v);},
    removeItem: (k:string) => {values.delete(k);} } as Storage;
}
function draft(): ReviewDraft { return {id:'draft',revisionId:'original-revision',savedAt:new Date().toISOString(),
  feedback:[],judgments:{},publicEvidenceIds:[],correctionReason:'未完成的更正理由'}; }
describe('teacher browser recovery storage', () => {
  it('survives a new store but isolates accounts and reports; empty state removes it', () => {
    const s=storage(), first=reviewDraftStore(s,'teacher-a','run-a'), current=draft();
    expect(first.read()).toBeNull(); first.write({current,preserved:[]});
    expect(reviewDraftStore(s,'teacher-a','run-a').read()?.current).toEqual(current);
    expect(reviewDraftStore(s,'teacher-b','run-a').read()).toBeNull();
    expect(reviewDraftStore(s,'teacher-a','run-b').read()).toBeNull();
    first.write({current:null,preserved:[]}); expect(first.read()).toBeNull();
  });
  it('refuses stale-tab overwrite or deletion, retaining the newer tab content', () => {
    const s=storage(), a=reviewDraftStore(s,'a','r'), b=reviewDraftStore(s,'a','r');
    a.read(); b.read(); a.write({current:draft(),preserved:[]});
    expect(()=>b.write({current:null,preserved:[]})).toThrow('DRAFT_CHANGED_IN_OTHER_TAB');
    expect(reviewDraftStore(s,'a','r').read()?.current?.correctionReason).toBe('未完成的更正理由');
  });
  it('expires after seven days and rejects altered account binding and unsafe object keys', () => {
    const s=storage(), k='codelab:review-draft:v1:a:r';
    const entry={version:1,userId:'a',runId:'r',updatedAt:Date.now()-8*86400000,current:draft(),preserved:[]};
    s.setItem(k,JSON.stringify(entry)); expect(reviewDraftStore(s,'a','r').read()).toBeNull();
    s.setItem(k,JSON.stringify({...entry,updatedAt:Date.now(),userId:'b'}));
    expect(()=>reviewDraftStore(s,'a','r').read()).toThrow('DRAFT_INVALID');
    s.setItem(k,'{"__proto__":{}}'); expect(()=>reviewDraftStore(s,'a','r').read()).toThrow('DRAFT_INVALID');
  });
  it('keeps prior storage intact when quota prevents a backup', () => {
    const s=storage(), store=reviewDraftStore(s,'a','r'); store.read();
    store.write({current:draft(),preserved:[]});
    s.setItem=()=>{throw new Error('QuotaExceededError');};
    expect(()=>store.write({current:{...draft(),correctionReason:'replacement'},preserved:[]})).toThrow('QuotaExceededError');
    expect(reviewDraftStore(s,'a','r').read()?.current?.correctionReason).toBe('未完成的更正理由');
  });
  it('rejects an oversized stored payload before JSON parsing', () => {
    const s=storage(); s.setItem('codelab:review-draft:v1:a:r','x'.repeat(1_000_001));
    expect(()=>reviewDraftStore(s,'a','r').read()).toThrow('DRAFT_TOO_LARGE');
  });
});
