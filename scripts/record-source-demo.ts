// Real product replay. No new model request or course execution is triggered.
import { chromium, expect, request } from "@playwright/test";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import path from "node:path";
import { root } from "../apps/api/src/template.js";

const origin = "http://127.0.0.1:5174";
const projectId = "f2370e8a-9427-437c-b0c7-c9b1121217ae";
const id = randomUUID();
const out = path.join(root, "output/submission-demo", id);
const privateDir = path.join(root, ".data/demo-recording", id);
await mkdir(out, { recursive: true });
await mkdir(privateDir, { recursive: true });
const credentials = JSON.parse(
  await readFile(
    path.join(root, ".data/business-v2/development-credentials.json"),
    "utf8",
  ),
);
const auth = await request.newContext({ baseURL: origin });
const login = await auth.post("/api/v1/session/login", {
  headers: { origin },
  data: { email: "teacher@codelab.local", password: credentials.loginPassword },
});
expect(login.status()).toBe(200);
const before = await (await auth.get(`/api/v2/projects/${projectId}`)).json();
expect(before.analyses[0].status).toBe("succeeded");
const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  storageState: await auth.storageState(),
  recordVideo: { dir: privateDir, size: { width: 1440, height: 1000 } },
});
const page = await context.newPage();
const video = page.video()!;
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
const began = Date.now();
const chapters: { start: number; end: number; caption: string }[] = [];
const hold = async (caption: string, seconds = 5) => {
  const start = (Date.now() - began) / 1000;
  await page.waitForTimeout(seconds * 1000);
  chapters.push({ start, end: (Date.now() - began) / 1000, caption });
};
try {
  await page.goto(origin + "/projects");
  await expect(page.locator(".upload-stage")).toBeVisible();
  await page.screenshot({ path: path.join(out, "upload.png") });
  await hold(
    "真实工作台回放：普通 ZIP 入口。本片复用已保存的分析，不触发新的模型调用。",
  );
  await page
    .getByLabel("上传项目 ZIP")
    .setInputFiles(
      path.join(
        root,
        "output/museum-source-analysis/河洛数字博物馆_源码分析.zip",
      ),
    );
  await page.waitForURL(origin + `/projects/${projectId}`);
  await expect(page.locator(".source-report")).toBeVisible();
  await page.screenshot({ path: path.join(out, "investigation.png") });
  await hold(
    "重复上传同一份 ZIP，系统复用已有项目。本次历史分析 53 秒，实际阅读 19 个文件片段。",
  );
  await page.locator(".report-tabs").scrollIntoViewIfNeeded();
  // Element screenshots can temporarily enlarge the viewport and corrupt the
  // screencast framing. Keep all recording screenshots at the fixed viewport.
  await page.screenshot({ path: path.join(out, "report.png") });
  await hold(
    "项目全景与模块职责：认证、内容、预约和订单。481 个文件已索引，不代表全部审计完成。",
  );
  await page.getByRole("button", { name: /业务链路/ }).click();
  await page.screenshot({ path: path.join(out, "flows.png") });
  await hold("业务链路展示预约和订单创建步骤，每条说明附带可打开的源码引用。");
  await page.locator(".citations button").first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.locator("code.highlight").first()).toBeVisible();
  await page.screenshot({ path: path.join(out, "citation.png") });
  await hold(
    "点击引用直接定位原始代码行。出处有效，并不自动证明模型推论正确。",
    6,
  );
  await page.getByRole("button", { name: "关闭源码" }).click();
  await page.getByRole("button", { name: /反证复核/ }).click();
  const withdrawn = page
    .locator("article")
    .filter({ has: page.locator(".review-decision.withdrawn") });
  await expect(withdrawn).toHaveCount(1);
  await withdrawn.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(out, "withdrawn.png") });
  await hold(
    "反证复核撤回“单条 INSERT 缺少事务注解”的初步判断。其余建议仍需人工判断。",
    7,
  );
  await page.getByRole("button", { name: /阅读路线/ }).click();
  await page.locator(".report-tabs").scrollIntoViewIfNeeded();
  await hold(
    "阅读路线帮助继续理解项目。配置风险、会话机制等模型表述仍有误差，详见人工更正文档。",
    6,
  );
  expect(errors).toEqual([]);
  const after = await (await auth.get(`/api/v2/projects/${projectId}`)).json();
  expect(after.analyses.map((a: any) => a.id)).toEqual(
    before.analyses.map((a: any) => a.id),
  );
  await context.close();
  const videoPath = path.join(out, "CodeLab_源码分析_真实页面回放.webm");
  await video.saveAs(videoPath);
  const timestamp = (seconds: number) =>
    new Date(Math.round(seconds * 1000)).toISOString().slice(11, 23);
  await writeFile(
    path.join(out, "CodeLab_源码分析_真实页面回放.vtt"),
    "WEBVTT\n\n" +
      chapters
        .map(
          (c, i) =>
            `${i + 1}\n${timestamp(c.start)} --> ${timestamp(c.end)}\n${c.caption}\n`,
        )
        .join("\n"),
  );
  const bytes = await readFile(videoPath);
  await writeFile(
    path.join(out, "result.json"),
    JSON.stringify(
      {
        id,
        projectId,
        analysisId: before.analyses[0].id,
        capturedAt: new Date().toISOString(),
        state: "recorded-real-product-replay",
        newModelCalls: 0,
        analysisHistoryUnchanged: true,
        browserErrors: errors,
        videoBytes: bytes.length,
        videoSha256: createHash("sha256").update(bytes).digest("hex"),
        chapters,
        limitations: [
          "Historical report replay, not live model generation",
          "No audio narration",
          "Source review only, not a course execution or teacher-publishing recording",
        ],
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      state: "recorded",
      directory: path.relative(root, out),
      bytes: bytes.length,
    }),
  );
} finally {
  await context.close();
  await browser.close();
  await auth.dispose();
}
