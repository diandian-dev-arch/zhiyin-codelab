import { expect, it } from 'vitest';
import { sourceContent, sourceContentQuery } from '../apps/api/src/source-content';

it('returns bounded source lines with absolute numbering and supports explicit full-file reads', () => {
  expect(sourceContent('one\ntwo\nthree\nfour', { start: 2, end: 3 })).toEqual({ content: 'two\nthree', startLine: 2, totalLines: 4 });
  expect(sourceContent('one\ntwo', {})).toEqual({ content: 'one\ntwo', startLine: 1, totalLines: 2 });
  expect(sourceContentQuery.parse({ path: 'src/main.ts', start: '2', end: '4' })).toEqual({ path: 'src/main.ts', start: 2, end: 4 });
});
it('preserves long evidence ranges without silently clipping them', () => {
  const query = sourceContentQuery.parse({ path: 'main.ts', start: '5', end: '1005' });
  const result = sourceContent(Array.from({ length: 1100 }, (_, i) => String(i + 1)).join('\n'), query);
  expect(result.startLine).toBe(5);
  expect(result.content.split('\n')).toHaveLength(1001);
  expect(result.content.split('\n').at(-1)).toBe('1005');
});
it.each([{ start: 0, end: 2 }, { start: 2 }, { end: 2 }, { start: 3, end: 2 }, { start: 1, end: Number.MAX_SAFE_INTEGER + 1 }, { start: 1.1, end: 2 }, { analysisId: 'another-project' }])('rejects invalid range or report identifiers: %j', query => {
  expect(sourceContentQuery.safeParse({ path: 'main.ts', ...query }).success).toBe(false);
});
