// Read-only inspection of the live workspace: authenticates, searches, opens evidence.
// Never creates submissions, invokes models, confirms, or publishes a report.
import { chromium } from "@playwright/test";
import { readFile, mkdir } from "node:fs/promises";
const output = "output/studio-ui";
await mkdir(output, { recursive: true });
const { loginPassword } = JSON.parse(
  await readFile(".data/business-v2/development-credentials.json", "utf8"),
);
const browser = await chromium.launch({
  channel: process.env.PLAYWRIGHT_CHANNEL || "msedge",
});
const errors = [];
const checks = [];
async function capture(page, name, fullPage = false) {
  await page.screenshot({ path: `${output}/${name}.png`, fullPage });
  const layout = await page.evaluate(() => ({
    width: innerWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  if (layout.scroll > layout.width)
    throw new Error(
      `Horizontal overflow in ${name}: ${JSON.stringify(layout)}`,
    );
  checks.push(name);
}
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("http://127.0.0.1:5174/");
  await page.getByLabel("邮箱").waitFor();
  await capture(page, "login-desktop");
  await page.getByLabel("邮箱").fill("teacher@codelab.local");
  await page.getByLabel("密码", { exact: true }).fill(loginPassword);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.locator(".task-card").first().waitFor();
  await capture(page, "tasks-desktop");
  await page.getByLabel("搜索任务或班级").fill("no-such-task-studio-check");
  await page.getByRole("heading", { name: "没有匹配的任务" }).waitFor();
  await page.getByRole("button", { name: "清除筛选", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await capture(page, "tasks-mobile", true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator(".task-card").first().click();
  await page.locator(".task-pulse").waitFor();
  await capture(page, "task-desktop", true);
  await page.setViewportSize({ width: 390, height: 844 });
  await capture(page, "task-mobile", true);
  const reports = page.getByRole("link", { name: "查看报告", exact: true });
  if (await reports.count()) {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await reports.first().click();
    await page.locator(".review-hero").waitFor();
    await page.locator(".v2-evidence").waitFor();
    await capture(page, "report-desktop", true);
    await page.locator(".review-nav-item").nth(1).click();
    await page.locator(".v2-evidence").waitFor();
    await capture(page, "report-second-criterion");
    await page.setViewportSize({ width: 390, height: 844 });
    await capture(page, "report-mobile", true);
    await page.setViewportSize({ width: 768, height: 1024 });
    await capture(page, "report-tablet", true);
  }
  if (errors.length) throw new Error(errors.join("\n"));
  console.log(JSON.stringify({ checked: checks, pageErrors: errors, output }));
} finally {
  await browser.close();
}
