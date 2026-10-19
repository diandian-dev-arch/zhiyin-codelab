import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';

// All API traffic is intercepted, including analysis POSTs. No real jobs or costs.
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  let analysisRequests = 0, stateReads = 0, disconnected = false;
  let releaseRequest;
  const pending = new Promise(resolve => { releaseRequest = resolve; });
  const project = { id: 'reconnect-fixture', name: '断线回归样例', available: true,
    files: [{ path: 'main.ts', lines: 1 }], omitted: [], analyses: [] };
  await page.route('**/api/**', async route => {
    const req = route.request(), path = new URL(req.url()).pathname;
    if (path.endsWith('/analyze')) {
      assert.equal(req.method(), 'POST');
      analysisRequests++;
      await pending;
      // Simulate accepted server work whose response never reached the client.
      project.analyses = [{ id: 'accepted-job', status: 'running', created_at: new Date().toISOString(),
        started_at: new Date().toISOString(), canCancel: false, events: [] }];
      return route.abort('failed');
    }
    if (path === '/api/v2/source-cost-preview') return route.fulfill({ json: {
      price: { inputPerMillion: 2, outputPerMillion: 3, label: '测试价格' }, allocationCny: 1, maxCalls: 4,
    } });
    assert.equal(req.method(), 'GET');
    if (path === '/api/v2/projects/reconnect-fixture') {
      stateReads++;
      if (disconnected) return route.abort('failed');
      return route.fulfill({ json: project });
    }
    return route.fulfill({ json: path === '/api/v1/session'
      ? { user: { id: 'test', name: 'Test', email: 'fixture@example.test', role: 'teacher' }, csrf: 'fixture', businessVersion: 2, executionApproved: false }
      : path === '/api/v2/model-settings'
        ? { enabled: true, configured: true, active: false, settings: { vendor: 'deepseek', model: 'fixture', maxOutputTokens: 12000 } }
        : { projects: [], tasks: [] } });
  });
  await page.goto(`${process.env.READER_TEST_ORIGIN || 'http://127.0.0.1:5175'}/projects/reconnect-fixture`);
  await page.getByRole('button', { name: '开始解读', exact: true }).click();
  const start = page.getByRole('button', { name: /确认并开始解读/ });
  await expect(start).toBeEnabled();
  await start.dblclick();
  await expect.poll(() => analysisRequests).toBe(1);
  await expect(start).toBeDisabled();
  disconnected = true;
  releaseRequest();
  await expect(page.getByText(/操作结果尚未确认/)).toBeVisible();
  await expect(page.getByRole('button', { name: '重新连接', exact: true })).toBeVisible();
  await expect(start).toBeDisabled();
  const readsBeforeRecovery = stateReads;
  disconnected = false;
  await page.getByRole('button', { name: '重新连接', exact: true }).click();
  await expect(page.getByRole('region', { name: '解读进度' })).toBeVisible();
  assert.ok(stateReads > readsBeforeRecovery);
  assert.equal(analysisRequests, 1);
  // A subsequent polling cycle and refresh must both recover the same job by GET.
  const readsAfterRecovery = stateReads;
  await expect.poll(() => stateReads, { timeout: 7000 }).toBeGreaterThan(readsAfterRecovery);
  assert.equal(analysisRequests, 1);
  await page.reload();
  await expect(page.getByRole('region', { name: '解读进度' })).toBeVisible();
  assert.equal(analysisRequests, 1);
  console.log('PASS double click, unknown POST receipt, disconnected reads, explicit reconnect, polling and refresh: exactly one intercepted analysis POST.');
} finally { await browser.close(); }
