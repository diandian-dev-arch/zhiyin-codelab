import { chromium, expect, request, type Page } from "@playwright/test";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { root } from "../apps/api/src/template.js";
import { createHash, randomUUID } from 'node:crypto';
import { connectDesktopDatabase } from './desktop-database.js';

const baseURL = "http://127.0.0.1:5174";
const { loginPassword } = JSON.parse(await readFile(path.join(root, ".data/business-v2/development-credentials.json"), "utf8"));
const output = path.join(root, "output/workspace-verification", new Date().toISOString().replace(/[:.]/g, "-"));
await mkdir(output, { recursive: true });
const record = process.argv.includes('--record');
const resumeArg = process.argv.find(arg=>arg.startsWith('--resume-task='));
const reviewArg = process.argv.find(arg=>arg.startsWith('--review-task='));
const reviewOnly=!!reviewArg;
const resumeTaskId=(resumeArg??reviewArg)?.split('=')[1];
if ((resumeArg&&reviewArg)||process.argv.slice(2).some(arg => arg !== '--record' && arg !== resumeArg && arg !== reviewArg) || (resumeTaskId&&!/^[0-9a-f-]{36}$/.test(resumeTaskId))) throw new Error('UNSUPPORTED_ARGUMENT');
let resumedRuns: {id:string;status:string;publications:string}[]=[];
let resumedTitle='';
if(resumeTaskId){
  const db=await connectDesktopDatabase();
  try{
    resumedTitle=(await db.query('SELECT title FROM tasks WHERE id=$1',[resumeTaskId])).rows[0]?.title;
    expect(resumedTitle).toMatch(/^团队样本实际验收 /);
    resumedRuns=(await db.query("SELECT r.id,r.status,(SELECT count(*) FROM publications p WHERE p.run_id=r.id) AS publications FROM runs r JOIN submissions s ON s.id=r.submission_id WHERE s.task_id=$1 ORDER BY r.created_at",[resumeTaskId])).rows;
    expect(resumedRuns).toHaveLength(reviewOnly?7:3);expect(resumedRuns.slice(0,6).every(r=>r.status==='completed')).toBe(true);expect(Number(resumedRuns[0].publications)).toBe(1);
    if(reviewOnly)expect(resumedRuns[6].status).toBe('build_error');
  }finally{await db.close();}
}
const privateVideoDir = path.join(root, '.data/workspace-video', randomUUID());
const chapters: Record<string, {start:number;end:number;caption:string}[]> = {teacher: [], student: []};
const auth = {teacher: await request.newContext({baseURL}), student: await request.newContext({baseURL})};
// Log in before creating recorded pages; credentials and the login form never enter the video.
for (const role of ['teacher','student'] as const) {
  const response = await auth[role].post('/api/v1/session/login', {headers: {origin: baseURL},
    data: {email: `${role}@codelab.local`, password: loginPassword}});
  expect(response.status()).toBe(200);
}
const browser = await chromium.launch({ channel: "chrome", headless: true });
const videoOption = record ? {recordVideo: {dir: privateVideoDir, size: {width:1440,height:1000}}} : {};
const teacherContext = await browser.newContext({ baseURL, viewport: { width: 1440, height: 1000 }, storageState: await auth.teacher.storageState(), ...videoOption });
const studentContext = await browser.newContext({ baseURL, viewport: { width: 1440, height: 1000 }, storageState: await auth.student.storageState(), ...videoOption });
const began = Date.now();
const teacher = await teacherContext.newPage(), student = await studentContext.newPage();
const videos = {teacher: teacher.video(), student: student.video()};
const errors: string[] = [];
const blockedModelWrites: string[] = [];
for (const context of [teacherContext, studentContext]) await context.route('**/api/**', async route => {
  const req = route.request(), pathname = new URL(req.url()).pathname;
  if ((reviewOnly&&!['GET','HEAD'].includes(req.method()))||(req.method() === 'POST' && (pathname.endsWith('/model-settings/test') || /\/analyses$/.test(pathname)
    || /^\/api\/v2\/projects/.test(pathname)
    || (/\/submissions\/[^/]+\/runs$/.test(pathname) && req.postDataJSON()?.personalAnalysisMode !== 'off')))) {
    blockedModelWrites.push(pathname); await route.abort();
  } else await route.continue();
});
for (const page of [teacher, student]) page.on("pageerror", (error) => errors.push(error.message));
const result: Record<string,any> = {source:'constructed_execution', state:'running', recorded:record, createdRunIds:[],
  initialAnalysisMode:'off', externalModelCalls:0, pageErrors: errors, blockedModelWrites,
  resumedTaskId:resumeTaskId??null,reviewOnly,replayedRunIds:resumedRuns.map(r=>r.id),recordingScope:reviewOnly?'Read-only tour of seven existing real executions; creates no runs or publications.':resumeTaskId?'Replay existing first three runs; execute the next four on the same task. Original interrupted recording retained.':'New task and seven actual executions'};
async function checkpoint(){await writeFile(path.join(output,'progress.json'),JSON.stringify({...result,chapters},null,2));}
async function mark(page:Page, caption:string) {
  const role = page === teacher ? 'teacher' : 'student';
  console.log(JSON.stringify({stage:caption, role}));
  const start=(Date.now()-began)/1000;
  if (record) await page.waitForTimeout(2500);
  chapters[role].push({start,end:(Date.now()-began)/1000,caption});
  await checkpoint();
}
async function startCheck() {
  await expect(student.getByLabel('检查后的 AI 分析')).toHaveValue('off');
  const response = student.waitForResponse(r => /\/submissions\/[^/]+\/runs$/.test(new URL(r.url()).pathname) && r.request().method()==='POST');
  await student.getByRole('button',{name:'创建检查',exact:true}).click();
  const received = await response;
  expect(received.status()).toBe(202);
  const body = await received.json();
  result.createdRunIds.push(body.runId);
  await checkpoint();
  await expect(student.getByLabel('检查后的 AI 分析')).toHaveValue('off');
}
async function openComparison() {
  const details=teacher.locator('details.comparison');
  await details.locator('summary').click();
  await expect(details).toHaveAttribute('open','');
  await details.scrollIntoViewIfNeeded();
}
async function login(page: Page, _role: string) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "实训任务", exact: true })).toBeVisible();
}
try {
  await login(teacher, "teacher");
  const title = resumedTitle || `团队样本实际验收 ${new Date().toLocaleString("zh-CN")}`;
  if(!resumeTaskId){
  await teacher.getByRole("button", { name: "创建任务", exact: true }).click();
  await teacher.getByLabel("任务名称").fill(title);
  await teacher.getByLabel("任务说明").fill("constructed_execution：五项核心行为与人工可读性的完整工程走查，验证真实网页操作与团队样本执行，不代表真实课程评测。");
  await teacher.locator("form").getByRole("button", { name: "创建任务", exact: true }).click();
  await teacher.getByRole("link", { name: title, exact: true }).click();
  await teacher.getByText("选择验收包并发布新规则", { exact: true }).click();
  await teacher.getByLabel("我已确认以上要求与本次课程任务一致").check();
  await teacher.getByRole("button", { name: "发布新规则", exact: true }).click();
  await expect(teacher.getByRole("status")).toContainText("新规则已发布");
  }else await teacher.goto('/tasks/'+resumeTaskId);
  const taskUrl = teacher.url();
  result.taskUrl=taskUrl;
  await mark(teacher,reviewOnly?'只读导览：同一任务的七次真实结果，不重新执行或发布':resumeTaskId?'接续同一任务：回看已创建并发布的规则，前三次检查不重复执行':'教师创建并发布本轮构造样本验收任务');
  await login(student, "student");
  await student.getByRole("link", { name: title, exact: true }).click();
  if(!resumeTaskId){
  await student.getByLabel("项目 ZIP").setInputFiles(path.join(root, "fixtures/correct.zip"));
  await student.getByRole("button", { name: "保存提交", exact: true }).click();
  await expect(student.getByRole("status")).toContainText("提交已保存");
  await mark(student,'保存正确样本，默认仅基础检查，不调用个人或平台模型');
  await startCheck();
  await expect(student.getByRole("link", { name: "进度与反馈", exact: true })).toBeVisible();
  await student.getByRole("link", { name: "进度与反馈", exact: true }).click();
  await student.waitForURL(/\/runs\/[0-9a-f-]+$/);
  }else await student.goto('/runs/'+resumedRuns[0].id);
  const runUrl = student.url();
  result.runUrl=runUrl;
  if(!resumeTaskId) await expect(student.getByText("教师尚未发布反馈，请稍后查看。", { exact: true })).toBeVisible();
  await teacher.goto(runUrl);
  await expect(teacher.getByRole("navigation", { name: "验收条目" })).toBeVisible({ timeout: 120000 });
  await expect(teacher.getByRole("heading", { name: "NEW-01 · 原始检查：满足要求", exact: true })).toBeVisible();
  await mark(teacher,resumeTaskId?'回看首轮已发布的正确报告，保留原教师反馈和证据':'真实Docker检查完成，教师查看原始证据并编写反馈');
  if(!resumeTaskId){
  await teacher.getByLabel("建议的下一步").fill("团队样本实际执行已验证新增行为。后续修改请保持新增数量和标题一致；人工可读性仍需课程教师判断。");
  await teacher.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(teacher.getByRole("status")).toContainText("修改已保存");
  const count = await teacher.getByRole("navigation", { name: "验收条目" }).getByRole("button").count();
  for (let index = 0; index < count; index++) {
    await teacher.getByRole("navigation", { name: "验收条目" }).getByRole("button").nth(index).click();
    await teacher.getByRole("button", { name: "确认本条内容", exact: true }).click();
    await expect(teacher.getByRole("button", { name: "本条已确认", exact: true })).toBeDisabled();
  }
  await teacher.screenshot({ path: path.join(output, "teacher-confirmed.png"), fullPage: true });
  await teacher.getByRole("button", { name: `发布报告 ${count}/${count}`, exact: true }).click();
  await expect(teacher.getByRole("status")).toContainText("报告已发布");
  await mark(teacher,'六项反馈确认后发布；人工确认不改写机器事实');
  }
  await student.reload();
  await expect(student.getByRole("navigation", { name: "验收条目" })).toBeVisible();
  await student.getByRole("button", { name: "NEW-01 · 截图", exact: true }).click();
  await expect(student.getByAltText("当前报告的运行截图")).toBeVisible();
  await student.getByAltText('当前报告的运行截图').scrollIntoViewIfNeeded();
  await mark(student,'学生读取已发布反馈与实际运行截图');
  await student.screenshot({ path: path.join(output, "student-evidence.png"), fullPage: true });
  await student.setViewportSize({ width: 390, height: 844 });
  await student.screenshot({ path: path.join(output, "student-mobile.png"), fullPage: true });
  expect(await student.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await student.setViewportSize({ width: 1440, height: 1000 });
  if(!resumeTaskId){
  await student.getByRole("link", { name: "返回任务" }).click();
  await student.getByLabel("项目 ZIP").setInputFiles(path.join(root, "fixtures/create-missing.zip"));
  await student.getByRole("button", { name: "保存提交", exact: true }).click();
  await expect(student.getByRole("status")).toContainText("提交已保存");
  await startCheck();
  await expect(student.getByRole("status")).toContainText("已进入检查队列");
  await student.locator(".v2-submission").first().getByRole("link", { name: "进度与反馈", exact: true }).click();
  await student.waitForURL(/\/runs\/[0-9a-f-]+$/);
  }else await student.goto('/runs/'+resumedRuns[1].id);
  const resubmissionUrl = student.url();
  await teacher.goto(resubmissionUrl);
  await expect(teacher.getByRole("navigation", { name: "验收条目" })).toBeVisible({ timeout: 120000 });
  await openComparison();
  await expect(teacher.getByRole('row').filter({has:teacher.getByRole('cell',{name:'NEW-01',exact:true})}).getByRole("cell", { name: "出现回归", exact: true })).toBeVisible();
  await mark(teacher,(resumeTaskId?'回看第二次检查：':'')+'新增功能出现回归；与上次同条件检查对比');
  await teacher.screenshot({ path: path.join(output, "resubmission-regression.png"), fullPage: true });
  // The actual API remains teacher-only; a Vue route itself is not authorization evidence.
  const comparisonApi = await student.request.get("/api/v2" + new URL(resubmissionUrl).pathname + "/comparison");
  expect(comparisonApi.status()).toBe(404);
  await student.goto(runUrl);
  await expect(student.getByRole("navigation", { name: "验收条目" })).toBeVisible();
  await expect(student.getByRole("heading", { name: "NEW-01 · 原始检查：满足要求", exact: true })).toBeVisible();
  if(!resumeTaskId){
  await student.getByRole("link", { name: "返回任务" }).click();
  await student.getByLabel("项目 ZIP").setInputFiles(path.join(root, "fixtures/correct.zip"));
  await student.getByRole("button", { name: "保存提交", exact: true }).click();
  await expect(student.getByRole("status")).toContainText("提交已保存");
  await startCheck();
  await expect(student.getByRole("status")).toContainText("已进入检查队列");
  await student.locator(".v2-submission").first().getByRole("link", { name: "进度与反馈", exact: true }).click();
  await student.waitForURL(/\/runs\/[0-9a-f-]+$/);
  }else await student.goto('/runs/'+resumedRuns[2].id);
  const repairedRunUrl = student.url();
  await teacher.goto(repairedRunUrl);
  await expect(teacher.getByRole("navigation", { name: "验收条目" })).toBeVisible({ timeout: 120000 });
  await openComparison();
  await expect(teacher.getByRole('row').filter({has:teacher.getByRole('cell',{name:'NEW-01',exact:true})}).getByRole("cell", { name: "已修复", exact: true })).toBeVisible();
  await mark(teacher,(resumeTaskId?'回看第三次检查：':'')+'再次提交正确版本，新增功能确认修复');
  await teacher.screenshot({ path: path.join(output, "resubmission-repaired.png"), fullPage: true });
  const filterRuns: string[] = [];
  for (const [sample, change] of [["filter-defect", "出现回归"], ["fixed-with-regression", "已修复"]]) {
    if(!reviewOnly){
    await student.goto(taskUrl);
    await student.getByLabel("项目 ZIP").setInputFiles(path.join(root, `fixtures/${sample}.zip`));
    await student.getByRole("button", { name: "保存提交", exact: true }).click();
    await expect(student.getByRole("status")).toContainText("提交已保存");
    await startCheck();
    await expect(student.getByRole("status")).toContainText("已进入检查队列");
    await student.locator(".v2-submission").first().getByRole("link", { name: "进度与反馈", exact: true }).click();
    await student.waitForURL(/\/runs\/[0-9a-f-]+$/);
    }else await student.goto('/runs/'+resumedRuns[sample==='filter-defect'?3:4].id);
    filterRuns.push(student.url());
    await teacher.goto(student.url());
    await expect(teacher.getByRole("navigation", { name: "验收条目" })).toBeVisible({ timeout: 120000 });
    await openComparison();
    const row = teacher.getByRole("row").filter({ has: teacher.getByRole("cell", { name: "FILTER-03", exact: true }) });
    await expect(row.getByRole("cell", { name: change, exact: true })).toBeVisible();
    if (sample === "fixed-with-regression") {
      const persistence = teacher.getByRole("row").filter({ has: teacher.getByRole("cell", { name: "SAVE-01", exact: true }) });
      await expect(persistence.getByRole("cell", { name: "出现回归", exact: true })).toBeVisible();
      await persistence.scrollIntoViewIfNeeded();
    }
    await row.scrollIntoViewIfNeeded();
    await mark(teacher,(reviewOnly?'回看实际结果：':'')+(sample === 'fixed-with-regression' ? '筛选已修复，但刷新保存出现回归；全部启用案例重新检查' : '提交筛选缺陷样本，真实观察筛选回归'));
    await teacher.screenshot({ path: path.join(output, `filter-${sample}.png`), fullPage: true });
  }
  if(!reviewOnly){await teacher.goto(taskUrl);
  await teacher.getByText("选择验收包并发布新规则", { exact: true }).click();
  await teacher.getByLabel("我已确认以上要求与本次课程任务一致").check();
  await teacher.getByRole("button", { name: "发布新规则", exact: true }).click();
  await expect(teacher.getByRole("status")).toContainText("新规则已发布");
  await student.goto(taskUrl);
  await student.getByLabel("项目 ZIP").setInputFiles(path.join(root, "fixtures/correct.zip"));
  await student.getByRole("button", { name: "保存提交", exact: true }).click();
  await expect(student.getByRole("status")).toContainText("提交已保存");
  await startCheck();
  await expect(student.getByRole("status")).toContainText("已进入检查队列");
  await student.locator(".v2-submission").first().getByRole("link", { name: "进度与反馈", exact: true }).click();
  await student.waitForURL(/\/runs\/[0-9a-f-]+$/);
  }else await student.goto('/runs/'+resumedRuns[5].id);
  await teacher.goto(student.url());
  await expect(teacher.getByRole("navigation", { name: "验收条目" })).toBeVisible({ timeout: 120000 });
  await openComparison();
  await expect(teacher.getByText(/两次检查的规则、案例或实测环境不能确认一致/)).toBeVisible();
  await expect(teacher.locator(".comparison table")).toHaveCount(0);
  await teacher.screenshot({ path: path.join(output, "rule-incompatible.png"), fullPage: true });
  await mark(teacher,'规则版本变化，不混用修复或回归标签');
  if(!reviewOnly){
  await student.goto(taskUrl);
  await student.getByLabel('项目 ZIP').setInputFiles(path.join(root,'fixtures/build-error.zip'));
  await student.getByRole('button',{name:'保存提交',exact:true}).click();
  await expect(student.getByRole('status')).toContainText('提交已保存');
  await startCheck();
  await expect(student.getByRole('status')).toContainText('已进入检查队列');
  await student.locator('.v2-submission').first().getByRole('link',{name:'进度与反馈',exact:true}).click();
  await student.waitForURL(/\/runs\/[0-9a-f-]+$/);
  }else await student.goto('/runs/'+resumedRuns[6].id);
  result.buildErrorRunUrl=student.url();
  await teacher.goto(student.url());
  await expect(teacher.getByRole('navigation',{name:'验收条目'})).toBeVisible({timeout:120000});
  await expect(teacher.getByRole('heading',{name:'NEW-01 · 原始检查：未完成检查',exact:true})).toBeVisible();
  await teacher.getByRole('heading',{name:'NEW-01 · 原始检查：未完成检查',exact:true}).scrollIntoViewIfNeeded();
  await mark(teacher,'构建失败保留构建记录，案例显示未完成检查而非功能通过');
  await teacher.screenshot({path:path.join(output,'build-error.png'),fullPage:true});
  await student.goto(runUrl);
  await expect(student.getByRole("heading", { name: "NEW-01 · 原始检查：满足要求", exact: true })).toBeVisible();
  await mark(student,'所有新提交及规则变化之后，最早发布的正确报告仍可阅读');
  expect(errors).toEqual([]);
  expect(blockedModelWrites).toEqual([]);
  const db=await connectDesktopDatabase();
  try {
    const runs=(await db.query('SELECT r.id,r.status,r.execution_config FROM runs r JOIN submissions s ON s.id=r.submission_id WHERE s.task_id=$1 ORDER BY r.created_at',[new URL(taskUrl).pathname.split('/').at(-1)])).rows;
    expect(runs).toHaveLength(7);
    expect(runs.every(r=>r.execution_config.initialAnalysisMode==='off' && !r.execution_config.initialModel)).toBe(true);
    result.taskRunIds=runs.map(r=>r.id);
    result.createdRunIds=result.taskRunIds.filter((id:string)=>!resumedRuns.some(r=>r.id===id));
    const attempts=(await db.query('SELECT count(*) AS total FROM analysis_attempts WHERE run_id=ANY($1::uuid[])',[result.taskRunIds])).rows[0];
    expect(Number(attempts.total)).toBe(0);
    result.modelAnalysisAttempts=0;
    result.runStatuses=runs.map(r=>({id:r.id,status:r.status}));
    const owners=(await db.query('SELECT id,run_id,owner_phase,cleanup_state FROM execution_attempts WHERE run_id=ANY($1::uuid[])',[result.taskRunIds])).rows;
    expect(owners.every(o=>o.owner_phase==='closed'&&o.cleanup_state==='clean')).toBe(true);
    result.executionOwners=owners;
  } finally {await db.close();}
  Object.assign(result,{state:'passed',resubmissionUrl,repairedRunUrl,checks:["teacher-create", "publish-rule", "student-upload", "real-worker-execution", "save-feedback", "confirm-items", "publish", "student-evidence", "mobile-overflow", "resubmission-regression", "resubmission-repaired", "student-comparison-denied", "old-publication-preserved", "no-page-errors", "default-off-no-model-attempts", "filter-repaired-save-regressed", "rule-incompatible", "build-error-not-run"]});
  if(resumeTaskId){result.preexistingChecks=['teacher-create','publish-rule','save-feedback','confirm-items','publish'];if(reviewOnly)result.preexistingChecks.push('student-upload','real-worker-execution');result.checks=result.checks.filter((c:string)=>!result.preexistingChecks.includes(c));}
  await writeFile(path.join(output, "filter-comparison.json"), JSON.stringify({ source: "constructed_execution", filterRuns, state: "passed", ruleMismatch: "incompatible-without-change-labels", originalPublication: "readable-after-rule-change" }, null, 2));
  console.log(JSON.stringify({ state: "passed", taskUrl, runUrl, output }));
} catch (error) {
  Object.assign(result,{state:'failed',error:error instanceof Error ? error.message : 'UI_CHECK_FAILED'});
  await checkpoint();
  await teacher.screenshot({ path: path.join(output, "failure-teacher.png"), fullPage: true });
  await student.screenshot({ path: path.join(output, "failure-student.png"), fullPage: true });
  throw error;
} finally {
  await teacherContext.close();await studentContext.close();
  result.videos=[];
  try{if(record) for(const role of ['teacher','student'] as const) {
    const filename=`${role}.webm`;await videos[role]!.saveAs(path.join(output,filename));
    const bytes=await readFile(path.join(output,filename));
    result.videos.push({role,filename,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),chapters:chapters[role]});
  }}catch(error){result.recordingError=error instanceof Error?error.message:'VIDEO_SAVE_FAILED';result.state='failed';process.exitCode=1;}
  await browser.close();
  result.finishedAt=new Date().toISOString();
  await writeFile(path.join(output,'result.json'),JSON.stringify(result,null,2));
  await auth.teacher.dispose();await auth.student.dispose();
  console.log(JSON.stringify({state:result.state,output,createdRunIds:result.createdRunIds}));
}
