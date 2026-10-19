import { test, expect } from '@playwright/test';

for (const width of [1440, 390]) {
  test(`OpenAI presets and legacy configuration at ${width}px without billable calls`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    let settings = { vendor: 'openai', model: 'gpt-4.1-mini', contextWindowTokens: null, maxOutputTokens: 12000 };
    const writes: string[] = [], errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/**', async route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      if (path === '/api/v1/session') return route.fulfill({ json: {
        user: { id: 'fixture', name: 'Fixture', email: 'fixture@example.test', role: 'teacher' },
        csrf: 'fixture', businessVersion: 2, executionApproved: false,
      } });
      if (path === '/api/v2/model-settings') {
        if (request.method() === 'PUT') {
          writes.push(path);
          const { apiKey, ...saved } = request.postDataJSON();
          settings = saved;
        } else expect(request.method()).toBe('GET');
        return route.fulfill({ json: { enabled: true, configured: true, active: false, settings } });
      }
      // No request can reach a real API, including connectivity tests.
      expect(request.method(), path).toBe('GET');
      expect(path).not.toContain('/test');
      return route.fulfill({ json: { tasks: [], projects: [], available: true } });
    });
    await page.goto('/settings');
    await page.getByRole('button', { name: '模型设置', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '个人模型设置' });
    const model = dialog.getByLabel('模型名称', { exact: true });
    await expect(model).toHaveValue('gpt-4.1-mini');
    await expect(dialog.getByRole('button', { name: 'gpt-4.1-mini', exact: true })).toHaveCount(0);
    await dialog.getByRole('radio', { name: 'DeepSeek', exact: true }).check();
    await dialog.getByRole('radio', { name: 'OpenAI', exact: true }).check();
    await expect(model).toHaveValue('gpt-6.1-sol');
    expect(writes).toEqual([]);
    for (const name of ['gpt-6.1-sol', 'gpt-6-astra']) {
      const preset = dialog.getByRole('button', { name, exact: true });
      await preset.click();
      await expect(model).toHaveValue(name);
      await expect(preset).toHaveAttribute('aria-pressed', 'true');
      await dialog.getByRole('button', { name: '保存配置', exact: true }).click();
      await expect(dialog.locator('.model-success')).toContainText('配置已保存');
      await dialog.getByRole('button', { name: '关闭模型设置' }).click();
      await page.getByRole('button', { name: '模型设置', exact: true }).click();
      await expect(model).toHaveValue(name);
    }
    await dialog.screenshot({ path: testInfo.outputPath(`openai-models-${width}.png`) });
    expect(writes).toEqual(['/api/v2/model-settings', '/api/v2/model-settings']);
    expect(errors).toEqual([]);
  });
}
