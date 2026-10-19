import { sourceReadingArchive, sourceReadingCorpus } from '../eval/source-reading-corpus.js';
import { importSourceZip } from '../apps/api/src/source-zip.js';

// Read-only, in-memory preparation. Never submits these samples to a model.
const samples = [];
for (const sample of sourceReadingCorpus) {
  const archive = sourceReadingArchive(sample);
  const imported = await importSourceZip(archive.zip);
  samples.push({ id: sample.id, category: sample.category, sha256: archive.sha256,
    zipBytes: archive.zip.length, retainedFiles: Object.keys(imported.files).length,
    omitted: imported.omitted, reviewExpectations: sample.expected.length,
    prohibitedClaims: sample.forbidden.length });
}
console.log(JSON.stringify({ source: 'authored-synthetic-development', modelCalls: 0,
  semanticReviewCompleted: false, samples }, null, 2));
