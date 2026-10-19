import{readFileSync,writeFileSync,mkdirSync,realpathSync}from'node:fs';import{createRequire}from'node:module';
const a=createRequire(import.meta.url),b=createRequire(realpathSync(a.resolve('@playwright/test'))),c=createRequire(realpathSync(b.resolve('playwright'))),d=createRequire(realpathSync(c.resolve('playwright-core'))),{PNG}=d('./lib/utilsBundle.js');
const out='output/glass-lab/comparison';mkdirSync(out,{recursive:true});
for(const [name,reference,current]of[
  ['login','design-proposals/2026-10-18-glass-lab/handoff/screenshots/05-login-teacher-bronze.png','output/glass-lab/browser/login-desktop.png'],
  ['welcome','design-proposals/2026-10-18-glass-lab/handoff/screenshots/01-landing-hero-bronze.png','output/glass-lab/browser/welcome-desktop.png']]){
  const left=PNG.sync.read(readFileSync(reference)),right=PNG.sync.read(readFileSync(current)),image=new PNG({width:left.width+right.width,height:Math.max(left.height,right.height)});
  for(const [p,x]of[[left,0],[right,left.width]])for(let y=0;y<p.height;y++)p.data.copy(image.data,(y*image.width+x)*4,y*p.width*4,(y+1)*p.width*4);
  writeFileSync(`${out}/${name}-reference-left-implementation-right.png`,PNG.sync.write(image));
}
console.log(out);
