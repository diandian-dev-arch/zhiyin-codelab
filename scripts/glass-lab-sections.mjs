import { chromium } from '@playwright/test';
import { mkdirSync,writeFileSync } from 'node:fs';
const out='output/glass-lab/sections';mkdirSync(out,{recursive:true});
const browser=await chromium.launch({channel:'chrome'});
try {
const context=await browser.newContext({viewport:{width:1440,height:900}}),page=await context.newPage();const errors=[];
page.on('pageerror',e=>errors.push(e.message));
for(const theme of ['bronze','celadon','ochre','rose']){
  await page.addInitScript(t=>localStorage.setItem('codelab-theme',t),theme);
  await page.goto('http://localhost:5345/welcome');await page.locator('.hero-copy h1').waitFor();await page.waitForTimeout(2600);
  await page.screenshot({path:`${out}/hero-${theme}.png`});
}
await page.addInitScript(()=>localStorage.setItem('codelab-theme','bronze'));await page.goto('http://localhost:5345/welcome');await page.locator('#flow').waitFor();
for(const [name,selector,ratio] of [['flow-start','#flow',.18],['flow-mid','#flow',.62],['flow-full','#flow',.995],['report','#report',null],['features','#features',null],['roles','#roles',null],['outro','.outro-card',null]]){
  await page.locator(selector).evaluate((e,r)=>{if(r===null)e.scrollIntoView({block:'center',behavior:'instant'});else scrollTo({top:e.offsetTop+(e.offsetHeight-innerHeight)*r,behavior:'instant'});},ratio);
  await page.waitForTimeout(2300);await page.screenshot({path:`${out}/${name}.png`});
}
const flow=await page.locator('#flow').evaluate(e=>({height:e.offsetHeight,viewport:innerHeight}));
writeFileSync(`${out}/results.json`,JSON.stringify({errors,flow},null,2));console.log(JSON.stringify({errors,flow}));
} finally {await browser.close();}
