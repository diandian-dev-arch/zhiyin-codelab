import { expect, it } from 'vitest';
import { sourceReportQuality } from '../packages/contracts/src/source';
import { validateSourceReport } from '../apps/api/src/source-agent';

it('keeps historical quality unknown and gives limitations precedence over complete', () => {
  expect(sourceReportQuality({})).toBe('unknown');
  expect(sourceReportQuality({ analysisWarnings: [] })).toBe('unknown');
  expect(sourceReportQuality({ analysisWarnings: ['旧报告限制'] })).toBe('limited');
  expect(sourceReportQuality({ reportQuality: 'complete', reportLimitReasons: [] })).toBe('complete');
  expect(sourceReportQuality({ reportQuality: 'limited' })).toBe('limited');
  expect(sourceReportQuality({ reportQuality: 'complete', analysisWarnings: ['限制'] })).toBe('limited');
  expect(sourceReportQuality({ reportLimitReasons: ['COUNTEREVIDENCE_PLAN_INVALID'] })).toBe('limited');
});

it('does not accept model-authored quality, reason codes or warning fields', () => {
  const citation = { path: 'main.ts', start: 1, end: 1 };
  const section = { title: '入口', body: '源码说明', citations: [citation] };
  const report = validateSourceReport({ overview: '用途', stack: [], modules: [section], flows: [], findings: [], readingPath: [section], limitations: ['静态阅读'],
    reportQuality: 'complete', reportLimitReasons: ['COUNTEREVIDENCE_PLAN_INVALID'], analysisWarnings: ['模型伪造提示'] }, { 'main.ts': { start: 1, end: 1 } });
  expect(report).not.toHaveProperty('reportQuality');
  expect(report).not.toHaveProperty('reportLimitReasons');
  expect(report).not.toHaveProperty('analysisWarnings');
});
