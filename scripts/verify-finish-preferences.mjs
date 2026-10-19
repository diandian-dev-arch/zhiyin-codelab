import{chromium}from'@playwright/test';import{writeFileSync}from'node:fs';import assert from'node:assert/strict';
const browser=await chromium.launch({channel:'chrome'}),out='output/frontend-finish-2026-10-19',results=[];
try{
const page=await browser.newPage({viewport:{width:962,height:600}}),cdp=await page.context().newCDPSession(page);
await page.goto('http://localhost:5345/');await page.getByLabel('邮箱',{exact:true}).fill('teacher@codelab.local');await page.getByLabel('密码',{exact:true}).fill('Browser-test-only-2904!');await page.getByRole('button',{name:'登录',exact:true}).click();await page.locator('.task-card').first().waitFor();
await page.locator('.sidebar .account').scrollIntoViewIfNeeded();await page.screenshot({path:`${out}/after/sidebar-short-window.png`});
results.push(await page.locator('.sidebar').evaluate(e=>({name:'short-sidebar',height:e.clientHeight,content:e.scrollHeight,scrollable:getComputedStyle(e).overflowY})));
const button=page.getByRole('button',{name:'创建任务',exact:true});await button.scrollIntoViewIfNeeded();const before=await button.boundingBox();await button.hover();const after=await button.boundingBox();assert.deepEqual(before,after);
await page.goto('http://localhost:5345/settings');await page.locator('.gl-theme-list').waitFor();
await page.emulateMedia({forcedColors:'active'});await page.screenshot({path:`${out}/after/settings-forced.png`});
await page.emulateMedia({forcedColors:'none',contrast:'more'});await page.screenshot({path:`${out}/after/settings-contrast.png`});
await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-transparency',value:'reduce'}]});
results.push(await page.locator('.sidebar').evaluate(e=>({name:'reduced-transparency',background:getComputedStyle(e).backgroundColor,blur:getComputedStyle(e).backdropFilter})));await cdp.send('Emulation.setEmulatedMedia',{features:[]});
await page.emulateMedia({reducedMotion:'reduce'});await page.getByRole('button',{name:'模型设置',exact:true}).click();await page.locator('dialog[open]').waitFor();assert.equal(await page.locator('dialog[open]').evaluate(e=>getComputedStyle(e).animationName),'none');
await page.keyboard.press('Escape');await page.setViewportSize({width:320,height:700});await page.evaluate(()=>document.documentElement.style.fontSize='125%');
results.push(await page.evaluate(()=>({name:'text125',width:innerWidth,scrollWidth:document.documentElement.scrollWidth})));assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:`${out}/after/settings-text125-mobile.png`});
writeFileSync(`${out}/preferences.json`,JSON.stringify({results,hoverStable:true,reducedDialog:true},null,2));console.log(JSON.stringify({results,hoverStable:true,reducedDialog:true}));
}finally{await browser.close();}
