import { test, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { zipSync, strToU8 } from 'fflate';

test('folder preparation stays local and can be replaced with a ZIP before saving', async ({ page }, info) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codelab-folder-ui-'));
  const writes: string[] = [];
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await mkdir(path.join(directory, 'src'));
    await mkdir(path.join(directory, 'node_modules'));
    await writeFile(path.join(directory, 'src', 'main.ts'), 'export const demo = true;');
    await writeFile(path.join(directory, 'node_modules', 'ignored.js'), 'fixture dependency');
    await writeFile(path.join(directory, '.env'), 'SYNTHETIC_FIXTURE=never-upload');
    await page.route('**/api/**', route => {
      const request = route.request();
      if (request.method() !== 'GET') {
        writes.push(new URL(request.url()).pathname);
        return route.abort('blockedbyclient');
      }
      const url = new URL(request.url());
      return route.fulfill({ json: url.pathname === '/api/v1/session'
        ? { user: { id: 'folder-ui', name: '样例', role: 'student', email: 'fixture@example.test' }, csrf: 'fixture', businessVersion: 2 }
        : url.pathname === '/api/v2/projects' ? { projects: [], available: false }
        : url.pathname === '/api/v2/model-settings' ? { enabled: true, configured: false, active: false, settings: null }
        : { items: [] } });
    });
    await page.goto('/projects');
    await page.getByLabel('选择项目文件夹', { exact: true }).setInputFiles(directory);
    await expect(page.locator('.zip-drop strong')).toHaveText(`${path.basename(directory)}.zip`);
    await expect(page.getByRole('button', { name: '仅保存源码', exact: true })).toBeEnabled();
    await expect(page.locator('.zip-drop')).toContainText('尚未保存');
    await page.screenshot({ path: info.outputPath('folder-prepared.png') });
    await page.getByLabel('选择项目 ZIP', { exact: true }).setInputFiles({
      name: 'replacement.zip', mimeType: 'application/zip',
      buffer: Buffer.from(zipSync({ 'src/replacement.ts': strToU8('export const replacement = true;') })),
    });
    await expect(page.locator('.zip-drop strong')).toHaveText('replacement.zip');
    await page.getByRole('button', { name: '移除文件', exact: true }).click();
    await expect(page.getByRole('button', { name: '仅保存源码', exact: true })).toBeDisabled();
    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: '我的设置', exact: true })).toBeVisible();
    expect(writes).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    // Delete only this test's exact generated folder, never source/user data.
    await rm(directory, { recursive: true, force: true });
  }
});
