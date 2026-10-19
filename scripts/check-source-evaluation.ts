import { readFile, stat } from 'node:fs/promises';
import { summarizeSourceEvaluation } from '../packages/contracts/src/source-evaluation.js';

try {
  if (process.argv.length !== 3) throw new Error('SOURCE_EVALUATION_ARGUMENT_REQUIRED');
  const target = process.argv[2];
  const info = await stat(target);
  if (!info.isFile() || info.size > 4 * 1024 * 1024) throw new Error('SOURCE_EVALUATION_FILE_LIMIT');
  const result = summarizeSourceEvaluation(JSON.parse(await readFile(target, 'utf8')));
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  // Do not print schema values, paths, report text or credentials from input.
  const code = error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'SOURCE_EVALUATION_INVALID';
  console.error(JSON.stringify({ code }));
  process.exitCode = 1;
}
