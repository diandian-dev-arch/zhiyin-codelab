// Mechanical color migration only. No Vue script/template or business code changes.
import { readFileSync, writeFileSync, readdirSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(realpathSync('apps/web/node_modules/vite/package.json'));
const postcss = require('postcss');
const skip = new Set(['Notifications.vue','CodeFlowAnimation.vue','PaperBackground.vue','ProjectChart.vue']);
const paths = ['apps/web/src/style.css',...['studio','motion','manuscript','coursework'].map(n=>`apps/web/src/styles/${n}.css`),...['views','components'].flatMap(dir=>readdirSync(`apps/web/src/${dir}`).filter(n=>n.endsWith('.vue')&&!skip.has(n)).map(n=>`apps/web/src/${dir}/${n}`))];
const literal = /#[\da-f]{3,8}\b|rgba?\(\s*[\d.]+(?:\s*[, ]\s*[\d.%]+){2}(?:\s*[,/]\s*[\d.%]+)?\s*\)|\b(?:white|black)\b/gi;
let count = 0;
function token(value,prop) {
  if (prop.includes('shadow')) return 'var(--gl-bg)';
  if (prop.includes('border') || prop.includes('outline')) return 'var(--gl-control-line)';
  if (prop.includes('background')) return 'var(--gl-solid)';
  if (prop === 'color' || prop.includes('fill') || prop.includes('stroke')) return 'var(--gl-text)';
  return 'var(--gl-solid)';
}
function migrate(css) {
  const root = postcss.parse(css);
  root.walkDecls(d=>{
    if (d.prop.startsWith('--')) return;
    if (d.prop === 'color' && /var\(--paper\)/.test(d.value)) {
      const background = d.parent.nodes?.find(n=>n.type==='decl'&&/^background/.test(n.prop))?.value ?? '';
      d.value = d.value.replaceAll('var(--paper)', /var\(--accent\)/.test(background)?'var(--gl-on-c1)':'var(--gl-text)');count++;
    }
    if (/background/.test(d.prop) && /var\(--ink\)/.test(d.value)) {d.value=d.value.replaceAll('var(--ink)','var(--gl-solid)');count++;}
    if (literal.test(d.value) && !d.value.includes('url(')) {literal.lastIndex=0;d.value=d.value.replace(literal,v=>token(v,d.prop));count++;}
    literal.lastIndex=0;
  });
  return root.toString();
}
for(const p of paths) {
  const original=readFileSync(p,'utf8');
  const next=p.endsWith('.vue')?original.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/g,(_,a,css,b)=>a+migrate(css)+b):migrate(original);
  if(next!==original)writeFileSync(p,next);
}
console.log(`Migrated ${count} CSS declarations; script/template blocks untouched.`);
