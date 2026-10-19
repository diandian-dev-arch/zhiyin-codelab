import { test, expect, type Page } from '@playwright/test';
import { zipSync, strToU8 } from 'fflate';

const password = 'Browser-test-only-2904!';
async function login(page: Page, email: string) {
  await page.goto('/');
  await page.getByLabel('邮箱', { exact: true }).fill(email);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '实训任务', exact: true })).toBeVisible();
}
async function checkWidth(page: Page, width: number) {
  await page.setViewportSize({ width, height: 900 });
  for (const theme of ['bronze', 'celadon', 'ochre', 'rose']) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    const overflow = await page.locator('.project-task, .task-navigation, .submission-detail, .work-layout, .submission-form').evaluateAll(elements => elements.filter(element => {
      const box = element.getBoundingClientRect();
      return box.width > 0 && (box.left < -1 || box.right > innerWidth + 1);
    }).map(element => element.className));
    expect(overflow).toEqual([]);
  }
  await expect(page.locator('main')).toHaveCount(1);
  await page.evaluate(() => { document.documentElement.dataset.theme = 'bronze'; });
}

test('teacher publishes, student submits without a key, classmates review, and teacher selects a learning example', async ({ page: teacher, browser }, testInfo) => {
  const errors: string[] = [];
  teacher.on('pageerror', error => errors.push(error.message));
  await login(teacher, 'teacher@codelab.local');
  await teacher.screenshot({ path: testInfo.outputPath('teacher-tasks-first-viewport.png') });
  const session = await (await teacher.request.get('/api/v1/session')).json();
  const classes = await (await teacher.request.get('/api/v1/classes')).json();
  const peerResponse = await teacher.request.post(`/api/v1/classes/${classes.items[0].id}/students`, {
    headers: { 'X-CSRF-Token': session.csrf, Origin: new URL(teacher.url()).origin },
    data: { email: 'peer-project@codelab.local', name: '互评同学', password },
  });
  expect(peerResponse.ok()).toBe(true);
  await teacher.getByRole('button', { name: '创建任务', exact: true }).click();
  await teacher.getByLabel('任务名称', { exact: true }).fill('开放项目实训闭环验证');
  await teacher.getByLabel('任务说明', { exact: true }).fill('实现一个清晰的小项目，说明入口与核心功能，并给同学具体建议。');
  await teacher.getByRole('button', { name: '发布任务', exact: true }).click();
  await expect(teacher.getByRole('heading', { name: '开放项目实训闭环验证', exact: true })).toBeVisible();
  const taskPath = new URL(teacher.url()).pathname;
  expect(taskPath).toMatch(/^\/tasks\/[0-9a-f-]+$/);
  const task = await (await teacher.request.get(`/api/v2${taskPath}`)).json();
  expect(task.kind).toBe('project');
  expect(task.rubric).toHaveLength(3);

  const studentContext = await browser.newContext({ baseURL: testInfo.project.use.baseURL });
  const peerContext = await browser.newContext({ baseURL: testInfo.project.use.baseURL });
  try {
    const student = await studentContext.newPage();
    student.on('pageerror', error => errors.push(error.message));
    let analysisCalls = 0;
    student.on('request', request => { if (request.method() === 'POST' && /\/analyze(?:\?|$)/.test(request.url())) analysisCalls++; });
    await login(student, 'student@codelab.local');
    await student.setViewportSize({ width: 390, height: 844 });
    await expect(student.locator('.task-card').first()).toBeVisible();
    const firstTask = await student.locator('.task-card h2').first().boundingBox();
    expect(firstTask!.y).toBeLessThan(844);
    await student.screenshot({ path: testInfo.outputPath('student-tasks-first-viewport.png') });
    await student.goto(taskPath);
    await checkWidth(student, 320);
    await expect(student.getByRole('navigation', { name: '实训任务内容', exact: true }).getByRole('button')).toHaveCount(3);
    await student.screenshot({ path: testInfo.outputPath('student-before-submission-320.png') });
    await student.getByRole('button', { name: '提交我的项目', exact: true }).first().click();
    await student.getByLabel('选择实训项目 ZIP').setInputFiles({
      name: 'student-python-project.zip', mimeType: 'application/zip',
      buffer: Buffer.from(zipSync({ 'student-project/main.py': strToU8('def greet(name):\n    return f"Hello, {name}"\n\nprint(greet("class"))\n'), 'student-project/README.md': strToU8('# A small greeting project\n') })),
    });
    await student.getByLabel('项目说明（可选）', { exact: true }).fill('这个项目展示问候函数与入口，欢迎评价命名和结构。');
    await student.getByLabel('允许本班师生查看这份项目源码和导读，用于课程评价与学习。', { exact: true }).check();
    await student.getByLabel('若被教师选为优秀作品，同意在本次任务的优秀作品区展示。', { exact: true }).check();
    const uploadResponse = student.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/v2/projects');
    await student.getByRole('button', { name: '保存并提交作品', exact: true }).click();
    const saved = await uploadResponse;
    expect(saved.ok()).toBe(true);
    expect(new URL(saved.url()).searchParams.get('analyze')).toBe('false');
    await expect(student.getByText('作品已提交，教师和同学现在可以阅读交流。本次保存未发起 AI 调用。', { exact: true })).toBeVisible();
    await expect(student.getByRole('heading', { name: '这份作品还没有共享 AI 导读' })).toBeVisible();
    expect(analysisCalls).toBe(0);
    await checkWidth(student, 320);
    await checkWidth(student, 390);
    await student.screenshot({ path: testInfo.outputPath('student-submitted-mobile.png'), fullPage: true });
    await checkWidth(student, 1440);

    const peer = await peerContext.newPage();
    peer.on('pageerror', error => errors.push(error.message));
    await login(peer, 'peer-project@codelab.local');
    await peer.goto(taskPath);
    await peer.getByRole('button', { name: /作品与互评/ }).click();
    await peer.getByRole('button', { name: /^评价与反馈/ }).click();
    await peer.getByLabel('一个值得学习的优点', { exact: true }).fill('入口与问候函数分开，职责清楚，容易复用。');
    await peer.getByLabel('一个可以改进的地方', { exact: true }).fill('建议补充空白名字的处理和一个边界测试。');
    await peer.getByLabel('推荐为优秀作品，理由见上方具体评价', { exact: true }).check();
    await peer.getByRole('button', { name: '提交评价', exact: true }).click();
    await expect(peer.getByText('评价已保存。你的具体建议会帮助同学继续改进。', { exact: true })).toBeVisible();
    await expect(peer.getByRole('button', { name: '更新我的评价', exact: true })).toBeVisible();

    await teacher.reload();
    await expect(teacher.locator('.my-submission-status')).toContainText('待反馈');
    await teacher.getByRole('button', { name: /^评价与反馈/ }).click();
    await expect(teacher.locator('.peer-reviews')).toContainText('入口与问候函数分开，职责清楚，容易复用。');
    await teacher.getByLabel('给学生的反馈', { exact: true }).fill('功能结构清楚，已达到本次任务目标。下一步补充边界验证。');
    await teacher.getByRole('combobox', { name: '任务完成情况', exact: true }).selectOption('achieved');
    await teacher.getByLabel('选为本次任务的优秀作品', { exact: true }).check();
    await teacher.getByLabel('入选理由', { exact: true }).fill('函数职责单一，适合作为班级代码组织示例。');
    await teacher.getByRole('button', { name: '发布教师反馈', exact: true }).click();
    await expect(teacher.getByText('教师反馈已发布，学生现在可以查看。', { exact: true })).toBeVisible();
    await checkWidth(teacher, 1440);
    await teacher.screenshot({ path: testInfo.outputPath('teacher-evaluation-desktop.png'), fullPage: true });
    await checkWidth(teacher, 390);
    await teacher.screenshot({ path: testInfo.outputPath('teacher-evaluation-mobile.png'), fullPage: true });
    await student.reload();
    await student.getByRole('button', { name: /优秀作品/ }).click();
    await expect(student.getByRole('heading', { name: '把优秀做法，变成下一次灵感' })).toBeVisible();
    await expect(student.locator('.feature-reason')).toContainText('函数职责单一，适合作为班级代码组织示例。');
    await student.getByRole('button', { name: /^评价与反馈/ }).click();
    await expect(student.locator('.teacher-feedback')).toContainText('功能结构清楚，已达到本次任务目标。');
    await expect(student.getByLabel('一个值得学习的优点')).toHaveCount(0);
    expect(analysisCalls).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await studentContext.close();
    await peerContext.close();
  }
});
