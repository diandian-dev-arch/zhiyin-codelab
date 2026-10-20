import {chromium} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
const root=path.dirname(fileURLToPath(import.meta.url));
await mkdir(path.join(root,'previews'),{recursive:true});
const browser=await chromium.launch({headless:true,channel:'chrome'});
const page=await browser.newPage({viewport:{width:1920,height:1080}});
const errors=[],checks=[];page.on('pageerror',e=>errors.push(e.message));
page.on('console',msg=>{if(msg.type()==='error')errors.push(msg.text());});
const url=name=>pathToFileURL(path.join(root,name)).href;
const assert=(condition,name)=>{if(!condition)throw Error(name);checks.push(name);};
for(const name of ['cover','evidence']){
 await page.goto(url(name+'.html'));await page.waitForFunction(()=>window.__ready);
 for(const t of [600,2600]){await page.evaluate(t=>window.__seek(t),t);await page.screenshot({path:path.join(root,'previews',name+(t===2600?'':'-motion')+'.png')});}
 assert(await page.locator('h1').evaluate(el=>{const a=el.getBoundingClientRect(),s=document.querySelector('.slide').getBoundingClientRect();return a.left>=s.left&&a.right<=s.right&&a.bottom<=s.bottom;}),name+' heading in bounds');
 assert(await page.evaluate(()=>[...document.images].every(i=>i.complete&&i.naturalWidth>0)),name+' images loaded');
 for(let i=0;i<3;i++){await page.locator(`[data-focus="${i}"]`).click();assert(await page.locator(`[data-focus="${i}"]`).getAttribute('aria-pressed')==='true',name+' focus '+i);}
 if(name==='evidence'){await page.locator('#open-image').click();assert(await page.locator('dialog').evaluate(d=>d.open),'image zoom opens');await page.keyboard.press('Escape');assert(await page.locator('dialog').evaluate(d=>!d.open),'image zoom Escape closes');assert(await page.locator('#open-image').evaluate(el=>el===document.activeElement),'image focus restored');}
}
await page.setViewportSize({width:1440,height:1040});await page.goto(url('index.html'));
const child=()=>page.frames().find(f=>f.url().endsWith('cover.html')||f.url().endsWith('evidence.html'));
await page.waitForFunction(()=>document.querySelector('#time').textContent.startsWith('2.6'));
await page.waitForFunction(()=>document.querySelector('#play').textContent==='播放');
await page.screenshot({path:path.join(root,'previews','player-desktop.png'),fullPage:true});
await page.locator('#replay').click();await page.waitForFunction(()=>document.querySelector('#play').textContent==='暂停');await page.locator('#play').click();
assert(!(await child().evaluate(()=>window.__state().playing)),'pause button stops animation');
await page.locator('#timeline').fill('600');assert((await child().evaluate(()=>window.__state().time))===600,'scrub seeks exact time');
await page.locator('#motion').click();await page.waitForFunction(()=>document.querySelector('#motion').getAttribute('aria-pressed')==='false');
assert((await child().evaluate(()=>window.__state().time))===2600,'motion off shows full content');
assert(await page.locator('#timeline').isDisabled(),'motion off disables timeline');
await page.locator('#palette').selectOption('ink');await page.waitForTimeout(70);
assert((await child().evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--blue')))==='#254779','palette updates slide');
await page.locator('#next').click();await page.waitForFunction(()=>document.querySelector('#time').textContent.startsWith('2.6'));
await page.locator('[data-focus="1"]').click();await page.waitForTimeout(70);assert((await child().evaluate(()=>window.__state().selected))===1,'host focus updates slide');
await child().locator('[data-focus="2"]').click();await page.waitForFunction(()=>document.querySelector('[data-focus="2"]').getAttribute('aria-pressed')==='true');checks.push('slide focus updates host');
await page.reload();await page.waitForFunction(()=>document.querySelector('#time').textContent.startsWith('2.6'));
assert(await page.locator('#slide').getAttribute('src')==='evidence.html','page preference restored');
assert(await page.locator('#palette').inputValue()==='ink','palette preference restored');
assert(await page.locator('#motion').getAttribute('aria-pressed')==='false','motion preference restored');
await page.locator('#fullscreen').click();await page.waitForFunction(()=>!!document.fullscreenElement);await page.locator('#exit-fullscreen').click();await page.waitForFunction(()=>!document.fullscreenElement);checks.push('fullscreen enter and exit');
await child().locator('h1').click();await page.keyboard.press('ArrowLeft');await page.waitForFunction(()=>document.querySelector('#slide').getAttribute('src')==='cover.html');checks.push('keyboard navigation from iframe');
await page.setViewportSize({width:390,height:844});await page.waitForTimeout(100);await page.screenshot({path:path.join(root,'previews','player-mobile.png'),fullPage:true});
assert(await page.evaluate(()=>document.documentElement.scrollWidth===innerWidth),'mobile no horizontal overflow');
await page.locator('[data-page="evidence"]').click();await page.waitForFunction(()=>document.querySelector('#time').textContent.startsWith('2.6'));await child().locator('#open-image').click();
assert(await child().locator('dialog').evaluate(el=>{const r=el.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight;}),'mobile zoom fits iframe');
await page.emulateMedia({reducedMotion:'reduce'});await page.goto(url('cover.html'));await page.waitForFunction(()=>window.__ready);assert(await page.evaluate(()=>window.__state().time===2600&&!window.__state().playing),'reduced motion static final frame');
assert(errors.length===0,'no browser errors');
await writeFile(path.join(root,'verification.json'),JSON.stringify({checks,errors},null,2));await browser.close();console.log(JSON.stringify({checks,errors},null,2));
