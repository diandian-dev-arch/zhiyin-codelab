// Read-only check of the running teacher roster UI; creates no accounts/classes.
import {chromium,expect} from '@playwright/test';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
const directory=`docs/verification/2026-09-29/class-members-live-${randomUUID()}`;
await mkdir(directory,{recursive:true});
const {loginPassword}=JSON.parse(await readFile('.data/business-v2/development-credentials.json','utf8'));
const browser=await chromium.launch({channel:'chrome',headless:true});
const result:Record<string,unknown>={state:'running',modelCalls:0,managementWrites:0};
try{
  for(const role of ['teacher','student']){
    const page=await browser.newPage({baseURL:'http://127.0.0.1:5174',viewport:{width:1440,height:1000}});
    await page.goto('/');await page.getByLabel('邮箱').fill(`${role}@codelab.local`);
    await page.getByLabel('密码',{exact:true}).fill(loginPassword);await page.getByRole('button',{name:'登录',exact:true}).click();
    await expect(page.getByRole('heading',{name:'实训任务',exact:true})).toBeVisible();
    const classes=await(await page.request.get('/api/v1/classes')).json();assert(classes.items.length);
    const response=await page.request.get(`/api/v1/classes/${classes.items[0].id}/students`);
    assert.equal(response.status(),role==='teacher'?200:403);
    if(role==='teacher'){
      const payload=await response.json();assert(payload.items.every((item:any)=>Object.keys(item).sort().join(',')==='email,id,name'));
      await page.getByRole('button',{name:'班级与账号'}).click();await page.getByRole('button',{name:'查询班级成员',exact:true}).click();
      await expect(page.getByRole('button',{name:'查询班级成员',exact:true})).toBeEnabled();
      await expect(page.getByRole('region',{name:'班级成员核对'}).getByRole('alert')).toHaveCount(0);
      await page.screenshot({path:`${directory}/desktop.png`,fullPage:true});
      await page.setViewportSize({width:390,height:844});
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
      await page.screenshot({path:`${directory}/mobile.png`,fullPage:true});
    }
    await page.close();
  }
  result.state='passed';
}catch(error){result.state='failed';result.error=error instanceof Error?error.message:String(error);process.exitCode=1;}
finally{await browser.close();await writeFile(`${directory}/result.json`,JSON.stringify(result,null,2));console.log(JSON.stringify({directory,...result}));}
