import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';

// Every request is fulfilled locally; no configuration or analysis reaches the server.
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  for (const [width, height] of [[1440, 900], [768, 1024], [390, 844], [320, 740]]) {
  const page = await browser.newPage({ reducedMotion: 'reduce', viewport: { width, height } });
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  const state = { enabled: true, active: false, configured: true, revision: 'fixture-1', settings: { vendor: 'deepseek', model: 'fixture-model-one', contextWindowTokens: null, maxOutputTokens: 12000 } };
  let modelUnavailable = false;
  let analysisRequests = 0;
  await page.route('**/api/**', async route => {
    const req = route.request(), path = new URL(req.url()).pathname;
    if (path === '/api/v2/model-settings' && req.method() === 'PUT') {
      state.settings = { ...state.settings, ...req.postDataJSON() };
      return route.fulfill({ json: state });
    }
    if (path === '/api/v2/source-cost-preview') return route.fulfill({ json: { price: { inputPerMillion: 2, outputPerMillion: 3, label: '测试价格' }, allocationCny: 1, maxCalls: 3 } });
    if (path.endsWith('/analyze')) { analysisRequests++; return route.fulfill({ status: 500, json: { message: 'Unexpected analysis request' } }); }
    assert.equal(req.method(), 'GET');
    if (path === '/api/v2/model-settings' && modelUnavailable) return route.fulfill({ status: 503, json: { message: 'Fixture unavailable' } });
    const json = path === '/api/v1/session'
      ? { user: { id: 'test', name: 'Test', email: 'test@example.test', role: 'teacher' }, csrf: 'fixture', businessVersion: 2, executionApproved: false }
      : path === '/api/v2/model-settings' ? state
      : path === '/api/v2/projects/confirmation-fixture'
        ? { id: 'confirmation-fixture', name: 'Confirmation fixture', available: true, files: [{ path: 'main.py', lines: 1 }], omitted: [], analyses: [] }
      : { projects: [], tasks: [] };
    await route.fulfill({ json });
  });
  await page.goto(`${process.env.READER_TEST_ORIGIN || 'http://127.0.0.1:5175'}/projects/confirmation-fixture`);
  await page.getByRole('button', { name: '开始解读', exact: true }).click();
  const panel = page.locator('.next-analysis');
  await expect(panel.getByText('本次模型：DeepSeek · fixture-model-one', { exact: true })).toBeVisible();
  const budget = panel.getByRole('spinbutton', { name: '本次预算（元）' });
  await budget.fill('3.7');
  await panel.getByRole('button', { name: '模型设置', exact: true }).click();
  await page.getByRole('textbox', { name: '模型名称', exact: true }).fill('fixture-model-two');
  await page.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect(page.getByText(/配置已保存。之后的新分析/)).toBeVisible();
  const dialog = page.getByRole('dialog', { name: '个人模型设置' });
  assert.ok(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1), `Model dialog overflow at ${width}px`);
  await page.getByRole('button', { name: '关闭模型设置', exact: true }).click();
  await expect(panel.getByRole('button', { name: '模型设置', exact: true })).toBeFocused();
  await expect(panel.getByText('本次模型：DeepSeek · fixture-model-two', { exact: true })).toBeVisible();
  await expect(budget).toHaveValue('3.7');
  // A failed dialog read can be retried in place, then Escape must return to
  // the original confirmation trigger rather than the dialog's retry button.
  modelUnavailable = true;
  await panel.getByRole('button', { name: '模型设置', exact: true }).click();
  await expect(page.getByRole('button', { name: '重新读取配置', exact: true })).toBeVisible();
  modelUnavailable = false;
  await page.getByRole('button', { name: '重新读取配置', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '模型名称', exact: true })).toHaveValue('fixture-model-two');
  await expect(page.getByRole('button', { name: '关闭模型设置', exact: true })).toBeEnabled();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: '个人模型设置' })).not.toBeVisible();
  await expect(panel.getByRole('button', { name: '模型设置', exact: true })).toBeFocused();
  await expect(budget).toHaveValue('3.7');
  await expect(panel.getByRole('button', { name: /确认并开始解读/ })).toBeEnabled();
  await panel.locator('.advanced-analysis > summary').click();
  await panel.getByRole('radio', { name: /深入分析/ }).check();
  await expect(budget).toHaveValue('3.7');
  modelUnavailable = true;
  await page.reload();
  await page.getByRole('button', { name: '开始解读', exact: true }).click();
  await expect(panel.getByText(/暂时无法核对本次模型/)).toBeVisible();
  await expect(panel.getByRole('button', { name: /确认并开始解读/ })).toBeDisabled();
  modelUnavailable = false;
  await panel.getByRole('button', { name: '重新读取模型', exact: true }).click();
  await expect(panel.getByRole('button', { name: /确认并开始解读/ })).toBeEnabled();
  assert.equal(analysisRequests, 0);
  assert.deepEqual(pageErrors, []);
  console.log(`PASS ${width}x${height}: model identity, budget retention, close/Escape focus return, failed-read retry, unknown-model guard; no model calls or dialog overflow.`);
  await page.close();
  }
} finally { await browser.close(); }
