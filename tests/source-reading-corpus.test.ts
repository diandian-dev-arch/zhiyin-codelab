import { expect, it } from 'vitest';
import { sourceReadingArchive, sourceReadingCorpus } from '../eval/source-reading-corpus';
import { importSourceZip } from '../apps/api/src/source-zip';

it.each(sourceReadingCorpus)('imports fixed $category sample and preserves its review evidence', async sample => {
  const archive = sourceReadingArchive(sample);
  expect(sourceReadingArchive(sample).sha256).toBe(archive.sha256);
  const imported = await importSourceZip(archive.zip);
  expect(imported.sha256).toBe(archive.sha256);
  for (const evidence of sample.evidence) {
    expect(imported.files[evidence.path]).toBe(sample.files[evidence.path]);
    expect(evidence.start).toBeGreaterThan(0);
    expect(evidence.end).toBeLessThanOrEqual(imported.files[evidence.path].trimEnd().split('\n').length);
  }
  if (sample.category === 'omissions') {
    expect(Object.keys(imported.files)).toHaveLength(121);
    expect(imported.omitted).toEqual(expect.arrayContaining([
      { path: 'large.ts', reason: '单文件超过 512 KB' },
      { path: 'legacy.py', reason: '不是 UTF-8 文本' },
      { path: 'node_modules/dependency/index.js', reason: '依赖或构建产物' },
    ]));
  } else expect(imported.omitted).toEqual([]);
});
