import { readFile, writeFile, lstat, rename, unlink } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { root } from '../apps/api/src/template.js';
import { createSummaryProviderV2 } from '../apps/api/src/model-provider-v2.js';

/** Import only model fields from a user-supplied file; never echo credentials or replace other settings. */
export async function importModelConfig(source: string, projectRoot = root) {
  const stat = await lstat(source);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) throw new Error('MODEL_CONFIG_FILE_INVALID');
  const parsed = parseEnv(await readFile(source, 'utf8'));
  const fields = ['MODEL_BASE_URL', 'MODEL_NAME', 'MODEL_API_KEY', 'MODEL_TEMPERATURE', 'SOURCE_MODEL_CONTEXT_TOKENS', 'SOURCE_MODEL_MAX_OUTPUT_TOKENS', 'SOURCE_MODEL_TOKENIZER'];
  const selected: Record<string, string> = {};
  for (const name of fields) {
    if (parsed[name] !== undefined) selected[name] = parsed[name];
    else if (['MODEL_BASE_URL', 'MODEL_NAME', 'MODEL_API_KEY'].includes(name)) throw new Error('MODEL_CONFIG_FIELD_MISSING');
  }
  if (!createSummaryProviderV2(selected)) throw new Error('MODEL_CONFIG_FIELD_MISSING');
  // Keep the file representation lossless and auditable; reject rather than guess quote escaping.
  for (const value of Object.values(selected)) if (/[\r\n']/.test(value)) throw new Error('MODEL_CONFIG_VALUE_UNSUPPORTED');
  const destination = path.join(projectRoot, '.env');
  let existing = '';
  try {
    const targetStat = await lstat(destination);
    if (!targetStat.isFile() || targetStat.isSymbolicLink() || targetStat.nlink !== 1 || targetStat.size > 128 * 1024)
      throw new Error('MODEL_CONFIG_TARGET_INVALID');
    existing = await readFile(destination, 'utf8');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const kept = existing.split(/\r?\n/).filter(line => {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    return !match || !fields.includes(match[1]);
  }).join('\n').replace(/\n*$/, '');
  // Omitted optional fields remove old-model overrides, never carry a tokenizer/window to a new model.
  const content = kept + '\n' + Object.entries(selected).map(([key, value]) => `${key}='${value}'`).join('\n') + '\n';
  const expected = parseEnv(existing);
  for (const key of fields) delete expected[key];
  Object.assign(expected, selected);
  const actual = parseEnv(content);
  if (Object.keys(expected).length !== Object.keys(actual).length || Object.entries(expected).some(([key, value]) => actual[key] !== value))
    throw new Error('MODEL_CONFIG_MERGE_UNSAFE');
  const temporary = path.join(projectRoot, `.env-import-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
    if (JSON.stringify(parseEnv(content)) !== JSON.stringify(parseEnv(await readFile(temporary, 'utf8'))))
      throw new Error('MODEL_CONFIG_WRITE_MISMATCH');
    await rename(temporary, destination);
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  return { imported: true, fields: Object.keys(selected), temperatureConfigured: 'MODEL_TEMPERATURE' in selected };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw new Error('MODEL_CONFIG_SOURCE_REQUIRED');
    console.log(JSON.stringify(await importModelConfig(path.resolve(process.argv[2]))));
  } catch { console.error('MODEL_CONFIG_IMPORT_FAILED'); process.exitCode = 1; }
}
