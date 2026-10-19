// Real local workspace, real Chrome, labeled demonstration records; no model calls.
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
const base = "http://127.0.0.1:5174",
  directory = path.resolve("docs/verification/2026-10-18/coursework");
const resumeAssignment = process.argv[2];
if (resumeAssignment)
  assert.match(resumeAssignment, /^\/assignments\/[0-9a-f-]{36}$/);
const { loginPassword } = JSON.parse(
  await readFile(".data/business-v2/development-credentials.json", "utf8"),
);
const result: any = {
  startedAt: new Date().toISOString(),
  kind: "live-local-workspace-browser",
  externalModelCalls: 0,
  passed: false,
};
const browser = await chromium.launch({ channel: "chrome", headless: true });
const errors: string[] = [];
try {
  await mkdir(directory, { recursive: true });
  const teacher = await browser.newPage({
    baseURL: base,
    viewport: { width: 1440, height: 1000 },
    reducedMotion: "reduce",
  });
  const student = await browser.newPage({
    baseURL: base,
    viewport: { width: 390, height: 844 },
    reducedMotion: "reduce",
  });
  for (const [page, email] of [
    [teacher, "teacher@codelab.local"],
    [student, "student@codelab.local"],
  ] as const) {
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("/");
    await page.getByLabel("邮箱", { exact: true }).fill(email);
    await page.getByLabel("密码", { exact: true }).fill(loginPassword);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page
      .getByRole("heading", { name: "实训任务", exact: true })
      .waitFor();
  }
  let title: string;
  if (resumeAssignment) {
    await teacher.goto(resumeAssignment);
    title = await teacher.getByRole("heading", { level: 1 }).innerText();
    assert(title.startsWith("[升级演示]"), "ONLY_RESUME_LABELED_DEMO");
  } else {
    await teacher.getByRole("link", { name: "课程作业", exact: true }).click();
    await teacher
      .getByRole("button", { name: "创建作业", exact: true })
      .click();
    title = `[升级演示] 固定函数版本 ${new Date().toLocaleTimeString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" })}`;
    await teacher.getByLabel("作业名称", { exact: true }).fill(title);
    await teacher
      .getByLabel("目标与说明", { exact: true })
      .fill("本轮升级工程演示记录，可直接粘贴函数；不调用外部模型。");
    await teacher
      .getByLabel("评价标准（每行一条）", { exact: true })
      .fill("空关键词返回原列表");
    await teacher
      .getByRole("button", { name: "创建并发布", exact: true })
      .click();
    await teacher
      .getByRole("heading", { name: title, exact: true, level: 1 })
      .waitFor();
  }
  result.assignmentPath = new URL(teacher.url()).pathname;
  await teacher
    .getByRole("link")
    .filter({
      has: teacher.getByRole("heading", { name: title, exact: true, level: 2 }),
    })
    .click();
  await teacher.getByRole("heading", { name: title, exact: true }).waitFor();
  result.taskPath = new URL(teacher.url()).pathname;
  await student.goto(result.taskPath);
  await student.getByLabel("文件路径", { exact: true }).fill("src/search.ts");
  await student
    .getByLabel("一次性粘贴代码", { exact: true })
    .fill(
      "export function search(items: string[], q: string) {\n  return q ? items.filter(x => x.includes(q)) : items;\n}",
    );
  await student
    .getByRole("button", { name: "准备固定快照", exact: true })
    .click();
  await student.getByLabel(/确认提交到/).check();
  await student
    .getByRole("button", { name: "确认正式提交", exact: true })
    .click();
  await student.getByRole("heading", { name: /· V1$/ }).waitFor();
  result.submissionPath = new URL(student.url()).pathname;
  await teacher.goto(result.submissionPath);
  await teacher
    .getByLabel("本次教师反馈", { exact: true })
    .fill(
      "升级演示：已核对固定函数源码，后续自行添加边界测试。未运行代码，未调用模型。",
    );
  await teacher
    .getByRole("combobox", { name: "目标达成", exact: true })
    .selectOption("achieved");
  await teacher
    .getByRole("button", { name: "保存新评价草稿", exact: true })
    .click();
  await teacher
    .getByRole("button", { name: "确认发布此评价", exact: true })
    .click();
  await student.reload();
  await student
    .getByText(
      "升级演示：已核对固定函数源码，后续自行添加边界测试。未运行代码，未调用模型。",
      { exact: true },
    )
    .waitFor();
  assert(
    await student.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
    "MOBILE_OVERFLOW",
  );
  for (const page of [student, teacher])
    await page.evaluate(() => {
      (document.activeElement as HTMLElement)?.blur();
      window.scrollTo(0, 0);
    });
  await student.screenshot({
    path: path.join(directory, "workspace-student-mobile.png"),
    fullPage: true,
    animations: "disabled",
  });
  await teacher.screenshot({
    path: path.join(directory, "workspace-teacher-desktop.png"),
    fullPage: true,
    animations: "disabled",
  });
  await teacher.goto(result.assignmentPath);
  await teacher.getByText(/已提交 · 1 已发布评价/).waitFor();
  assert.deepEqual(errors, []);
  result.passed = true;
} catch (error) {
  process.exitCode = 1;
  result.error = "WORKSPACE_BROWSER_CHECK_FAILED";
  result.diagnostic = (error instanceof Error ? error.message : "UNKNOWN_ERROR")
    .split(loginPassword)
    .join("[redacted]")
    .slice(0, 3500);
} finally {
  await browser.close();
  result.finishedAt = new Date().toISOString();
  await writeFile(
    path.join(directory, "workspace-browser.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
}
