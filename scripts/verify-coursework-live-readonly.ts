// Existing workspace only. Login sessions and generated evidence are the only writes.
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";

const baseURL = "http://127.0.0.1:5174";
const referenceDirectory = path.resolve("docs/verification/2026-10-18/coursework");
const [outputDirectory, ...extra] = process.argv.slice(2);
assert.equal(extra.length, 0, 'ONE_OPTIONAL_OUTPUT_DIRECTORY_ONLY');
const directory = path.resolve(outputDirectory ?? referenceDirectory);
assert(directory.startsWith(path.resolve('docs/verification') + path.sep), 'OUTPUT_OUTSIDE_VERIFICATION');
const { loginPassword } = JSON.parse(
  await readFile(".data/business-v2/development-credentials.json", "utf8"),
);
const previous = JSON.parse(
  await readFile(path.join(referenceDirectory, "workspace-browser.json"), "utf8"),
);
assert.equal(previous.passed, true);
for (const [field, prefix] of [
  ["assignmentPath", "assignments"],
  ["taskPath", "course-tasks"],
  ["submissionPath", "course-submissions"],
]) {
  assert.match(previous[field], new RegExp(`^/${prefix}/[0-9a-f-]{36}$`));
}
const result: Record<string, unknown> = {
  startedAt: new Date().toISOString(),
  kind: "live-workspace-readonly-after-reload",
  externalModelCalls: 0,
  businessWrites: 0,
  passed: false,
};
const browser = await chromium.launch({ channel: "chrome", headless: true });
const errors: string[] = [],
  unexpectedWrites: string[] = [];
try {
  await mkdir(directory, { recursive: true });
  const health = await fetch(`${baseURL}/api/v1/health`, {
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(health.status, 200);
  assert.equal((await health.json()).businessVersion, 2);
  for (const role of ["teacher", "student"] as const) {
    const page = await browser.newPage({
      baseURL,
      viewport:
        role === "teacher"
          ? { width: 1440, height: 1000 }
          : { width: 390, height: 844 },
      reducedMotion: "reduce",
      timezoneId: "America/New_York",
    });
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("/");
    await page
      .getByLabel("邮箱", { exact: true })
      .fill(`${role}@codelab.local`);
    await page.getByLabel("密码", { exact: true }).fill(loginPassword);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page
      .getByRole("heading", { name: "实训任务", exact: true })
      .waitFor();
    // Enforce read-only business verification after the required login.
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) {
        unexpectedWrites.push(
          `${request.method()} ${new URL(request.url()).pathname}`,
        );
        await route.abort();
      } else await route.continue();
    });
    await page.getByRole("link", { name: "课程作业", exact: true }).click();
    await page
      .getByRole("heading", { name: "课程作业", exact: true })
      .waitFor();
    const demo = page.locator(`a[href="${previous.assignmentPath}"]`);
    await demo.waitFor();
    const progress = await demo.innerText();
    assert.match(progress, role === "teacher" ? /本班进度/ : /我的进度/);
    assert.match(progress, /1\s*\/\s*1 份任务成果已交/);
    assert.match(progress, /1 份已评价/);
    result[`${role}Progress`] = progress;
    if (role === "teacher") {
      await page.getByRole("button", { name: "创建作业", exact: true }).click();
      await page
        .getByLabel("作业名称", { exact: true })
        .fill("只读预览：不会创建记录");
      await page
        .getByLabel("目标与说明", { exact: true })
        .fill("读取已加载的最新预览组件。");
      await page
        .getByLabel("评价标准（每行一条）", { exact: true })
        .fill("空关键词保留原列表");
      await page
        .getByLabel("截止时间（北京时间）", { exact: true })
        .fill("2030-01-01T20:00");
      await page
        .getByRole("button", { name: "预览学生视图", exact: true })
        .click();
      const preview = page.getByRole("complementary", {
        name: "学生视图预览",
        exact: true,
      });
      await preview
        .getByRole("heading", { name: "只读预览：不会创建记录", exact: true })
        .waitFor();
      assert.match(await preview.innerText(), /20:00:00（北京时间）/);
      await page.evaluate(() => {
        (document.activeElement as HTMLElement)?.blur();
        window.scrollTo(0, 0);
      });
      await page.screenshot({
        path: path.join(directory, "workspace-preview-readonly.png"),
        fullPage: true,
        animations: "disabled",
      });
      result.previewInNewYorkShowsBeijing = true;
    }
    await page.goto(previous.taskPath);
    await page
      .getByRole("heading", { name: "任务要求", exact: true })
      .waitFor();
    await page.getByText(/允许来源：/).waitFor();
    await page.goto(previous.submissionPath);
    await page.getByRole("heading", { name: /· V1$/ }).waitFor();
    await page
      .getByText(
        "升级演示：已核对固定函数源码，后续自行添加边界测试。未运行代码，未调用模型。",
        { exact: true },
      )
      .waitFor();
    await page.getByRole("button", { name: /^src\/search\.ts ·/ }).click();
    const sourcePane = page.getByRole(
      role === "student" ? "dialog" : "region",
      { name: "项目源码文件", exact: true },
    );
    await sourcePane.waitFor();
    await sourcePane
      .getByRole("group", { name: "源码内容", exact: true })
      .waitFor();
    assert.match(await sourcePane.innerText(), /return q \?/);
    assert.match(await sourcePane.innerText(), /固定快照/);
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
      `${role}_SOURCE_OVERFLOW`,
    );
    await sourcePane
      .getByRole("button", { name: "关闭源码", exact: true })
      .click();
    result[`${role}FixedSourceReader`] = true;
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
      `${role}_OVERFLOW`,
    );
    await page.evaluate(() => {
      (document.activeElement as HTMLElement)?.blur();
      window.scrollTo(0, 0);
    });
    await page.screenshot({
      path: path.join(
        directory,
        `workspace-${role === "student" ? "student-mobile" : "teacher-desktop"}.png`,
      ),
      fullPage: true,
      animations: "disabled",
    });
    const modelConfirmation = page.getByLabel(
      role === "teacher"
        ? /确认由本人模型配置承担本次调用/
        : /我有权为当前快照授权/,
    );
    if (await modelConfirmation.count()) {
      await modelConfirmation.check();
      const receiverPath =
        role === "teacher"
          ? "/api/v2/course-model-recipient"
          : `/api/v2${previous.taskPath}`;
      const unchanged = await page.waitForResponse(
        (response) => new URL(response.url()).pathname === receiverPath,
      );
      await unchanged.finished();
      assert(
        await modelConfirmation.isChecked(),
        `${role}_UNCHANGED_CONSENT_RESET`,
      );
      // Browser-only response substitution; never edit the real account/model configuration.
      await page.route(`**${receiverPath}`, async (route) => {
        const response = await route.fetch();
        const body = await response.json();
        const field = role === "teacher" ? "recipient" : "teacherRecipient";
        await route.fulfill({
          json: {
            ...body,
            [field]: {
              ...body[field],
              hash: "b".repeat(64),
              model: "只读验证：接收方变更",
            },
          },
        });
      });
      await page.getByText(/只读验证：接收方变更/).waitFor();
      assert(
        !(await modelConfirmation.isChecked()),
        `${role}_CHANGED_CONSENT_RETAINED`,
      );
      result[`${role}RecipientChangeResetsConfirmation`] =
        "browser-response-substitution-only";
    } else {
      result[`${role}RecipientChangeResetsConfirmation`] =
        "not-configured-no-confirmation";
    }
    await page.close();
  }
  assert.deepEqual(errors, [], "BROWSER_ERRORS");
  assert.deepEqual(unexpectedWrites, [], "BUSINESS_WRITE_ATTEMPTED");
  result.passed = true;
} catch (error) {
  process.exitCode = 1;
  result.diagnostic = (error instanceof Error ? error.message : "UNKNOWN_ERROR")
    .split(loginPassword)
    .join("[redacted]")
    .slice(0, 3000);
} finally {
  await browser.close();
  result.unexpectedWrites = unexpectedWrites;
  result.finishedAt = new Date().toISOString();
  await writeFile(
    path.join(directory, "workspace-readonly.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
}
