import { describe, expect, it } from 'vitest';
import { analysisStage, readableHistory } from '../apps/web/src/lib/analysis-progress';

describe('reader progress', () => {
  it('maps real events to three user stages without regressing during verification', () => {
    const events = ['map', 'plan', 'read', 'investigate_plan', 'read', 'investigate_done', 'synthesize', 'search', 'read_verify', 'repair_verification', 'verified'];
    expect(events.map((_, i) => analysisStage(events.slice(0, i + 1).map(kind => ({ kind }))))).toEqual([0,0,0,1,1,1,2,2,2,2,2]);
  });
  it('supports quick mode skipping investigation and unknown future events', () => {
    expect(analysisStage([])).toBe(0);
    expect(analysisStage([{ kind: 'synthesize' }, { kind: 'future_event' }])).toBe(2);
  });
  it('offers only a different, successful readable report, never a failed draft', () => {
    const reports = [{ id: 'new', status: 'failed', report: {} }, { id: 'missing', status: 'succeeded' }, { id: 'old', status: 'succeeded', report: { overview: 'retained' } }];
    expect(readableHistory(reports, 'new')?.id).toBe('old');
    expect(readableHistory(reports, 'old')).toBeUndefined();
    expect(readableHistory([], 'new')).toBeUndefined();
  });
});
