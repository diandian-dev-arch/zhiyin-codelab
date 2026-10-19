import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

const widths = [320, 375, 414, 768, 1280];
const out = 'output/frontend-design';
async function login(page: Page, role: 'student' | 'teacher') {
  await page.goto('/');
  await page.getByLabel('邮箱', {exact:true}).fill(role + '@codelab.local');
  await page.getByLabel('密码', {exact:true}).fill('Browser-test-only-2904!');
  await page.getByRole('button', {name:'登录',exact:true}).click();
  await expect(page.getByRole('heading', {name:'实训任务',exact:true})).toBeVisible();
}
async function layout(page: Page, label: string) {
  const violations = await page.evaluate(() => {
    const selectors = ['main', '.page-heading', '.panel', '.task-collection', '.task-card', '.upload-stage', '.personal-model-bar', '.source-report', '.v2-report', '.review-split', '.agent-studio', 'dialog[open]', '.model-columns', '.login-container'];
    return selectors.flatMap(selector => [...document.querySelectorAll(selector)].flatMap(el => {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return [];
      return r.x < -1 || r.right > innerWidth + 1 ? [selector + ': ' + r.x + '—' + r.right + '/' + innerWidth] : [];
    }));
  });
  expect(violations, label).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), label).toBe(true);
}
async function captureWidths(page: Page, label: string) {
  for (const width of widths) {
    await page.setViewportSize({width, height:900});
    await layout(page, label + '-' + width);
    await page.screenshot({path: out + '/' + label + '-' + width + '.png', fullPage:true});
  }
}
test.beforeAll(async () => { await mkdir(out, {recursive:true}); });
test('login reflows, password visibility and keyboard focus stay usable', async ({page}) => {
  await page.goto('/');
  await expect(page.getByRole('heading',{name:'欢迎使用 CodeLab'})).toBeVisible();
  await captureWidths(page, 'login');
  await page.getByLabel('密码',{exact:true}).fill('visibility-fixture');
  await page.getByRole('button',{name:'显示密码',exact:true}).click();
  await expect(page.getByLabel('密码',{exact:true})).toHaveAttribute('type','text');
  await page.getByRole('button',{name:'隐藏密码',exact:true}).click();
  await expect(page.getByLabel('密码',{exact:true})).toHaveAttribute('type','password');
  await page.getByLabel('邮箱',{exact:true}).focus();
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('密码',{exact:true})).toBeFocused();
  expect(await page.getByLabel('密码',{exact:true}).evaluate(el => getComputedStyle(el).outlineStyle)).not.toBe('none');
});
test('student navigation, task disclosures, settings and model dialog reflow', async ({page}) => {
  await page.route('**/api/v2/model-settings', route => route.fulfill({json:{enabled:true,configured:false,active:false,settings:null}}));
  await login(page, 'student');
  await captureWidths(page,'tasks');
  const scope = page.locator('.task-scope').first();
  await expect(scope).not.toHaveAttribute('open');
  await scope.locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(scope).toHaveAttribute('open');
  for (const [width, device] of [[1440, 'desktop'], [390, 'mobile']] as const) {
    await page.setViewportSize({width, height:900});
    await layout(page, 'task-disclosure-' + device);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({path: out + '/task-disclosure-' + device + '.png', fullPage:true});
  }
  await page.getByLabel('搜索任务或班级',{exact:true}).fill('没有这份任务-设计测试');
  await expect(page.getByRole('heading',{name:'没有匹配的任务'})).toBeVisible();
  await page.getByRole('button',{name:'清除筛选'}).click();
  await page.locator('.task-description h2 a').first().click();
  await expect(page.locator('.task-desk')).toBeVisible();
  await captureWidths(page,'task-detail');
  await expect(page.getByRole('navigation',{name:'工作台主导航'}).getByRole('link',{name:'实训任务',exact:true})).toHaveAttribute('aria-current','page');
  await page.goto('/settings');
  await captureWidths(page,'settings');
  await page.getByRole('button',{name:'模型设置',exact:true}).click();
  const dialog = page.getByRole('dialog',{name:'个人模型设置'});
  await expect(dialog.getByLabel('模型名称',{exact:true})).toBeEnabled();
  await captureWidths(page,'model-dialog');
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('button',{name:'模型设置',exact:true})).toBeFocused();
  await page.goto('/projects');
  await expect(page.getByRole('button',{name:'选择 ZIP',exact:true})).toBeVisible();
  await captureWidths(page,'projects');
  await page.setViewportSize({width:320,height:900});
  await page.getByRole('navigation',{name:'工作台导航'}).getByRole('link',{name:'实训任务',exact:true}).click();
  await expect(page.getByRole('heading',{name:'实训任务',exact:true})).toBeVisible();
});
test('model context picker keeps keyboard selection, Escape and form semantics without sending configuration', async ({page}) => {
  let active = false;
  const writes: string[] = [];
  await page.route('**/api/v2/model-settings', route => {
    if (route.request().method() !== 'GET') {
      writes.push(route.request().method() + ' ' + route.request().url());
      return route.fulfill({status:409,json:{error:{message:'This read-only test must not save model settings.'}}});
    }
    return route.fulfill({json:{enabled:true,configured:false,active,settings:null}});
  });
  await login(page, 'student');
  page.on('request', request => {
    if (request.method() !== 'GET' && /\/api\/v2\//.test(request.url())) writes.push(request.method() + ' ' + request.url());
  });
  await page.goto('/settings');
  const trigger = page.getByRole('button',{name:'模型设置',exact:true});
  await trigger.click();
  const dialog = page.getByRole('dialog',{name:'个人模型设置'});
  const advanced = dialog.locator('.model-advanced');
  await advanced.locator('summary').click();
  const picker = dialog.getByRole('combobox',{name:'上下文窗口',exact:true});
  await expect(picker).toBeEnabled();
  for (const [width, device] of [[1440, 'desktop'], [390, 'mobile']] as const) {
    await page.setViewportSize({width,height:900});
    await picker.click();
    await expect(picker).toHaveJSProperty('value', device === 'desktop' ? 'auto' : 'custom');
    await expect.poll(() => picker.evaluate(el => el.matches(':open'))).toBe(true);
    await layout(page, 'model-select-open-' + device);
    await expect(dialog.getByRole('button',{name:'关闭模型设置',exact:true})).toBeInViewport({ratio:1});
    await page.screenshot({path:out + '/model-select-open-' + device + '.png',fullPage:false});
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await expect(picker).toHaveValue('custom');
    const custom = dialog.getByLabel('自定义上下文（tokens）',{exact:true});
    await expect(custom).toBeVisible();
    await expect(custom).toHaveAttribute('required');
    await custom.fill('');
    expect(await custom.evaluate(el => (el as HTMLInputElement).validity.valueMissing)).toBe(true);
    await custom.fill('131072');
    expect(await custom.evaluate(el => (el as HTMLInputElement).validity.valid)).toBe(true);
    await picker.click();
    await expect.poll(() => picker.evaluate(el => el.matches(':open'))).toBe(true);
    await page.keyboard.press('Escape');
    await expect.poll(() => picker.evaluate(el => el.matches(':open'))).toBe(false);
    await expect(dialog).toBeVisible();
    await expect(picker).toBeFocused();
    await expect(picker).toHaveValue('custom');
    await expect(custom).toHaveValue('131072');
  }
  await dialog.getByRole('button',{name:'关闭模型设置',exact:true}).click();
  await expect(trigger).toBeFocused();
  active = true;
  await trigger.click();
  await expect(dialog.getByText('当前账号有正在排队或执行的分析。请等待完成或先停止，再修改密钥和模型。关闭并重新打开此窗口可刷新状态。')).toBeVisible();
  await expect(picker).toBeDisabled();
  await expect(dialog.getByRole('button',{name:'保存配置',exact:true})).toBeDisabled();
  await dialog.getByRole('button',{name:'关闭模型设置',exact:true}).click();
  expect(writes).toEqual([]);
});
test('teacher evidence desk, narrow layout and reduced motion preserve review controls', async ({page}) => {
  await login(page,'teacher');
  await page.goto('/runs/00000000-0000-4000-8000-000000000003');
  await expect(page.locator('.v2-evidence')).toBeVisible();
  await captureWidths(page,'teacher-review');
  await page.setViewportSize({width:320,height:900});
  await page.getByLabel('建议的下一步').fill('用于布局验证的临时草稿');
  await expect(page.getByLabel('建议的下一步')).toHaveValue('用于布局验证的临时草稿');
  await expect(page.getByRole('button',{name:'保存修改',exact:true})).toBeEnabled();
  await page.emulateMedia({reducedMotion:'reduce'});
  expect(await page.getByRole('button',{name:'保存修改',exact:true}).evaluate(el => getComputedStyle(el).transitionDuration)).toBe('0s');
  // No save, publish, model, cancellation or other business write in this test.
});
