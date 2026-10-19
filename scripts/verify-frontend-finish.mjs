import { chromium } from '@playwright/test';
import { mkdirSync,writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const phase=process.argv.includes('--before')?'before':'after',out=`output/frontend-finish-2026-10-19/${phase}`;
mkdirSync(out,{recursive:true});const browser=await chromium.launch({channel:'chrome'}),errors=[],results=[];
try{
const page=await browser.newPage({viewport:{width:1440,height:900}});page.on('pageerror',e=>errors.push(e.message));
async function measure(name){const state=await page.evaluate(()=>{
const sidebar=document.querySelector('.sidebar'),r=sidebar?.getBoundingClientRect(),m=document.querySelector('#main-content').getBoundingClientRect();
return{width:innerWidth,scrollWidth:document.documentElement.scrollWidth,sidebarClear:!sidebar||getComputedStyle(sidebar).display==='none'||m.left>=r.right,
overflow:[...document.querySelectorAll('main,.page-heading,.panel,.task-card,.model-columns,.project-library-heading,.review-split,dialog[open],.login-container,.gl-theme-list')].filter(e=>{const a=e.getBoundingClientRect();return a.width&&a.height&&(a.left< -1||a.right>innerWidth+1);}).map(e=>e.className),canvas:document.querySelectorAll('canvas').length};});results.push({name,...state});if(phase==='after'){assert(state.scrollWidth<=state.width,`${name}:horizontal overflow ${state.width}`);assert(state.sidebarClear,`${name}:sidebar overlap ${state.width}`);assert.deepEqual(state.overflow,[],`${name}:element overflow ${state.width}`);}}
async function inspect(name){for(const width of[320,375,390,414,768,962,1280,1440]){await page.setViewportSize({width,height:900});await page.waitForTimeout(180);await measure(name);}await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:`${out}/${name}-desktop.png`,fullPage:true});await page.setViewportSize({width:390,height:844});await page.screenshot({path:`${out}/${name}-mobile.png`,fullPage:true});await page.setViewportSize({width:1440,height:900});}
await page.goto('http://localhost:5345/');await page.locator('#login-title').waitFor();await page.waitForTimeout(2600);await inspect('login');
await page.getByLabel('邮箱',{exact:true}).fill('teacher@codelab.local');await page.getByLabel('密码',{exact:true}).fill('Browser-test-only-2904!');await page.getByRole('button',{name:'登录',exact:true}).click();await page.locator('.task-card').first().waitFor();await inspect('tasks');
await page.getByRole('button',{name:'创建任务',exact:true}).click();await page.getByLabel('任务名称',{exact:true}).waitFor();await inspect('task-create');await page.getByRole('button',{name:'取消',exact:true}).click();
await page.getByRole('button',{name:'班级与账号',exact:true}).click();await page.getByRole('heading',{name:'班级与学生账号',exact:true}).waitFor();await inspect('class-accounts');
for(const[name,path,selector]of[['projects','/projects','.studio-title h1'],['coursework','/assignments','.course-page'],['review','/runs/00000000-0000-4000-8000-000000000003','.v2-evidence'],['settings','/settings','.gl-theme-list'],['unavailable','/not-a-record','.unavailable-page']]){await page.goto('http://localhost:5345'+path);await page.locator(selector).waitFor();await page.waitForTimeout(800);await inspect(name);}
await page.goto('http://localhost:5345/settings');await page.locator('.gl-theme-list').waitFor();
if(phase==='after'){
 const selected=page.getByRole('radio',{name:'石墨·铜金',exact:true});await selected.click();await selected.focus();await page.keyboard.press('ArrowRight');await page.waitForTimeout(1000);assert.equal(await page.getByRole('radio',{name:'墨色·青瓷',exact:true}).getAttribute('aria-checked'),'true');await page.keyboard.press('End');await page.waitForTimeout(1000);assert.equal(await page.getByRole('radio',{name:'烟墨·灰玫',exact:true}).getAttribute('aria-checked'),'true');await page.keyboard.press('Home');await page.waitForTimeout(1000);assert.equal(await selected.getAttribute('aria-checked'),'true');
}
await page.getByRole('button',{name:'模型设置',exact:true}).click();await page.locator('dialog[open]').waitFor();await inspect('model-dialog');
await page.setViewportSize({width:390,height:844});await page.locator('.model-save').scrollIntoViewIfNeeded();await page.screenshot({path:`out/model-dialog-actions-mobile.png`.replace('out/',out+'/')});
await page.setViewportSize({width:1440,height:900});await page.keyboard.press('Escape');
if(phase==='after')assert(await page.getByRole('button',{name:'模型设置',exact:true}).evaluate(e=>document.activeElement===e));
await page.emulateMedia({reducedMotion:'reduce'});await page.goto('http://localhost:5345/');await page.locator('.task-card').first().waitFor();await measure('reduced');assert.equal(await page.getByRole('button',{name:'创建任务',exact:true}).evaluate(e=>getComputedStyle(e).transitionDuration),'0s');
writeFileSync(`${out}/results.json`,JSON.stringify({errors,results},null,2));console.log(JSON.stringify({phase,checks:results.length,sidebarViolations:results.filter(r=>!r.sidebarClear).length,errors}));assert.deepEqual(errors,[]);
}finally{await browser.close();}
