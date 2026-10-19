import {test,expect} from '@playwright/test';

test('project upload, analyze and cancel recover unknown outcomes without automatic replay',async({page})=>{
  await page.goto('/');
  await page.getByLabel('邮箱').fill('student@codelab.local');
  await page.getByLabel('密码',{exact:true}).fill('Browser-test-only-2904!');
  await page.getByRole('button',{name:'登录',exact:true}).click();
  await expect(page.getByRole('heading',{name:'实训任务',exact:true})).toBeVisible();
  const id='00000000-0000-4000-8000-000000000094';
  let status='failed', imported=false;
  const writes:string[]=[], releases:Array<()=>void>=[];
  // Keep the configured-model fixture coherent without calling a real price service.
  await page.route('**/api/v2/model-settings', route => route.fulfill({json:{enabled:true,configured:true,active:false,settings:{vendor:'deepseek',model:'synthetic-fixture',maxOutputTokens:12000}}}));
  await page.route('**/api/v2/source-cost-preview', route => route.fulfill({json:{price:null,allocationCny:null,maxCalls:0}}));
  await page.route('**/api/v2/projects**',async route=>{
    const request=route.request(), url=new URL(request.url());
    if(request.method()==='POST') {
      writes.push(url.pathname);
      if(url.pathname.endsWith('/analyze')) status='running';
      else if(url.pathname.endsWith('/cancel')) status='cancelled';
      else imported=true;
      // Server accepted it; deliberately lose the HTTP response.
      await new Promise<void>(resolve=>releases.push(resolve));
      await route.fulfill({json:{id}}).catch(()=>{});
      return;
    }
    await route.fulfill({json:url.pathname.endsWith(id)
      ? {id,name:'恢复测试项目',available:true,files:[],omitted:[],analyses:[{id:'analysis',status,canCancel:status==='queued'||status==='running',events:[],created_at:new Date().toISOString()}]}
      : {available:true,projects:imported?[{id,name:'已保存的项目',status:'queued'}]:[]}});
  });
  await page.clock.install();
  try {
    await page.goto('/projects');
    const projectZip=page.getByLabel('选择项目 ZIP',{exact:true});
    await projectZip.setInputFiles({name:'sample.zip',mimeType:'application/zip',buffer:Buffer.from('intercepted fixture')});
    expect(writes).toEqual([]);
    await page.getByRole('button',{name:'保存并继续',exact:true}).click();
    await expect.poll(()=>writes.length).toBe(1);
    await page.clock.fastForward(135001);
    await expect(page.getByRole('alert')).toContainText('保存结果尚未确认');
    await expect(page.getByRole('link').filter({hasText:'已保存的项目'})).toBeVisible();
    await expect(projectZip).toBeEnabled();
    releases[0](); await page.clock.fastForward(100);
    await expect(page).toHaveURL(/\/projects$/);
    await page.goto(`/projects/${id}`);
    await page.getByRole('button',{name:'调整范围并重新分析',exact:true}).click();
    const rerun=page.locator('.next-analysis');
    await rerun.getByRole('button',{name:/确认并重新解读/}).click();
    await expect.poll(()=>writes.length).toBe(2);
    await page.clock.fastForward(15001);
    await expect(page.getByRole('alert')).toContainText('操作结果尚未确认');
    const analysisState=page.getByRole('region',{name:'项目分析状态',exact:true});
    const stop=analysisState.getByRole('button',{name:'停止当前分析',exact:true});
    await expect(stop).toBeEnabled();
    releases[1](); await page.clock.fastForward(100);
    await expect(page.getByRole('alert')).toContainText('操作结果尚未确认');
    await stop.click();
    await expect.poll(()=>writes.length).toBe(3);
    await page.clock.fastForward(15001);
    await expect(analysisState.getByRole('status')).toHaveText('分析已停止');
    await expect(page.getByRole('button',{name:'停止当前分析'})).toHaveCount(0);
    releases[2](); await page.clock.fastForward(100);
    expect(writes).toEqual(['/api/v2/projects',`/api/v2/projects/${id}/analyze`,`/api/v2/projects/${id}/cancel`]);
  } finally {releases.forEach(release=>release());}
});
