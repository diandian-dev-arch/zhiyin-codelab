import { afterEach, expect, it, vi } from 'vitest';
import { validatedReadingBrief, type ReadingBrief } from '../packages/contracts/src/source';
import { analyzeSource, validateSourceReport, validateVerifiedSourceReport, type SourceReport } from '../apps/api/src/source-agent';
import type { SummaryProviderV2 } from '../apps/api/src/model-provider-v2';

const citation = { path: 'main.ts', start: 2, end: 3 };
const section = { title: '数据处理', body: '输入数字并返回处理结果。', citations: [citation] };
const finding = { ...section, title: '输入待核对', severity: 'low' as const, confidence: 'hypothesis' as const,
  nextStep: '', condition: '非数字输入时', verificationSteps: [{ action: '隔离环境传入非数字并观察响应', expectedObservation: '返回输入错误' }], remediation: '确认后在入口增加类型校验' };
const brief: ReadingBrief = { version: 1, purpose: { text: '帮助用户处理数字并查看结果。', sourceRefs: [{ section: 'modules', index: 0 }], citations: [citation] },
  scenes: [{ sourceRef: { section: 'flows', index: 0 }, businessSummary: '用户输入后得到处理结果。', activities: [{ text: '提交数字', citations: [citation] }] }],
  takeaway: { text: '输入条件需要核实。', sourceRefs: [{ section: 'findings', index: 0 }], citations: [citation] } };
const draft: SourceReport = { overview: '数字处理工具', stack: [], modules: [section], flows: [section], findings: [finding], readingPath: [section], limitations: ['未运行项目'], readingBrief: brief };
const read = { 'main.ts': { start: 1, end: 5 }, 'other.ts': { start: 1, end: 5 } };
const ranges = Object.fromEntries(Object.entries(read).map(([path, range]) => [path, [range]]));
const check = (findingIndex = 0, value = finding) => ({ findingIndex, decision: 'retained', finding: value, reason: '仍需运行核对', citations: [citation] });
afterEach(() => vi.unstubAllEnvs());

it('preserves optional fields through validation and JSON persistence without altering legacy fields', () => {
  const result = validateSourceReport(draft, read, ranges);
  expect(JSON.parse(JSON.stringify(result)).readingBrief).toEqual(brief);
  expect(result.findings[0]).toEqual(finding);
  expect(result.overview).toBe(draft.overview);
  expect(validateSourceReport({ ...draft, readingBrief: undefined }, read).readingBrief).toBeUndefined();
});
it.each([
  { ...brief, version: 2 },
  { ...brief, purpose: { ...brief.purpose, text: 'x'.repeat(241) } },
  { ...brief, purpose: { ...brief.purpose, sourceRefs: [{ section: 'modules', index: 99 }] } },
  { ...brief, purpose: { ...brief.purpose, citations: [{ ...citation, end: 90 }] } },
  { ...brief, purpose: { ...brief.purpose, citations: [{ path: 'other.ts', start: 2, end: 3 }] } },
])('falls back invalid enhancements without swallowing core report errors: %j', readingBrief => {
  const result = validateSourceReport({ ...draft, readingBrief, analysisWarnings: ['model-owned fake warning'] }, read, ranges);
  expect(result.readingBrief).toBeUndefined();
  expect(result.modules).toEqual(draft.modules);
  expect(result.reportLimitReasons).toContain('READING_ENHANCEMENT_REJECTED');
  expect(result.analysisWarnings?.join()).not.toContain('fake warning');
  expect(() => validateSourceReport({ ...draft, readingBrief, modules: [{ ...section, citations: [{ ...citation, end: 99 }] }] }, read, ranges)).toThrow('INVALID_SOURCE_CITATION');
});
it('checks actual disjoint read ranges and removes invalid scenes/takeaway independently', () => {
  expect(validatedReadingBrief(brief, draft, () => false)).toBeUndefined();
  expect(() => validateSourceReport(draft, read, { 'main.ts': [{ start: 2, end: 2 }, { start: 3, end: 3 }] })).toThrow('INVALID_SOURCE_CITATION');
  const result = validateSourceReport({ ...draft, readingBrief: { ...brief,
    scenes: [{ ...brief.scenes![0], sourceRef: { section: 'flows', index: 8 } }],
    takeaway: { ...brief.takeaway!, citations: [{ path: 'other.ts', start: 1, end: 2 }] },
  } }, read, ranges);
  expect(result.readingBrief?.purpose).toEqual(brief.purpose);
  expect(result.readingBrief?.scenes).toEqual([]);
  expect(result.readingBrief?.takeaway).toBeUndefined();
  expect(result.reportLimitReasons).toContain('READING_ENHANCEMENT_REJECTED');
});
it('drops malformed guidance only and does not reinterpret nextStep', () => {
  const result = validateSourceReport({ ...draft, findings: [{ ...finding, verificationSteps: [{ action: 'missing observation' }] }] }, read, ranges);
  expect(result.findings[0].verificationSteps).toBeUndefined();
  expect(result.findings[0].condition).toBe(finding.condition);
  expect(result.findings[0].nextStep).toBe('');
  expect(result.reportLimitReasons).toContain('READING_ENHANCEMENT_REJECTED');
});
it('retains unchanged guidance, explicitly remaps reordered findings and removes withdrawn risk takeaways', () => {
  const second = { ...finding, title: '另一线索' };
  const original = { ...draft, findings: [finding, second] };
  const reordered = validateVerifiedSourceReport({ checks: [check(1, second), check()] }, original, read, ranges);
  expect(reordered.readingBrief?.takeaway?.sourceRefs).toEqual([{ section: 'findings', index: 1 }]);
  expect(reordered.findings[1].verificationSteps).toEqual(finding.verificationSteps);
  const withdrawn = validateVerifiedSourceReport({ checks: [{ findingIndex: 0, decision: 'withdrawn', reason: '已有守卫', citations: [citation] }] }, draft, read, ranges);
  expect(withdrawn.readingBrief?.purpose).toEqual(brief.purpose);
  expect(withdrawn.readingBrief?.takeaway).toBeUndefined();
  expect(withdrawn.findings).toEqual([]);
  expect(withdrawn.reportLimitReasons).toContain('READING_ENHANCEMENT_REJECTED');
  expect(draft.readingBrief).toEqual(brief);
});
it('discards inherited summaries referencing corrected sections instead of guessing by renamed titles', () => {
  const result = validateVerifiedSourceReport({ checks: [check()], report: { flows: [{ ...section, sectionIndex: 0, title: '已修正业务' }] } }, draft, read, ranges);
  expect(result.readingBrief?.scenes).toEqual([]);
  const changedPurpose = validateVerifiedSourceReport({ checks: [check()], report: { modules: [{ ...section, sectionIndex: 0, body: '原结论不成立' }] } }, draft, read, ranges);
  expect(changedPurpose.readingBrief).toBeUndefined();
  const changedFinding = validateVerifiedSourceReport({ checks: [check(0, { ...finding, body: '影响更小' })] }, draft, read, ranges);
  expect(changedFinding.readingBrief?.takeaway).toBeUndefined();
});
it('accepts an explicitly reviewed replacement using original indexes and permits explicit null rollback', () => {
  const result = validateVerifiedSourceReport({ checks: [check()], report: { modules: [{ ...section, sectionIndex: 0, body: '修订说明' }], readingBrief: brief } }, draft, read, ranges);
  expect(result.readingBrief).toEqual(brief);
  expect(validateVerifiedSourceReport({ checks: [check()], report: { readingBrief: null } }, draft, read, ranges).readingBrief).toBeUndefined();
  expect(validatedReadingBrief({ ...brief, scenes: [brief.scenes![0], brief.scenes![0]] }, draft)).toBeUndefined();
});
it('records malformed review-only enhancements instead of silently dropping them', () => {
  const legacy = { ...draft, readingBrief: undefined, findings: [{ ...section, severity: 'low' as const, confidence: 'hypothesis' as const, nextStep: '' }] };
  const result = validateVerifiedSourceReport({ checks: [check(0, { ...legacy.findings[0], verificationSteps: [{ action: 'missing expected observation' }] } as any)], report: { readingBrief: { ...brief, version: 99 } } }, legacy, read, ranges);
  expect(result.readingBrief).toBeUndefined();
  expect(result.findings[0].verificationSteps).toBeUndefined();
  expect(result.reportLimitReasons).toContain('READING_ENHANCEMENT_REJECTED');
  expect(result.analysisWarnings?.length).toBeGreaterThan(0);
});
it.each([false, true])('uses the same four existing model calls and keeps generation off by default (enabled=%s)', async enabled => {
  if (enabled) vi.stubEnv('SOURCE_READING_BRIEF', '1');
  else vi.stubEnv('SOURCE_READING_BRIEF', '0');
  let calls = 0;
  const provider: SummaryProviderV2 = { configuration: { provider: 'fixture', model: 'fixture', endpoint: 'http://unused.invalid' }, complete: async input => {
    calls++;
    const request = JSON.parse(input.user);
    if (calls === 2) {
      expect(!!request.shape.readingBrief).toBe(enabled);
      if (enabled) expect(request.constraints).toContain('expectedObservation');
    }
    if (calls === 4 && enabled) expect(request.constraints).toContain('readingBrief');
    const output = calls === 1 ? { paths: ['main.ts'] } : calls === 2 ? draft : calls === 3 ? { searches: [], reads: [] } : { checks: [check()] };
    if (calls > 4) throw new Error('No extra model calls authorized');
    return { content: JSON.stringify(output), raw: 'fixture', requestId: null, usage: null };
  } };
  const result = await analyzeSource({ files: { 'main.ts': '// fixture\nexport const n = 2;\nexport const result = n * 2;\n' }, provider, signal: new AbortController().signal, emit: async () => {} });
  expect(calls).toBe(4);
  expect(!!result.report.readingBrief).toBe(enabled);
  expect(!!result.report.findings[0].verificationSteps).toBe(enabled);
  expect(!!result.report.findings[0].remediation).toBe(enabled);
  expect(result.model.calls).toHaveLength(4);
});
