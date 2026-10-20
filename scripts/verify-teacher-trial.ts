import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect, type Page } from '@playwright/test';
import { postgres, type DB } from '../apps/api/src/db.js';
import { hashPassword } from '../apps/api/src/auth.js';
import { root } from '../apps/api/src/template.js';

// This creates clearly marked internal records in the dedicated trial DB only.
const trialDirectory = path.join(root, '.data/teacher-trial');
const status = JSON.parse(await readFile(path.join(trialDirectory, 'status.json'), 'utf8'));
const secrets = JSON.parse(await readFile(path.join(trialDirectory, 'private-credentials.json'), 'utf8'));
assert.equal(status.workspace, 'teacher-trial');
assert.equal(status.phase, 'ready');
assert.equal(status.environmentId, secrets.environmentId);
const output = path.join(root, 'docs/verification/2026-10-19/teacher-trial', randomUUID());
await mkdir(output, { recursive: true });
const origin = new URL(status.lanUrl).origin;
const receipt: Record<string, any> = {
  startedAt: new Date().toISOString(), passed: false, scope: 'developer-machine-isolated-trial-browser-walkthrough',
  environmentId: status.environmentId, externalModelCalls: 0, secondComputerVerified: false,
  teacherEvaluationCompleted: false, originalDatabaseAccess: false, internalRecordsCreated: true,
  pages: [], pageErrors: [],
};
let db: DB | undefined;
let stage = 'database-identity';
const diagnosticPages: { name: string; page: Page }[] = [];
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--no-proxy-server'] });
try {
  const { stdout } = await promisify(execFile)('docker', ['inspect', status.databaseContainerId], { windowsHide: true, timeout: 10000 });
  const info = JSON.parse(stdout)[0];
  assert.equal(info.Config.Labels?.['codelab.teacher-trial'], status.environmentId);
  assert(info.Mounts.some((m: any) => m.Name === 'codelab-teacher-trial-postgres' && m.Destination === '/var/lib/postgresql/data'));
  const binding = info.NetworkSettings.Ports['5432/tcp'];
  assert.equal(binding.length, 1);
  assert.equal(binding[0].HostIp, '127.0.0.1');
  db = postgres(`postgres://postgres:${secrets.databasePassword}@127.0.0.1:${binding[0].HostPort}/teacher_trial`);
  assert.equal((await db.query('SELECT current_database() AS name')).rows[0].name, 'teacher_trial');
  const initial = (await db.query('SELECT snapshot_id FROM course_submissions WHERE id=$1', [status.fixture.submissionId])).rows[0];
  assert(initial);
  const originalSample = await db.query('SELECT content_hash FROM course_snapshots WHERE id=$1', [initial.snapshot_id]);
  const ids = { teacher: randomUUID(), student: randomUUID(), classId: randomUUID() };
  const password = randomUUID() + randomUUID();
  await db.transaction(async tx => {
    for (const role of ['teacher', 'student'] as const) await tx.query('INSERT INTO users(id,email,name,role,password_hash) VALUES($1,$2,$3,$4,$5)',
      [ids[role], `${ids[role]}@trial-verification.invalid`, `[内部验收] ${role}`, role, hashPassword(password)]);
    await tx.query('INSERT INTO classes(id,name,teacher_id) VALUES($1,$2,$3)', [ids.classId, '[内部验收] 独立流程班级', ids.teacher]);
    await tx.query('INSERT INTO memberships(class_id,user_id) VALUES($1,$2)', [ids.classId, ids.student]);
  });
  const teacherContext = await browser.newContext({ baseURL: origin, viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  const studentContext = await browser.newContext({ baseURL: origin, viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  // A different port alone does not isolate cookies. Preserve an unrelated sid.
  await teacherContext.addCookies([{ name: 'sid', value: 'unrelated-original-cookie-sentinel', url: origin, httpOnly: true, sameSite: 'Strict' }]);
  const teacher = await teacherContext.newPage(), student = await studentContext.newPage();
  diagnosticPages.push({ name: 'teacher', page: teacher }, { name: 'student', page: student });
  for (const page of [teacher, student]) page.on('pageerror', e => receipt.pageErrors.push(e.name));
  async function login(page: typeof teacher, role: 'teacher' | 'student', account = { email: `${ids[role]}@trial-verification.invalid`, password }) {
    await page.goto('/assignments');
    assert.match(await page.title(), /教师试用/);
    await page.getByLabel('邮箱', { exact: true }).fill(account.email);
    await page.getByLabel('密码', { exact: true }).fill(account.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('heading', { name: '课程作业', exact: true })).toBeVisible();
    await expect(page.locator('main')).toHaveCount(1);
    await expect(page.locator('.sidebar nav .nav-item')).toHaveCount(2);
    await expect(page.locator('.mobile-workspace-nav a')).toHaveCount(2);
    await expect(page.getByRole('link', { name: 'AI 项目解读', exact: true })).toHaveCount(0);
    await expect(page.getByRole('link', { name: '账号与模型', exact: true })).toHaveCount(0);
    if (page.viewportSize()!.width < 760) {
      const columns = await page.locator('.mobile-workspace-nav').evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length);
      assert.equal(columns, 2);
    }
  }
  stage = 'teacher-login';
  await login(teacher, 'teacher');
  stage = 'student-login';
  await login(student, 'student');
  stage = 'trial-settings-and-route-boundary';
  await teacher.goto('/settings');
  await expect(teacher.getByRole('heading', { name: '账号信息', exact: true })).toBeVisible();
  await expect(teacher.getByRole('heading', { name: '个人 AI 模型', exact: true })).toHaveCount(0);
  await expect(teacher.getByRole('button', { name: '模型设置', exact: true })).toHaveCount(0);
  await teacher.screenshot({ path: path.join(output, 'teacher-settings.png') });
  for (const target of ['/', '/projects']) {
    await teacher.goto(target);
    await expect(teacher).toHaveURL(`${origin}/assignments`);
    await expect(teacher.getByRole('heading', { name: '课程作业', exact: true })).toBeVisible();
  }
  stage = 'create-coursework';
  await teacher.getByRole('button', { name: '创建作业', exact: true }).click();
  await teacher.getByLabel('作业名称', { exact: true }).fill('[内部验收] 固定提交与人工反馈');
  await teacher.getByLabel('目标与说明', { exact: true }).fill('仅非敏感合成资料，验证流程，不代表真实教师评测。');
  await teacher.getByLabel('评价标准（每行一条）', { exact: true }).fill('空查询保留全部项目');
  await teacher.getByText('起始材料、来源与分析范围', { exact: true }).click();
  await expect(teacher.getByLabel('Gitee 仓库', { exact: true })).toHaveCount(0);
  await expect(teacher.getByLabel('GitHub 仓库', { exact: true })).toHaveCount(0);
  await expect(teacher.getByLabel('允许学生主动请求辅助代码', { exact: true })).toHaveCount(0);
  await teacher.getByRole('button', { name: '创建并发布', exact: true }).click();
  await teacher.getByRole('link').filter({ has: teacher.getByRole('heading', { name: '[内部验收] 固定提交与人工反馈', level: 2, exact: true }) }).click();
  const taskPath = new URL(teacher.url()).pathname;
  stage = 'student-fixed-submission';
  await student.goto(taskPath);
  await student.getByLabel('一次性粘贴代码', { exact: true }).fill('export function search(items: string[], query: string) { return query ? items.filter(x => x.includes(query)) : []; }');
  await student.getByRole('button', { name: '准备固定快照', exact: true }).click();
  await expect(student.getByRole('heading', { name: '已保存的固定快照', exact: true })).toBeVisible();
  await expect(student.getByRole('heading', { name: '先做私人自查（可选）', exact: true })).toHaveCount(0);
  await expect(student.getByText('仓库读取授权（与模型外发授权分开）', { exact: true })).toHaveCount(0);
  await student.screenshot({ path: path.join(output, 'student-local-snapshot.png') });
  await student.getByLabel(/确认提交到/).check();
  await student.getByRole('button', { name: '确认正式提交', exact: true }).click();
  await expect(student.getByRole('heading', { name: /· V1$/ })).toBeVisible();
  const submissionPath = new URL(student.url()).pathname;
  stage = 'teacher-source-and-feedback';
  await teacher.goto(submissionPath);
  await expect(teacher.getByRole('heading', { name: '正式 AI 辅助评阅', exact: true })).toHaveCount(0);
  await expect(teacher.getByLabel('采用的本次正式 AI 报告')).toHaveCount(0);
  await teacher.getByRole('button', { name: /^solution\.ts ·/ }).click();
  await expect(teacher.locator('.evidence-pane')).toContainText('export function search');
  await teacher.getByRole('button', { name: '关闭源码', exact: true }).click();
  const feedback = '[内部验收] 已核对固定源码，空查询返回空数组不符合本次目标；本条不是实际教师评阅结果。';
  await teacher.getByLabel('本次教师反馈', { exact: true }).fill(feedback);
  await teacher.getByRole('button', { name: '保存新评价草稿', exact: true }).click();
  stage = 'publication-boundary';
  await student.reload();
  await expect(student.getByText(feedback, { exact: true })).toHaveCount(0);
  await teacher.getByRole('button', { name: '确认发布此评价', exact: true }).click();
  await student.reload();
  await expect(student.getByText(feedback, { exact: true })).toBeVisible();
  for (const [name, page] of [['teacher', teacher], ['student', student]] as const) {
    await page.evaluate(() => scrollTo(0, 0));
    const noOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
    assert(noOverflow);
    await page.screenshot({ path: path.join(output, `${name}.png`) });
    receipt.pages.push({ role: name, width: page.viewportSize()?.width, noOverflow });
  }
  const session = await (await teacherContext.request.get('/api/v1/session')).json();
  assert.equal(session.workspace, 'teacher-trial');
  stage = 'disabled-model-and-cookie';
  const modelAttempt = await teacherContext.request.put('/api/v2/model-settings', {
    headers: { Origin: origin, 'X-CSRF-Token': session.csrf },
    data: { vendor: 'deepseek', model: 'not-enabled', apiKey: 'synthetic-denied-value-only' },
  });
  assert.equal(modelAttempt.status(), 403);
  assert.equal((await modelAttempt.json()).error.code, 'TEACHER_TRIAL_RESTRICTED');
  await teacher.getByRole('button', { name: '退出登录', exact: true }).filter({ visible: true }).click();
  await expect(teacher.getByLabel('邮箱', { exact: true })).toBeVisible();
  const cookies = await teacherContext.cookies();
  assert.equal(cookies.find(c => c.name === 'sid')?.value, 'unrelated-original-cookie-sentinel');
  assert(!cookies.some(c => c.name === 'codelab_teacher_trial_sid'));
  const zeroTables = ['user_model_settings', 'course_repository_connections', 'source_model_calls', 'course_analyses', 'runs', 'analysis_attempts', 'source_projects'];
  stage = 'database-and-sample-invariants';
  receipt.sensitiveAndExecutionTables = {};
  for (const table of zeroTables) {
    const count: number = Number((await db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n);
    assert.equal(count, 0, table);
    receipt.sensitiveAndExecutionTables[table] = count;
  }
  assert.deepEqual((await db.query('SELECT content_hash FROM course_snapshots WHERE id=$1', [initial.snapshot_id])).rows, originalSample.rows);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM course_evaluations WHERE submission_id=$1', [status.fixture.submissionId])).rows[0].n, 0);
  stage = 'supplied-accounts-readonly';
  for (const role of ['teacher', 'student'] as const) {
    const context = await browser.newContext({ baseURL: origin, reducedMotion: 'reduce', viewport: role === 'teacher' ? { width: 1440, height: 900 } : { width: 390, height: 844 } });
    const page = await context.newPage();
    page.on('pageerror', error => receipt.pageErrors.push(error.name));
    await login(page, role, secrets[role]);
    const list = await (await context.request.get('/api/v2/assignments')).json();
    assert.equal(list.items.length, 1);
    assert.equal(list.items[0].id, status.fixture.assignmentId);
    await expect(page.getByRole('heading', { name: '[非敏感合成样例] 搜索函数人工评阅', exact: true })).toBeVisible();
    await page.screenshot({ path: path.join(output, `supplied-${role}.png`) });
    if (role === 'student') {
      await page.setViewportSize({ width: 320, height: 844 });
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await page.screenshot({ path: path.join(output, 'supplied-student-320.png') });
    }
    await context.close();
  }
  assert.deepEqual(receipt.pageErrors, []);
  receipt.internalSubmissionPath = submissionPath;
  receipt.originalTrialSampleUnchanged = true;
  receipt.cookieIsolation = true;
  receipt.suppliedAccountsOnlySeeTheirOriginalSample = true;
  receipt.trialOnlyNavigationAndLocalControls = true;
  receipt.passed = true;
  await teacherContext.close();
  await studentContext.close();
} catch (error) {
  receipt.failedStage = stage;
  receipt.errorType = error instanceof Error ? error.name : 'Unknown';
  const failureCode = (error as { code?: unknown })?.code;
  if (typeof failureCode === 'string' && /^[A-Z0-9_]{1,64}$/.test(failureCode)) receipt.failureCode = failureCode;
  receipt.error = error instanceof assert.AssertionError ? error.message.slice(0, 160) : 'TEACHER_TRIAL_BROWSER_VERIFICATION_FAILED';
  for (const { name, page } of diagnosticPages) {
    if (await page.locator('.workspace').count().catch(() => 0))
      await page.screenshot({ path: path.join(output, `failed-${name}.png`) }).catch(() => {});
  }
  process.exitCode = 1;
} finally {
  await browser.close();
  await db?.close();
  receipt.finishedAt = new Date().toISOString();
  await writeFile(path.join(output, 'result.json'), JSON.stringify(receipt, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ passed: receipt.passed, stage: receipt.failedStage, error: receipt.error, evidence: path.relative(root, output), secondComputerVerified: false, teacherEvaluationCompleted: false }));
}
