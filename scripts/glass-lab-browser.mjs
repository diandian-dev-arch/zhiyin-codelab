import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
const out='output/glass-lab/browser';mkdirSync(out,{recursive:true});
const browser=await chromium.launch({channel:'chrome',args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const context=await browser.newContext({viewport:{width:1440,height:900}});
const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
const base='http://localhost:5345';
const results=[];
async function layout(label){results.push({label,...await page.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,canvas:document.querySelectorAll('canvas').length,overflow:[...document.querySelectorAll('main,.page-heading,.panel,.task-card,.login-container,.source-report,.v2-report,.agent-studio,dialog[open],.model-columns')].filter(e=>{const r=e.getBoundingClientRect();return r.width&&r.height&&(r.left < -1||r.right>innerWidth+1);}).map(e=>e.className),smallTargets:[...document.querySelectorAll('button,a[href],summary,input[type=checkbox],input[type=radio]')].filter(e=>{const r=e.getBoundingClientRect();return r.width&&r.height&&getComputedStyle(e).visibility!=='hidden'&&(r.width<43.9||r.height<43.9);}).map(e=>({tag:e.tagName,text:(e.textContent||e.getAttribute('aria-label')||'').slice(0,50),class:e.className,w:e.getBoundingClientRect().width,h:e.getBoundingClientRect().height})).slice(0,50)}))});}
for(const path of ['/','/welcome']){
  await page.goto(base+path);await page.locator(path==='/'?'#login-title':'.hero-copy h1').waitFor();
  await page.waitForTimeout(3200);await page.screenshot({path:`${out}/${path==='/'?'login':'welcome'}-desktop.png`});
  for(const width of [320,375,390,414,768,1280,1440]){await page.setViewportSize({width,height:900});await page.waitForTimeout(100);await layout(path);}
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:`${out}/${path==='/'?'login':'welcome'}-mobile.png`,fullPage:false});await page.setViewportSize({width:1440,height:900});
}
await page.goto(base+'/');await page.getByLabel('邮箱',{exact:true}).fill('teacher@codelab.local');await page.getByLabel('密码',{exact:true}).fill('Browser-test-only-2904!');await page.getByRole('button',{name:'登录',exact:true}).click();await page.locator('.workspace').waitFor();
for(const path of ['/','/projects','/assignments','/runs/00000000-0000-4000-8000-000000000003','/settings']){
  await page.goto(base+path);await page.locator('.workspace').waitFor();
  await page.locator(path==='/projects'?'.zip-drop':path==='/settings'?'.gl-theme-list':path.startsWith('/runs')?'.v2-evidence':path==='/assignments'?'.course-page':'.task-card').first().waitFor();
  await page.waitForTimeout(1600);
  for(const width of [320,375,390,414,768,1280,1440]){await page.setViewportSize({width,height:900});await layout(path);}
  await page.screenshot({path:`${out}/workspace-${path.replaceAll('/','')||'tasks'}.png`,fullPage:true});
  await page.setViewportSize({width:390,height:844});
  if(path.startsWith('/runs')){for(const selector of ['.agent-studio','.v2-publication']){await page.locator(selector).scrollIntoViewIfNeeded();await page.waitForTimeout(1500);await page.locator(selector).screenshot({path:`${out}/${selector.slice(1)}-mobile.png`});}await page.evaluate(()=>scrollTo(0,0));await page.waitForTimeout(500);}
  await page.screenshot({path:`${out}/workspace-${path.replaceAll('/','')||'tasks'}-mobile.png`,fullPage:true});await page.setViewportSize({width:1440,height:900});
}
await page.getByRole('button',{name:'模型设置',exact:true}).click();await page.locator('dialog[open]').waitFor();for(const width of [320,390,768,1440]){await page.setViewportSize({width,height:900});await layout('dialog');}
await page.screenshot({path:`out/model-dialog.png`.replace('out/',out+'/'),fullPage:true});
writeFileSync(`${out}/results.json`,JSON.stringify({errors,results},null,2));console.log(JSON.stringify({errors,violations:results.filter(r=>r.scrollWidth>r.width||r.overflow.length)}));await browser.close();
