import { test, expect, type Page } from "@playwright/test";
async function login(page: Page, role: string) {
  await page.goto("/");
  await page.getByLabel("邮箱").fill(role + "@codelab.local");
  await page
    .getByLabel("密码", { exact: true })
    .fill("Browser-test-only-2904!");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "实训任务", exact: true }),
  ).toBeVisible();
}
test("teacher reviews, publishes; student reads and compares, then uploads with closed execution gate", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await login(page, "teacher");
  await page.getByText("任务管理看板", { exact: true }).click();
  await page.getByRole("link", { name: "复核报告" }).click();
  await expect(
    page.getByRole("heading", { name: "验收报告复核" }),
  ).toBeVisible();
  for (const title of [
    "新增任务",
    "编辑任务",
    "删除任务",
    "切换完成状态",
    "筛选任务",
    "拒绝空白任务",
    "刷新后保留数据",
  ]) {
    await page
      .getByRole("navigation", { name: "验收条目" })
      .getByRole("button")
      .filter({ hasText: title })
      .click();
    await page
      .getByLabel("建议的下一步")
      .fill("教师已核对测试夹具，按对应要求修改后重新提交。");
    await page.getByRole("button", { name: "保存并确认本条" }).click();
    await expect(
      page.getByRole("button", { name: "保存并确认本条" }),
    ).toBeEnabled();
    await expect(page.getByRole("status")).toContainText("已保存");
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: info.outputPath("teacher-review.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "发布报告 7/7" }).click();
  await expect(page.getByRole("status")).toContainText("报告已发布");
  await page.getByRole("button", { name: "退出登录" }).click();
  await login(page, "student");
  await page.goto("/runs/00000000-0000-4000-8000-000000000002");
  await expect(
    page.getByRole("heading", { name: "项目验收报告" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "保存并确认本条" }),
  ).toHaveCount(0);
  await page
    .getByRole("button")
    .filter({ hasText: "UI 测试证据（合成）" })
    .click();
  await expect(page.locator("pre")).toContainText("不代表实际执行结果");
  await page
    .getByLabel("历史提交")
    .selectOption("00000000-0000-4000-8000-000000000001");
  await page.getByRole("button", { name: "查看复验变化" }).click();
  await expect(page.getByText("检查层面已解决", { exact: true })).toBeVisible();
  await expect(page.getByText("出现回归", { exact: true })).toBeVisible();
  await expect(page.getByText("仍未满足", { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: info.outputPath("student-mobile.png"),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("link", { name: "返回任务" }).click();
  await page.getByLabel("项目 ZIP").setInputFiles("fixtures/correct.zip");
  await page.getByRole("button", { name: "上传并发起检查" }).click();
  await expect(page.getByRole("status")).toContainText("提交已保存");
  await expect(page.getByRole("alert")).toContainText("隔离验收");
  expect(errors).toEqual([]);
});
