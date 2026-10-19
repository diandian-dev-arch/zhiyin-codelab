import { test, expect } from '@playwright/test';

test('source dialog reports failures locally, retries and discards closed requests', async ({ page }) => {
  const id = '00000000-0000-4000-8000-000000000091';
  await page.goto('/');
  await page.getByLabel('邮箱').fill('student@codelab.local');
  await page.getByLabel('密码', {exact:true}).fill('Browser-test-only-2904!');
  await page.getByRole('button', {name:'登录',exact:true}).click();
  await expect(page.getByRole('heading',{name:'实训任务',exact:true})).toBeVisible();
  // UI-only source fixture. No upload, analysis request or external model call.
  await page.route(`**/api/v2/projects/${id}`, route => route.fulfill({json:{
    id,name:'源码恢复夹具',available:false,files:[{path:'main.ts',lines:1}],omitted:[],analyses:[],
  }}));
  let behavior: 'failure'|'success'|'hang' = 'failure';
  let release!: () => void;
  const gate = new Promise<void>(resolve => {release=resolve;});
  let requests=0;
  await page.route(`**/api/v2/projects/${id}/source?*`, async route => {
    requests++;
    if(behavior==='failure') return route.fulfill({status:503,json:{error:{message:'fixture outage'}}});
    if(behavior==='hang') {
      await gate;
      await route.fulfill({json:{path:'main.ts',content:'OBSOLETE_SOURCE'}}).catch(()=>{});
      return;
    }
    return route.fulfill({json:{path:'main.ts',content:'CURRENT_SOURCE'}});
  });
  await page.goto(`/projects/${id}`);
  await page.getByRole('button',{name:'分析详情',exact:true}).click();
  const details=page.locator('.analysis-details');
  await details.getByText('文件地图 · 1 个文件',{exact:true}).click();
  const sourceFile=details.getByRole('treeitem',{name:'main.ts',exact:true});
  await sourceFile.click();
  const dialog=page.locator('.evidence-pane');
  await expect(dialog.getByRole('alert')).toContainText('源码暂时无法读取');
  await expect(dialog.locator('.evidence-path > span')).toHaveText('main.ts');
  behavior='success';
  await dialog.getByRole('button',{name:'重试读取源码',exact:true}).click();
  await expect(dialog.locator('pre')).toContainText('CURRENT_SOURCE');
  expect(requests).toBe(2);
  await page.keyboard.press('Escape');
  await page.clock.install();
  behavior='hang';
  try {
    await sourceFile.click();
    await expect(dialog.getByRole('status')).toHaveText('正在读取源码…');
    await page.clock.fastForward(15001);
    await expect(dialog.getByRole('alert')).toContainText('源码读取超时');
    expect(requests).toBe(3);
    await expect(dialog.locator('pre')).toHaveCount(0);
    await page.keyboard.press('Escape');
    behavior='success';
    await sourceFile.click();
    await expect(dialog.locator('pre')).toContainText('CURRENT_SOURCE');
    release();
    await page.clock.fastForward(1000);
    await expect(dialog.locator('pre')).not.toContainText('OBSOLETE_SOURCE');
    await expect(dialog.getByRole('alert')).toHaveCount(0);
    expect(requests).toBe(4);
  } finally {release();}
});
