// Real browser/HTTP/import/DB pipeline; deterministic fixture model, never a paid provider.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { chromium, expect } from "@playwright/test";
import { zipSync, strToU8 } from "fflate";
import { createApp, type Config } from "../apps/api/src/app.js";
import { migrate } from "../apps/api/src/db.js";
import { seed } from "../apps/api/src/seed.js";
import { testDB } from "../tests/db.js";
import { root } from "../apps/api/src/template.js";
import type { SummaryProviderV2 } from "../apps/api/src/model-provider-v2.js";
import { ModelRequestError } from "../apps/api/src/model-provider-v2.js";
import { sourceExecutionSnapshot } from "../apps/api/src/source-execution.js";

const directory = path.join(
  root,
  "docs/verification/2026-09-29",
  `source-import-${randomUUID()}`,
);
const modes = process.argv.includes("--modes");
const planRepair = process.argv.includes("--plan-repair");
const contextBudget = process.argv.includes("--context");
const usageCheck = process.argv.includes("--usage");
if (planRepair && !modes) throw new Error("--plan-repair requires --modes");
await mkdir(directory, { recursive: true });
const db = await testDB();
await migrate(db);
const password = randomUUID();
await seed(db, password);
const citation = { path: "sample/main.ts", start: 1, end: 1 };
const section = {
  title: "导入验证样本",
  body: "这是用于验证上传和页面的固定测试回复，不代表真实模型质量。",
  citations: [citation],
};
const report = {
  overview: section.body,
  stack: ["TypeScript"],
  modules: [section],
  flows: [section],
  findings: [],
  readingPath: [section],
  limitations: ["fixture model; import/UI verification only"],
};
let modelCalls = 0;
let failureCalls = 0;
let failSecondCall = false;
let holdInvestigation = false;
let releaseInvestigation = () => {};
let investigationGate = Promise.resolve();
function pauseInvestigation() {
  holdInvestigation = true;
  investigationGate = new Promise<void>((resolve) => {
    releaseInvestigation = resolve;
  });
}
let secondRoundSawEvidence = false;
let malformedPlanSent = false;
let repairObserved = false;
const provider: SummaryProviderV2 = {
  ...(contextBudget
    ? {
        sourceContext: {
          contextWindowTokens: 32768,
          maxOutputTokens: 4096,
          tokenizer: "cl100k_base" as const,
        },
      }
    : {}),
  configuration: {
    provider: "fixture",
    model: "fixture-no-network",
    endpoint: "http://test.invalid",
  },
  async complete(input) {
    modelCalls++;
    if (failSecondCall) {
      failureCalls++;
      if (failureCalls === 2) throw new ModelRequestError('MODEL_HTTP_403','failed');
      return {content:JSON.stringify({paths:['sample/main.ts']}),raw:'fixture',requestId:null,usage:{inputTokens:101,outputTokens:17}};
    }
    const request = JSON.parse(input.user);
    if (request.phase === "investigation") {
      if (request.round === 1 && holdInvestigation) await investigationGate;
      if (request.round === 2)
        secondRoundSawEvidence = JSON.stringify(request.excerpts).includes(
          "backendEvidence",
        );
      if (planRepair && !malformedPlanSent) {
        malformedPlanSent = true;
        return {
          content: JSON.stringify({
            goal: "受控格式错误",
            searches: [],
            reads: [{ path: "sample/backend/data.ts", start: 1, count: 999 }],
          }),
          raw: "fixture",
          requestId: null,
          usage: null,
        };
      }
      if (request.correction) {
        assert(
          request.errors.some(
            (e: any) =>
              e.path.join(".") === "reads.0.count" && e.maximum === 180,
          ),
        );
        repairObserved = true;
        await investigationGate;
      }
      return {
        content: JSON.stringify({
          goal:
            request.round === 1 ? "追踪后端数据入口" : "检查前端调用与后端实现",
          searches: [],
          reads: [
            {
              path:
                request.round === 1
                  ? "sample/backend/data.ts"
                  : "sample/frontend/view.ts",
              start: 1,
              count: 10,
            },
          ],
        }),
        raw: "fixture",
        requestId: null,
        usage:
          contextBudget && modelCalls % 2 === 0
            ? { inputTokens: 10, outputTokens: 2 }
            : null,
      };
    }
    return {
      content: JSON.stringify(
        request.draft
          ? request.checkShape || request.shape
            ? { report: { modules: [{ ...section, sectionIndex: 0, title: "复核后的导入模块" }] }, checks: [] }
            : { searches: [], reads: [] }
          : request.shape
            ? report
            : { paths: [citation.path] },
      ),
      raw: "fixture",
      requestId: null,
      usage:
        contextBudget && modelCalls % 2 === 0
          ? { inputTokens: 10, outputTokens: 2 }
          : null,
    };
  },
};
const config: Config = {
  origin: "pending",
  secure: false,
  executionApproved: false,
  model: "fixture",
  image: "none",
  sourceProvider: provider,
  businessVersion: 2,
};
const app = await createApp(db, config);
const apiOrigin = await app.listen({ host: "127.0.0.1", port: 0 });
const webRequire = createRequire(path.join(root, "apps/web/package.json"));
const { createServer } = await import(
  pathToFileURL(webRequire.resolve("vite")).href
);
const web = await createServer({
  root: path.join(root, "apps/web"),
  server: {
    host: "127.0.0.1",
    port: 0,
    strictPort: false,
    proxy: { "/api": apiOrigin },
  },
});
await web.listen();
const address = web.httpServer.address();
config.origin = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors: string[] = [];
const archivePath = path.join(
  root,
  ".data",
  `source-import-fixture-${randomUUID()}.zip`,
);
page.on("pageerror", (error) => errors.push(error.message));
try {
  await page.goto(config.origin + "/projects");
  await page.getByLabel("邮箱").fill("teacher@codelab.local");
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(
    page.getByText("普通项目即可 · 最大 100 MB", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: path.join(directory, "upload-desktop.png"),
    fullPage: true,
  });
  // A valid archive exactly at the advertised limit; large binary is intentionally omitted.
  const files: Record<string, Uint8Array> = {
    "sample/main.ts": strToU8("export const imported = true;"),
    "sample/exhibit.glb": new Uint8Array(0),
  };
  if (modes)
    Object.assign(files, {
      "sample/backend/data.ts": strToU8("export const backendEvidence = true;"),
      "sample/frontend/view.ts": strToU8(
        "export const frontendEvidence = true;",
      ),
    });
  const overhead = zipSync(files, { level: 0 }).byteLength;
  files["sample/exhibit.glb"] = new Uint8Array(
    modes ? 20 : 100 * 1024 * 1024 - overhead,
  );
  const archive = Buffer.from(zipSync(files, { level: 0 }));
  if (!modes) assert.equal(archive.length, 100 * 1024 * 1024);
  const started = Date.now();
  const uploadResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/v2/projects" &&
      response.request().method() === "POST",
    { timeout: 120000 },
  );
  void uploadResponse.catch(() => {});
  await writeFile(archivePath, archive, { flag: "wx" });
  await page.getByLabel("上传项目 ZIP").setInputFiles(archivePath);
  assert.equal((await uploadResponse).status(), 201);
  await page.waitForURL(/\/projects\/[0-9a-f-]+$/, { timeout: 30000 });
  await expect(page.locator(".source-report")).toBeVisible({ timeout: 30000 });
  const projectId = page.url().split("/").at(-1)!;
  const detail = await (
    await page.request.get(`${config.origin}/api/v2/projects/${projectId}`)
  ).json();
  assert.equal(
    detail.sha256,
    createHash("sha256").update(archive).digest("hex"),
  );
  assert.equal(detail.files.length, modes ? 3 : 1);
  assert.equal(detail.omitted.length, 1);
  assert.equal(detail.analyses[0].status, "succeeded");
  assert.equal(detail.analyses[0].report.coverage.readLines, 1);
  assert.equal(detail.analyses[0].analysis_options.mode, "quick");
  await expect(
    page.getByRole("region", { name: "实际分析范围" }),
  ).toContainText(modes ? "3 / 3 个文件路径" : "1 / 1 个文件路径");
  await page.getByText("查看跳过原因", { exact: true }).click();
  await expect(
    page.getByRole("region", { name: "实际分析范围" }),
  ).toContainText("非源码文件：1 个");
  await page.locator(".citations button").first().click();
  await expect(page.getByRole("dialog")).toContainText(
    "export const imported = true;",
  );
  await page.getByRole("button", { name: "关闭源码" }).click();
  if (modes) {
    await page.getByText("调整模式并重新分析", { exact: true }).click();
    await page.getByRole("radio", { name: /深入分析/ }).check();
    await page.getByRole("checkbox", { name: /backend/ }).check();
    pauseInvestigation();
    await page.getByRole("button", { name: /重新分析项目 · 深入分析/ }).click();
    await expect(page.locator(".round-track li").first()).toContainText(
      "进行中",
      { timeout: 30000 },
    );
    await page.getByText("调整模式并重新分析", { exact: true }).click();
    await expect(page.getByRole("radio", { name: /快速概览/ })).toBeDisabled();
    await page.getByText("调整模式并重新分析", { exact: true }).click();
    await expect(page.locator(".investigation")).toContainText(
      "本次重点：backend",
    );
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({
      path: path.join(directory, "deep-running.png"),
      fullPage: true,
    });
    holdInvestigation = false;
    releaseInvestigation();
    if (planRepair) {
      // Hold only the completed-reply correction so its real persisted progress
      // is visible in the UI; no invented timer or model progress percentage.
      investigationGate = new Promise<void>((resolve) => {
        releaseInvestigation = resolve;
      });
      await expect(page.locator(".investigation h2")).toContainText(
        "正在校正调查计划格式",
        { timeout: 30000 },
      );
      await page.screenshot({
        path: path.join(directory, "plan-repair-progress.png"),
        fullPage: true,
      });
      releaseInvestigation();
    }
    await expect(page.locator(".source-report")).toBeVisible({
      timeout: 30000,
    });
    const deep = await (
      await page.request.get(`${config.origin}/api/v2/projects/${projectId}`)
    ).json();
    assert.deepEqual(deep.analyses[0].analysis_options, {
      version: 1,
      mode: "deep",
      modules: ["backend"],
    });
    assert.equal(deep.analyses[0].report.coverage.readFiles, 3);
    assert.equal(deep.analyses[0].report.investigation.length, 2);
    assert(secondRoundSawEvidence);
    assert.equal(modelCalls, planRepair ? 11 : 10);
    if (planRepair) {
      assert(repairObserved);
      assert.equal(
        deep.analyses[0].events.filter((e: any) => e.kind === "repair_plan")
          .length,
        1,
      );
      assert.equal(
        deep.analyses[0].report.verification.version,
        "source-agent-v4.3-section-corrections",
      );
      assert(
        deep.analyses[0].events.some(
          (e: any) =>
            e.kind === "plan_invalid" && e.label.includes("超出允许上限"),
        ),
      );
      assert(
        !deep.analyses[0].events.some((e: any) => e.label.includes("too_big")),
      );
    }
    await page.getByText(/目录阅读地图/).click();
    await expect(page.locator(".directory-map")).toContainText("backend");
    await page.getByLabel("分析记录").selectOption(detail.analyses[0].id);
    await expect(page.locator(".live-label")).toContainText("快速概览");
    await expect(page.locator(".round-track")).toHaveCount(0);
    await page.getByLabel("分析记录").selectOption("");
    await expect(page.locator(".round-track li.complete")).toHaveCount(2);
  }
  await page.screenshot({
    path: path.join(directory, "coverage-desktop.png"),
    fullPage: true,
  });
  if (contextBudget) {
    await page.getByText("模型容量与实际用量", { exact: true }).click();
    await expect(page.locator(".model-usage")).toContainText("32,768 token");
    await expect(page.locator(".model-usage")).toContainText(
      "以上仅为已知小计",
    );
    const current = await (
      await page.request.get(`${config.origin}/api/v2/projects/${projectId}`)
    ).json();
    assert.equal(
      current.analyses[0].report.context.policy.tokenizer,
      "cl100k_base",
    );
    assert(current.analyses[0].report.context.callsWithoutUsage > 0);
    assert(current.analyses[0].report.context.callsWithUsage > 0);
    await page.screenshot({
      path: path.join(directory, "context-budget-desktop.png"),
      fullPage: true,
    });
  }
  await page.reload();
  await expect(page.locator(".source-report")).toBeVisible();
  await expect(page.locator(".execution-snapshot")).toContainText("fixture-no-network · 设置已在提交时固定");
  const frozenDetail = await (await page.request.get(`${config.origin}/api/v2/projects/${projectId}`)).json();
  assert(frozenDetail.analyses.length > 0);
  for (const analysis of frozenDetail.analyses.filter((a: any) => a.status === 'succeeded')) {
    assert.deepEqual(analysis.report.report.modules.map((m: any) => m.title), ['复核后的导入模块']);
    assert.equal(analysis.report.verification.version, 'source-agent-v4.3-section-corrections');
  }
  await expect(page.getByRole('heading', { name: '复核后的导入模块', exact: true })).toHaveCount(1);
  await expect(page.getByRole('heading', { name: '导入验证样本', exact: true })).toHaveCount(0);
  for (const analysis of frozenDetail.analyses) assert.deepEqual(analysis.execution_snapshot,sourceExecutionSnapshot(provider));
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("region", { name: "实际分析范围" }),
  ).toBeVisible();
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.screenshot({
    path: path.join(directory, "coverage-mobile.png"),
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  if (usageCheck) {
    failSecondCall = true;
    await page.getByText('调整模式并重新分析',{exact:true}).click();
    await page.getByRole('radio',{name:/快速概览/}).check();
    await page.getByRole('button',{name:/重新分析项目/}).click();
    await expect(page.locator('.investigation h2')).toHaveText('本次分析未完成',{timeout:30000});
    await page.reload();
    await page.locator('.call-usage summary').click();
    await expect(page.locator('.call-usage')).toContainText('101');
    await expect(page.locator('.call-usage')).toContainText('17');
    const failed = await (await page.request.get(`${config.origin}/api/v2/projects/${projectId}`)).json();
    assert.equal(failed.analyses[0].status,'failed');
    assert.equal(failed.analyses[0].report,null);
    assert.equal(failed.analyses[0].modelUsage.registeredCalls,2);
    assert.equal(failed.analyses[0].modelUsage.callsWithoutUsage,1);
    assert.equal(failed.analyses[0].modelUsage.failedCalls,1);
    assert.equal(failed.analyses[0].modelUsage.knownInputTokens,101);
    assert.equal(failureCalls,2);
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.screenshot({path:path.join(directory,'failure-usage-mobile.png'),fullPage:true});
    await page.getByLabel('分析记录').selectOption(detail.analyses[0].id);
    await expect(page.locator('.source-report')).toBeVisible();
    failSecondCall = false;
  }
  if (modes) {
    await page.setViewportSize({ width: 320, height: 844 });
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await page.getByRole("link", { name: /分析另一个项目/ }).click();
    await page.getByRole("radio", { name: /深入分析/ }).check();
    pauseInvestigation();
    // A distinct source creates a fresh project so the upload's mode is exercised.
    const secondArchive = Buffer.from(
      zipSync({ ...files, "sample/README.md": strToU8("second import") }),
    );
    await page.getByLabel("上传项目 ZIP").setInputFiles({
      name: "deep-source.zip",
      mimeType: "application/zip",
      buffer: secondArchive,
    });
    await expect(page.locator(".round-track li").first()).toContainText(
      "进行中",
      { timeout: 30000 },
    );
    const cancelProjectId = page.url().split("/").at(-1)!;
    assert.notEqual(cancelProjectId, projectId);
    await page.getByRole("button", { name: "停止当前分析" }).click();
    await expect(page.locator(".investigation h2")).toHaveText("分析已停止");
    const callsAtCancel = modelCalls;
    holdInvestigation = false;
    releaseInvestigation();
    // Wait for the real worker to leave its in-flight request, not an arbitrary observation timer.
    await app.close();
    const cancelled = (
      await db.query(
        "SELECT status,report,analysis_options FROM source_analyses WHERE project_id=$1",
        [cancelProjectId],
      )
    ).rows[0];
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.report, null);
    assert.equal(cancelled.analysis_options.mode, "deep");
    assert.equal(modelCalls, callsAtCancel);
  }
  const result = {
    state: "passed",
    source: "isolated-browser-http-db-fixture-model",
    archiveBytes: archive.length,
    zipSha256: detail.sha256,
    uploadAndReportMs: Date.now() - started,
    retainedFiles: detail.files.length,
    omittedFiles: detail.omitted.length,
    coverage: detail.analyses[0].report.coverage,
    modelCalls,
    externalModelCalls: 0,
    refreshVerified: true,
    citationVerified: true,
    mobileOverflow: false,
    browserErrors: errors,
    analysisModesVerified: modes,
    secondRoundSawEvidence,
    deepUploadAndCancellationVerified: modes,
    planRepairVerified: planRepair && repairObserved,
    contextBudgetVerified: contextBudget,
    executionSnapshotVerified: true,
    partialFailureUsageVerified: usageCheck,
    renamedSectionReplacementVerified: true,
    limitations: [
      "Not real model quality or production load testing",
      modes
        ? "Three source files for interaction verification, not real model quality"
        : "Binary-heavy 100MB boundary fixture; not a 100MB source corpus",
    ],
  };
  await writeFile(
    path.join(directory, "result.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify({ directory, ...result }));
} catch (error) {
  await writeFile(
    path.join(directory, "failure.json"),
    JSON.stringify(
      {
        state: "failed",
        message: error instanceof Error ? error.message : "unknown",
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  releaseInvestigation();
  await browser.close();
  await web.close();
  await app.close();
  await db.close();
  await unlink(archivePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}
