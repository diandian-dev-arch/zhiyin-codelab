import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const files = [];
async function visit(directory, prefix = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const name = prefix + entry.name;
    if (entry.isDirectory()) await visit(path.join(directory, entry.name), name + '/');
    else if (entry.isFile()) {
      const bytes = await readFile(path.join(directory, entry.name));
      files.push({ path: name, byteSize: bytes.length, sha256: hash(bytes) });
    } else throw new Error('UNSUPPORTED_TEMPLATE_ENTRY');
  }
}
await visit('/opt/template-reference');
files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
// Fixed JSON field order is part of this explicitly versioned template hash.
process.stdout.write(JSON.stringify({
  templateHash: hash(JSON.stringify({ version: 'template-files-v1', files })),
  dependencyLockHash: hash(await readFile('/opt/template/package-lock.json')),
  buildScriptSha256: hash(await readFile('/opt/build.sh')),
}) + '\n');
