import { describe, expect, it, vi } from 'vitest';
import { analyzeSource } from '../apps/api/src/source-agent';
import { sourceReportQuality } from '../packages/contracts/src/source';
import type { SummaryProviderV2 } from '../apps/api/src/model-provider-v2';

const citation = { path: 'main.ts', start: 1, end: 1 };
const section = { title: '入口', body: '静态源码线索', citations: [citation] };
const finding = { ...section, severity: 'medium', confidence: 'direct', nextStep: '核对上游调用' };
const draft = { overview: '项目用途', stack: [], modules: [section], flows: [], findings: [finding], readingPath: [section], limitations: ['仅静态阅读'] };
const configuration = { provider: 'fixture', model: 'fixture', endpoint: 'http://unused.invalid' };
const files = { 'main.ts': 'export const value = 1;' };
const signal = () => new AbortController().signal;

describe('bounded source analysis recovery', () => {
  it('retains only a validated draft when the local cost guard blocks verification, without another paid call', async () => {
    const events: string[] = [];
    const complete = vi.fn(async () => ({ content: JSON.stringify(complete.mock.calls.length === 1 ? { paths: ['main.ts'] } : draft), raw: '{}', requestId: null,
      usage: { inputTokens: complete.mock.calls.length === 1 ? 1 : 998_000, outputTokens: 0 } }));
    const begin = vi.fn(async () => 'call'), finish = vi.fn(async () => {});
    const result = await analyzeSource({ files, provider: { configuration, complete }, signal: signal(),
      options: { version: 1, mode: 'quick', modules: [], cost: { inputPerMillion: 1, outputPerMillion: 1, limitCny: 1, label: 'fixture' } },
      callLedger: { begin, finish }, emit: async event => { events.push(event.kind); } });
    expect(complete).toHaveBeenCalledTimes(2);
    expect(begin).toHaveBeenCalledTimes(2);
    expect(finish).toHaveBeenCalledTimes(2);
    expect(sourceReportQuality(result.report)).toBe('limited');
    expect(result.report.reportLimitReasons).toContain('COST_BUDGET_LIMITED');
    expect(result.report.findings[0].confidence).toBe('hypothesis');
    expect(result.report).not.toHaveProperty('verification');
    expect(result.verification.completed).toBe(false);
    expect(events).toContain('analysis_limited');
    expect(events).not.toContain('verified');
    expect(result.report.modules).toEqual(draft.modules);
  });

  it('fits long-form calls to affordable output while completing real verification', async () => {
    const events: string[] = [];
    const complete = vi.fn(async (request: Parameters<SummaryProviderV2['complete']>[0]) => {
      const n = complete.mock.calls.length;
      const output = n === 1 ? { paths: ['main.ts'] } : n === 2 ? draft : n === 3 ? { searches: [], reads: [] }
        : { checks: [{ findingIndex: 0, decision: 'retained', reason: '源码依据', citations: [citation], finding }] };
      expect(request.maxOutputTokens).toBeGreaterThanOrEqual(1024);
      return { content: JSON.stringify(output), raw: '{}', requestId: null, usage: { inputTokens: 100, outputTokens: 100 } };
    });
    const result = await analyzeSource({ files, provider: { configuration, complete }, signal: signal(),
      options: { version: 1, mode: 'quick', modules: [], cost: { inputPerMillion: 2, outputPerMillion: 8, limitCny: .08, label: 'fixture' } },
      emit: async event => { events.push(event.kind); } });
    expect(complete).toHaveBeenCalledTimes(4);
    expect(complete.mock.calls[1][0].maxOutputTokens).toBeLessThan(12000);
    expect(events).toContain('budget_adjusted');
    expect(result.report.reportQuality).toBe('complete');
    expect(result.verification.completed).toBe(true);
  });

  it('retains a validated draft if later full prompts exceed model context, without trimming evidence to fit', async () => {
    let calls = 0;
    const largeDraft = { ...draft, modules: Array.from({ length: 6 }, (_, i) => ({ ...section, title: `Module ${i}`, body: 'x'.repeat(2400) })) };
    const complete: SummaryProviderV2['complete'] = async () => {
      calls++;
      const output = calls === 1 ? { paths: ['main.ts'] } : largeDraft;
      return { content: JSON.stringify(output), raw: '{}', requestId: null, usage: null };
    };
    const result = await analyzeSource({ files, provider: { configuration, complete,
      sourceContext: { contextWindowTokens: 16384, maxOutputTokens: 4096, tokenizer: 'utf8-conservative' } }, signal: signal(), emit: async () => {} });
    expect(calls).toBe(2);
    expect(result.report.reportQuality).toBe('limited');
    expect(result.report.reportLimitReasons).toContain('CONTEXT_BUDGET_LIMITED');
    expect(result.verification.completed).toBe(false);
    expect(result.report.modules).toEqual(largeDraft.modules);
    expect(result.report.modules[0].citations).toEqual([citation]);
  });

  it('keeps enough budget for a draft rather than spending it on optional deep investigation', async () => {
    const events: string[] = [];
    const complete = vi.fn(async (request: Parameters<SummaryProviderV2['complete']>[0]) => {
      const body = JSON.parse(request.user);
      expect(body.phase).not.toBe('investigation');
      const n = complete.mock.calls.length;
      const output = n === 1 ? { paths: ['main.ts'] } : n === 2 ? draft : n === 3 ? { searches: [], reads: [] }
        : { checks: [{ findingIndex: 0, decision: 'retained', reason: '仅已有源码', citations: [citation], finding }] };
      return { content: JSON.stringify(output), raw: '{}', requestId: null, usage: { inputTokens: 100, outputTokens: 100 } };
    });
    const result = await analyzeSource({ files, provider: { configuration, complete }, signal: signal(),
      options: { version: 1, mode: 'deep', modules: [], cost: { inputPerMillion: 2, outputPerMillion: 8, limitCny: .07, label: 'fixture' } },
      emit: async event => { events.push(event.kind); } });
    expect(complete).toHaveBeenCalledTimes(4);
    expect(result.report.reportQuality).toBe('limited');
    expect(result.report.reportLimitReasons).toContain('COST_BUDGET_LIMITED');
    expect(result.investigation).toEqual([]);
    expect(result.verification.completed).toBe(true);
    expect(events).toContain('analysis_limited');
  });

  it('preserves the validated draft without retrying a truncated final verification', async () => {
    const complete = vi.fn(async () => {
      const n = complete.mock.calls.length;
      return { content: n === 4 ? '{"checks":[' : JSON.stringify(n === 1 ? { paths: ['main.ts'] } : n === 2 ? draft : { searches: [], reads: [] }),
        raw: n === 4 ? '{"choices":[{"finish_reason":"length"}]}' : '{}', requestId: null, usage: null };
    });
    const result = await analyzeSource({ files, provider: { configuration, complete }, signal: signal(), emit: async () => {} });
    expect(complete).toHaveBeenCalledTimes(4);
    expect(result.report.reportQuality).toBe('limited');
    expect(result.report.reportLimitReasons).toContain('OUTPUT_BUDGET_LIMITED');
    expect(result.report.findings[0].confidence).toBe('hypothesis');
    expect(result.report).not.toHaveProperty('verification');
  });

  it('does not publish an invalid draft even when its repair cannot fit the budget', async () => {
    const complete = vi.fn(async () => ({ content: JSON.stringify(complete.mock.calls.length === 1 ? { paths: ['main.ts'] } : { ...draft, modules: [{ ...section, citations: [{ ...citation, end: 999 }] }] }),
      raw: '{}', requestId: null, usage: { inputTokens: complete.mock.calls.length === 2 ? 998_000 : 1, outputTokens: 0 } }));
    await expect(analyzeSource({ files, provider: { configuration, complete }, signal: signal(),
      options: { version: 1, mode: 'quick', modules: [], cost: { inputPerMillion: 1, outputPerMillion: 1, limitCny: 1, label: 'fixture' } },
      emit: async () => {} })).rejects.toThrow('SOURCE_COST_BUDGET');
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it.each(['MODEL_TRANSPORT_UNKNOWN', 'MODEL_HTTP_403', 'SOURCE_CONFIGURATION_CHANGED', 'cancelled'])(
    'does not recover or retry an unsafe operational failure: %s', async code => {
      let calls = 0;
      const provider: SummaryProviderV2 = { configuration, complete: async () => {
        calls++;
        if (calls === 3) throw new Error(code);
        return { content: JSON.stringify(calls === 1 ? { paths: ['main.ts'] } : draft), raw: '{}', requestId: null, usage: null };
      } };
      await expect(analyzeSource({ files, provider, signal: signal(), emit: async () => {} })).rejects.toThrow(code);
      expect(calls).toBe(3);
    },
  );
});
