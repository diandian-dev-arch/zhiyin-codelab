import { test, expect, type Page } from '@playwright/test';

async function login(page: Page, role: 'teacher' | 'student') {
  await page.goto('/');
  await page.getByLabel('邮箱', { exact: true }).fill(`${role}@codelab.local`);
  await page.getByLabel('密码', { exact: true }).fill('Browser-test-only-2904!');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '实训任务', exact: true })).toBeVisible();
}

async function resumeAfterRead(page: Page) {
  const recovery = page.getByRole('status', { name: '保存结果待核对' });
  await recovery.getByRole('button', { name: '读取最新记录核对', exact: true }).click();
  await recovery.getByLabel('我已核对服务器记录，理解原操作仍可能完成，确认允许新的写入。', { exact: true }).check();
  await recovery.getByRole('button', { name: '确认核对，恢复写入', exact: true }).click();
  await expect(recovery).toHaveCount(0);
}

test('a committed assignment with a lost receipt preserves input, locks writes, and reconciles by GET only', async ({ page }, info) => {
  await login(page, 'teacher');
  await page.getByRole('link', { name: '课程作业', exact: true }).click();
  await page.getByRole('button', { name: '创建作业', exact: true }).click();
  await page.getByLabel('作业名称', { exact: true }).fill('失联创建：保留输入并核对');
  await page.getByLabel('目标与说明', { exact: true }).fill('本用例只写入隔离内存测试库。');
  await page.getByLabel('评价标准（每行一条）', { exact: true }).fill('保留原输入');
  let writes = 0;
  await page.route('**/api/v2/assignments', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    writes++;
    const accepted = await route.fetch();
    expect(accepted.status()).toBe(201);
    await route.abort('failed');
  });
  await page.getByRole('button', { name: '创建并发布', exact: true }).click();
  const recovery = page.getByRole('status', { name: '保存结果待核对' });
  await expect(recovery).toBeVisible();
  await expect(page.getByLabel('作业名称', { exact: true })).toHaveValue('失联创建：保留输入并核对');
  await expect(page.getByRole('button', { name: '创建并发布', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '保存草稿', exact: true })).toBeDisabled();
  await recovery.getByRole('button', { name: '读取最新记录核对', exact: true }).click();
  await expect(page.getByRole('heading', { name: '失联创建：保留输入并核对', level: 2, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '创建并发布', exact: true })).toBeDisabled();
  expect(writes).toBe(1);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await recovery.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('assignment-unknown-mobile.png') });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: info.outputPath('assignment-unknown-readback.png'), fullPage: true });
  await recovery.getByLabel('我已核对服务器记录，理解原操作仍可能完成，确认允许新的写入。', { exact: true }).check();
  await recovery.getByRole('button', { name: '确认核对，恢复写入', exact: true }).click();
  await expect(page.getByRole('button', { name: '创建并发布', exact: true })).toBeEnabled();
  expect(writes).toBe(1);
  const items = (await (await page.request.get('/api/v2/assignments')).json()).items;
  expect(items.filter((item: any) => item.title === '失联创建：保留输入并核对')).toHaveLength(1);
});

test('a lost formal-submission receipt retains its original key and reuses the accepted fixed submission after explicit recovery', async ({ page: teacher, browser }, info) => {
  await login(teacher, 'teacher');
  const session = await (await teacher.request.get('/api/v1/session')).json();
  const classes = await (await teacher.request.get('/api/v1/classes')).json();
  const created = await teacher.request.post('/api/v2/assignments', {
    headers: { 'X-CSRF-Token': session.csrf, Origin: new URL(teacher.url()).origin },
    data: { classId: classes.items[0].id, title: '失联正式提交', subjectMode: 'individual', status: 'published', tasks: [{ title: '固定源码', description: '不执行项目、不请求模型。', requirements: [{ id: 'R1', title: '保留输入' }] }] },
  });
  expect(created.status()).toBe(201);
  const assignment = await created.json();
  const detail = await (await teacher.request.get(`/api/v2/assignments/${assignment.id}`)).json();
  const taskId = detail.tasks[0].task_id;
  const context = await browser.newContext({ baseURL: info.project.use.baseURL });
  try {
    const student = await context.newPage();
    let modelCalls = 0;
    student.on('request', request => { if (request.method() === 'POST' && /\/(?:analyses|self-checks|messages)(?:\?|$)/.test(request.url())) modelCalls++; });
    await login(student, 'student');
    await student.goto(`/course-tasks/${taskId}`);
    await student.getByLabel('一次性粘贴代码', { exact: true }).fill('export const stable = true;');
    await student.getByRole('button', { name: '准备固定快照', exact: true }).click();
    await expect(student.getByRole('heading', { name: '已保存的固定快照', exact: true })).toBeVisible();
    await student.getByLabel('本次说明', { exact: true }).fill('提交回执丢失后仍保留这段说明');
    await student.getByLabel(/确认提交到/).check();
    const sent: { key: string | undefined; body: string | null }[] = [];
    let acceptedId = '';
    await student.route(`**/api/v2/course-tasks/${taskId}/submissions`, async route => {
      if (route.request().method() !== 'POST') return route.continue();
      sent.push({ key: route.request().headers()['idempotency-key'], body: route.request().postData() });
      if (sent.length > 1) return route.continue();
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      acceptedId = (await response.json()).submission.id;
      await route.abort('failed');
    });
    await student.getByRole('button', { name: '确认正式提交', exact: true }).click();
    await expect(student.getByRole('status', { name: '保存结果待核对' })).toBeVisible();
    await expect(student.getByLabel('本次说明', { exact: true })).toHaveValue('提交回执丢失后仍保留这段说明');
    await expect(student.getByRole('button', { name: '确认正式提交', exact: true })).toBeDisabled();
    await resumeAfterRead(student);
    expect(sent).toHaveLength(1);
    const acceptedLink = student.locator(`a[href="/course-submissions/${acceptedId}"]`);
    await expect(acceptedLink).toBeVisible();
    await student.getByLabel(/确认提交到/).check();
    await student.getByRole('button', { name: '确认正式提交', exact: true }).click();
    await expect(student).toHaveURL(new RegExp(`/course-submissions/${acceptedId}$`));
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
    expect(sent[0].key).toBeTruthy();
    const current = await (await student.request.get(`/api/v2/course-tasks/${taskId}`)).json();
    expect(current.submissions).toHaveLength(1);
    expect(modelCalls).toBe(0);
    await student.screenshot({ path: info.outputPath('formal-replayed-same-receipt.png'), fullPage: true });
  } finally { await context.close(); }
});
