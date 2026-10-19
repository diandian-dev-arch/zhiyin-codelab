import { readFileSync,writeFileSync,existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
const root='output/glass-lab',base=JSON.parse(readFileSync(`${root}/baseline/source-hashes.json`,'utf8'));
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const protectedFiles=Object.keys(base).filter(p=>/^(tests\/|packages\/|apps\/(api|runner)\/)/.test(p)||['pnpm-lock.yaml','package.json','apps/web/package.json','apps/web/src/api.ts'].includes(p));
const changedProtected=protectedFiles.filter(p=>!existsSync(p)||hash(p)!==base[p]);
const changed=Object.keys(base).filter(p=>existsSync(p)&&hash(p)!==base[p]);
const templateExceptions=new Set(['App.vue','views/Login.vue','views/Landing.vue','views/Settings.vue']);
const changedContracts=[];
for(const p of changed.filter(p=>p.startsWith('apps/web/src/')&&p.endsWith('.vue'))){
  const short=p.slice('apps/web/src/'.length);if(templateExceptions.has(short))continue;
  const original=readFileSync(`${root}/baseline/src/${short}`,'utf8'),current=readFileSync(p,'utf8');
  const nonStyle=s=>s.replace(/<style\b[^>]*>[\s\S]*?<\/style>/g,'').replace(/ aria-hidden="true"/g,'').trimEnd();
  if(nonStyle(original)!==nonStyle(current))changedContracts.push(p);
}
const handoff='design-proposals/2026-10-18-glass-lab/handoff/assets';
const originalAssets=['src/glass/liquid.ts','src/glass/evidence-core.ts','src/glass/pointer.ts','src/glass/theme.ts','src/glass/directives.ts','src/glass/canvas-loop.ts','src/components/glass/GlLiquid.vue','src/components/glass/GlEvidenceCore.vue','src/components/glass/GlEvidenceTree.vue','src/components/glass/GlThemeSwitcher.vue','src/styles/glass/tokens.css','src/styles/glass/base.css','src/styles/glass/motion.css','src/styles/glass/components.css','tokens.css'];
const changedAssets=originalAssets.filter(p=>hash(`apps/web/${p}`)!==hash(`${handoff}/${p}`));
const baselineSize=JSON.parse(readFileSync(`${root}/baseline/bundle.json`)).gzip,currentSize=JSON.parse(readFileSync(`${root}/final/bundle.json`)).gzip;
const result={protectedCount:protectedFiles.length,changedProtected,changedContracts,changedAssets,changedFiles:changed,baselineGzip:baselineSize,finalGzip:currentSize,growth:currentSize-baselineSize,within60KiB:currentSize-baselineSize<=61440};
writeFileSync(`${root}/integrity.json`,JSON.stringify(result,null,2));console.log(JSON.stringify(result));
if(changedProtected.length||changedContracts.length||changedAssets.length||!result.within60KiB)process.exitCode=1;
