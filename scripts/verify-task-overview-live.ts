import assert from 'node:assert/strict';
import {chromium,expect} from '@playwright/test';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {unzipSync} from 'fflate';
import {hashTemplateFiles} from '../apps/api/src/template.js';
const directory=`docs/verification/2026-09-29/task-overview-live-${randomUUID()}`;
await mkdir(directory,{recursive:true});
const {loginPassword}=JSON.parse(await readFile('.data/business-v2/development-credentials.json','utf8'));
const browser=await chromium.launch({channel:'chrome',headless:true});
const result:Record<string,unknown>={state:'running',modelCalls:0};
try{
 for(const role of ['teacher','student']){
  const page=await browser.newPage({baseURL:'http://127.0.0.1:5174',viewport:{width:1440,height:1000}});
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('/');await page.getByLabel('邮箱',{exact:true}).fill(`${role}@codelab.local`);
  await page.getByLabel('密码',{exact:true}).fill(loginPassword);await page.getByRole('button',{name:'登录',exact:true}).click();
  await expect(page.getByRole('heading',{name:'实训任务',exact:true})).toBeVisible();
  const response=await page.request.get('/api/v2/tasks');assert.equal(response.status(),200);
  const {items}=await response.json();assert(items.length>0);assert(items.every((t:any)=>t.overview));
  for(const item of items){
    assert(Object.hasOwn(item,'ruleScope'));
    if(!item.ruleVersion){assert.equal(item.ruleScope,null);continue;}
    const detail=await(await page.request.get(`/api/v2/tasks/${item.taskId}`)).json();
    const rule=detail.currentRule;
    const historyResponse=await page.request.get(`/api/v2/tasks/${item.taskId}/rules`);
    assert.equal(historyResponse.status(),200);
    const history=await historyResponse.json();
    assert.equal(history.items[0].ruleId,rule.ruleId);
    assert(history.items.every((entry:any)=>entry.taskId===item.taskId));
    assert.equal(detail.template.version,rule.packManifest.templateVersion);
    const download=new URL(detail.template.downloadUrl,'http://127.0.0.1:5174');
    assert.equal(download.searchParams.get('ruleId'),rule.ruleId);
    const templateResponse=await page.request.get(download.pathname+download.search);
    assert.equal(templateResponse.status(),detail.template.available?200:409);
    if(detail.template.available){
      assert.match(templateResponse.headers()['content-type'],/application\/zip/);
      assert.equal(hashTemplateFiles(unzipSync(await templateResponse.body())),rule.packManifest.templateHash);
    }
    if(role==='student' && item.overview.latestPublication){
      const publicationId=item.overview.latestPublication.publicationId;
      assert(publicationId);
      const choicesResponse=await page.request.get(`/api/v2/publications/${publicationId}/comparison-options`);
      assert.equal(choicesResponse.status(),200);
      const choices=await choicesResponse.json();
      assert(choices.items.every((entry:any)=>entry.publicationId!==publicationId));
      if(choices.items.length){
        const comparisonResponse=await page.request.get(`/api/v2/publications/${publicationId}/comparison?before=${choices.items[0].publicationId}`);
        assert.equal(comparisonResponse.status(),200);
        const compared=await comparisonResponse.json();
        assert.equal(compared.after.publicationId,publicationId);
        assert.equal(compared.before.publicationId,choices.items[0].publicationId);
        assert(!Object.hasOwn(compared.automatic,'items'));
        result.publicationComparisons=Number(result.publicationComparisons ?? 0)+1;
      }
      result.publicationOptionLists=Number(result.publicationOptionLists ?? 0)+1;
    }
    assert.equal(item.ruleScope.caseCount,rule.requiredCaseIds.length);
    assert.deepEqual(item.ruleScope.criteria,rule.packManifest.criteria
      .filter((c:any)=>rule.enabledCriterionIds.includes(c.criterionId))
      .map((c:any)=>({criterionId:c.criterionId,title:c.title,mode:c.mode})));
  }
  if(role==='student')assert(items.every((t:any)=>!('pendingReviews' in t.overview)));
  await expect(page.locator('.task-progress')).toHaveCount(items.length);
  const filter=page.getByLabel('按待办筛选',{exact:true});
  await filter.selectOption(role==='teacher'?'review':'feedback');
  const expected=items.filter((t:any)=>role==='teacher'?t.overview.pendingReviewCount>0:!!t.overview.latestPublication).length;
  await expect(page.locator('.task-card')).toHaveCount(expected);
  await filter.selectOption('all');
  await expect(page.locator('.task-card')).toHaveCount(items.length);
  await page.screenshot({path:`${directory}/${role}-desktop.png`,fullPage:true});
  await page.setViewportSize({width:390,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:`${directory}/${role}-mobile.png`,fullPage:true});
  await page.getByRole('button',{name:'刷新任务列表',exact:true}).click();
  await expect(page.getByRole('button',{name:'刷新任务列表',exact:true})).toBeEnabled();
  if(role==='teacher'){
    const target=items.find((item:any)=>item.ruleVersion);
    await page.goto(`/tasks/${target.taskId}`);
    const history=page.locator('.rule-history');await history.locator('summary').first().click();
    await expect(history.locator('.rule-version').first()).toBeVisible();
    await history.locator('.rule-version summary').first().click();
    await expect(history).toContainText('发布新版本不会覆盖此记录');
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.screenshot({path:`${directory}/teacher-rule-history-mobile.png`,fullPage:true});
  }
  assert.deepEqual(errors,[]);result[role]={tasks:items.length,pageErrors:errors,mobileOverflow:false,templateRuleBindingVerified:true};await page.close();
 }
 result.state='passed';
}catch{result.state='failed';process.exitCode=1;}
finally{await browser.close();await writeFile(`${directory}/result.json`,JSON.stringify(result,null,2));console.log(JSON.stringify({directory,...result}));}
