// Development demo with real controlled execution and real role-separated UI.
// The current workspace policy decides initial AI analysis; never mock a reply.
import { chromium, expect, request, type Page } from "@playwright/test";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { root } from "../apps/api/src/template.js";

const origin = "http://127.0.0.1:5174";
const resume = process.argv[2];
if (resume && !/^[0-9a-f-]{36}$/.test(resume)) throw Error("INVALID_DEMO_ID");
const id = resume ?? randomUUID();
const output = path.join(root, "output/course-demo", id);
const privateDir = path.join(root, ".data/course-demo", id);
await mkdir(output, { recursive: true });
await mkdir(privateDir, { recursive: true });
const stateFile = path.join(output, "result.json");
const state: any = resume
  ? JSON.parse(await readFile(stateFile, "utf8"))
  : {
      id,
      source: "constructed_execution",
      createdAt: new Date().toISOString(),
      state: "recording",
      segments: [],
      sample: "filter-defect.zip",
      taskUrl: null,
      runUrl: null,
    };
const save = () => writeFile(stateFile, JSON.stringify(state, null, 2));
const credentials = JSON.parse(
  await readFile(
    path.join(root, ".data/business-v2/development-credentials.json"),
    "utf8",
  ),
);
const teacherAuth = await request.newContext({ baseURL: origin });
const studentAuth = await request.newContext({ baseURL: origin });
for (const [role, auth] of [
  ["teacher", teacherAuth],
  ["student", studentAuth],
] as const) {
  const response = await auth.post("/api/v1/session/login", {
    headers: { origin },
    data: {
      email: `${role}@codelab.local`,
      password: credentials.loginPassword,
    },
  });
  expect(response.status()).toBe(200);
}
const browser = await chromium.launch({ channel: "chrome", headless: true });
const errors: string[] = [];
const stamp = (seconds: number) =>
  new Date(Math.round(seconds * 1000)).toISOString().slice(11, 23);
async function segment(
  name: string,
  role: "teacher" | "student",
  action: (
    page: Page,
    hold: (caption: string, seconds?: number) => Promise<void>,
  ) => Promise<void>,
) {
  if (
    state.segments.some((s: any) => s.name === name && s.state === "passed") &&
    !(
      name === "04-student-report" &&
      process.argv.includes("--rerecord-student")
    )
  )
    return;
  const attempt = state.segments.filter((s: any) => s.name === name).length + 1;
  const basename = `${name}-${attempt}`;
  const context = await browser.newContext({
    baseURL: origin,
    storageState: await (
      role === "teacher" ? teacherAuth : studentAuth
    ).storageState(),
    viewport: { width: 1440, height: 1000 },
    recordVideo: { dir: privateDir, size: { width: 1440, height: 1000 } },
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  const video = page.video()!;
  const began = Date.now();
  const chapters: any[] = [];
  const hold = async (caption: string, seconds = 4) => {
    const start = (Date.now() - began) / 1000;
    await page.waitForTimeout(seconds * 1000);
    chapters.push({ start, end: (Date.now() - began) / 1000, caption });
  };
  let passed = false;
  console.log(JSON.stringify({ stage: name, state: "started", id }));
  try {
    await action(page, hold);
    passed = true;
  } finally {
    await page
      .screenshot({ path: path.join(output, `${basename}.png`) })
      .catch(() => {});
    await context.close();
    const filename = `${basename}.webm`;
    await video.saveAs(path.join(output, filename));
    const bytes = await readFile(path.join(output, filename));
    await writeFile(
      path.join(output, `${basename}.vtt`),
      "WEBVTT\n\n" +
        chapters
          .map(
            (c, i) =>
              `${i + 1}\n${stamp(c.start)} --> ${stamp(c.end)}\n${c.caption}\n`,
          )
          .join("\n"),
    );
    state.segments.push({
      name,
      role,
      state: passed ? "passed" : "failed",
      filename,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      chapters,
    });
    await save();
  }
}
try {
  await segment("01-teacher-task", "teacher", async (page, hold) => {
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "实训任务", exact: true }),
    ).toBeVisible();
    const title = `实训流程录像 · 构造筛选缺陷 ${id.slice(0, 8)}`;
    if (!state.taskUrl) {
      await page.getByRole("button", { name: "创建任务", exact: true }).click();
      await page.getByLabel("任务名称").fill(title);
      await page
        .getByLabel("任务说明")
        .fill(
          "constructed_execution：团队构造筛选缺陷样本，真实执行与教师/学生流程录像；不是课程试点或独立教师评价。",
        );
      await page
        .locator("form")
        .getByRole("button", { name: "创建任务", exact: true })
        .click();
      await page.getByRole("heading", { name: title, exact: true }).click();
      await page.waitForURL(/\/tasks\/[0-9a-f-]+$/);
      state.taskUrl = page.url();
      await save();
    } else await page.goto(state.taskUrl);
    await hold(
      "教师创建本次实训任务。本片使用团队构造的筛选缺陷样本，不是真实课程试点评测。",
    );
    const detail = await (
      await teacherAuth.get("/api/v2" + new URL(state.taskUrl).pathname)
    ).json();
    if (!detail.currentRule) {
      await page.getByText("选择验收包并发布新规则", { exact: true }).click();
      await page.getByLabel("我已确认以上要求与本次课程任务一致").check();
      await page
        .getByRole("button", { name: "发布新规则", exact: true })
        .click();
      await expect(page.getByRole("status")).toContainText("新规则已发布");
    }
    await hold("教师确认验收要求并发布规则。学生提交绑定当前规则版本。");
  });
  await segment("02-student-submit", "student", async (page, hold) => {
    await page.goto(state.taskUrl);
    if (!state.runUrl) {
      await page
        .getByLabel("项目 ZIP")
        .setInputFiles(path.join(root, `fixtures/${state.sample}`));
      await hold(
        "学生上传 filter-defect.zip。课程执行限已登记的受控任务包，与普通源码分析入口分开。",
      );
      await page.getByRole("button", { name: "保存提交", exact: true }).click();
      await expect(page.getByRole("status")).toContainText("提交已保存");
      await page.getByRole("button", { name: "创建检查", exact: true }).click();
      await expect(
        page
          .locator(".v2-submission")
          .first()
          .getByRole("link", { name: "进度与反馈", exact: true }),
      ).toBeVisible();
      await page
        .locator(".v2-submission")
        .first()
        .getByRole("link", { name: "进度与反馈", exact: true })
        .click();
      await page.waitForURL(/\/runs\/[0-9a-f-]+$/);
      state.runUrl = page.url();
      await save();
    } else await page.goto(state.runUrl);
    await expect(
      page.getByText("教师尚未发布反馈，请稍后查看。", { exact: true }),
    ).toBeVisible();
    const denied = await studentAuth.get(
      "/api/v2" + new URL(state.runUrl).pathname + "/review",
    );
    expect(denied.status()).toBe(404);
    state.studentDraftDenied = denied.status();
    await hold("检查已进入真实执行流程。教师发布前，学生不能读取草稿。");
  });
  await segment("03-teacher-review-publish", "teacher", async (page, hold) => {
    await page.goto(state.runUrl);
    const began = Date.now();
    let last = "";
    while (true) {
      const response = await teacherAuth.get(
        "/api/v2" + new URL(state.runUrl).pathname,
      );
      expect(response.status()).toBe(200);
      const run = await response.json();
      const current = `${run.status}/${run.resourceState}/${run.analysis?.status ?? "none"}`;
      if (current !== last) {
        console.log(
          JSON.stringify({
            stage: "actual-execution",
            runId: run.runId,
            state: current,
          }),
        );
        last = current;
      }
      if (run.status === "completed" && run.resourceState === "closed") {
        state.runOutcome = run;
        await save();
        break;
      }
      if (
        ["cancelled", "build_error", "infra_error", "interrupted"].includes(
          run.status,
        )
      )
        throw Error("REAL_EXECUTION_NOT_COMPLETED");
      if (Date.now() - began > 720000) throw Error("REAL_EXECUTION_WAIT_LIMIT");
      await hold(
        "真实等待：执行器构建项目、进行浏览器检查，随后按当前配置运行 Agent。此段保留实际耗时。",
        5,
      );
    }
    await page.reload();
    await expect(
      page.getByRole("navigation", { name: "验收条目" }),
    ).toBeVisible();
    const review = await (
      await teacherAuth.get(
        "/api/v2" + new URL(state.runUrl).pathname + "/review",
      )
    ).json();
    state.analysisOutcomes =
      review.analyses?.map((a: any) => ({
        id: a.id,
        status: a.status,
        strategy: a.strategy,
      })) ?? [];
    const nav = page.getByRole("navigation", { name: "验收条目" });
    await nav.getByRole("button").filter({ hasText: "筛选" }).click();
    await expect(
      page.getByRole("heading", { name: /FILTER-03 · 原始检查：/ }),
    ).toBeVisible();
    await hold(
      "查看筛选行为的实际检查结果与证据。AI 状态按真实结果展示，未形成建议时仍可复核基础报告。",
      6,
    );
    await page
      .getByLabel("建议的下一步")
      .fill(
        "本次构造样本用于演示筛选缺陷。请根据FILTER-03观察记录检查筛选条件与列表渲染，再提交修复版本进行全量复验。",
      );
    await page.getByRole("button", { name: "保存修改", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("修改已保存");
    const count = await nav.getByRole("button").count();
    for (let index = 0; index < count; index++) {
      await nav.getByRole("button").nth(index).click();
      const confirm = page.getByRole("button", {
        name: "确认本条内容",
        exact: true,
      });
      if (await confirm.count()) await confirm.click();
      await expect(
        page.getByRole("button", { name: "本条已确认", exact: true }),
      ).toBeDisabled();
    }
    await hold("教师逐项复核并确认反馈。确认不会把失败检查改成通过。");
    await page
      .getByRole("button", { name: `发布报告 ${count}/${count}`, exact: true })
      .click();
    await expect(page.getByRole("status")).toContainText("报告已发布");
    state.confirmedCriteria = count;
    await save();
    await hold("教师发布报告。学生获得的是已确认的发布快照。");
  });
  await segment("04-student-report", "student", async (page, hold) => {
    await page.goto(state.runUrl);
    const nav = page.getByRole("navigation", { name: "验收条目" });
    await expect(nav).toBeVisible();
    await nav.getByRole("button").filter({ hasText: "筛选" }).click();
    await expect(
      page.getByText(
        "本次构造样本用于演示筛选缺陷。请根据FILTER-03观察记录检查筛选条件与列表渲染，再提交修复版本进行全量复验。",
        { exact: true },
      ),
    ).toBeVisible();
    await hold("学生现在可以查看教师反馈，按源码和检查证据定位问题。", 6);
    const screenshot = page.getByRole("button", {
      name: "FILTER-03 · 截图",
      exact: true,
    });
    await screenshot.click();
    await expect(page.getByAltText("当前报告的运行截图")).toBeVisible();
    await page.getByAltText("当前报告的运行截图").scrollIntoViewIfNeeded();
    await hold(
      "打开实际运行截图。下次提交将产生新报告，已发布快照继续保留。",
      6,
    );
  });
  const publishedResponse = await teacherAuth.get(
    "/api/v2" + new URL(state.runUrl).pathname,
  );
  expect(publishedResponse.status()).toBe(200);
  state.publishedRun = await publishedResponse.json();
  expect(state.publishedRun.report.latestPublication).not.toBeNull();
  expect(errors).toEqual([]);
  state.browserErrors = errors;
  state.state = "passed";
  delete state.failure;
  state.finishedAt = new Date().toISOString();
  state.limitations = [
    "Team constructed sample and generated development accounts; not independent teacher evaluation",
    "Four workflow steps across separate recordings; earlier interrupted recordings retained, including actual execution wait",
    "Real configured Agent outcome; this run degraded without usable model advice",
    "No audio narration",
  ];
  await save();
  console.log(
    JSON.stringify({
      state: "passed",
      directory: path.relative(root, output),
      taskUrl: state.taskUrl,
      runUrl: state.runUrl,
      analysisOutcomes: state.analysisOutcomes,
    }),
  );
} catch (error) {
  state.state = "failed";
  state.browserErrors = errors;
  state.failure = error instanceof Error ? error.message : "DEMO_FAILED";
  await save();
  throw error;
} finally {
  await browser.close();
  await teacherAuth.dispose();
  await studentAuth.dispose();
}
