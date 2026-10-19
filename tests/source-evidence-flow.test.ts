import { describe, expect, it } from 'vitest';
import { validateEvidenceFlows } from '../apps/api/src/source-evidence-flow';
import type { EvidenceFlow } from '../packages/contracts/src/source';
import { validateSourceReport } from '../apps/api/src/source-agent';

const cite = { path: 'main.ts', start: 1, end: 2 };
const ranges = { 'main.ts': [{ start: 1, end: 3 }, { start: 8, end: 10 }] };
function fixture(): EvidenceFlow {
  return { id: 'scene', title: '业务场景', summary: '读取并处理数据',
    steps: ['entry', 'service', 'store'].map(id => ({ id, title: id, responsibility: '负责一个步骤', citations: [{ ...cite }] })),
    edges: [{ from: 'entry', to: 'service', relation: 'inferred', explanation: '当前只能推断关联', evidence: [{ ...cite }] }],
    gaps: ['调用关系尚待核实'],
  };
}
describe('optional evidence flows', () => {
  it('falls back inside the real report validator instead of failing the report', () => {
    const section = { title: '入口', body: '用途说明', citations: [cite] };
    const report = { overview: '项目用途', stack: [], modules: [section], flows: [section], findings: [], readingPath: [section], limitations: ['未运行代码'] };
    const read = { 'main.ts': { start: 1, end: 10 } };
    const fallback = validateSourceReport({ ...report, evidenceFlows: { broken: true } }, read, ranges);
    expect(fallback).toEqual({ ...report, analysisWarnings: [expect.stringContaining('未通过')], reportLimitReasons: ['EVIDENCE_FLOW_REJECTED'] });
    expect(validateSourceReport({ ...report, evidenceFlows: [fixture()] }, read, ranges).evidenceFlows).toHaveLength(1);
    const direct = fixture(); direct.edges[0].relation = 'call';
    expect(validateSourceReport({ ...report, evidenceFlows: [direct] }, read, ranges)).toEqual(fallback);
    expect(validateSourceReport({ ...report, analysisWarnings: ['模型伪造的系统提示'] }, read, ranges)).toEqual(report);
  });
  it('accepts absent fields for old reports without requesting regeneration', () => {
    expect(validateEvidenceFlows(undefined, ranges)).toEqual({ flows: [], rejected: 0, reasons: [] });
  });
  it('keeps explicit inferred relationships with gaps and permits branching', () => {
    const flow = fixture();
    flow.edges.push({ ...flow.edges[0], to: 'store' });
    expect(validateEvidenceFlows([flow], ranges).flows).toEqual([flow]);
  });
  it('does not equate valid line ranges or shared files with proven calls', () => {
    const flow = fixture(); flow.edges[0].relation = 'call';
    expect(validateEvidenceFlows([flow], ranges).reasons).toContain('UNVERIFIED_FLOW_RELATION');
    expect(validateEvidenceFlows([flow], ranges, () => false).flows).toEqual([]);
    expect(validateEvidenceFlows([flow], ranges, () => true).flows).toHaveLength(1);
  });
  it('requires direct evidence even when a semantic verifier accepts', () => {
    const flow = fixture(); flow.edges[0].relation = 'data'; flow.edges[0].evidence = [];
    expect(validateEvidenceFlows([flow], ranges, () => true).flows).toEqual([]);
  });
  it('rejects invalid identities and endpoints', () => {
    const flow = fixture(); flow.steps[1].id = 'entry';
    expect(validateEvidenceFlows([flow], ranges).flows).toEqual([]);
    const other = fixture(); other.edges[0].to = 'nonexistent';
    expect(validateEvidenceFlows([other], ranges).reasons).toContain('INVALID_FLOW_EDGE');
    expect(validateEvidenceFlows([fixture(), fixture()], ranges).rejected).toBe(2);
  });
  it('rejects unknown paths, unread gaps and inverted line ranges', () => {
    for (const citation of [{ path: 'invented.ts', start: 1, end: 2 }, { path: 'main.ts', start: 2, end: 9 }, { path: 'main.ts', start: 3, end: 1 }]) {
      const flow = fixture(); flow.steps[0].citations = [citation];
      expect(validateEvidenceFlows([flow], ranges).flows).toEqual([]);
    }
  });
  it('keeps valid siblings without throwing when an optional item is malformed', () => {
    expect(validateEvidenceFlows([null, fixture()], ranges)).toMatchObject({ rejected: 1, flows: [fixture()] });
    for (const raw of [null, {}, 'bad', Array(6).fill(fixture())]) expect(validateEvidenceFlows(raw, ranges).flows).toEqual([]);
  });
  it('enforces bounds, explicit gaps and evidence for steps', () => {
    const flow = fixture(); flow.gaps = [];
    expect(validateEvidenceFlows([flow], ranges).reasons).toContain('MISSING_FLOW_GAP');
    flow.steps = flow.steps.slice(0, 2);
    expect(validateEvidenceFlows([flow], ranges).reasons).toContain('INVALID_FLOW_SHAPE');
  });
});
