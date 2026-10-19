// Real browser + configured model: controlled Python sample or user-authorized museum source.
import { chromium, expect } from "@playwright/test";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { zipSync, strToU8 } from "fflate";
import path from "node:path";
import { root } from "../apps/api/src/template.js";
const origin = "http://127.0.0.1:5174";
const museum = process.argv.includes("--museum");
const reanalyze = process.argv.includes("--reanalyze");
const deep = process.argv.includes("--deep");
const argument = (name: string) => {
  const i = process.argv.indexOf(name);
  if (i < 0) return undefined;
  const value = process.argv[i + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing ${name}`);
  return value;
};
const existingProject = argument("--project");
const email = argument("--email") ?? 'teacher@codelab.local';
const observeAnalysis = argument("--observe");
const focus = argument("--focus");
if (observeAnalysis && (!existingProject || reanalyze))
  throw new Error("--observe requires --project and forbids --reanalyze");
if (focus && (!deep || !existingProject || !reanalyze))
  throw new Error("--focus requires --deep --project --reanalyze");
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const id = randomUUID(),
  out = path.join(root, "docs/verification/2026-09-28", `source-project-${id}`);
await mkdir(out, { recursive: true });
const credentials = JSON.parse(
  await readFile(
    path.join(root, ".data/business-v2/development-credentials.json"),
    "utf8",
  ),
);
const files = {
  "reading-room/README.md":
    "# Reading room\nA tiny command-line reading list. Add books, mark them read, and save a JSON file.\nRun python app.py. This is a controlled CodeLab verification sample, not student code.\n",
  "reading-room/app.py":
    'from library import Library\n\ndef main():\n    library = Library("books.json")\n    library.add("Designing Data-Intensive Applications")\n    library.mark_read(0)\n    library.save()\n    print(library.books)\n\nif __name__ == "__main__":\n    main()\n',
  "reading-room/library.py":
    'import json\nfrom pathlib import Path\n\nclass Library:\n    def __init__(self, filename):\n        self.path = Path(filename)\n        self.books = json.loads(self.path.read_text()) if self.path.exists() else []\n\n    def add(self, title):\n        self.books.append({"title": title, "read": False})\n\n    def mark_read(self, index):\n        self.books[index]["read"] = True\n\n    def save(self):\n        self.path.write_text(json.dumps(self.books, ensure_ascii=False))\n',
  "reading-room/.env": "SAMPLE_TEST_VALUE=never-send-this-configuration\n",
};
const buffer = museum
  ? await readFile(
      path.join(
        root,
        "output/museum-source-analysis/河洛数字博物馆_源码分析.zip",
      ),
    )
  : Buffer.from(
      zipSync(
        Object.fromEntries(
          Object.entries(files).map(([p, s]) => [p, strToU8(s)]),
        ),
      ),
    );
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors: string[] = [];
let observedId = observeAnalysis;
let observedProject = existingProject;
let lastStatus = "not-observed";
page.on("pageerror", (e) => errors.push(e.message));
try {
  await page.goto(origin + "/projects");
  await page.getByLabel("邮箱").fill(email);
  await page
    .getByLabel("密码", { exact: true })
    .fill(credentials.loginPassword);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "从一份源码，看懂整个项目。" }),
  ).toBeVisible();
  await page.screenshot({
    path: path.join(out, "upload-desktop.png"),
    fullPage: true,
  });
  if (existingProject) {
    await page.goto(origin + `/projects/${existingProject}`);
  } else {
    if (deep) await page.getByRole("radio", { name: /深入分析/ }).check();
    await page.getByLabel("上传项目 ZIP").setInputFiles({
    name: museum ? "河洛数字博物馆_源码分析.zip" : "reading-room.zip",
    mimeType: "application/zip",
    buffer,
    });
  }
  await page.waitForURL(/\/projects\/[0-9a-f-]+$/);
  const projectId = page.url().split("/").at(-1)!;
  observedProject = projectId;
  console.log(JSON.stringify({ stage: existingProject ? "opened" : "uploaded", projectId }));
  await expect(page.locator(".investigation")).toBeVisible();
  const initial = await (
    await page.request.get(origin + `/api/v2/projects/${projectId}`)
  ).json();
  const previousId = initial.analyses[0].id;
  // Detail exposes only the latest 20 entries; retain 19 for a new insertion.
  const oldHistories = initial.analyses.slice(0, reanalyze ? 19 : 20).filter((a: any) => !["queued", "running"].includes(a.status));
  const oldHistoryHash = digest(oldHistories);
  if (
    reanalyze && !["queued", "running"].includes(initial.analyses[0].status)
  ) {
    await page.getByText("调整模式并重新分析", { exact: true }).click();
    await page.getByRole("radio", { name: deep ? /深入分析/ : /快速概览/ }).check();
    if (focus) {
      await page.getByLabel("筛选关注目录").fill(focus);
      await page.getByRole("checkbox", { name: new RegExp(focus) }).check();
    }
    // Submit once. Observation failures never replay this paid request.
    const responsePromise = page.waitForResponse(r => r.request().method() === "POST" && r.url().endsWith(`/projects/${projectId}/analyze`));
    await page.getByRole("button", { name: /重新分析项目/ }).click();
    const submitted = await responsePromise;
    expect(submitted.ok()).toBe(true);
    observedId = (await submitted.json()).id;
    await writeFile(path.join(out, "observation.json"), JSON.stringify({ projectId, analysisId: observedId, origin, deep, focus: focus ?? null }, null, 2));
    await expect
      .poll(async () => {
        const d = await (
          await page.request.get(origin + `/api/v2/projects/${projectId}`)
        ).json();
        return d.analyses[0].id;
      })
      .not.toBe(previousId);
  }
  const selected = await (await page.request.get(origin + `/api/v2/projects/${projectId}`)).json();
  observedId ??= selected.analyses[0].id;
  if (observeAnalysis && observeAnalysis !== selected.analyses[0].id)
    await page.getByLabel("分析记录").selectOption(observeAnalysis);
  await writeFile(path.join(out, "observation.json"), JSON.stringify({ projectId, analysisId: observedId, origin, deep, focus: focus ?? null, resume: `pnpm exec tsx scripts/verify-source-project.ts --museum --project ${projectId} --email ${email} --observe ${observedId}${deep ? " --deep" : ""}` }, null, 2));
  console.log(JSON.stringify({ stage: "observing", projectId, analysisId: observedId, evidence: path.relative(root, out) }));
  await page.screenshot({
    path: path.join(out, "analysis-progress.png"),
    fullPage: true,
  });
  let status = "";
  let result: any;
  let lastEvents = -1;
  for (let i = 0; i < (deep ? 465 : 300); i++) {
    const r = await page.request.get(origin + `/api/v2/projects/${projectId}`);
    expect(r.status()).toBe(200);
    result = await r.json();
    const a = result.analyses.find((a: any) => a.id === observedId);
    expect(a, "Observed analysis must remain available").toBeTruthy();
    status = a.status;
    lastStatus = status;
    if (a.events.length !== lastEvents) {
      lastEvents = a.events.length;
      console.log(
        JSON.stringify({
          stage: status,
          events: lastEvents,
          last: a.events.at(-1)?.kind,
        }),
      );
    }
    if (!["queued", "running"].includes(status)) break;
    await page.waitForTimeout(2000);
  }
  const analysis = result.analyses.find((a: any) => a.id === observedId);
  const previousHistoriesUnchanged = digest(result.analyses.filter((a: any) => oldHistories.some((old: any) => old.id === a.id))) === oldHistoryHash;
  await writeFile(path.join(out, "terminal-observation.json"), JSON.stringify({ analysisId: observedId, status, code: analysis.code, events: analysis.events, previousHistoriesUnchanged }, null, 2));
  expect(previousHistoriesUnchanged).toBe(true);
  expect(status).toBe("succeeded");
  // All subsequent report assertions refer to the pinned ID, never a newer task.
  result.analyses = [analysis];
  if (deep) {
    expect(analysis.analysis_options.mode).toBe("deep");
    expect(analysis.report.investigation).toHaveLength(2);
    await expect(page.locator(".round-track li.complete")).toHaveCount(2);
  }
  if (reanalyze)
    expect(result.analyses[0].report.verification.version).toBe(
      "source-agent-v4.3-section-corrections",
    );
  await expect(page.locator(".source-report")).toBeVisible({ timeout: 10000 });
  if (analysis.modelUsage?.recording === 'available') {
    expect(analysis.modelUsage.pendingCalls).toBe(0);
    expect(analysis.modelUsage.returnedCalls).toBe(analysis.report.model.calls.length);
    expect(analysis.modelUsage.knownInputTokens).toBe(analysis.report.context.knownInputTokens);
    expect(analysis.modelUsage.knownOutputTokens).toBe(analysis.report.context.knownOutputTokens);
    await page.locator('.call-usage summary').click();
    await expect(page.locator('.call-usage')).toContainText(String(analysis.modelUsage.returnedCalls));
  }
  await page.screenshot({
    path: path.join(out, "report-desktop.png"),
    fullPage: true,
  });
  await page.locator(".citations button").first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.locator("code.highlight").first()).toBeVisible();
  await page.screenshot({ path: path.join(out, "source-citation.png") });
  await page.getByRole("button", { name: "关闭源码" }).click();
  await page.getByRole("button", { name: /问题与建议/ }).click();
  await page.screenshot({
    path: path.join(out, "findings-desktop.png"),
    fullPage: true,
  });
  if (result.analyses[0].report.report.verification) {
    await page.getByRole("button", { name: /反证复核/ }).click();
    await expect(page.locator(".verification-note")).toBeVisible();
    expect(await page.locator(".review-decision").count()).toBe(
      result.analyses[0].report.report.verification.length,
    );
    if (result.analyses[0].report.report.verification.length) {
      await page.locator(".citations button").first().click();
      await expect(page.locator("code.highlight").first()).toBeVisible();
      await page.getByRole("button", { name: "关闭源码" }).click();
    }
    await page.screenshot({
      path: path.join(out, "verification-desktop.png"),
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => {
    (document.activeElement as HTMLElement)?.blur();
    window.scrollTo(0, 0);
  });
  await page.screenshot({
    path: path.join(out, "report-mobile.png"),
    fullPage: true,
  });
  console.log(JSON.stringify({stage:'mobile-layout',...(await page.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth})))}));
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.reload();
  if (observeAnalysis) await page.getByLabel("分析记录").selectOption(observeAnalysis);
  await expect(page.locator(".source-report")).toBeVisible();
  if (!museum)
    expect(result.omitted.some((o: any) => o.path.endsWith(".env"))).toBe(true);
  expect(errors).toEqual([]);
  await writeFile(
    path.join(out, "result.json"),
    JSON.stringify(
      {
        id,
        state: "passed",
        projectId,
        origin,
        source: museum
          ? "authorized-museum-working-tree"
          : "controlled-python-sample",
        realModel: true,
        analysisOptions: analysis.analysis_options,
        executionSnapshot: analysis.execution_snapshot,
        modelUsage: analysis.modelUsage,
        elapsedMs: new Date(analysis.finished_at).getTime() - new Date(analysis.started_at).getTime(),
        coverage: analysis.report.coverage,
        previousHistoriesUnchanged: true,
        analysisId: result.analyses[0].id,
        files: result.files.length,
        readFiles: Object.keys(result.analyses[0].report.read).length,
        events: lastEvents,
        findings: result.analyses[0].report.report.findings.length,
        browserErrors: errors,
        checked: [
          existingProject ? "existing project opened without reupload" : "UI ZIP upload",
          "real model",
          "validated citations",
          "source viewer",
          "responsive width",
          "reload persistence",
        ],
        limitations: [
          "One project, not comprehensive quality evaluation",
          "Source-only analysis; project not executed",
        ],
      },
      null,
      2,
    ),
  );
  await writeFile(
    path.join(out, "analysis-report.json"),
    JSON.stringify(result.analyses[0].report, null, 2),
  );
  console.log(
    JSON.stringify({
      state: "passed",
      projectId,
      evidence: path.relative(root, out),
    }),
  );
} catch (error) {
  await writeFile(path.join(out, "failure.json"), JSON.stringify({ state: "verification-failed", projectId: observedProject, analysisId: observedId, lastObservedStatus: lastStatus, automaticRetry: false, error: error instanceof Error ? error.message.slice(0, 800) : "unknown" }, null, 2));
  await page
    .screenshot({ path: path.join(out, "failure.png"), fullPage: true })
    .catch(() => {});
  console.error(
    JSON.stringify({
      state: "failed",
      error: error instanceof Error ? error.message.slice(0, 800) : "unknown",
      evidence: path.relative(root, out),
    }),
  );
  process.exitCode = 1;
} finally {
  await browser.close();
}
