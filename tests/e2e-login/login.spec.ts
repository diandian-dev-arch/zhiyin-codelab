import { test, expect } from '@playwright/test';

test('hung session read times out and its late response cannot replace recovered state', async ({ page }) => {
  await page.clock.install();
  let pending: import('@playwright/test').Route | undefined;
  let release!: () => void;
  let delivered = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/v1/session', async route => {
    if (pending) return route.continue();
    pending = route;
    await gate;
    await route.fulfill({json:{user:{id:'late-user',name:'迟到账户',email:'late@example.test',role:'teacher'},csrf:'late',businessVersion:2}});
    delivered = true;
  });
  await page.goto('/projects');
  await expect.poll(() => !!pending).toBe(true);
  await page.clock.fastForward(15001);
  await expect(page.getByRole('heading', {name:'工作台暂时无法连接'})).toBeVisible();
  await page.getByRole('button', {name:'重试连接',exact:true}).click();
  await expect(page.getByLabel('邮箱')).toBeVisible();
  release();
  await expect.poll(() => delivered).toBe(true);
  await expect(page.getByLabel('邮箱')).toBeVisible();
  await expect(page.locator('.workspace')).toHaveCount(0);
});

test('hung login times out without auto retry and can be explicitly retried', async ({ page }) => {
  await page.clock.install();
  await page.goto('/');
  let calls = 0;
  let pending: import('@playwright/test').Route | undefined;
  await page.route('**/api/v1/session/login', route => { calls++; pending = route; });
  await page.getByLabel('邮箱').fill('student@codelab.local');
  await page.getByLabel('密码', {exact:true}).fill('Browser-test-only-2904!');
  await page.getByRole('button', {name:'登录',exact:true}).click();
  await expect.poll(() => calls).toBe(1);
  await page.clock.fastForward(15001);
  await expect(page.getByRole('alert')).toHaveText('连接等待超过15秒，请检查网络后重试。');
  await expect(page.getByLabel('密码', {exact:true})).toHaveValue('');
  await page.clock.fastForward(60000);
  expect(calls).toBe(1);
  await pending!.abort();
  await page.unroute('**/api/v1/session/login');
  await page.getByLabel('密码', {exact:true}).fill('Browser-test-only-2904!');
  await page.getByRole('button', {name:'登录',exact:true}).click();
  await expect(page.getByRole('heading', {name:'实训任务',exact:true})).toBeVisible();
});

for (const failure of ['network', 'unavailable', 'invalid'] as const) {
  test(`initial ${failure} session failure is distinct from logout and retry recovers`, async ({ page }) => {
    let reads = 0;
    await page.route('**/api/v1/session', route => {
      reads++;
      if (failure === 'network') return route.abort('failed');
      if (failure === 'unavailable') return route.fulfill({status:503,json:{error:'unavailable'}});
      return route.fulfill({status:200,json:{error:'invalid upstream response'}});
    });
    await page.goto('/projects');
    await expect(page.getByRole('heading', {name:'工作台暂时无法连接'})).toBeVisible();
    await expect(page.getByRole('alert')).toContainText('尚未确认你的登录状态');
    await expect(page.getByLabel('密码', {exact:true})).toHaveCount(0);
    await expect(page.locator('.workspace')).toHaveCount(0);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    await page.unroute('**/api/v1/session');
    await page.route('**/api/v1/session', async route => { reads++; await gate; await route.continue(); });
    await page.getByRole('button', {name:'重试连接',exact:true}).click();
    await expect(page.getByRole('button', {name:'正在重试…'})).toBeDisabled();
    await expect.poll(() => reads).toBe(2);
    release();
    await expect(page.getByLabel('邮箱')).toBeVisible();
    await expect(page.getByRole('heading', {name:'工作台暂时无法连接'})).toHaveCount(0);
    await expect(page).toHaveURL(/\/projects$/);
  });
}

test('retry restores the existing authenticated account and project route', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('邮箱').fill('student@codelab.local');
  await page.getByLabel('密码', {exact:true}).fill('Browser-test-only-2904!');
  await page.getByRole('button', {name:'登录',exact:true}).click();
  await expect(page.getByRole('heading', {name:'实训任务',exact:true})).toBeVisible();
  await page.route('**/api/v1/session', route => route.abort('failed'));
  await page.goto('/projects');
  await expect(page.getByRole('heading', {name:'工作台暂时无法连接'})).toBeVisible();
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.unroute('**/api/v1/session');
  await page.getByRole('button', {name:'重试连接',exact:true}).click();
  await expect(page.getByRole('button', { name:'选择 ZIP', exact:true })).toBeVisible();
  await expect(page.getByLabel('选择项目 ZIP', { exact:true })).toBeAttached();
  await expect(page.locator('.account')).toContainText('学生');
  await expect(page).toHaveURL(/\/projects$/);
});

test('failed credentials retain email but clear password and allow retry', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('邮箱').fill('student@codelab.local');
  await page.getByLabel('密码', {exact:true}).fill('wrong-password');
  await page.getByRole('button', {name:'登录',exact:true}).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByLabel('邮箱')).toHaveValue('student@codelab.local');
  await expect(page.getByLabel('密码', {exact:true})).toHaveValue('');
  await page.getByLabel('密码', {exact:true}).fill('Browser-test-only-2904!');
  await page.getByRole('button', {name:'登录',exact:true}).click();
  await expect(page.getByRole('heading', {name:'实训任务',exact:true})).toBeVisible();
});

test('failed session read after login is visible and repeated submit sends only once', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByLabel('邮箱')).toBeVisible();
  await page.route('**/api/v1/session', route => route.abort('failed'));
  let requests = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/v1/session/login', async route => {
    requests++;
    await gate;
    await route.continue();
  });
  await page.getByLabel('邮箱').fill('student@codelab.local');
  await page.getByLabel('密码', {exact:true}).fill('Browser-test-only-2904!');
  await page.getByRole('button', {name:'登录',exact:true}).click();
  await expect.poll(() => requests).toBe(1);
  await expect(page.getByRole('button', {name:'正在登录…'})).toBeDisabled();
  await page.locator('form.login-form').evaluate(form => {
    form.dispatchEvent(new Event('submit', {bubbles:true,cancelable:true}));
  });
  release();
  await expect(page.getByRole('alert')).toHaveText('暂时无法读取登录状态，请检查网络后重新登录。');
  expect(requests).toBe(1);
  await expect(page.getByLabel('邮箱')).toHaveValue('student@codelab.local');
  await expect(page.getByLabel('密码', {exact:true})).toHaveValue('');
  await expect(page.locator('.workspace')).toHaveCount(0);
  await page.unroute('**/api/v1/session');
  await page.getByLabel('密码', {exact:true}).fill('Browser-test-only-2904!');
  await page.getByRole('button', {name:'登录',exact:true}).click();
  await expect(page.getByRole('heading', {name:'实训任务',exact:true})).toBeVisible();
});
