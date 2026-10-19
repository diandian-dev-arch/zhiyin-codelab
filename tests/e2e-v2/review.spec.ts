import { test, expect, type Page } from "@playwright/test";
import { readFile } from 'node:fs/promises';
import { unzipSync } from 'fflate';
import { createHash, randomUUID } from 'node:crypto';
// These tests exercise actual UI/API/database/artifact reads with ui_fixture observations.
// They do not execute a submitted Vue application or satisfy the real T05/T06 gate.
const runPath = "/runs/00000000-0000-4000-8000-000000000003";
test('evidence timeout allows explicit retry without losing teacher input', async ({ page }) => {
  await login(page, 'teacher');
  await page.clock.install();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let attempts = 0;
  await page.route('**/api/v2/runs/*/evidence/*', async route => {
    attempts++;
    if (attempts === 1) {
      await gate;
      await route.fulfill({status:200,contentType:'text/plain',body:'late obsolete evidence'}).catch(() => {});
    } else await route.continue();
  });
  try {
    await page.goto(runPath);
    await expect(page.getByText('正在读取运行证据…', {exact:true})).toBeVisible();
    await page.getByLabel('建议的下一步').fill('超时期间保留的教师草稿');
    await page.clock.fastForward(15001);
    await expect(page.getByRole('alert').filter({hasText:'证据读取超时'})).toBeVisible();
    expect(attempts).toBe(1);
    await page.getByRole('button',{name:'重试读取证据',exact:true}).click();
    await expect(page.locator('.v2-evidence')).toBeVisible();
    release();
    await page.clock.fastForward(1000);
    await expect(page.locator('.v2-evidence')).not.toContainText('late obsolete evidence');
    await expect(page.getByLabel('建议的下一步')).toHaveValue('超时期间保留的教师草稿');
    await expect(page.getByRole('button',{name:'重试读取证据',exact:true})).toHaveCount(0);
    expect(attempts).toBe(2);
  } finally { release(); }
});
async function login(page: Page, role: "teacher" | "student") {
  await page.goto("/");
  await page.getByLabel("邮箱").fill(`${role}@codelab.local`);
  await page
    .getByLabel("密码", { exact: true })
    .fill("Browser-test-only-2904!");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "实训任务", exact: true }),
  ).toBeVisible();
}
async function selectItem(page: Page, title: string) {
  await page
    .getByRole("navigation", { name: "验收条目" })
    .getByRole("button")
    .filter({ hasText: title })
    .click();
}
async function confirmItem(page: Page) {
  await page.getByRole("button", { name: "确认本条内容", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "本条已确认", exact: true }),
  ).toBeDisabled();
}
test("separate facts, judgment, confirmation, publication and historical correction in the browser", async ({
  page,
  browser,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const studentContext = await browser.newContext({
    baseURL: String(test.info().project.use.baseURL),
    viewport: { width: 1440, height: 1000 },
  });
  const student = await studentContext.newPage();
  student.on("pageerror", (error) => errors.push(error.message));
  await login(student, "student");
  await expect(student.locator('.task-progress')).toContainText('等待教师反馈');
  await expect(student.getByLabel('当前验收范围')).toContainText('2 个自动检查案例');
  await expect(student.getByLabel('当前验收范围')).toContainText('人工判断');
  await expect(student.getByRole('link',{name:/阅读已发布反馈/})).toHaveCount(0);
  await student.getByRole('group',{name:'按待办筛选',exact:true}).getByRole('button',{name:/^有已发布反馈/}).click();
  await expect(student.getByText('当前条件下没有已发布反馈。可进入任务查看检查进度。',{exact:true})).toBeVisible();
  await student.getByRole('button',{name:'清除筛选',exact:true}).click();
  await student.goto(runPath);
  await expect(
    student.getByText("教师尚未发布反馈，请稍后查看。"),
  ).toBeVisible();
  await expect(
    student.getByRole("navigation", { name: "验收条目" }),
  ).toHaveCount(0);
  await login(page, "teacher");
  await expect(page.getByRole('button',{name:/待复核的最新提交/})).toContainText('1份');
  await page.locator('.review-queue > summary').click();
  await expect(page.getByRole('link',{name:'复核此提交',exact:true})).toHaveAttribute('href',runPath);
  await page.getByRole('group',{name:'按待办筛选',exact:true}).getByRole('button',{name:/^待我复核/}).click();
  await expect(page.locator('.task-card')).toHaveCount(1);
  await page.getByText("任务管理看板", { exact: true }).click();
  await page.getByRole("link", { name: "查看报告", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "验收报告复核", exact: true }),
  ).toBeVisible();
  // Two browser sessions edit the same revision. The losing editor must retain
  // their draft and be able to read the winner without overwriting it.
  const otherContext = await browser.newContext({baseURL:String(test.info().project.use.baseURL)});
  const otherTeacher = await otherContext.newPage();
  await login(otherTeacher,'teacher');await otherTeacher.goto(runPath);
  await page.getByLabel('建议的下一步').fill('ui_fixture：本地冲突草稿需要保留');
  // Losing the session must not unmount the editor or silently save after login.
  await page.context().clearCookies();
  await page.getByRole('button',{name:'保存修改',exact:true}).click();
  const expired=page.getByRole('region',{name:'重新登录并保留草稿'});
  await expect(expired).toBeVisible();
  await expect(page.getByRole('region',{name:'发布前待办'})).toContainText('请先在本页重新登录');
  await expect(page.getByRole('region',{name:'发布前待办'})).toContainText('反馈有未保存的修改');
  await expect(page.getByLabel('建议的下一步')).toHaveValue('ui_fixture：本地冲突草稿需要保留');
  const expiredDownload=page.waitForEvent('download');
  await expired.getByRole('button',{name:'下载当前未保存草稿',exact:true}).click();
  const expiredDraftPath=await (await expiredDownload).path();
  const expiredDraft=JSON.parse(await readFile(expiredDraftPath!,'utf8'));
  expect(expiredDraft.feedback.some((item:any)=>item.nextStep==='ui_fixture：本地冲突草稿需要保留')).toBe(true);
  await expired.getByLabel('当前账号密码').fill('wrong-fixture-password');
  await expired.getByRole('button',{name:'重新登录并继续编辑',exact:true}).click();
  await expect(expired.getByLabel('当前账号密码')).toHaveValue('');
  await expect(expired).toBeVisible();
  await expired.getByLabel('当前账号密码').fill('Browser-test-only-2904!');
  await expired.getByRole('button',{name:'重新登录并继续编辑',exact:true}).click();
  await expect(expired).toHaveCount(0);
  await expect(page.getByLabel('建议的下一步')).toHaveValue('ui_fixture：本地冲突草稿需要保留');
  await expect(page.getByRole('button',{name:'保存修改',exact:true})).toBeEnabled();
  const leaveDialog = page.waitForEvent('dialog');
  const leaveClick = page.getByRole('link', {name:'← 返回任务',exact:true}).click();
  const warning = await leaveDialog;
  expect(warning.message()).toContain('未保存');
  await warning.dismiss();
  await leaveClick;
  await expect(page).toHaveURL(new RegExp(runPath + '$'));
  await expect(page.getByLabel('建议的下一步')).toHaveValue('ui_fixture：本地冲突草稿需要保留');
  await otherTeacher.getByLabel('建议的下一步').fill('ui_fixture：另一窗口已保存的新内容');
  let releaseSave!: () => void;
  const saveGate = new Promise<void>(resolve => { releaseSave = resolve; });
  let observedSave!: () => void;
  const saveReceived = new Promise<void>(resolve => { observedSave = resolve; });
  await otherTeacher.route('**/api/v2/runs/*/review', async route => {
    if (route.request().method() !== 'PUT') return route.continue();
    observedSave();
    await saveGate;
    await route.continue();
  });
  await otherTeacher.getByRole('button',{name:'保存修改',exact:true}).click();
  await saveReceived;
  try {
    await expect(otherTeacher.getByLabel('建议的下一步')).toBeDisabled();
    await expect(otherTeacher.getByLabel('事实与观察')).toBeDisabled();
    await otherTeacher.getByText('补充教师判断（保留原始检查）',{exact:true}).click();
    for (const control of await otherTeacher.locator('.feedback-edit-fields select').all())
      await expect(control).toBeDisabled();
  } finally { releaseSave(); }
  await expect(otherTeacher.getByRole('status').filter({hasText:'修改已保存'})).toBeVisible();
  await expect(otherTeacher.getByLabel('建议的下一步')).toBeEnabled();
  await expect(otherTeacher.getByLabel('建议的下一步')).toHaveValue('ui_fixture：另一窗口已保存的新内容');
  // This editor has no conflict backups or dirty feedback: only evidence choices changed.
  await otherTeacher.getByText(/随报告公开的证据/).click();
  const publicEvidence = otherTeacher.locator('input[type="checkbox"]').last();
  const wasChecked = await publicEvidence.isChecked();
  await publicEvidence.setChecked(!wasChecked);
  let logoutRequests = 0;
  otherTeacher.on('request', request => {
    if (request.url().endsWith('/session/logout')) logoutRequests++;
  });
  const logoutWarning = otherTeacher.waitForEvent('dialog');
  const logoutClick = otherTeacher.getByRole('button',{name:'退出登录',exact:true}).filter({visible:true}).click();
  await (await logoutWarning).dismiss();
  await logoutClick;
  expect(logoutRequests).toBe(0);
  await expect(publicEvidence).toBeChecked({checked:!wasChecked});
  await publicEvidence.setChecked(wasChecked);
  await otherTeacher.getByRole('link',{name:'← 返回任务',exact:true}).click();
  await expect(otherTeacher).toHaveURL(/\/tasks\//);
  await otherTeacher.getByRole('button',{name:'退出登录',exact:true}).filter({visible:true}).click();
  await expect(otherTeacher.getByRole('button',{name:'登录',exact:true})).toBeVisible();
  expect(logoutRequests).toBe(1);
  await page.getByRole('button',{name:'保存修改',exact:true}).click();
  await expect(page.getByRole('region',{name:'修订冲突处理'})).toBeVisible();
  await expect(page.getByLabel('建议的下一步')).toHaveValue('ui_fixture：本地冲突草稿需要保留');
  await page.getByRole('button',{name:'保留草稿并载入最新修订',exact:true}).click();
  await expect(page.getByLabel('建议的下一步')).toHaveValue('ui_fixture：另一窗口已保存的新内容');
  const backup = page.getByRole('region',{name:'保留的本地草稿'});
  await backup.locator('summary').click();
  await expect(backup).toContainText('ui_fixture：本地冲突草稿需要保留');
  const backupDownloadEvent=page.waitForEvent('download');
  await backup.getByRole('button',{name:'下载此草稿副本',exact:true}).click();
  const backupDownload=await backupDownloadEvent;
  const backupData=JSON.parse(await readFile((await backupDownload.path())!,'utf8'));
  expect(backupData.feedback.some((f:any)=>f.nextStep==='ui_fixture：本地冲突草稿需要保留')).toBe(true);
  await page.screenshot({path:info.outputPath('teacher-conflict-recovered.png'),fullPage:true});
  await backup.locator('summary').click();
  await otherContext.close();
  await page.locator(".analysis-drawer > summary").click();
  await page.getByLabel('分析方式', { exact: true }).selectOption('summary');
  const firstAnalysisResponse = page.waitForResponse(r => r.url().endsWith('/analyses') && r.request().method() === 'POST');
  await page.getByRole("button",{name:"重新分析存档",exact:true}).click();
  const firstAnalysis = (await (await firstAnalysisResponse).json()).analysis;
  expect(firstAnalysis.strategy).toBe('summary');
  await expect(page.getByText("重新分析已排队，当前报告仍可复核。",{exact:true})).toBeVisible();
  await expect(page.getByRole("button",{name:"重新分析存档",exact:true})).toBeDisabled();
  await page.getByLabel("建议的下一步").fill("ui_fixture：取消分析时保留未保存编辑");
  await page.getByRole("button",{name:"取消分析",exact:true}).click();
  await expect(page.getByText("分析已取消；已领取的资源会继续清理，当前报告保持不变。",{exact:true})).toBeVisible();
  await expect(page.getByLabel("建议的下一步")).toHaveValue("ui_fixture：取消分析时保留未保存编辑");
  const refreshWarning = page.waitForEvent('dialog');
  const refreshing = page.reload();
  const refreshDialog = await refreshWarning;
  expect(refreshDialog.type()).toBe('beforeunload');
  await refreshDialog.accept();
  await refreshing;
  // Refresh now retains browser recovery data; explicitly discard this test's draft.
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button',{name:'删除本机草稿副本',exact:true}).click();
  await page.locator(".analysis-drawer > summary").click();
  await expect(page.getByRole("button",{name:"重新分析存档",exact:true})).toBeEnabled();
  await page.getByLabel('对照已有分析（可选）', { exact: true }).selectOption(firstAnalysis.analysisAttemptId);
  const pairedResponse = page.waitForResponse(r => r.url().endsWith('/analyses') && r.request().method() === 'POST');
  await page.getByRole('button', { name: '重新分析存档', exact: true }).click();
  const paired = (await (await pairedResponse).json()).analysis;
  expect(paired.strategy).toBe('agent');
  expect(paired.pairedWithAnalysisId).toBe(firstAnalysis.analysisAttemptId);
  await page.getByRole('button', { name: '取消分析', exact: true }).click();
  await page.getByText(/查看分析记录/).click();
  await expect(page.locator('.analysis-records')).toContainText('一次性总结 · 已取消');
  await expect(page.locator('.analysis-records')).toContainText(`对照 ${firstAnalysis.analysisAttemptId.slice(0, 8)}`);
  await page.clock.install();
  let exportRequests=0,exportReady=false,releaseExport!:()=>void;
  const exportGate=new Promise<void>(resolve=>releaseExport=resolve);
  const exports:string[]=[];page.on('download',file=>exports.push(file.suggestedFilename()));
  await page.route('**/api/v2/runs/*/analyses/*/export',async route=>{
    exportRequests++;
    if(exportRequests===1){
      const response=await route.fetch();expect(response.ok()).toBe(true);
      exportReady=true;await exportGate;await route.fulfill({response}).catch(()=>{});
    }else await route.continue();
  });
  await page.getByRole('button',{name:'下载配对材料',exact:true}).click();
  await expect.poll(()=>exportReady).toBe(true);
  await page.clock.fastForward(60001);
  await expect(page.getByRole('alert')).toContainText('下载等待超过60秒');
  expect(exportRequests).toBe(1);expect(exports).toEqual([]);
  await expect(page.getByRole('button',{name:'下载配对材料',exact:true})).toBeEnabled();
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载配对材料', exact: true }).click();
  const download = await downloadEvent;
  releaseExport();await page.clock.fastForward(100);
  await page.unroute('**/api/v2/runs/*/analyses/*/export');
  expect(exportRequests).toBe(2);expect(exports).toEqual([download.suggestedFilename()]);
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(download.suggestedFilename()).toBe(`codelab-pair-${paired.analysisAttemptId}.zip`);
  const files = unzipSync(await readFile((await download.path())!));
  const material = JSON.parse(Buffer.from(files['evaluation-materials.json']).toString());
  expect(material.ledgerReady).toBe(false);
  expect(material.arms.map((a: any) => a.analysisStatus)).toEqual(['cancelled', 'cancelled']);
  for (const file of JSON.parse(Buffer.from(files['manifest.json']).toString()).files)
    expect(createHash('sha256').update(files[file.path]).digest('hex')).toBe(file.sha256);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'output/e2e-v2/pair-export-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: 'output/e2e-v2/pair-export-desktop.png', fullPage: true });
  await confirmItem(page);
  await page
    .getByLabel("建议的下一步")
    .fill("ui_fixture：教师补充说明，请保留新增行为并复核命名。");
  await expect(
    page.getByText("有未保存的修改，请先保存，再确认与发布。"),
  ).toBeVisible();
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "确认本条内容", exact: true }),
  ).toBeEnabled();
  await confirmItem(page);
  await selectItem(page, "筛选任务");
  await expect(page.getByRole('region',{name:'发布前待办'})).toContainText('请逐项确认：筛选任务、人工可读性');
  // Reopening starts at the first remaining confirmation, not the first tab.
  const resumedReview=await page.context().newPage();
  await resumedReview.goto(runPath);
  await expect(resumedReview.getByRole('heading',{name:'FILTER-03 · 原始检查：未完成检查',exact:true})).toBeVisible();
  await selectItem(resumedReview,'新增任务');
  await resumedReview.getByRole('button',{name:'刷新报告',exact:true}).click();
  await expect(resumedReview.getByRole('button',{name:'本条已确认',exact:true})).toBeVisible();
  await resumedReview.close();
  await expect(
    page.getByRole("heading", {
      name: "FILTER-03 · 原始检查：未完成检查",
      exact: true,
    }),
  ).toBeVisible();
  await page.getByText("补充教师判断（保留原始检查）", { exact: true }).click();
  await page.getByRole('combobox', {name:"FILTER-03 的教师判断",exact:true}).selectOption("failed");
  await page
    .getByLabel("判断理由", { exact: true })
    .fill("ui_fixture：教师独立复现后，发现已完成筛选仍显示未完成任务。");
  await page
    .getByLabel("核实记录", { exact: true })
    .fill("ui_fixture：人工准备完成A和未完成B，切换到已完成，仍看到B。");
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(
    page.getByRole("heading", {
      name: "FILTER-03 · 原始检查：未完成检查",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("navigation", { name: "验收条目" })
      .getByRole("button")
      .filter({ hasText: "筛选任务" }),
  ).toContainText("未满足");
  await confirmItem(page);
  await selectItem(page, "人工可读性");
  const judgmentDetails = page
    .locator("details")
    .filter({ has: page.locator("summary", { hasText: "补充教师判断" }) });
  if ((await judgmentDetails.getAttribute("open")) === null)
    await page
      .getByText("补充教师判断（保留原始检查）", { exact: true })
      .click();
  await page.getByRole('combobox', {name:"readability 的教师判断",exact:true}).selectOption("passed");
  await page
    .getByLabel("判断理由", { exact: true })
    .fill("ui_fixture：模块命名清楚，职责划分可以理解。");
  await page
    .getByRole("combobox", { name: "核实方式", exact: true })
    .selectOption("other_documented");
  await page
    .getByLabel("核实记录", { exact: true })
    .fill(
      "ui_fixture：教师阅读项目说明并逐项核对组件命名。此记录仅验证人工判断交互。",
    );
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await confirmItem(page);
  await page.screenshot({
    path: info.outputPath("teacher-confirmed.png"),
    fullPage: true,
  });
  await expect(page.getByRole('region',{name:'发布前待办'})).toContainText('当前页面已满足操作条件');
  const confirmedReview=await page.context().newPage();
  await confirmedReview.goto(runPath);
  await expect(confirmedReview.getByRole('heading',{name:'FILTER-03 · 原始检查：未完成检查',exact:true})).toBeVisible();
  await expect(confirmedReview.getByRole('button',{name:'本条已确认',exact:true})).toBeVisible();
  await confirmedReview.close();
  await page.getByRole("button", { name: "发布报告 3/3", exact: true }).click();
  await expect(page.getByRole("status").filter({hasText: "报告已发布，版本 1"})).toBeVisible();
  const afterPublishTasks = (await (await page.request.get('/api/v2/tasks')).json()).items;
  expect(afterPublishTasks.find((t:any)=>t.title==='任务管理看板').overview.pendingReviewCount).toBe(0);
  // Earlier reload cleared conflict copies; correction reason alone must warn.
  await page.reload();
  await expect(page.getByRole('region',{name:'发布前待办'})).toContainText('请填写更正原因');
  await page.getByLabel('更正原因',{exact:true}).fill('ui_fixture：尚未提交的更正说明');
  const reasonWarning = page.waitForEvent('dialog');
  const reasonLeave = page.getByRole('link',{name:'← 返回任务',exact:true}).click();
  await (await reasonWarning).dismiss();
  await reasonLeave;
  await expect(page.getByLabel('更正原因',{exact:true})).toHaveValue('ui_fixture：尚未提交的更正说明');
  await page.getByLabel('更正原因',{exact:true}).fill('');
  await expect(
    page.getByRole("button", { name: "保存修改", exact: true }),
  ).toHaveCount(0);
  const firstPublication = await page
    .getByRole("link", { name: "查看已发布版本 1", exact: true })
    .getAttribute("href");
  expect(firstPublication).toBeTruthy();
  // Stay on the waiting page: a teacher publication must appear without navigation.
  await expect(
    student.getByRole("navigation", { name: "验收条目" }),
  ).toBeVisible();
  await expect(
    student.getByRole("button", { name: "保存修改", exact: true }),
  ).toHaveCount(0);
  await student
    .getByRole("button", { name: "NEW-01 · 文字证据", exact: true })
    .click();
  await expect(student.locator(".v2-evidence pre")).toContainText("不代表实际执行结果");
  // A published student snapshot must remain readable when its evidence endpoint
  // fails, and retry must keep using publication-scoped access (never draft URLs).
  const studentSnapshotResponse = await student.request.get(`/api/v2${firstPublication}`);
  expect(studentSnapshotResponse.status()).toBe(200);
  const studentSnapshotBefore = await studentSnapshotResponse.json();
  expect(studentSnapshotBefore.publication.publicationId).toBe(firstPublication!.split('/').at(-1));
  let failStudentEvidence = true;
  let studentEvidenceReads = 0;
  await student.route('**/api/v2/publications/*/evidence/*', async route => {
    studentEvidenceReads++;
    if (failStudentEvidence) return route.fulfill({status:503,json:{error:{message:'fixture unavailable'}}});
    return route.continue();
  });
  await student.getByRole('button',{name:'NEW-01 · 文字证据',exact:true}).click();
  await expect(student.getByRole('alert').filter({hasText:'证据暂不可用'})).toBeVisible();
  await expect(student.getByRole('navigation',{name:'验收条目'})).toBeVisible();
  await expect(student.locator('.v2-evidence')).toHaveCount(0);
  failStudentEvidence = false;
  await student.getByRole('button',{name:'重试读取证据',exact:true}).click();
  await expect(student.locator('.v2-evidence pre')).toContainText('不代表实际执行结果');
  expect(studentEvidenceReads).toBe(2);
  await expect(student.getByRole('button',{name:'保存修改',exact:true})).toHaveCount(0);
  const studentSnapshotAfter = await student.request.get(`/api/v2${firstPublication}`);
  expect(studentSnapshotAfter.status()).toBe(200);
  expect(await studentSnapshotAfter.json()).toEqual(studentSnapshotBefore);
  await student.unroute('**/api/v2/publications/*/evidence/*');
  await student.setViewportSize({ width: 390, height: 844 });
  await student.screenshot({
    path: info.outputPath("student-published-mobile.png"),
    fullPage: true,
  });
  expect(
    await student.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await student.setViewportSize({ width: 1440, height: 1000 });
  await student.getByRole("link", { name: "返回任务" }).click();
  await student.getByLabel("项目 ZIP").setInputFiles("fixtures/correct.zip");
  await student.getByRole("button", { name: "保存提交", exact: true }).click();
  await expect(student.getByRole("status").filter({hasText: "执行服务尚未开放，提交已保留"})).toBeVisible();
  await expect(
    student.getByRole("button", { name: "创建检查", exact: true }),
  ).toHaveCount(0);
  await expect(student.locator(".v2-submission")).toHaveCount(2);
  await student.goto('/');
  await expect(student.locator('.task-progress')).toContainText('提交已保存，尚未创建检查');
  await expect(student.getByRole('link',{name:/阅读已发布反馈/})).toContainText('前次提交');
  await student.getByRole('group',{name:'按待办筛选',exact:true}).getByRole('button',{name:/^有已发布反馈/}).click();
  await expect(student.locator('.task-card')).toHaveCount(1);
  const afterResubmitTasks = (await (await page.request.get('/api/v2/tasks')).json()).items;
  expect(afterResubmitTasks.find((t:any)=>t.title==='任务管理看板').overview.pendingReviews).toEqual([]);
  await expect(student.getByRole('link',{name:/阅读已发布反馈/})).toHaveAttribute('href',firstPublication!);
  await student.getByRole('link',{name:/阅读已发布反馈/}).click();
  await expect(student).toHaveURL(new RegExp(firstPublication! + '$'));
  // A newer submission must not prohibit a labelled correction of the old publication.
  await page
    .getByLabel("更正原因", { exact: true })
    .fill("ui_fixture：补充原报告的下一步说明，不更改学生的新提交。");
  await page
    .getByRole("button", { name: "从已发布版本建立更正草稿", exact: true })
    .click();
  await expect(page.getByRole("status").filter({hasText: "已基于已发布版本创建更正草稿"})).toBeVisible();
  await selectItem(page, "新增任务");
  await page
    .getByLabel("建议的下一步")
    .fill("ui_fixture 历史更正：新增行为保持不变，补充边界条件说明。");
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await confirmItem(page);
  for (const title of ["筛选任务", "人工可读性"]) {
    await selectItem(page, title);
    await confirmItem(page);
  }
  await page
    .getByRole("button", { name: "发布更正报告 3/3", exact: true })
    .click();
  await expect(page.getByRole("status").filter({hasText: "报告已发布，版本 2"})).toBeVisible();
  await expect(
    page.getByRole("button", { name: "从已发布版本建立更正草稿", exact: true }),
  ).toBeVisible();
  await student.goto(firstPublication!);
  await expect(
    student.getByText("ui_fixture：教师补充说明，请保留新增行为并复核命名。", {
      exact: true,
    }),
  ).toBeVisible();
  await student
    .getByRole("link", { name: "查看后续更正版本", exact: true })
    .click();
  await expect(
    student.getByText(
      "ui_fixture 历史更正：新增行为保持不变，补充边界条件说明。",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    student.getByRole("button", { name: "保存修改", exact: true }),
  ).toHaveCount(0);
  const comparisonPanel=student.locator('.publication-comparison');
  await comparisonPanel.locator('summary').first().click();
  await comparisonPanel.getByLabel('基准发布版本').selectOption(firstPublication!.split('/').at(-1)!);
  await comparisonPanel.getByRole('button',{name:'比较这两个版本',exact:true}).click();
  await expect(comparisonPanel.getByRole('region',{name:'发布版本差异'})).toBeVisible();
  await expect(comparisonPanel).toContainText('这两份报告属于同一次提交');
  await comparisonPanel.locator('.feedback-pair').filter({hasText:'create'}).locator('summary').click();
  await expect(comparisonPanel.locator('.feedback-pair').filter({hasText:'create'}).locator('.feedback-columns')).toContainText('ui_fixture 历史更正');
  await expect(comparisonPanel.getByRole('link',{name:/基准/})).toHaveAttribute('href',firstPublication!);
  await student.setViewportSize({width:390,height:844});
  expect(await student.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await student.screenshot({path:info.outputPath('student-publication-comparison-mobile.png'),fullPage:true});
  // UI paging/retry uses intercepted option summaries; comparison still reads the real publication.
  const currentPublicationId=new URL(student.url()).pathname.split('/').at(-1)!;
  const realOptions=await (await student.request.get(`/api/v2/publications/${currentPublicationId}/comparison-options`)).json();
  const realPrior=realOptions.items.find((item:any)=>item.publicationId===firstPublication!.split('/').at(-1));
  expect(realPrior).toBeTruthy();
  const olderOptions=Array.from({length:50},()=>({...realPrior,publicationId:randomUUID()}));
  let failNextPage=true;
  await student.route('**/api/v2/publications/*/comparison-options*',async route=>{
    const after=new URL(route.request().url()).searchParams.get('after');
    if(after && failNextPage){failNextPage=false;return route.fulfill({status:503,json:{error:{code:'FIXTURE_UNAVAILABLE',message:'ui_fixture 版本列表暂不可用'}}});}
    return route.fulfill({json:after?{items:[olderOptions[49],realPrior],nextCursor:null}:{items:olderOptions,nextCursor:olderOptions[49].publicationId}});
  });
  await student.reload();
  await comparisonPanel.locator('summary').first().click();
  await expect(comparisonPanel.getByLabel('基准发布版本').locator('option')).toHaveCount(51);
  await comparisonPanel.getByRole('button',{name:'加载更早的发布版本'}).click();
  await expect(comparisonPanel.getByRole('alert')).toBeVisible();
  await comparisonPanel.getByRole('button',{name:'加载更早的发布版本'}).click();
  await expect(comparisonPanel.getByLabel('基准发布版本').locator('option')).toHaveCount(52);
  await expect(comparisonPanel.getByRole('button',{name:'加载更早的发布版本'})).toHaveCount(0);
  await comparisonPanel.getByLabel('基准发布版本').selectOption(realPrior.publicationId);
  await comparisonPanel.getByRole('button',{name:'比较这两个版本',exact:true}).click();
  await expect(comparisonPanel.getByRole('region',{name:'发布版本差异'})).toBeVisible();
  // Hold a real comparison response while navigating back to the original report.
  // Only delivery timing is intercepted; report and comparison bodies come from the API.
  await student.unroute('**/api/v2/publications/*/comparison-options*');
  // Exercise real option/comparison reads with only their first delivery held.
  // Recovery must keep the selected baseline, issue no writes, and reject late errors.
  await student.clock.install();
  const comparisonWrites:string[]=[];
  student.on('request',request=>{
    if(request.url().includes('/api/v2/') && request.method()!=='GET') comparisonWrites.push(request.url());
  });
  for(const kind of ['comparison-options','comparison'] as const){
    const pattern=kind==='comparison-options'
      ? `**/api/v2/publications/${currentPublicationId}/comparison-options*`
      : `**/api/v2/publications/${currentPublicationId}/comparison?*`;
    let attempts=0,ready=false,release!:()=>void;
    const gate=new Promise<void>(resolve=>release=resolve);
    await student.route(pattern,async route=>{
      attempts++;
      if(attempts===1){
        const response=await route.fetch();expect(response.ok()).toBe(true);
        ready=true;await gate;
        await route.fulfill({status:503,json:{error:{message:'late obsolete comparison error'}}}).catch(()=>{});
      }else await route.continue();
    });
    try{
      if(kind==='comparison-options'){
        await student.reload();await comparisonPanel.locator('summary').first().click();
      }else{
        await comparisonPanel.getByLabel('基准发布版本').selectOption(realPrior.publicationId);
        await comparisonPanel.getByRole('button',{name:'比较这两个版本',exact:true}).click();
      }
      await expect.poll(()=>ready).toBe(true);
      await student.clock.fastForward(15001);
      await expect(comparisonPanel.getByRole('alert')).toContainText('读取等待超过15秒');
      expect(attempts).toBe(1);
      const retry=kind==='comparison-options'?'重试读取版本':'比较这两个版本';
      await expect(comparisonPanel.getByRole('button',{name:retry,exact:true})).toBeEnabled();
      await comparisonPanel.getByRole('button',{name:retry,exact:true}).click();
      await expect(comparisonPanel.getByRole('alert')).toHaveCount(0);
      if(kind==='comparison-options') await expect(comparisonPanel.getByLabel('基准发布版本').locator('option')).toHaveCount(realOptions.items.length+1);
      else{
        await expect(comparisonPanel.getByRole('region',{name:'发布版本差异'})).toBeVisible();
        await expect(comparisonPanel.getByLabel('基准发布版本')).toHaveValue(realPrior.publicationId);
        await expect(comparisonPanel).toContainText('这两份报告属于同一次提交');
      }
      release();await student.clock.fastForward(100);
      await expect(comparisonPanel.getByRole('alert')).toHaveCount(0);
      expect(attempts).toBe(2);
    }finally{release();await student.unroute(pattern);}
  }
  expect(comparisonWrites).toEqual([]);
  let releaseComparison!:()=>void;
  let comparisonStarted!:()=>void;
  let comparisonDelivered!:()=>void;
  const heldComparison=new Promise<void>(resolve=>{releaseComparison=resolve;});
  const startedComparison=new Promise<void>(resolve=>{comparisonStarted=resolve;});
  const deliveredComparison=new Promise<void>(resolve=>{comparisonDelivered=resolve;});
  await student.route(`**/api/v2/publications/${currentPublicationId}/comparison?*`,async route=>{
    const response=await route.fetch();
    comparisonStarted();
    await heldComparison;
    await route.fulfill({response});
    comparisonDelivered();
  });
  await comparisonPanel.getByRole('button',{name:'比较这两个版本',exact:true}).click();
  await startedComparison;
  await expect(comparisonPanel.getByRole('button',{name:'正在比较…',exact:true})).toBeDisabled();
  await student.goBack();
  await expect(student).toHaveURL(new RegExp(firstPublication!+'$'));
  await expect(student.getByRole('link',{name:'查看后续更正版本',exact:true})).toBeVisible();
  releaseComparison();
  await deliveredComparison;
  await expect(student.getByRole('region',{name:'发布版本差异'})).toHaveCount(0);
  await expect(student.getByText('ui_fixture：教师补充说明，请保留新增行为并复核命名。',{exact:true})).toBeVisible();
  expect(errors).toEqual([]);
  await studentContext.close();
});

test("teacher creates a task and explicitly publishes its rule without losing edited choices on refresh", async ({
  page,
}) => {
  await login(page, "teacher");
  await page.getByRole("button", { name: "创建任务", exact: true }).click();
  await page
    .getByLabel("任务名称", { exact: true })
    .fill("ui_fixture 新建任务");
  await page
    .getByLabel("任务说明", { exact: true })
    .fill("ui_fixture：验证创建和规则确认，不执行项目。");
  await page.locator('.task-creation-options > summary').click();
  await page.getByLabel('任务方式', { exact: true }).selectOption('template');
  await page
    .locator("form")
    .filter({ has: page.getByLabel("任务名称", { exact: true }) })
    .getByRole("button", { name: "创建任务并设置验收", exact: true })
    .click();
  await expect(
    page.getByText("等待教师发布规则", { exact: true }),
  ).toBeVisible();
  await page.getByText("选择验收包并发布新规则", { exact: true }).click();
  await page.getByLabel("CK-06 人工可读性", { exact: true }).uncheck();
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(
    page.getByLabel("CK-06 人工可读性", { exact: true }),
  ).not.toBeChecked();
  await page
    .getByLabel("我已确认以上要求与本次课程任务一致", { exact: true })
    .check();
  await page.getByRole("button", { name: "发布新规则", exact: true }).click();
  await expect(page.getByRole("status").filter({hasText: "新规则已发布"})).toBeVisible();
  await expect(page.getByText("当前规则 v1", { exact: true })).toBeVisible();
  const history=page.locator('.rule-history');
  await history.locator('summary').first().click();
  await expect(history).toContainText('已显示全部 1 个规则版本');
  await history.locator('.rule-version summary').click();
  await expect(history).toContainText('新增任务');
  await expect(history).not.toContainText('人工可读性');
  await expect(history).toContainText('发布新版本不会覆盖此记录');
  await expect(page.locator(".requirements .criterion")).toHaveCount(2);
  await expect(page.getByRole('region', {name:'待发布要求预览'}).locator('.criterion')).toHaveCount(2);
});

test("Studio search, responsive navigation and evidence selection keep the current context", async ({ page }) => {
  await login(page, "teacher");
  await page.getByLabel("搜索任务或班级").fill("does-not-exist-studio");
  await expect(page.getByRole("heading", { name: "没有匹配的任务" })).toBeVisible();
  await page.getByRole("button", { name: "清除筛选", exact: true }).click();
  await expect(page.locator(".task-card").first()).toBeVisible();
  await page.goto(runPath);
  // The default follows outstanding work; this test deliberately inspects NEW-01.
  await selectItem(page, "新增任务");
  await expect(page.locator(".v2-evidence pre")).toContainText("模拟新增后数量加一");
  await page.getByRole("button", { name: "放大查看证据" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(page.getByRole("button", { name: "放大查看证据" })).toBeFocused();

  // A slow prior selection must not reappear after the teacher moves to a manual item.
  let release!: () => void;
  let requested!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { requested = resolve; });
  await page.route("**/api/v2/runs/*/evidence/*", async route => {
    requested();
    await pending;
    await route.fulfill({ status: 200, contentType: "text/plain", body: "STALE_EVIDENCE_MUST_NOT_APPEAR" }).catch(() => {});
  });
  await page.getByRole("button", { name: "NEW-01 · 文字证据", exact: true }).click();
  await started;
  await selectItem(page, "人工可读性");
  release();
  await expect(page.locator(".v2-evidence")).toHaveCount(0);
  await expect(page.getByText("STALE_EVIDENCE_MUST_NOT_APPEAR")).toHaveCount(0);
  await page.unrouteAll({ behavior: "wait" });
  await selectItem(page, "筛选任务");
  await expect(page.locator(".v2-evidence pre")).toBeVisible();
  await expect(page.getByRole("button", { name: "FILTER-03 · 文字证据", exact: true })).toHaveAttribute("aria-pressed", "true");
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});
