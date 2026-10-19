// Observe current tasks; intercept rule POSTs so no live rule is published.
import assert from 'node:assert/strict';
import {chromium,expect} from '@playwright/test';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
const origin='http://127.0.0.1:5174';
const directory=path.resolve('docs/verification/2026-09-29',`rule-draft-${randomUUID()}`);
await mkdir(directory,{recursive:true});
const {loginPassword}=JSON.parse(await readFile('.data/business-v2/development-credentials.json','utf8'));
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000}});
const errors:string[]=[],requests:{key:string|undefined;body:any}[]=[];
page.on('pageerror',e=>errors.push(e.message));
await page.route('**/api/**',async route=>{
  const request=route.request(),pathname=new URL(request.url()).pathname;
  if(request.method()==='POST'&&/^\/api\/v2\/tasks\/[^/]+\/rules$/.test(pathname)){
    requests.push({key:request.headers()['idempotency-key'],body:request.postDataJSON()});
    await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'VERIFY_ONLY',message:'验证：暂时无法发布，请重试'}})});
  }else if(!['GET','HEAD'].includes(request.method())&&!pathname.endsWith('/session/login')){
    await route.abort();throw new Error('UNEXPECTED_WRITE');
  }else await route.continue();
});
const result:Record<string,unknown>={state:'running',businessWrites:0,externalModelCalls:0};
try{
  await page.goto(origin+'/projects');await page.getByLabel('邮箱').fill('teacher@codelab.local');
  await page.getByLabel('密码',{exact:true}).fill(loginPassword);await page.getByRole('button',{name:'登录',exact:true}).click();
  await expect(page.getByLabel('上传项目 ZIP')).toBeVisible();
  const response=await page.request.get(origin+'/api/v2/tasks');assert.equal(response.status(),200);
  const data=await response.json(),task=data.items[0];assert(task);
  await page.goto(origin+'/tasks/'+(task.taskId??task.id));
  await page.getByText('选择验收包并发布新规则',{exact:true}).click();
  const fields=page.locator('.rule-draft-fields');
  const packs=await fields.locator('select').first().locator('option').evaluateAll(options=>options.map(o=>({value:(o as HTMLOptionElement).value,text:o.textContent})));
  const core=packs.find(p=>p.text?.includes('vue-board-core'));assert(core);
  await fields.locator('select').first().selectOption(core.value);
  const confirmation=page.getByLabel('我已确认以上要求与本次课程任务一致');
  const parameter=page.getByLabel('空白提交时必须显示提示信息');
  const publish=page.getByRole('button',{name:'发布新规则',exact:true});
  await expect(page.getByRole('region',{name:'待发布要求预览'})).toContainText('8 个自动案例');
  await confirmation.check();await expect(publish).toBeEnabled();
  await parameter.check();await expect(confirmation).not.toBeChecked();await expect(publish).toBeDisabled();
  await confirmation.check();await publish.click();await expect(page.getByText('验证：暂时无法发布，请重试',{exact:true})).toBeVisible();
  await expect(parameter).toBeChecked();await expect(confirmation).toBeChecked();
  await publish.click();await expect.poll(()=>requests.length).toBe(2);
  assert.equal(requests[0].key,requests[1].key);
  await parameter.uncheck();await expect(confirmation).not.toBeChecked();
  await confirmation.check();await publish.click();await expect.poll(()=>requests.length).toBe(3);
  assert.notEqual(requests[1].key,requests[2].key);
  assert.equal(requests[0].body.parameterValues.requireValidationMessage,true);
  assert.equal(requests[2].body.parameterValues.requireValidationMessage,false);
  const requirement=fields.locator('.v2-check input').first();
  await requirement.uncheck();await expect(confirmation).not.toBeChecked();await expect(publish).toBeDisabled();
  await page.screenshot({path:path.join(directory,'desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await fields.scrollIntoViewIfNeeded();await page.screenshot({path:path.join(directory,'mobile.png'),fullPage:true});
  assert.deepEqual(errors,[]);Object.assign(result,{state:'passed',confirmationInvalidated:true,sameDraftRetryKeyPreserved:true,
    editedDraftKeyChanged:true,failedInputPreserved:true,interceptedRuleRequests:requests.length,pageErrors:errors});
}catch(error){result.state='failed';result.error=error instanceof Error?error.message:String(error);process.exitCode=1;}
finally{await browser.close();await writeFile(path.join(directory,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({directory,...result}));}
