import { chromium, expect } from "@playwright/test";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { root } from "../apps/api/src/template.js";

// Uses an existing real execution report. Only unsaved form text is changed.
const runId = process.argv[2];
if (!runId || !/^[0-9a-f-]{36}$/.test(runId)) throw new Error("RUN_ID_REQUIRED");
const credentials = JSON.parse(await readFile(path.join(root, ".data/business-v2/development-credentials.json"), "utf8"));
const output = path.join(root, "output/workspace-verification", `analysis-${new Date().toISOString().replace(/[:.]/g, "-")}`);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({ baseURL: "http://127.0.0.1:5174", viewport: { width: 1440, height: 1000 } });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/");
  await page.getByLabel("邮箱", { exact: true }).fill("teacher@codelab.local");
  await page.getByLabel("密码", { exact: true }).fill(credentials.loginPassword);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByRole("heading", { name: "实训任务", exact: true })).toBeVisible();
  await page.goto(`/runs/${runId}`);
  await expect(page.getByRole("navigation", { name: "验收条目" })).toBeVisible();
  await expect(page.getByText("当前使用基础检查报告；配置模型后，新检查可生成 AI 候选建议。", { exact: true })).toBeVisible();
  const before = await (await page.request.get(`/api/v2/runs/${runId}/review`)).json();
  expect(before.analysisAvailable).toBe(false);
  await expect(page.getByRole("button", { name: "重新分析存档", exact: true })).toBeDisabled();
  await expect(page.getByLabel('分析方式', { exact: true })).toBeDisabled();
  await expect(page.getByLabel('分析方式', { exact: true })).toHaveValue('agent');
  const input = page.getByLabel("建议的下一步");
  await input.fill("未保存的教师修改：候选轮询不得覆盖此内容");
  await page.waitForResponse(response => response.url().endsWith(`/api/v2/runs/${runId}/review`) && response.status() === 200, { timeout: 10_000 });
  await expect(input).toHaveValue("未保存的教师修改：候选轮询不得覆盖此内容");
  const after = await (await page.request.get(`/api/v2/runs/${runId}/review`)).json();
  expect(after.revision.revisionId).toBe(before.revision.revisionId);
  await page.screenshot({ path: path.join(output, "teacher-analysis-state.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: path.join(output, 'teacher-analysis-mobile.png'), fullPage: true });
  expect(errors).toEqual([]);
  await writeFile(path.join(output, "result.json"), JSON.stringify({ source: "existing_real_execution_ui", runId, analysisConfigured: false, unsavedEditPreservedDuringPolling: true, persistedRevisionUnchanged: true, mobileOverflow: false, pageErrors: errors, modelQualityVerified: false }, null, 2));
  console.log(`分析状态与教师编辑保护验证通过：${output}`);
} finally { await browser.close(); }
