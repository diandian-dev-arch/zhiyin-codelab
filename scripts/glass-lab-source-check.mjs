import { chromium } from '@playwright/test';
import {zipSync,strToU8} from 'fflate';
import {mkdirSync,writeFileSync} from 'node:fs';
const out='output/glass-lab/source-browser';mkdirSync(out,{recursive:true});const browser=await chromium.launch({channel:'chrome'}),results=[],errors=[];
const page=await browser.newPage({viewport:{width:1440,height:900}});
try{
page.on('pageerror',e=>errors.push(e.message));
await page.goto('http://localhost:5347/projects');await page.getByLabel('邮箱',{exact:true}).fill('teacher@codelab.local');await page.getByLabel('密码',{exact:true}).fill('Browser-test-only-2904!');await page.getByRole('button',{name:'登录',exact:true}).click();await page.getByLabel('选择项目 ZIP',{exact:true}).waitFor({state:'attached'});
await page.waitForTimeout(1200);
const existing=page.locator('.project-history a').filter({hasText:'glass-lab-synthetic'}).first();
if(await existing.count())await existing.click();else{
await page.getByLabel('选择项目 ZIP',{exact:true}).setInputFiles({name:'glass-lab-synthetic.zip',mimeType:'application/zip',buffer:Buffer.from(zipSync({'hello/app.py':strToU8('print("glass-lab-visual-fixture")')}))});
await page.getByRole('button',{name:'保存并继续',exact:true}).click();await page.getByRole('button',{name:'关闭解读配置',exact:true}).click();await page.getByRole('button',{name:'开始解读',exact:true}).click();await page.getByRole('button',{name:/^确认并开始解读 ·/}).click();
}
const report=page.getByRole('region',{name:'项目解读报告',exact:true});await report.locator('.overview-text').waitFor({timeout:30000});
async function capture(label){for(const width of [320,375,390,414,768,1280,1440]){await page.setViewportSize({width,height:900});await page.waitForTimeout(1000);results.push({label,...await page.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,overflow:[...document.querySelectorAll('main,.source-report,.evidence-pane,.evidence-workspace.is-split,.project-map,.directory-map,.source-file-tree,dialog[open]')].filter(e=>{const r=e.getBoundingClientRect();return r.width&&r.height&&(r.left < -1||r.right>innerWidth+1);}).map(e=>e.className)}))});}await page.screenshot({path:`${out}/${label}-desktop.png`,fullPage:true});await page.setViewportSize({width:390,height:844});await page.waitForTimeout(1500);await page.screenshot({path:`${out}/${label}-mobile.png`,fullPage:label!=='source-evidence'});await page.setViewportSize({width:1440,height:900});await page.waitForTimeout(1000);}
await capture('source-overview');await report.getByRole('tab',{name:'源码与模块',exact:true}).click();await capture('source-modules');
await report.getByRole('tab',{name:'读懂项目',exact:true}).click();
if(await page.locator('.map-root').first().isVisible()){await page.locator('.map-root').first().hover();results.push({label:'map-opacity',...await page.locator('.map-root').first().evaluate(e=>({background:getComputedStyle(e).backgroundColor}))});}
await report.locator('.reader-source').first().click();await page.locator('.evidence-pane').waitFor();await capture('source-evidence');await page.keyboard.press('Escape');
writeFileSync(`${out}/results.json`,JSON.stringify({errors,results},null,2));console.log(JSON.stringify({errors,violations:results.filter(r=>r.overflow?.length||r.scrollWidth>r.width)}));
}catch(error){await page.screenshot({path:`${out}/failure.png`,fullPage:true});console.log(await page.locator('body').innerText());throw error;}finally{await browser.close();}
