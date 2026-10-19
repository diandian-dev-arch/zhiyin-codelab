import {test,expect} from '@playwright/test';

test('model settings bounds hung reads and writes without retrying billable requests', async ({page})=>{
  await page.goto('/');
  await page.getByLabel('邮箱').fill('student@codelab.local');
  await page.getByLabel('密码',{exact:true}).fill('Browser-test-only-2904!');
  await page.getByRole('button',{name:'登录',exact:true}).click();
  await expect(page.getByRole('heading',{name:'实训任务',exact:true})).toBeVisible();
  const projectWrites:string[]=[];
  await page.route('**/api/v2/projects**',route=>{
    if(route.request().method()!=='GET') projectWrites.push(route.request().method());
    return route.fulfill({json:{available:true,projects:[]}});
  });
  await page.route('**/api/v2/source-cost-preview',route=>route.fulfill({json:{price:null,allocationCny:null,maxCalls:0}}));
  const state={enabled:true,configured:true,active:false,settings:{vendor:'deepseek',model:'deepseek-flash',maxOutputTokens:12000,contextWindowTokens:null}};
  let reads=0;
  const writes:string[]=[];
  const releases:Array<()=>void>=[];
  await page.route('**/api/v2/model-settings{,/test}',async route=>{
    const method=route.request().method();
    if(method==='GET' && ++reads>1) return route.fulfill({json:state});
    if(method!=='GET') writes.push(method+new URL(route.request().url()).pathname);
    await new Promise<void>(resolve=>releases.push(resolve));
    await route.fulfill({json:method==='GET'?{...state,settings:{...state.settings,model:'obsolete'}}:state}).catch(()=>{});
  });
  await page.goto('/settings');
  await page.clock.install();
  const dialog=page.getByRole('dialog',{name:'个人模型设置'});
  try {
    await page.getByRole('button',{name:'模型设置',exact:true}).click();
    expect(projectWrites).toEqual([]);
    await expect.poll(()=>reads).toBe(1);
    await page.clock.fastForward(15001);
    await expect(dialog.getByRole('alert')).toContainText('读取配置超过15秒');
    await expect(dialog.getByRole('button',{name:'关闭模型设置'})).toBeEnabled();
    await dialog.getByRole('button',{name:'重新读取配置'}).click();
    await expect(dialog.getByLabel('模型名称',{exact:true})).toHaveValue('deepseek-flash');
    releases[0]();
    await page.clock.fastForward(100);
    await expect(dialog.getByLabel('模型名称',{exact:true})).toHaveValue('deepseek-flash');
    for(const [action,ms] of [['保存配置',15001],['测试连接',40001],['确认移除密钥',15001]] as const){
      if(action==='确认移除密钥') await dialog.getByRole('button',{name:'移除密钥',exact:true}).click();
      const previous=writes.length;
      await dialog.getByRole('button',{name:action,exact:true}).click();
      await expect.poll(()=>writes.length).toBe(previous+1);
      await page.clock.fastForward(ms);
      await expect(dialog.getByRole('alert')).toContainText(action==='测试连接'?'可能已处理并计费':'结果尚未确认');
      await expect(dialog.getByRole('button',{name:'关闭模型设置'})).toBeEnabled();
      expect(writes.length).toBe(previous+1);
      releases.at(-1)!();
      await page.clock.fastForward(100);
      await expect(dialog.getByRole('alert')).toContainText(action==='测试连接'?'可能已处理并计费':'结果尚未确认');
      await expect(dialog.locator('.model-success')).toHaveCount(0);
    }
    expect(writes).toEqual(['PUT/api/v2/model-settings','POST/api/v2/model-settings/test','DELETE/api/v2/model-settings']);
    expect(projectWrites).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
  } finally {releases.forEach(release=>release());}
});
