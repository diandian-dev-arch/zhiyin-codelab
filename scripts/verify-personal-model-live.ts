// One explicit billable connection test by default; --observe verifies without model calls.
import assert from 'node:assert/strict';
import {chromium,expect} from '@playwright/test';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
const origin='http://127.0.0.1:5174',project='4c99747f-d6b8-4839-b992-202f0d3a7c4f';
const observeOnly=process.argv.includes('--observe');
assert(process.argv.slice(2).every(arg=>arg==='--observe'),'UNKNOWN_ARGUMENT');
const verificationDate=new Date(Date.now()+8*3600_000).toISOString().slice(0,10);
const directory=path.resolve('docs/verification',verificationDate,`personal-model-live-${randomUUID()}`);await mkdir(directory,{recursive:true});
const {loginPassword}=JSON.parse(await readFile('.data/business-v2/development-credentials.json','utf8'));
const browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));const result:Record<string,unknown>={projectId:project,externalModelRequestsInitiated:0};
try{
  async function login(p:typeof page,email:string){await p.goto(origin+'/projects');await p.getByLabel('邮箱').fill(email);await p.getByLabel('密码',{exact:true}).fill(loginPassword);await p.getByRole('button',{name:'登录',exact:true}).click();await expect(p.getByLabel('上传项目 ZIP')).toBeVisible();}
  await login(page,'student@codelab.local');await page.goto(origin+'/projects/'+project);await expect(page.locator('.source-report')).toBeVisible();
  // Read-only deployment smoke: the explicit comparison route validates input
  // and rejects unknown runs without exposing course data or starting work.
  const invalidComparison=await page.request.get(origin+'/api/v2/compare?before=invalid&after=invalid');
  assert.equal(invalidComparison.status(),400);assert.equal((await invalidComparison.json()).error.code,'INVALID_REQUEST');
  const missingComparison=await page.request.get(origin+`/api/v2/compare?before=${randomUUID()}&after=${randomUUID()}`);
  assert.equal(missingComparison.status(),404);assert.equal((await missingComparison.json()).error.code,'NOT_FOUND');
  result.explicitComparisonReadOnlyChecks=true;
  const before=await(await page.request.get(origin+'/api/v2/projects/'+project)).json();assert.equal(before.analyses[0].id,'6d4a84d9-88e3-4f3e-8890-a5fe5c80c3de');assert.equal(before.analyses[0].status,'succeeded');
  await page.getByRole('button',{name:'模型设置',exact:true}).click();const dialog=page.getByRole('dialog',{name:'个人模型设置'});await expect(dialog).toContainText('已保存密钥');await expect(dialog.getByLabel('API Key',{exact:true})).toHaveValue('');await expect(dialog.getByLabel('模型名称',{exact:true})).toHaveValue('deepseek-flash');
  if(!observeOnly){
    const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/v2/model-settings/test',{timeout:40000});void response.catch(()=>{});
    result.externalModelRequestsInitiated=1;await dialog.getByRole('button',{name:'测试连接',exact:true}).click();const tested=await response;result.testStatus=tested.status();result.testResult=await tested.json();assert.equal(tested.status(),200);await expect(dialog).toContainText('连接通过');
  }
  result.observeOnly=observeOnly;
  await dialog.locator('.model-advanced summary').click();
  const contextPicker=dialog.getByRole('combobox',{name:'上下文窗口',exact:true});
  await expect(contextPicker).toHaveValue('1000000');
  await expect(contextPicker.locator('option')).toHaveCount(8);
  await contextPicker.selectOption('auto');
  await expect(dialog.getByLabel('自定义上下文（tokens）',{exact:true})).toHaveCount(0);
  await contextPicker.selectOption('131072');
  await contextPicker.selectOption('custom');
  await expect(dialog.getByLabel('自定义上下文（tokens）',{exact:true})).toHaveValue('131072');
  await dialog.getByLabel('自定义上下文（tokens）',{exact:true}).fill('96000');
  await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'模型设置',exact:true}).click();
  await expect(contextPicker).toHaveValue('1000000');
  result.contextPresetInteraction={options:8,customEntry:true,unsavedChangesDiscarded:true,settingsWrites:0};
  const state=await(await page.request.get(origin+'/api/v2/model-settings')).json();assert.equal(state.configured,true);assert.equal(Object.keys(state).some(k=>/api.?key|encrypted/i.test(k)),false);result.modelState=state;
  await dialog.screenshot({path:path.join(directory,'settings-desktop.png')});await page.setViewportSize({width:390,height:844});assert(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1));await page.screenshot({path:path.join(directory,'settings-mobile-top.png')});await contextPicker.scrollIntoViewIfNeeded();await page.screenshot({path:path.join(directory,'settings-mobile-context.png')});await dialog.getByRole('button',{name:'测试连接',exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:path.join(directory,'settings-mobile-actions.png')});await page.keyboard.press('Escape');
  await page.setViewportSize({width:1440,height:1000});await page.reload();await expect(page.locator('.source-report')).toBeVisible();const after=await(await page.request.get(origin+'/api/v2/projects/'+project)).json();assert.deepEqual(after.analyses,before.analyses);await page.screenshot({path:path.join(directory,'museum-report.png'),fullPage:true});
  const other=await browser.newPage();await login(other,'teacher@codelab.local');await expect(other.getByRole('button',{name:'配置我的模型'})).toBeVisible();await expect(other.getByLabel('上传项目 ZIP')).toBeDisabled();const teacher=await(await other.request.get(origin+'/api/v2/model-settings')).json();assert.equal(teacher.configured,false);assert.equal((await other.request.get(origin+'/api/v2/projects/'+project)).status(),404);await other.close();assert.deepEqual(errors,[]);
  Object.assign(result,{state:'passed',teacherConfigured:false,historicalAnalysesUnchanged:true,analysisReruns:0,pageErrors:errors});
}catch(error){Object.assign(result,{state:'failed',error:error instanceof Error?error.message:String(error)});process.exitCode=1;await page.screenshot({path:path.join(directory,'failure.png')});}
finally{await browser.close();await writeFile(path.join(directory,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({directory,...result}));}
