import { test, expect, type Page, type Route } from '@playwright/test';

async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('邮箱', { exact: true }).fill('student@codelab.local');
  await page.getByLabel('密码', { exact: true }).fill('Browser-test-only-2904!');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '实训任务', exact: true })).toBeVisible();
}
const logout = (page: Page) => page.getByRole('button', { name: '退出登录', exact: true }).filter({ visible: true });

test('an expired session settles logout while an invalid success body does not pretend success', async ({ page }) => {
  await login(page);
  await page.route('**/api/v1/session/logout', route => route.fulfill({ json: { error: 'invalid upstream response' } }));
  await logout(page).click();
  await expect(page.getByRole('alert')).toContainText('退出登录未确认');
  await expect(page.locator('.workspace')).toBeVisible();
  await page.unroute('**/api/v1/session/logout');
  await page.route('**/api/v1/session/logout', route => route.fulfill({ status: 401, json: { error: '未登录' } }));
  await page.getByRole('button', { name: '重试退出', exact: true }).click();
  await expect(page.getByLabel('邮箱', { exact: true })).toBeVisible();
  await expect(page.locator('.workspace')).toHaveCount(0);
});

for (const failure of ['network', 'server'] as const) {
  test(`logout ${failure} failure preserves the workspace and offers an explicit retry`, async ({ page }, info) => {
    await login(page);
    if (failure === 'network') await page.setViewportSize({ width: 390, height: 844 });
    let calls = 0;
    await page.route('**/api/v1/session/logout', route => {
      calls++;
      return failure === 'network' ? route.abort('failed') : route.fulfill({ status: 503, json: { error: 'unavailable' } });
    });
    await logout(page).click();
    await expect(page.getByRole('alert')).toContainText('退出登录未确认');
    await expect(page.locator('.workspace')).toBeVisible();
    await expect(logout(page)).toBeEnabled();
    expect(calls).toBe(1);
    await page.screenshot({ path: info.outputPath(`logout-${failure}.png`), fullPage: true });
    await page.unroute('**/api/v1/session/logout');
    await page.getByRole('button', { name: '重试退出', exact: true }).click();
    await expect(page.getByLabel('邮箱', { exact: true })).toBeVisible();
    await expect(page.locator('.workspace')).toHaveCount(0);
    expect((await page.request.get('/api/v1/session')).status()).toBe(401);
  });
}

test('pending logout deduplicates requests, times out and ignores its late response after recovery', async ({ page }) => {
  await login(page);
  await page.clock.install();
  let first: Route | undefined;
  let release!: () => void;
  let delivered = false;
  let calls = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/v1/session/logout', async route => {
    calls++;
    if (calls > 1) return route.continue();
    first = route;
    await gate;
    await route.fulfill({ json: { ok: true } }).catch(() => {});
    delivered = true;
  });
  await logout(page).click();
  await expect.poll(() => !!first).toBe(true);
  await expect(logout(page)).toBeDisabled();
  await logout(page).dispatchEvent('click');
  expect(calls).toBe(1);
  await page.clock.fastForward(15001);
  await expect(page.getByRole('alert')).toContainText('未保存内容仍保留');
  await page.clock.fastForward(30000);
  expect(calls).toBe(1);
  await page.getByRole('button', { name: '重试退出', exact: true }).click();
  await expect(page.getByLabel('邮箱', { exact: true })).toBeVisible();
  expect(calls).toBe(2);
  release();
  await expect.poll(() => delivered).toBe(true);
  await expect(page.locator('.workspace')).toHaveCount(0);
  expect((await page.request.get('/api/v1/session')).status()).toBe(401);
});
