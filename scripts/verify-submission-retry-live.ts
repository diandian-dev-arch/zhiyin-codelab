// All run mutations are intercepted. No check, publication or model call is created.
import assert from 'node:assert/strict';
import {chromium,expect} from '@playwright/test';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
const origin='http://127.0.0.1:5174';
const directory=path.resolve('docs/verification/2026-09-29',`submission-retry-${randomUUID()}`);
await mkdir(directory,{recursive:true});
const {loginPassword}=JSON.parse(await readFile('.data/business-v2/development-credentials.json','utf8'));
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000}});
const errors:string[]=[],requests:{key:string|undefined;body:any}[]=[];
page.on('pageerror',e=>errors.push(e.message));
await page.route('**/api/**',async route=>{
  const req=route.request(),pathname=new URL(req.url()).pathname;
  if(req.method()==='POST'&&/^\/api\/v2\/submissions\/[^/]+\/runs$/.test(pathname)){
    requests.push({key:req.headers()['idempotency-key'],body:req.postDataJSON()});
    await route.fulfill({status:requests.length===3?201:503,contentType:'application/json',
      body:JSON.stringify(requests.length===3?{runId:randomUUID()}:{error:{code:'VERIFY_ONLY',message:'验证：检查服务暂不可用'}})});
  }else if(!['GET','HEAD'].includes(req.method())&&!pathname.endsWith('/session/login')){
    await route.abort();errors.push('UNEXPECTED_WRITE');
  }else await route.continue();
});
const result:Record<string,unknown>={state:'running',businessWrites:0,externalModelCalls:0};
try{
  await page.goto(origin+'/projects');await page.getByLabel('邮箱').fill('student@codelab.local');
  await page.getByLabel('密码',{exact:true}).fill(loginPassword);await page.getByRole('button',{name:'登录',exact:true}).click();
  await expect(page.getByLabel('上传项目 ZIP')).toBeVisible();
  const tasks=await(await page.request.get(origin+'/api/v2/tasks')).json();
  let target:any,before:any;
  for(const task of tasks.items){
    const submissions=await(await page.request.get(origin+'/api/v2/tasks/'+task.taskId+'/submissions')).json();
    if(submissions.items.some((s:any)=>s.latestRun?.status==='completed')){target=task;before=submissions;break;}
  }
  assert(target,'NEED_EXISTING_COMPLETED_SUBMISSION');
  await page.goto(origin+'/tasks/'+target.taskId);
  await page.getByText('如何准备可提交的 ZIP',{exact:true}).click();
  await expect(page.locator('.submission-guide')).toContainText('2,000');
  await expect(page.getByRole('link',{name:'项目分析',exact:true})).toBeVisible();
  const rerun=page.getByRole('button',{name:'再次检查此提交',exact:true}).first();
  await rerun.click();await expect(page.getByRole('alert')).toContainText('提交已保留，无需重新上传');
  await rerun.click();await expect.poll(()=>requests.length).toBe(2);
  assert.equal(requests[0].key,requests[1].key);assert.deepEqual(requests[0].body,requests[1].body);
  await page.getByLabel('检查后的 AI 分析').selectOption('summary');
  await rerun.click();await expect(page.getByRole('status')).toContainText('已进入检查队列');
  assert.notEqual(requests[1].key,requests[2].key);assert.equal(requests[2].body.personalAnalysisMode,'summary');
  await expect(page.getByLabel('检查后的 AI 分析')).toHaveValue('off');
  await rerun.click();await expect.poll(()=>requests.length).toBe(4);
  assert.notEqual(requests[0].key,requests[3].key);assert.notEqual(requests[2].key,requests[3].key);
  await expect(page.getByRole('link',{name:'进度与反馈',exact:true}).first()).toBeVisible();
  await page.screenshot({path:path.join(directory,'desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await page.screenshot({path:path.join(directory,'mobile.png'),fullPage:true});
  const after=await(await page.request.get(origin+'/api/v2/tasks/'+target.taskId+'/submissions')).json();
  assert.deepEqual(after,before);assert.deepEqual(errors,[]);
  Object.assign(result,{state:'passed',sameIntentKeyPreserved:true,changedModeUsesNewKey:true,successClearsPendingIntent:true,
    submissionRecordsUnchanged:true,interceptedRequests:requests.length,pageErrors:errors});
}catch(error){result.state='failed';result.error=error instanceof Error?error.message:String(error);process.exitCode=1;}
finally{await browser.close();await writeFile(path.join(directory,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({directory,...result}));}
