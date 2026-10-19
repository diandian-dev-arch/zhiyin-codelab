import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";
import { createHash } from 'node:crypto';
// Must match deploy/executor/measure-build.mjs: JSON property order is part of v1.
export function hashTemplateFiles(input: Record<string, Uint8Array>) {
  const hash=(bytes: Uint8Array | string)=>createHash('sha256').update(bytes).digest('hex');
  const files=Object.keys(input).sort().map(name=>({path:name,byteSize:input[name].byteLength,sha256:hash(input[name])}));
  return hash(JSON.stringify({version:'template-files-v1',files}));
}
export const root = fileURLToPath(new URL("../../../", import.meta.url));
export const templateVersion = "vue-board-v1";
export async function templateFiles() {
  const base = path.join(root, "templates", templateVersion);
  const files: Record<string, Buffer> = {};
  async function walk(dir: string) {
    for (const f of await readdir(dir, { withFileTypes: true })) {
      if (f.name === "node_modules") continue;
      const full = path.join(dir, f.name);
      if (f.isDirectory()) await walk(full);
      else if (f.isFile())
        files[path.relative(base, full).replaceAll("\\", "/")] =
          await readFile(full);
      else throw new Error('UNSUPPORTED_TEMPLATE_ENTRY');
    }
  }
  await walk(base);
  return files;
}
export async function templateZip(files?: Record<string, Uint8Array>) {
  return Buffer.from(zipSync(files ?? await templateFiles()));
}
