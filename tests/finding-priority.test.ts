import { expect, it } from 'vitest';
import { prioritizeFindings } from '../apps/web/src/lib/finding-priority';

it('prioritizes usable evidence and next actions over self-reported severity without mutating data', () => {
  const citation = { path: 'main.ts', start: 1, end: 2 };
  const findings = [
    { title: 'unreferenced high', severity: 'high', confidence: 'direct', citations: [] },
    { title: 'hypothesis high', severity: 'high', confidence: 'hypothesis', citations: [citation] },
    { title: 'actionable low', severity: 'low', confidence: 'direct', citations: [citation], nextStep: '检查调用方' },
    { title: 'direct high', severity: 'high', confidence: 'direct', citations: [citation] },
  ];
  const snapshot = structuredClone(findings);
  expect(prioritizeFindings(findings).map(f => f.title)).toEqual(['actionable low', 'direct high', 'hypothesis high', 'unreferenced high']);
  expect(findings).toEqual(snapshot);
});

it('preserves ties, legacy fields, all entries and citations; invalid ranges do not boost priority', () => {
  const entries = [
    { id: 'bad', citations: [{ path: 'a', start: 8, end: 2 }] },
    { id: 'first', citations: [{ path: 'a', start: 1, end: 2 }] },
    { id: 'second', citations: [{ path: 'b', start: 1, end: 2 }] },
  ];
  expect(prioritizeFindings(entries)).toEqual([entries[1], entries[2], entries[0]]);
  expect(prioritizeFindings([])).toEqual([]);
});
