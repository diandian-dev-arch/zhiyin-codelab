import { chromium } from '@playwright/test';
import { mkdirSync,writeFileSync } from 'node:fs';
const out='output/glass-lab/metrics';mkdirSync(out,{recursive:true});const browser=await chromium.launch({channel:'chrome'}),all=[];
try {
const page=await browser.newPage({viewport:{width:1440,height:900}});
await page.goto('http://localhost:5345/');await page.getByLabel('邮箱',{exact:true}).fill('teacher@codelab.local');await page.getByLabel('密码',{exact:true}).fill('Browser-test-only-2904!');await page.getByRole('button',{name:'登录',exact:true}).click();await page.locator('.workspace').waitFor();
async function inspect(label){
const result=await page.evaluate(()=>{
  const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const ctx=canvas.getContext('2d',{willReadFrequently:true});
  const rgba=s=>{ctx.clearRect(0,0,1,1);ctx.fillStyle=s;ctx.fillRect(0,0,1,1);return Array.from(ctx.getImageData(0,0,1,1).data).map((v,i)=>i===3?v/255:v);};
  const mix=(a,b)=>a.slice(0,3).map((v,i)=>v*a[3]+b[i]*(1-a[3]));
  const luminance=c=>c.slice(0,3).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);
  const ratio=(a,b)=>{const x=luminance(a),y=luminance(b);return(Math.max(x,y)+.05)/(Math.min(x,y)+.05);};
  const background=e=>{const chain=[];for(let n=e;n;n=n.parentElement)chain.unshift(n);let bg=rgba(getComputedStyle(document.documentElement).backgroundColor);for(const n of chain)bg=mix(rgba(getComputedStyle(n).backgroundColor),bg);return bg;};
  const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'&&!e.closest('[aria-hidden=true],.gl-sr-only,.sr-only');};
  const contrast=[...document.querySelectorAll('body *')].filter(e=>visible(e)&&Array.from(e.childNodes).some(n=>n.nodeType===3&&n.textContent.trim())&&!e.closest('button:disabled,[aria-disabled=true],script,style,svg')).map(e=>{const s=getComputedStyle(e),bg=background(e),fg=mix(rgba(s.color),bg);return{tag:e.tagName,class:e.className,text:e.textContent.trim().slice(0,60),ratio:ratio(fg,bg),color:s.color,background:s.backgroundColor};}).filter(r=>r.ratio<4.5);
  const targets=[...document.querySelectorAll('button,a[href],summary,input[type=checkbox],input[type=radio]')].filter(visible).map(e=>{const label=e.matches('input')?(e.closest('label')||document.querySelector(`label[for="${e.id}"]`)):null;const r=(label||e).getBoundingClientRect();return{tag:e.tagName,class:e.className,text:e.textContent.trim().slice(0,35),width:r.width,height:r.height,measuredLabel:!!label};}).filter(r=>r.width<43.9||r.height<43.9);
  return{contrast,targets,canvas:document.querySelectorAll('canvas').length};
});all.push({label,...result});}
for(const path of ['/','/projects','/assignments','/runs/00000000-0000-4000-8000-000000000003','/settings']){await page.goto('http://localhost:5345'+path);await page.locator('.workspace').waitFor();await page.waitForTimeout(700);await inspect(path);}
await page.getByRole('button',{name:'模型设置',exact:true}).click();await page.locator('dialog[open]').waitFor();await inspect('model-dialog');
writeFileSync(`${out}/results.json`,JSON.stringify(all,null,2));console.log(JSON.stringify(all));
}finally{await browser.close();}
