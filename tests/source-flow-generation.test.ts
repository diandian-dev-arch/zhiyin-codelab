import { afterEach, describe, expect, it, vi } from 'vitest';
import { analyzeSource, type SourceEvent } from '../apps/api/src/source-agent';
import type { SummaryProviderV2 } from '../apps/api/src/model-provider-v2';
import type { EvidenceFlow } from '../packages/contracts/src/source';

const path = 'main.ts';
const files = { [path]: 'function entry() {\n service();\n}\nfunction service() {\n store();\n}\nfunction store() {}' };
const citation = { path, start: 1, end: 7 };
const section = { title: '核心场景', body: '入口调用处理函数，处理函数调用存储函数。', citations: [citation] };
const flow: EvidenceFlow = {
  id: 'main', title: '核心场景', summary: '三步调用', gaps: [],
  steps: ['entry', 'service', 'store'].map(id => ({ id, title: id, symbol: id, responsibility: id, citations: [citation] })),
  edges: [
    { from: 'entry', to: 'service', relation: 'call', evidence: [{ path, start: 2, end: 2 }], explanation: '入口调用处理函数' },
    { from: 'service', to: 'store', relation: 'call', evidence: [{ path, start: 5, end: 5 }], explanation: '处理函数调用存储函数' },
  ],
};

async function run(flag: string | undefined, optional: unknown, correction?: unknown) {
  vi.stubEnv('SOURCE_EVIDENCE_FLOWS', flag);
  const requests: Record<string, any>[] = [];
  const events: SourceEvent[] = [];
  const provider: SummaryProviderV2 = {
    configuration: { provider: 'offline-fixture', model: 'fixture', endpoint: 'http://unused.invalid' },
    complete: async input => {
      const request = JSON.parse(input.user);
      requests.push(request);
      // Unexpected repair or per-node requests fail immediately instead of hiding extra calls.
      const answers = [
        { paths: [path] },
        { overview: '项目用途', stack: [], modules: [section], flows: [section], findings: [], readingPath: [section], limitations: ['未运行代码'], ...(optional === undefined ? {} : { evidenceFlows: optional }) },
        { searches: [], reads: [] },
        { checks: [], ...(correction === undefined ? {} : { report: { evidenceFlows: correction } }) },
      ];
      if (requests.length > answers.length) throw new Error('UNEXPECTED_ADDITIONAL_MODEL_CALL');
      return { content: JSON.stringify(answers[requests.length - 1]), raw: 'offline-fixture', requestId: null,
        usage: { inputTokens: 100, outputTokens: 50 } };
    },
  };
  const result = await analyzeSource({ files, provider, signal: new AbortController().signal,
    emit: async event => { events.push(event); } });
  expect(requests).toHaveLength(4);
  expect(result.model.calls).toHaveLength(4);
  expect(result.context).toMatchObject({ knownInputTokens: 400, knownOutputTokens: 200 });
  expect(events.some(event => event.kind.startsWith('repair'))).toBe(false);
  expect(result.report.flows).toEqual([section]);
  return { result, requests };
}

afterEach(() => vi.unstubAllEnvs());

describe('optional evidence flows through complete source analysis', () => {
  it('generates and preserves proven calls using the existing four requests', async () => {
    const { result, requests } = await run('1', [flow]);
    expect(result.report.evidenceFlows).toEqual([flow]);
    expect(result.report.analysisWarnings).toBeUndefined();
    expect(result.report.reportQuality).toBe('complete');
    expect(result.report.reportLimitReasons).toEqual([]);
    const example = requests[1].shape.evidenceFlows[0];
    expect(example.steps.length).toBeGreaterThanOrEqual(3);
    const ids = new Set(example.steps.map((step: { id: string }) => step.id));
    expect(example.edges.every((edge: { from: string; to: string }) => ids.has(edge.from) && ids.has(edge.to))).toBe(true);
  });
  it.each([undefined, '0'])('omits generation instructions and output when flag=%s', async flag => {
    const { result, requests } = await run(flag, [flow]);
    expect(requests[1].shape).not.toHaveProperty('evidenceFlows');
    expect(result.report).not.toHaveProperty('evidenceFlows');
    expect(result.report.analysisWarnings).toBeUndefined();
    expect(result.report.reportQuality).toBe('complete');
    expect(result.report.reportLimitReasons).toEqual([]);
  });
  it.each([null, 'invalid', [{ ...flow, steps: [] }], [{ ...flow, edges: [{ ...flow.edges[0], to: 'missing' }] }]])(
    'keeps the legacy report without repair calls for malformed optional output %#', async optional => {
      const { result } = await run('1', optional);
      expect(result.report).not.toHaveProperty('evidenceFlows');
      expect(result.report.analysisWarnings).toHaveLength(1);
      expect(result.report.reportQuality).toBe('limited');
      expect(result.report.reportLimitReasons).toEqual(['EVIDENCE_FLOW_REJECTED']);
    },
  );
  it('accepts legacy output with no optional fields', async () => {
    const { result } = await run('1', undefined);
    expect(result.report).not.toHaveProperty('evidenceFlows');
    expect(result.report.analysisWarnings).toBeUndefined();
  });
  it('validates replacement flows from the final review rather than trusting them', async () => {
    const { result } = await run('1', [flow], [{ ...flow, edges: [{ ...flow.edges[0], evidence: [{ path, start: 7, end: 7 }] }] }]);
    expect(result.report).not.toHaveProperty('evidenceFlows');
    expect(result.report.analysisWarnings).toHaveLength(1);
  });
});
