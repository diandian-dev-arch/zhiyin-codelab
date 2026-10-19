import { chromium } from '@playwright/test';
import { writeFileSync } from 'node:fs';
const browser=await chromium.launch({channel:'chrome'}),out='output/assignments-polish-2026-10-19';
try{
  const page=await browser.newPage({viewport:{width:1440,height:1000}});
  await page.goto('http://localhost:5348/assignments');
  await page.getByLabel('邮箱',{exact:true}).fill('teacher@codelab.local');await page.getByLabel('密码',{exact:true}).fill('Browser-test-only-2904!');
  await page.getByRole('button',{name:'登录',exact:true}).click();await page.locator('.assignment-row').first().waitFor();await page.waitForTimeout(800);
  await page.screenshot({path:`${out}/final-board-desktop.png`,fullPage:true});
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:`${out}/final-board-mobile.png`,fullPage:true});
  const controls=await page.locator('.assignment-toolbar button,.assignment-toolbar input,.assignment-toolbar select').evaluateAll(es=>es.map(e=>({name:e.getAttribute('aria-label')||e.textContent.trim(),w:e.getBoundingClientRect().width,h:e.getBoundingClientRect().height,border:getComputedStyle(e).borderWidth})));
  writeFileSync(`${out}/controls.json`,JSON.stringify(controls,null,2));
}finally{await browser.close();}
