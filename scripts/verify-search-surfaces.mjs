import { chromium } from '@playwright/test';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const out='output/search-polish-2026-10-19';mkdirSync(out,{recursive:true});
const imports=[...readFileSync('apps/web/src/main-codelab.ts','utf8').matchAll(/import '([^']+\.css)'/g)].map(m=>`import '${m[1].replace('../','/').replace('./','/src/')}';`).join('\n');
const html=`<!doctype html><html lang="zh-CN" data-theme="bronze"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="search-test"></div><script type="module">
import {createApp,h,ref} from '/node_modules/.vite/deps/vue.js';
import StudioSearch from '/src/components/StudioSearch.vue';
import SourceFileTree from '/src/components/SourceFileTree.vue';
${imports}
createApp({setup(){const q=ref('');return()=>h('div',{class:'workspace',style:'display:block;padding:24px;min-height:100vh'},[
h('section',{style:'max-width:480px;margin:auto'},[
h('h2','任务搜索'),h(StudioSearch,{modelValue:q.value,label:'搜索任务或班级','onUpdate:modelValue':v=>q.value=v}),
h('main',{class:'course-page',style:'padding:24px 0'},[h('div',{class:'assignment-toolbar'},[h(StudioSearch,{modelValue:q.value,label:'搜索作业或班级','onUpdate:modelValue':v=>q.value=v})])]),
h('h2','文件搜索'),h(SourceFileTree,{files:[{path:'src/main.ts',lines:18},{path:'src/styles/glass.css',lines:80},{path:'README.md',lines:12}],citedPaths:['src/main.ts']})])]);}}).mount('#search-test');
</script></html>`;
const browser=await chromium.launch({channel:'chrome'}),errors=[],results=[];
let activePage;
try{
const context=await browser.newContext({viewport:{width:1440,height:900}}),page=await context.newPage();
activePage=page;
page.on('pageerror',e=>errors.push(e.message));
await page.route('**/__search-test',r=>r.fulfill({contentType:'text/html',body:html}));
await page.goto('http://localhost:5345/__search-test');await page.locator('.tree-search').waitFor();
for(const width of [320,375,390,414,768,962,1280,1440]){
 await page.setViewportSize({width,height:900});
 for(const label of ['搜索任务或班级','搜索作业或班级','搜索文件或路径']){
  const input=page.getByLabel(label,{exact:true}),outer=input.locator('..');
  const before=await input.boundingBox();await input.fill('main');
  const after=await input.boundingBox();assert.equal(before.width,after.width,'clear action must not resize text track');
  const state=await outer.evaluate(e=>({height:e.getBoundingClientRect().height,width:e.getBoundingClientRect().width,border:getComputedStyle(e.querySelector('input')).borderWidth,background:getComputedStyle(e.querySelector('input')).backgroundColor,outline:getComputedStyle(e).outlineStyle,scroll:document.documentElement.scrollWidth,inner:innerWidth}));
  assert.equal(state.border,'0px');assert.equal(state.height,48);assert.equal(state.outline,'solid');assert(state.scroll<=width);
  const clear=outer.getByRole('button',{name:label==='搜索文件或路径'?'清除文件搜索':'清空搜索',exact:true});
  const target=await clear.boundingBox();assert(target.width>=44&&target.height>=44);await clear.click();
  assert.equal(await input.inputValue(),'');assert(await input.evaluate(e=>e===document.activeElement));
  results.push({label,width,...state});
 }
}
for(const theme of ['bronze','celadon','ochre','rose']){await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);await page.getByLabel('搜索任务或班级',{exact:true}).fill('Vue');await page.screenshot({path:`${out}/search-${theme}.png`});}
await page.setViewportSize({width:390,height:844});await page.screenshot({path:`${out}/search-mobile.png`});
await page.emulateMedia({reducedMotion:'reduce'});assert.equal(await page.locator('.studio-search').first().evaluate(e=>getComputedStyle(e).transitionDuration),'0s');
await page.emulateMedia({forcedColors:'active'});await page.screenshot({path:`${out}/search-forced.png`});
await page.emulateMedia({forcedColors:'none',reducedMotion:'no-preference'});
await page.goto('http://localhost:5345/');await page.getByLabel('邮箱',{exact:true}).fill('teacher@codelab.local');await page.getByLabel('密码',{exact:true}).fill('Browser-test-only-2904!');await page.getByRole('button',{name:'登录',exact:true}).click();await page.getByLabel('搜索任务或班级',{exact:true}).waitFor();
await page.setViewportSize({width:1440,height:900});await page.getByLabel('搜索任务或班级',{exact:true}).fill('没有这份任务-搜索验证');await page.getByRole('heading',{name:'没有匹配的任务',exact:true}).waitFor();await page.locator('.studio-search').getByRole('button',{name:'清空搜索'}).click();await page.locator('.task-card').first().waitFor();await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:`${out}/tasks-desktop.png`,fullPage:true});
await page.setViewportSize({width:390,height:844});await page.screenshot({path:`${out}/tasks-mobile.png`,fullPage:true});
assert.deepEqual(errors,[]);writeFileSync(`${out}/results.json`,JSON.stringify({errors,results,clearFocus:'pass',inputTrackStable:'pass',taskFiltering:'pass'},null,2));console.log(JSON.stringify({errors,checks:results.length,clearFocus:'pass',taskFiltering:'pass'}));
}catch(e){console.log(await activePage.locator('body').innerHTML());throw e;}finally{await browser.close();}
