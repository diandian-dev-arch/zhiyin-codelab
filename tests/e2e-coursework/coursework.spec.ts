import type { Page } from "@playwright/test";
import { test, expect } from "@playwright/test";
import { zipSync, strToU8 } from "fflate";
const password = "Browser-test-only-2904!";
test.afterEach(async ({ page }) => {
  if (await page.locator('.workspace').count()) {
    await expect(page.locator('main')).toHaveCount(1);
    await expect(page.locator('#main-content')).toHaveCount(1);
  }
});
async function login(page: Page, email: string) {
  await page.goto("/");
  await page.getByLabel("邮箱", { exact: true }).fill(email);
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "实训任务", exact: true }),
  ).toBeVisible();
}
test("private and formal citations open the fixed source line without replacing the prepared snapshot", async ({
  page: teacher,
  browser,
}, info) => {
  await teacher.setViewportSize({ width: 1800, height: 1000 });
  await login(teacher, "teacher@codelab.local");
  await teacher.getByRole("link", { name: "课程作业", exact: true }).click();
  await expect(teacher.locator('.course-page')).toBeVisible();
  await expect(teacher.locator('main')).toHaveCount(1);
  await teacher.getByRole("button", { name: "创建作业", exact: true }).click();
  await teacher
    .getByLabel("作业名称", { exact: true })
    .fill("固定快照引用定位");
  await teacher
    .getByLabel("目标与说明", { exact: true })
    .fill("核对固定版本，不运行代码。");
  await teacher
    .getByLabel("评价标准（每行一条）", { exact: true })
    .fill("保留输入");
  await teacher
    .getByRole("button", { name: "创建并发布", exact: true })
    .click();
  await teacher
    .getByRole("link")
    .filter({
      has: teacher.getByRole("heading", {
        name: "固定快照引用定位",
        level: 2,
        exact: true,
      }),
    })
    .click();
  const taskPath = new URL(teacher.url()).pathname;
  const context = await browser.newContext({
    baseURL: info.project.use.baseURL,
    viewport: { width: 390, height: 844 },
  });
  try {
    const student = await context.newPage();
    await login(student, "student@codelab.local");
    await student.goto(taskPath);
    await student
      .getByLabel("文件路径", { exact: true })
      .fill("src/version.ts");
    const prepare = async (value: string) => {
      await student
        .getByLabel("一次性粘贴代码", { exact: true })
        .fill(
          `export function identity(value: string) {\n  return '${value}' + value;\n}\n`,
        );
      const response = student.waitForResponse(
        (r) =>
          new URL(r.url()).pathname === "/api/v2/imports" &&
          r.request().method() === "POST",
      );
      await student
        .getByRole("button", { name: "准备固定快照", exact: true })
        .click();
      const result = await (await response).json();
      expect(result.snapshot_id).toBeTruthy();
      await expect(
        student.getByRole("heading", { name: "已保存的固定快照", exact: true }),
      ).toBeVisible();
      return result.snapshot_id as string;
    };
    const first = await prepare("OLD");
    await student.getByLabel(/同意向上述模型发送当前快照范围内源码/).check();
    await student
      .getByRole("button", { name: "开始 L1 问题与解释", exact: true })
      .click();
    const citation = student.getByRole("button", {
      name: "src/version.ts:2–2",
      exact: true,
    });
    await expect(citation).toBeVisible({ timeout: 15000 });
    await student.getByLabel(/同意向上述接收方发送此自查快照/).check();
    const unchangedRecipient = await student.waitForResponse(
      (r) => new URL(r.url()).pathname === "/api/v2/course-model-recipient",
    );
    await unchangedRecipient.finished();
    await expect(
      student.getByLabel(/同意向上述模型发送当前快照范围内源码/),
    ).toBeChecked();
    await expect(
      student.getByLabel(/同意向上述接收方发送此自查快照/),
    ).toBeChecked();
    const second = await prepare("NEW");
    expect(second).not.toBe(first);
    await expect(
      student.getByLabel(/同意向上述模型发送当前快照范围内源码/),
    ).not.toBeChecked();
    await expect(
      student.getByRole("button", { name: "开始 L1 问题与解释", exact: true }),
    ).toBeDisabled();
    // The selected preparation changed, but the explicitly authorized historical session did not.
    await expect(
      student.getByLabel(/同意向上述接收方发送此自查快照/),
    ).toBeChecked();
    await student.getByLabel(/确认提交到/).check();
    await citation.click();
    const pane = student.getByRole("dialog", { name: "源码引用", exact: true });
    await expect(pane).toBeVisible();
    await expect(pane).toContainText(first);
    await expect(pane.locator("code.highlight")).toContainText("'OLD'");
    await expect(pane).toContainText("引用 L2–2");
    await pane
      .getByRole("button", { name: "查看完整文件", exact: true })
      .click();
    await expect(pane).toContainText("完整文件");
    await pane
      .getByRole("button", { name: "返回引用片段", exact: true })
      .click();
    await expect(pane.locator("code.highlight")).toContainText("'OLD'");
    await student.screenshot({
      path: info.outputPath("private-citation-mobile.png"),
      fullPage: true,
    });
    expect(
      await student.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
    await pane.getByRole("button", { name: "关闭源码", exact: true }).click();
    await expect(citation).toBeFocused();
    // Historical evidence must not reset the explicit submit confirmation or select its snapshot.
    await expect(student.getByLabel(/确认提交到/)).toBeChecked();
    const submitted = student.waitForResponse(
      (r) =>
        /\/course-tasks\/[^/]+\/submissions$/.test(new URL(r.url()).pathname) &&
        r.request().method() === "POST",
    );
    await student
      .getByRole("button", { name: "确认正式提交", exact: true })
      .click();
    expect((await (await submitted).json()).submission.snapshot_id).toBe(
      second,
    );
    await expect(student.getByRole("heading", { name: /· V1$/ })).toBeVisible();
    const submissionPath = new URL(student.url()).pathname;
    await student.getByLabel(/我有权为当前快照授权/).check();
    await student
      .getByRole("button", { name: "授权当前接收方分析本次成果", exact: true })
      .click();
    await teacher.goto(submissionPath);
    await teacher.getByLabel(/确认由本人模型配置承担本次调用/).check();
    await teacher
      .getByRole("button", { name: "使用本人模型发起正式分析", exact: true })
      .click();
    await teacher
      .getByRole("button", { name: "src/version.ts:2–2", exact: true })
      .click({ timeout: 15000 });
    const formal = teacher.getByRole("region", {
      name: "源码引用",
      exact: true,
    });
    await expect(formal).toBeVisible();
    await expect(formal).toContainText(second);
    await expect(formal.locator("code.highlight")).toContainText("'NEW'");
    await teacher.screenshot({
      path: info.outputPath("formal-citation-desktop.png"),
      fullPage: true,
    });
    await formal.getByRole("group", { name: "源码内容", exact: true }).focus();
    await teacher.keyboard.press("Escape");
    await expect(formal).toHaveCount(0);

    // Polling a changed recipient must never carry a previous authorization forward.
    const replaceRecipient = (recipient: any) => ({
      ...recipient,
      hash: "a".repeat(64),
      model: "changed-recipient-requires-confirmation",
    });
    await teacher.route("**/api/v2/course-model-recipient", async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({
        json: { ...body, recipient: replaceRecipient(body.recipient) },
      });
    });
    await student.route(`**/api/v2${taskPath}`, async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({
        json: {
          ...body,
          teacherRecipient: replaceRecipient(body.teacherRecipient),
        },
      });
    });
    await expect(
      teacher.getByText(/changed-recipient-requires-confirmation/),
    ).toBeVisible({ timeout: 10000 });
    await expect(
      teacher.getByLabel(/确认由本人模型配置承担本次调用/),
    ).not.toBeChecked();
    await expect(
      teacher.getByRole("button", {
        name: "使用本人模型发起正式分析",
        exact: true,
      }),
    ).toBeDisabled();
    await expect(
      student.getByText(/changed-recipient-requires-confirmation/),
    ).toBeVisible({ timeout: 10000 });
    await expect(student.getByLabel(/我有权为当前快照授权/)).not.toBeChecked();
    await expect(
      student.getByRole("button", {
        name: "授权当前接收方分析本次成果",
        exact: true,
      }),
    ).toBeDisabled();

    await student.goto(taskPath);
    await student
      .getByRole("button", { name: new RegExp(first.slice(0, 8)) })
      .click();
    const helpConsent = student.getByLabel(/同意向上述接收方发送此自查快照/);
    await helpConsent.check();
    await student
      .getByRole("button", { name: "选择此快照", exact: true })
      .first()
      .click();
    await student.getByLabel(/同意向上述模型发送当前快照范围内源码/).check();
    await student.route("**/api/v2/course-model-recipient", async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({
        json: { ...body, recipient: replaceRecipient(body.recipient) },
      });
    });
    await expect(
      student.getByText(/changed-recipient-requires-confirmation/).first(),
    ).toBeVisible({ timeout: 10000 });
    await expect(
      student.getByLabel(/同意向上述模型发送当前快照范围内源码/),
    ).not.toBeChecked();
    await expect(helpConsent).not.toBeChecked();
    await expect(
      student.getByRole("button", {
        name: "请求 L2 思路与验证提示",
        exact: true,
      }),
    ).toBeDisabled();
  } finally {
    await context.close();
  }
});
test("teacher creates nested tasks; student submits a fixed snippet; teacher publishes feedback; versions and mobile stay usable", async ({
  page: teacher,
  browser,
}, info) => {
  const errors: string[] = [];
  teacher.on("pageerror", (e) => errors.push(e.message));
  await login(teacher, "teacher@codelab.local");
  await teacher.getByRole("link", { name: "课程作业", exact: true }).click();
  await teacher.getByRole("button", { name: "创建作业", exact: true }).click();
  await teacher
    .getByLabel("作业名称", { exact: true })
    .fill("任务化浏览器闭环");
  await teacher
    .getByLabel("首个子任务名称", { exact: true })
    .fill("T1 搜索函数");
  await teacher
    .getByLabel("目标与说明", { exact: true })
    .fill("实现空关键词处理");
  await teacher
    .getByLabel("评价标准（每行一条）", { exact: true })
    .fill("空关键词返回所有项目");
  await teacher
    .locator("summary")
    .filter({ hasText: "起始材料、来源与分析范围" })
    .click();
  await teacher
    .getByLabel("起始材料", { exact: true })
    .fill("先在自己的 IDE 中实现搜索函数。");
  await teacher
    .getByRole("button", { name: "创建并发布", exact: true })
    .click();
  await expect(
    teacher.getByRole("heading", { name: "任务化浏览器闭环", exact: true }),
  ).toBeVisible();
  const assignmentPath = new URL(teacher.url()).pathname;
  await teacher.locator("summary").filter({ hasText: "添加子任务" }).click();
  await teacher.getByLabel("任务名称", { exact: true }).fill("T2 整理结果");
  await teacher
    .getByLabel("目标与说明", { exact: true })
    .fill("在固定前置成果上整理结果");
  await teacher
    .getByLabel("评价标准（每行一条）", { exact: true })
    .fill("保留搜索处理");
  await teacher
    .getByRole("combobox", { name: "前置任务", exact: true })
    .selectOption({ label: "T1 搜索函数" });
  await teacher
    .getByRole("button", { name: "添加子任务", exact: true })
    .click();
  await expect(
    teacher.getByRole("heading", { name: "T2 整理结果", exact: true }),
  ).toBeVisible();
  await teacher
    .getByRole("link")
    .filter({
      has: teacher.getByRole("heading", { name: "T1 搜索函数", exact: true }),
    })
    .click();
  await expect(
    teacher.getByRole("heading", { name: "T1 搜索函数", exact: true }),
  ).toBeVisible();
  const taskPath = new URL(teacher.url()).pathname;
  const context = await browser.newContext({
    baseURL: info.project.use.baseURL,
  });
  try {
    const student = await context.newPage();
    student.on("pageerror", (e) => errors.push(e.message));
    await login(student, "student@codelab.local");
    await student.goto(taskPath);
    await student.locator("summary").filter({ hasText: "起始材料" }).click();
    await expect(
      student.getByText("先在自己的 IDE 中实现搜索函数。", { exact: true }),
    ).toBeVisible();
    await student.getByLabel("文件路径", { exact: true }).fill("src/search.ts");
    await student
      .getByLabel("一次性粘贴代码", { exact: true })
      .fill(
        "export function search(items: string[], q: string) {\n  return items.filter(item => item.includes(q));\n}",
      );
    await student
      .getByRole("button", { name: "准备固定快照", exact: true })
      .click();
    await expect(
      student.getByRole("heading", { name: "已保存的固定快照", exact: true }),
    ).toBeVisible();
    await student.getByLabel(/确认提交到/).check();
    await student
      .getByRole("button", { name: "确认正式提交", exact: true })
      .click();
    await expect(student.getByRole("heading", { name: /· V1$/ })).toBeVisible();
    await expect(
      student.getByText("正式提交已接受", { exact: false }),
    ).toBeVisible();
    const submissionPath = new URL(student.url()).pathname;
    const downloadWait = student.waitForEvent("download");
    await student
      .getByRole("link", { name: "下载本次固定源码 ZIP", exact: true })
      .click();
    expect((await downloadWait).suggestedFilename()).toMatch(/-v1\.zip$/);
    await teacher.goto(submissionPath);
    await teacher
      .getByLabel("本次教师反馈", { exact: true })
      .fill("已人工核对固定版本，建议补充大小写测试。");
    await teacher
      .getByRole("combobox", { name: "目标达成", exact: true })
      .selectOption("achieved");
    await teacher
      .getByRole("button", { name: "保存新评价草稿", exact: true })
      .click();
    await expect(
      teacher.getByRole("heading", { name: "评价修订 1 · 草稿", exact: true }),
    ).toBeVisible();
    await student.reload();
    await expect(
      student.getByText("教师尚未发布评价。", { exact: true }),
    ).toBeVisible();
    await teacher
      .getByRole("button", { name: "确认发布此评价", exact: true })
      .click();
    await student.reload();
    await expect(
      student.getByText("已人工核对固定版本，建议补充大小写测试。", {
        exact: true,
      }),
    ).toBeVisible();
    await student.setViewportSize({ width: 390, height: 844 });
    expect(
      await student.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
    await student.screenshot({
      path: info.outputPath("student-receipt-mobile.png"),
      fullPage: true,
      animations: "disabled",
    });
    await student.goto(assignmentPath);
    await expect(
      student.getByText("我的进度：1 / 1 已提交 · 1 已发布评价", {
        exact: true,
      }),
    ).toBeVisible();
    await student
      .getByRole("link")
      .filter({
        has: student.getByRole("heading", { name: "T2 整理结果", exact: true }),
      })
      .click();
    await expect(
      student.getByRole("heading", { name: "T2 整理结果", exact: true }),
    ).toBeVisible();
    await expect(
      student.getByText("尚无正式提交。", { exact: true }),
    ).toBeVisible();
    await expect(
      student.getByLabel("一次性粘贴代码", { exact: true }),
    ).toHaveValue("");
    await student
      .getByRole("combobox", { name: "固定前置基线", exact: true })
      .selectOption({ index: 1 });
    await student
      .getByLabel("一次性粘贴代码", { exact: true })
      .fill("export const result = [];");
    await student
      .getByRole("button", { name: "准备固定快照", exact: true })
      .click();
    await student.getByLabel(/确认提交到/).check();
    await student
      .getByRole("button", { name: "确认正式提交", exact: true })
      .click();
    await expect(
      student.getByText("前置基线：", { exact: false }),
    ).toBeVisible();
    await expect(
      student.getByText("教师尚未发布评价。", { exact: true }),
    ).toBeVisible();
    await teacher.screenshot({
      path: info.outputPath("teacher-published-desktop.png"),
      fullPage: true,
      animations: "disabled",
    });
    await student.goto(taskPath);
    await student
      .getByRole("combobox", { name: "成果来源", exact: true })
      .selectOption("files");
    await student
      .locator("input[type=file]")
      .first()
      .setInputFiles({
        name: "files.ts",
        mimeType: "text/plain",
        buffer: Buffer.from("export const files = true;"),
      });
    await student
      .getByRole("button", { name: "准备固定快照", exact: true })
      .click();
    await student.getByLabel(/确认提交到/).check();
    await student
      .getByRole("button", { name: "确认正式提交", exact: true })
      .click();
    await expect(student.getByRole("heading", { name: /· V2$/ })).toBeVisible();
    await expect(
      student.getByText("教师尚未发布评价。", { exact: true }),
    ).toBeVisible();
    await student.goto(taskPath);
    await student
      .getByRole("combobox", { name: "成果来源", exact: true })
      .selectOption("zip");
    await student.locator("input[type=file]").setInputFiles({
      name: "code.zip",
      mimeType: "application/zip",
      buffer: Buffer.from(
        zipSync({ "src/zip.ts": strToU8("export const zipped = true;") }),
      ),
    });
    await student
      .getByRole("button", { name: "准备固定快照", exact: true })
      .click();
    await student.getByRole("button", { name: /^src\/zip\.ts/ }).click();
    await expect(
      student.getByText("export const zipped = true;", { exact: false }),
    ).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});
test("a team confirms membership and submits only after the teacher opens a scoped late window", async ({
  page: teacher,
  browser,
}, info) => {
  await login(teacher, "teacher@codelab.local");
  await teacher.getByRole("link", { name: "课程作业", exact: true }).click();
  await teacher.getByRole("button", { name: "创建作业", exact: true }).click();
  await teacher
    .getByLabel("作业名称", { exact: true })
    .fill("团队补交浏览器闭环");
  await teacher
    .getByRole("combobox", { name: "提交方式", exact: true })
    .selectOption("team");
  await teacher
    .getByLabel("目标与说明", { exact: true })
    .fill("团队处理边界输入");
  await teacher
    .getByLabel("评价标准（每行一条）", { exact: true })
    .fill("保留输入");
  await teacher
    .getByLabel("截止时间（北京时间）", { exact: true })
    .fill("2020-01-01T10:00");
  await teacher
    .getByRole("button", { name: "创建并发布", exact: true })
    .click();
  await teacher.getByLabel("团队名", { exact: true }).fill("浏览器 A 组");
  await teacher
    .getByRole("checkbox", { name: /student@codelab.local/ })
    .check();
  await teacher
    .getByRole("combobox", { name: "指定提交人", exact: true })
    .selectOption({ index: 1 });
  await teacher
    .getByRole("button", { name: "发送团队邀请", exact: true })
    .click();
  await expect(teacher.getByText("浏览器 A 组", { exact: true })).toBeVisible();
  const assignmentPath = new URL(teacher.url()).pathname;
  const context = await browser.newContext({
    baseURL: info.project.use.baseURL,
  });
  try {
    const student = await context.newPage();
    await login(student, "student@codelab.local");
    await student.goto(assignmentPath);
    await student
      .getByRole("button", { name: "确认加入", exact: true })
      .click();
    await student
      .getByRole("link")
      .filter({
        has: student.getByRole("heading", {
          name: "团队补交浏览器闭环",
          exact: true,
        }),
      })
      .click();
    const taskPath = new URL(student.url()).pathname;
    await student
      .getByLabel("一次性粘贴代码", { exact: true })
      .fill("export const result = 1;");
    await student
      .getByRole("button", { name: "准备固定快照", exact: true })
      .click();
    await student.getByLabel(/确认提交到/).check();
    await student
      .getByRole("button", { name: "确认正式提交", exact: true })
      .click();
    await expect(student.getByRole("alert")).toContainText("已过截止时间");
    await teacher.goto(taskPath);
    await teacher
      .locator("summary")
      .filter({ hasText: "指定对象限时补交" })
      .click();
    await teacher
      .getByRole("combobox", { name: "提交主体", exact: true })
      .selectOption({ label: "浏览器 A 组" });
    const local = (d: Date) =>
      new Date(d.getTime() + 8 * 3600000).toISOString().slice(0, 16);
    await teacher
      .getByLabel("开放时间", { exact: true })
      .fill(local(new Date(Date.now() - 120000)));
    await teacher
      .getByLabel("补交截止", { exact: true })
      .fill(local(new Date(Date.now() + 3600000)));
    await teacher.getByLabel("原因", { exact: true }).fill("浏览器补交验证");
    await teacher
      .getByRole("button", { name: "开放指定补交", exact: true })
      .click();
    await expect(
      teacher.getByRole("heading", { name: "补交窗口", exact: true }),
    ).toBeVisible();
    await student
      .getByRole("button", { name: "确认正式提交", exact: true })
      .click();
    await expect(
      student.getByRole("heading", { name: "浏览器 A 组 · V1", exact: true }),
    ).toBeVisible();
    await expect(student.getByText(/限时补交/)).toBeVisible();
  } finally {
    await context.close();
  }
});

test("teacher previews and saves a private draft, revises sources, then publishes with a Beijing deadline in another browser timezone", async ({
  browser,
}, info) => {
  const draftTitle = `待预览草稿 · ${info.repeatEachIndex}`;
  const teacherContext = await browser.newContext({
    baseURL: info.project.use.baseURL,
    timezoneId: "America/New_York",
  });
  const studentContext = await browser.newContext({
    baseURL: info.project.use.baseURL,
  });
  try {
    const teacher = await teacherContext.newPage(),
      student = await studentContext.newPage();
    await login(teacher, "teacher@codelab.local");
    await login(student, "student@codelab.local");
    await teacher.getByRole("link", { name: "课程作业", exact: true }).click();
    await teacher
      .getByRole("button", { name: "创建作业", exact: true })
      .click();
    await teacher.getByLabel("作业名称", { exact: true }).fill(draftTitle);
    await teacher
      .getByLabel("首个子任务名称", { exact: true })
      .fill("草稿搜索任务");
    await teacher.getByLabel("目标与说明", { exact: true }).fill("保留空输入");
    await teacher
      .getByLabel("评价标准（每行一条）", { exact: true })
      .fill("空输入不丢失列表");
    await teacher
      .getByLabel("截止时间（北京时间）", { exact: true })
      .fill("2030-01-01T20:00");
    let createRequests = 0;
    teacher.on("request", (r) => {
      if (
        r.method() === "POST" &&
        new URL(r.url()).pathname === "/api/v2/assignments"
      )
        createRequests++;
    });
    await teacher
      .getByRole("button", { name: "预览学生视图", exact: true })
      .click();
    const preview = teacher.getByRole("complementary", {
      name: "学生视图预览",
    });
    await expect(
      preview.getByRole("heading", { name: "草稿搜索任务", exact: true }),
    ).toBeVisible();
    await expect(preview).toContainText("2030/1/1 20:00:00");
    expect(createRequests).toBe(0);
    await teacher
      .getByRole("button", { name: "保存草稿", exact: true })
      .click();
    await expect(
      teacher.getByRole("button", { name: "发布作业", exact: true }),
    ).toBeVisible();
    const assignmentPath = new URL(teacher.url()).pathname;
    await student.goto("/assignments");
    await expect(
      student.getByRole("heading", { name: "课程作业", exact: true }),
    ).toBeVisible();
    await expect(
      student.getByRole("heading", { name: draftTitle, exact: true }),
    ).toHaveCount(0);
    expect(
      (await student.request.get(`/api/v2${assignmentPath}`)).status(),
    ).toBe(404);
    await teacher
      .getByRole("link")
      .filter({
        has: teacher.getByRole("heading", {
          name: "草稿搜索任务",
          exact: true,
        }),
      })
      .click();
    const taskPath = new URL(teacher.url()).pathname;
    await expect(
      teacher.getByRole("heading", { name: "草稿搜索任务", exact: true }),
    ).toBeVisible();
    const task = await (await teacher.request.get(`/api/v2${taskPath}`)).json();
    expect(task.task.config.dueAt).toBe("2030-01-01T12:00:00.000Z");
    await teacher
      .locator("summary")
      .filter({ hasText: "修订任务要求与辅导政策" })
      .click();
    await teacher
      .getByRole("button", { name: "载入当前要求", exact: true })
      .click();
    await teacher
      .locator("summary")
      .filter({ hasText: "起始材料、来源与分析范围" })
      .click();
    const settings = teacher.getByRole("group", {
      name: "允许的成果来源（至少一项）",
    });
    for (const label of [
      "代码片段",
      "文件 / 多文件",
      "Gitee 仓库",
      "GitHub 仓库",
    ])
      await settings
        .getByRole("checkbox", { name: label, exact: true })
        .uncheck();
    await teacher
      .getByLabel("起始材料", { exact: true })
      .fill("修订起始材料，只接收 ZIP");
    await teacher
      .getByRole("button", { name: "保存为新修订", exact: true })
      .click();
    await expect(
      teacher.getByText("修订起始材料，只接收 ZIP", { exact: true }),
    ).toHaveCount(1);
    expect((await student.request.get(`/api/v2${taskPath}`)).status()).toBe(
      404,
    );
    await teacher.goto(assignmentPath);
    await teacher
      .getByRole("button", { name: "发布作业", exact: true })
      .click();
    await expect(
      teacher.getByRole("button", { name: "发布作业", exact: true }),
    ).toHaveCount(0);
    await student.goto(taskPath);
    await expect(
      student.getByRole("heading", { name: "草稿搜索任务", exact: true }),
    ).toBeVisible();
    const source = student.getByRole("combobox", {
      name: "成果来源",
      exact: true,
    });
    await expect(source).toHaveValue("zip");
    await expect(source.locator("option")).toHaveCount(1);
    await student.goto("/assignments");
    const row = student.getByRole("link").filter({
      has: student.getByRole("heading", { name: draftTitle, exact: true }),
    });
    await expect(row).toContainText("我的进度：0 / 1 份任务成果已交");
    await expect(row).toContainText("2030/1/1 20:00:00");
  } finally {
    await teacherContext.close();
    await studentContext.close();
  }
});
