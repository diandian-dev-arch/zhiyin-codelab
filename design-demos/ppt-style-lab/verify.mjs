import {chromium} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
const root=path.dirname(fileURLToPath(import.meta.url));
await mkdir(path.join(root,'previews'),{recursive:true});
const browser=await chromium.launch({headless:true,channel:'chrome'});
const page=await browser.newPage({viewport:{width:1920,height:1080},deviceScaleFactor:1});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
const report={slides:[],interactions:[],errors};
for(const dir of ['a','b','c'])for(const kind of ['cover','evidence']){
 const name=`${dir}-${kind}`;
 await page.goto(pathToFileURL(path.join(root,'slides',name+'.html')).href);
 await page.waitForFunction(()=>window.__ready===true);await page.evaluate(()=>document.fonts.ready);
 const state=await page.evaluate(()=>{const s=document.querySelector('.slide'),r=s.getBoundingClientRect();return{width:r.width,height:r.height,images:[...document.images].map(i=>({complete:i.complete,width:i.naturalWidth})),overflow:[...s.querySelectorAll('h1,h2,h3,p,figure,figcaption')].filter(el=>{let b=el.getBoundingClientRect();return b.left<r.left-1||b.top<r.top-1||b.right>r.right+1||b.bottom>r.bottom+1}).map(el=>el.textContent.slice(0,80))};});
 await page.screenshot({path:path.join(root,'previews',name+'.png')});report.slides.push({name,...state});
}
await page.setViewportSize({width:1440,height:1000});
await page.goto(pathToFileURL(path.join(root,'index.html')).href);
for(const dir of ['a','b','c']){
 await page.locator(`[data-direction="${dir}"]`).click();
 for(const kind of ['cover','evidence']){await page.locator(`[data-page="${kind}"]`).click();await page.frameLocator('#preview').locator('.slide').waitFor();const src=await page.locator('#preview').getAttribute('src');if(src!==`slides/${dir}-${kind}.html`)throw Error('Wrong preview');report.interactions.push(src);}
}
await page.locator('[data-direction="a"]').click();await page.locator('[data-page="cover"]').click();
await page.locator('#fullscreen').click();await page.waitForFunction(()=>document.fullscreenElement?.id==='canvas');await page.evaluate(()=>document.exitFullscreen());report.interactions.push('fullscreen enter and exit passed');
await page.screenshot({path:path.join(root,'previews','selection-desktop.png'),fullPage:true});
await page.locator('#choose').click();if(!(await page.locator('#selection').textContent()).includes('已在本机'))throw Error('Choice status failed');
await page.keyboard.press('ArrowRight');if(!(await page.locator('#preview').getAttribute('src')).includes('evidence'))throw Error('Keyboard failed');
await page.reload();if(!(await page.locator('#preview').getAttribute('src')).includes('evidence'))throw Error('Restore failed');
report.interactions.push('preference, keyboard, reload passed');
await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(root,'previews','selection-mobile.png'),fullPage:true});
report.mobile=await page.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth}));
await page.setViewportSize({width:1440,height:900});await page.goto(pathToFileURL(path.join(root,'deck.html')).href);
await page.locator('#wall .card').first().click();await page.keyboard.press('ArrowRight');if(!(await page.locator('#frame').getAttribute('src')).includes('a-evidence'))throw Error('Deck navigation failed');await page.keyboard.press('Escape');if(await page.locator('body').getAttribute('data-mode')!=='overview')throw Error('Overview return failed');
report.interactions.push('overview enter, next, escape passed');
await writeFile(path.join(root,'verification.json'),JSON.stringify(report,null,2));
await browser.close();console.log(JSON.stringify(report,null,2));
if(errors.length||report.slides.some(s=>s.overflow.length||s.images.some(i=>!i.complete||!i.width))||report.mobile.scrollWidth>report.mobile.width)process.exitCode=1;
