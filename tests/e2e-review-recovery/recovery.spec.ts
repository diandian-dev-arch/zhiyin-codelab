import { test, expect, type Page } from "@playwright/test";
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
// Fault injection uses isolated UI fixtures, not billable model calls.
const runPath = "/runs/00000000-0000-4000-8000-000000000003";
test('initial course and report reads time out and can be explicitly recovered',async({page})=>{
  await login(page,'teacher');
  const run=await (await page.request.get('/api/v2'+runPath)).json();
  await page.clock.install();
  for(const [url,button] of [[`/tasks/${run.taskId}`,'重新读取任务'],[runPath,'刷新报告']] as const){
    let count=0,release!:()=>void;
    const gate=new Promise<void>(resolve=>release=resolve);
    await page.route('**/api/v2'+url,async route=>{
      count++;
      if(count===1){await gate;await route.fulfill({status:503,json:{error:{message:'obsolete failure'}}}).catch(()=>{});}
      else await route.continue();
    });
    try{
      await page.goto(url);await expect.poll(()=>count).toBe(1);
      await page.clock.fastForward(15001);
      await expect(page.getByRole('alert')).toContainText('读取等待超过15秒');
      await page.getByRole('button',{name:button,exact:true}).click();
      await expect(page.getByRole('alert')).toHaveCount(0);
      if(url===runPath) await expect(page.getByLabel('建议的下一步')).toBeVisible();
      else await expect(page.getByRole('heading',{name:'提交与检查记录'})).toBeVisible();
      release();await page.clock.fastForward(100);
      await expect(page.getByRole('alert')).toHaveCount(0);
      expect(count).toBe(2);
    }finally{release();await page.unroute('**/api/v2'+url);}
  }
});
test('hung Agent polling marks disconnected and recovers without discarding teacher edits',async({page})=>{
  await login(page,'teacher'); await page.goto(runPath);
  await page.getByLabel('建议的下一步').fill('连接恢复期间保留的教师输入');
  await page.clock.install();
  let count=0, release!:()=>void;
  const gate=new Promise<void>(resolve=>release=resolve);
  const writes:string[]=[];
  page.on('request',request=>{if(request.method()!=='GET' && request.url().includes('/api/v2/')) writes.push(request.url());});
  await page.route('**/api/v2/runs/*/review',async route=>{
    count++;
    if(count===1){await gate; await route.fulfill({status:503,json:{error:{message:'late stale failure'}}}).catch(()=>{});}
    else await route.continue();
  });
  try {
    await page.clock.fastForward(4001); await expect.poll(()=>count).toBe(1);
    await page.clock.fastForward(15001);
    await expect(page.locator('.studio-status')).toContainText('连接待恢复');
    await expect(page.locator('.studio-status .lit')).toHaveCount(0);
    await expect(page.getByLabel('建议的下一步')).toHaveValue('连接恢复期间保留的教师输入');
    await page.clock.fastForward(4001);
    await expect.poll(()=>count).toBe(2);
    await expect(page.locator('.studio-status')).not.toContainText('连接待恢复');
    release(); await page.clock.fastForward(100);
    await expect(page.locator('.studio-status')).not.toContainText('连接待恢复');
    await expect(page.getByLabel('建议的下一步')).toHaveValue('连接恢复期间保留的教师输入');
    expect(writes).toEqual([]);
  } finally {release();}
});
test('recovers a closed-page draft without writes and fences a changed server revision', async ({ page, context }, info) => {
  await login(page, 'teacher'); await page.goto(runPath);
  await page.getByLabel('建议的下一步').fill('关闭页面后恢复的未保存教师建议');
  await expect(page.getByRole('region',{name:'本机草稿恢复'})).toContainText('未保存内容已备份到本机');
  await page.close({runBeforeUnload:false});
  const reopened=await context.newPage();
  let writes=0;
  reopened.on('request', request=>{if(request.url().includes('/api/v2/') && request.method()!=='GET') writes++;});
  await reopened.goto(runPath);
  await expect(reopened.getByRole('region',{name:'本机草稿恢复'})).toContainText('找到了未保存的草稿');
  await reopened.getByRole('button',{name:'恢复到编辑区',exact:true}).click();
  await expect(reopened.getByLabel('建议的下一步')).toHaveValue('关闭页面后恢复的未保存教师建议');
  expect(writes).toBe(0);
  await reopened.route('**/api/v2/runs/*/review',async route=>{
    const response=await route.fetch(), body=await response.json();
    body.revision.revisionId=randomUUID();
    await route.fulfill({response,json:body});
  });
  reopened.once('dialog',dialog=>dialog.accept()); await reopened.reload();
  await expect(reopened.getByRole('region',{name:'本机草稿恢复'})).toContainText('服务器版本已变化');
  await expect(reopened.getByRole('button',{name:'恢复到编辑区',exact:true})).toHaveCount(0);
  await reopened.getByRole('button',{name:'保留为副本并继续',exact:true}).click();
  const copies=reopened.getByRole('region',{name:'保留的本地草稿'});
  await copies.locator('summary').click(); await expect(copies).toContainText('关闭页面后恢复的未保存教师建议');
  expect(writes).toBe(0);
  await reopened.setViewportSize({width:390,height:844});
  await reopened.getByRole('region',{name:'本机草稿恢复'}).screenshot({path:info.outputPath('draft-recovery-mobile.png')});
  expect(await reopened.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  reopened.once('dialog',dialog=>dialog.accept());
  await reopened.getByRole('button',{name:'删除本机草稿副本',exact:true}).click();
  await expect(copies).toHaveCount(0);
  await reopened.reload(); await expect(reopened.getByRole('region',{name:'本机草稿恢复'})).not.toContainText('找到了');
});
test('browser quota failure preserves edits and offers a download instead of claiming backup success', async ({page}) => {
  await page.addInitScript(()=>{
    const original=Storage.prototype.setItem;
    Storage.prototype.setItem=function(key,value){
      if(key.startsWith('codelab:review-draft:')) throw new DOMException('quota','QuotaExceededError');
      return original.call(this,key,value);
    };
  });
  await login(page,'teacher'); await page.goto(runPath);
  await page.getByLabel('建议的下一步').fill('存储不足时仍保留的输入');
  const region=page.getByRole('region',{name:'本机草稿恢复'});
  await expect(region.getByRole('alert')).toContainText('本机草稿暂未保存');
  await expect(region).not.toContainText('未保存内容已备份到本机');
  await expect(page.getByLabel('建议的下一步')).toHaveValue('存储不足时仍保留的输入');
  const downloading=page.waitForEvent('download');
  await region.getByRole('button',{name:'下载当前未保存草稿',exact:true}).click();
  const file=await downloading;
  expect(await readFile((await file.path())!,'utf8')).toContain('存储不足时仍保留的输入');
});
async function login(page: Page, role: "teacher" | "student") {
  await page.goto("/");
  await page.getByLabel("邮箱").fill(`${role}@codelab.local`);
  await page
    .getByLabel("密码", { exact: true })
    .fill("Browser-test-only-2904!");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "实训任务", exact: true }),
  ).toBeVisible();
}
