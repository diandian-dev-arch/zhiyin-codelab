import {test,expect,type Page} from '@playwright/test';
import {readFile} from 'node:fs/promises';
async function login(page:Page,role:string){
  await page.goto('/');
  await page.getByLabel('邮箱').fill(`${role}@codelab.local`);
  await page.getByLabel('密码',{exact:true}).fill('Browser-test-only-2904!');
  await page.getByRole('button',{name:'登录',exact:true}).click();
  await expect(page.getByRole('heading',{name:'实训任务',exact:true})).toBeVisible();
  const tasks=await(await page.request.get('/api/v2/tasks')).json();
  return tasks.items[0].taskId as string;
}
test('lost rule receipt releases the form and explicit retry reuses the accepted identity',async({page})=>{
  await login(page,'teacher');
  await page.getByRole('button',{name:'创建任务',exact:true}).click();
  await page.getByLabel('任务名称',{exact:true}).fill('写请求恢复专用任务');
  await page.getByLabel('任务说明',{exact:true}).fill('隔离规则发布，不改变上传样本绑定的课程。');
  await page.getByText('评价标准与任务方式',{exact:false}).click();
  await page.getByLabel('任务方式',{exact:true}).selectOption('template');
  await page.locator('form').filter({has:page.getByLabel('任务名称',{exact:true})}).getByRole('button',{name:'创建任务并设置验收',exact:true}).click();
  await expect(page.getByRole('heading',{name:'写请求恢复专用任务',exact:true})).toBeVisible();
  const taskId=new URL(page.url()).pathname.split('/').at(-1)!;
  await page.getByText('选择验收包并发布新规则',{exact:true}).click();
  await page.getByLabel('我已确认以上要求与本次课程任务一致',{exact:true}).check();
  const before=await(await page.request.get(`/api/v2/tasks/${taskId}`)).json();
  const keys:string[]=[];let accepted=false,release!:()=>void;
  const gate=new Promise<void>(resolve=>release=resolve);
  await page.route(`**/api/v2/tasks/${taskId}/rules`,async route=>{
    if(route.request().method()!=='POST')return route.continue();
    keys.push(route.request().headers()['idempotency-key']);
    const response=await route.fetch();expect(response.ok()).toBe(true);
    if(keys.length===1){accepted=true;await gate;}
    await route.fulfill({response}).catch(()=>{});
  });
  await page.clock.install();
  try{
    await page.getByRole('button',{name:'发布新规则',exact:true}).click();
    await expect.poll(()=>accepted).toBe(true);await page.clock.fastForward(15001);
    await expect(page.getByRole('alert')).toContainText('结果未知');
    await expect(page.getByRole('button',{name:'发布新规则',exact:true})).toBeEnabled();
    expect(keys).toHaveLength(1);
    await page.getByRole('button',{name:'重新读取任务',exact:true}).click();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await page.getByRole('button',{name:'发布新规则',exact:true}).click();
    await expect(page.getByRole('status')).toContainText('新规则已发布');
    expect(keys).toHaveLength(2);expect(keys[1]).toBe(keys[0]);
    const after=await(await page.request.get(`/api/v2/tasks/${taskId}`)).json();
    expect(after.currentRule.version).toBe((before.currentRule?.version??0)+1);
    release();await page.clock.fastForward(100);
    expect(keys).toHaveLength(2);
  }finally{release();}
});
test('upload and execution writes time out without automatic replay or late success',async({page})=>{
  const taskId=await login(page,'student');
  // Only enable the fixture UI. Run writes below are intercepted, no runner/model is started.
  await page.route(`**/api/v2/tasks/${taskId}`,async route=>{
    const response=await route.fetch(),body=await response.json();
    await route.fulfill({response,json:{...body,executionAvailable:true}});
  });
  await page.goto(`/tasks/${taskId}`);
  const keys:string[]=[],rules:string[]=[];let saved=false,release!:()=>void;
  const gate=new Promise<void>(resolve=>release=resolve);
  await page.route(`**/api/v2/tasks/${taskId}/submissions`,async route=>{
    if(route.request().method()!=='POST')return route.continue();
    keys.push(route.request().headers()['idempotency-key']);rules.push(route.request().headers()['x-rule-id']);
    // Chromium interception omits file bytes. Rebuild the known fixture multipart
    // for this accepted-but-lost-receipt test, retaining the UI's auth and identities.
    const headers={...route.request().headers()};delete headers['content-type'];delete headers['content-length'];
    const response=await page.request.post(route.request().url(),{headers,multipart:{file:{name:'correct.zip',mimeType:'application/zip',buffer:await readFile('fixtures/correct.zip')}}});
    expect(response.ok(),await response.text()).toBe(true);
    if(keys.length===1){saved=true;await gate;}
    await route.fulfill({response}).catch(()=>{});
  });
  await page.clock.install();
  try{
    await page.getByLabel('项目 ZIP').setInputFiles('fixtures/correct.zip');
    await page.getByRole('button',{name:'保存提交',exact:true}).click();
    await expect.poll(()=>saved).toBe(true);await page.clock.fastForward(135001);
    await expect(page.getByRole('alert')).toContainText('结果未知');expect(keys).toHaveLength(1);
    await page.getByRole('button',{name:'重新读取任务',exact:true}).click();
    await expect(page.getByRole('button',{name:'创建检查',exact:true})).toBeVisible();
    await page.getByRole('button',{name:'保存提交',exact:true}).click();
    await expect(page.getByRole('status')).toContainText('提交已保存');
    expect(keys).toHaveLength(2);expect(keys[0]).toBe(keys[1]);expect(rules[0]).toBe(rules[1]);
    release();await page.clock.fastForward(100);
    let writes=0,releaseRun!:()=>void;const runGate=new Promise<void>(resolve=>releaseRun=resolve);
    await page.route('**/api/v2/submissions/*/runs',async route=>{writes++;await runGate;await route.fulfill({json:{}}).catch(()=>{});});
    try{
      await page.getByRole('button',{name:'创建检查',exact:true}).click();
      await expect.poll(()=>writes).toBe(1);await page.clock.fastForward(15001);
      await expect(page.getByRole('alert')).toContainText('提交已保留');
      await expect(page.getByRole('button',{name:'创建检查',exact:true})).toBeEnabled();
      releaseRun();await page.clock.fastForward(100);
      await expect(page.getByRole('alert')).toContainText('结果未知');expect(writes).toBe(1);
      await expect(page.getByRole('status')).toHaveCount(0);
    }finally{releaseRun();}
  }finally{release();}
});
