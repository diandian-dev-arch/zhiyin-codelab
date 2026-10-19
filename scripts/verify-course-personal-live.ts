// Read-only business verification on the existing development workspace. No model calls or business writes.
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { connectDesktopDatabase } from './desktop-database.js';
const origin='http://127.0.0.1:5174';
const directory=path.resolve('docs/verification/2026-09-29',`course-personal-live-${randomUUID()}`);
await mkdir(directory,{recursive:true});
const db=await connectDesktopDatabase();
async function snapshot() {
  const tables:Record<string,unknown>={};
  for(const {tablename} of (await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'sessions' ORDER BY tablename")).rows){
    assert.match(tablename,/^[a-z_]+$/);
    const rows=(await db.query(`SELECT to_jsonb(t) AS row FROM "${tablename}" t ORDER BY to_jsonb(t)::text COLLATE "C"`)).rows;
    tables[tablename]={rows:rows.length,sha256:createHash('sha256').update(JSON.stringify(rows)).digest('hex')};
  }
  return tables;
}
const browser=await chromium.launch({channel:'chrome',headless:true});
const {loginPassword}=JSON.parse(await readFile('.data/business-v2/development-credentials.json','utf8'));
const result:Record<string,unknown>={externalModelCalls:0};
const errors:string[]=[],blocked:string[]=[];
let currentPage: import('@playwright/test').Page | undefined;
try{
  const before=await snapshot();
  // Compare this observation's before/after snapshots. Legitimate later submissions
  // must not fail merely because they were created after an older backup.
  result.snapshotScope='current-state-before-after';
  const target=(await db.query("SELECT r.id,s.task_id FROM runs r JOIN submissions s ON s.id=r.submission_id WHERE r.contract_version=2 AND EXISTS(SELECT 1 FROM report_revisions rr WHERE rr.run_id=r.id) ORDER BY r.created_at DESC LIMIT 1")).rows[0];
  assert(target);
  for(const role of ['student','teacher']){
    const context=await browser.newContext({viewport:{width:1440,height:1000}});
    const page=await context.newPage();currentPage=page;page.on('pageerror',e=>errors.push(e.message));
    await context.route('**/api/**',async route=>{
      const r=route.request();
      if(!['GET','HEAD'].includes(r.method()) && !new URL(r.url()).pathname.endsWith('/session/login')){
        blocked.push(`${r.method()} ${new URL(r.url()).pathname}`);await route.abort();
      }else await route.continue();
    });
    await page.goto(origin+'/projects');await page.getByLabel('邮箱').fill(role+'@codelab.local');
    await page.getByLabel('密码',{exact:true}).fill(loginPassword);await page.getByRole('button',{name:'登录',exact:true}).click();
    await expect(page.getByLabel('上传项目 ZIP')).toBeVisible();
    await page.goto(origin+'/tasks/'+target.task_id);
    await expect(page.getByLabel('检查后的 AI 分析')).toHaveValue('off');
    await expect(page.locator('.course-model-choice')).toContainText('费用由你的 API Key 所属账户承担');
    await page.getByRole('button',{name:'模型设置',exact:true}).click();
    await expect(page.getByRole('dialog',{name:'个人模型设置'})).toBeVisible();
    await expect(page.getByLabel('API Key',{exact:true})).toHaveValue('');
    await page.keyboard.press('Escape');
    if(role==='teacher'){
      await page.goto(origin+'/runs/'+target.id);
      await expect(page.locator('.course-model-choice')).toContainText('请先配置自己的模型');
      const response=await page.request.get(origin+'/api/v2/runs/'+target.id+'/review');
      assert.equal(response.status(),200);const review=await response.json();
      assert.equal(review.personalModelBilling,true);assert.equal(review.analysisAvailable,false);
      await page.getByRole('button',{name:'模型设置',exact:true}).click();
      await expect(page.getByRole('dialog')).toContainText('尚未配置');
      await page.keyboard.press('Escape');
      result.teacherNoFallback=true;
    }
    await page.screenshot({path:path.join(directory,role+'-desktop.png'),fullPage:true});
    await page.setViewportSize({width:390,height:844});
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    await page.screenshot({path:path.join(directory,role+'-mobile.png'),fullPage:true});
    await context.close();
  }
  assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);assert.deepEqual(await snapshot(),before);
  Object.assign(result,{state:'passed',businessTablesUnchanged:true,tableCount:Object.keys(before).length,pageErrors:errors,blockedWrites:blocked,runId:target.id,taskId:target.task_id});
}catch(e){result.state='failed';result.error=e instanceof Error?e.message:'LIVE_CHECK_FAILED';result.pageErrors=errors;result.blockedWrites=blocked;result.pageUrl=currentPage?.url();await currentPage?.screenshot({path:path.join(directory,'failure.png')}).catch(()=>{});process.exitCode=1;}
finally{await browser.close();await db.close();await writeFile(path.join(directory,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({directory,...result}));}
