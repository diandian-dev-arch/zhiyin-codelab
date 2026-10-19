import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

const out = resolve(process.argv[2] ?? 'output/glass-lab/baseline');
mkdirSync(out, { recursive: true });
function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    if (['node_modules', 'dist', '.data'].includes(e.name)) return [];
    const p = join(dir, e.name);
    return e.isDirectory() ? files(p) : [p];
  });
}
const hashes = Object.fromEntries(['tests', 'packages', 'apps/api', 'apps/runner', 'apps/web/src', 'apps/web/index.html', 'apps/web/tokens.css', 'pnpm-lock.yaml', 'package.json', 'apps/web/package.json'].flatMap(p => p.includes('.') ? [p] : files(p)).map(p => [relative(process.cwd(), resolve(p)).replaceAll('\\', '/'), createHash('sha256').update(readFileSync(p)).digest('hex')]));
writeFileSync(join(out, 'source-hashes.json'), JSON.stringify(hashes, null, 2));
const assets = files('apps/web/dist/assets').filter(p => /\.(js|css)$/.test(p)).map(p => ({ file: p, bytes: readFileSync(p).length, gzip: gzipSync(readFileSync(p)).length }));
writeFileSync(join(out, 'bundle.json'), JSON.stringify({ assets, gzip: assets.reduce((n, a) => n + a.gzip, 0) }, null, 2));
console.log(JSON.stringify({ files: Object.keys(hashes).length, gzip: assets.reduce((n, a) => n + a.gzip, 0) }));
