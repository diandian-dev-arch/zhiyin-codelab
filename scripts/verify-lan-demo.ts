import { chromium, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const { address } = JSON.parse(await readFile('.data/workspace-lan.json', 'utf8'));
const baseURL = `http://${address}:5174`;
const { loginPassword } = JSON.parse(await readFile('.data/business-v2/development-credentials.json', 'utf8'));
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--no-proxy-server'] });
try {
  for (const role of ['teacher', 'student']) {
    const context = await browser.newContext({ baseURL });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto('/login');
    await page.getByLabel('邮箱', { exact: true }).fill(`${role}@codelab.local`);
    await page.getByLabel('密码', { exact: true }).fill(loginPassword);
    const loggedIn = page.waitForResponse(r => r.url().endsWith('/api/v1/session/login') && r.request().method() === 'POST');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    expect((await loggedIn).status()).toBe(200);
    await expect(page.getByRole('button', { name: '登录', exact: true })).toHaveCount(0);
    await expect(page).toHaveURL(/\/projects$/);
    const session = await context.request.get('/api/v1/session');
    expect(session.status()).toBe(200);
    expect((await session.json()).user.role).toBe(role);
    await page.goto('/tasks');
    await expect(page.getByRole('heading', { name: '实训任务', exact: true })).toBeVisible();
    const uuid = await page.evaluate(() => ({ secure: isSecureContext, id: crypto.randomUUID() }));
    expect(uuid.secure).toBe(false);
    expect(uuid.id).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    const task = page.locator('a[href^="/tasks/"]').first();
    if (await task.count()) {
      await task.click();
      await expect(page).toHaveURL(/\/tasks\/.+/);
      await expect(page.locator('main')).toBeVisible();
    }
    const wrongOrigin = await context.request.post('/api/v1/session/logout', { headers: { origin: 'http://untrusted.example' } });
    expect(wrongOrigin.status()).toBe(403);
    const missingCsrf = await context.request.post('/api/v1/session/logout', { headers: { origin: baseURL } });
    expect(missingCsrf.status()).toBe(403);
    expect(errors).toEqual([]);
    console.log(JSON.stringify({ role, login: 'passed', tasks: 'passed', lanHttpUUID: 'passed', originAndCsrf: 'passed', pageErrors: errors }));
    await context.close();
  }
} finally { await browser.close(); }
