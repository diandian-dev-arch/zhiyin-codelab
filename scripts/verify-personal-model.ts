// Isolated browser verification. All model replies are fixtures; no external API calls.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { zipSync, strToU8 } from "fflate";
import { createApp, type Config } from "../apps/api/src/app.js";
import { createUserModelService } from "../apps/api/src/user-model-settings.js";
import { migrate } from "../apps/api/src/db.js";
import { seed } from "../apps/api/src/seed.js";
import { testDB } from "../tests/db.js";
import { root, hashTemplateFiles, templateFiles } from "../apps/api/src/template.js";
import { createDevelopmentPack } from '../packages/contracts/src/v2/index.js';

const directory = path.join(
  root,
  `docs/verification/${new Date(Date.now()+8*3600_000).toISOString().slice(0,10)}`,
  `personal-model-${randomUUID()}`,
);
await mkdir(directory, { recursive: true });
const db = await testDB();
await migrate(db);
const password = randomUUID();
await seed(db, password);
const section = {
  title: "入口",
  body: "读取样本源码",
  citations: [{ path: "sample/main.py", start: 1, end: 1 }],
};
const report = {
  overview: "个人模型分析样本",
  stack: ["Python"],
  modules: [section],
  flows: [section],
  findings: [],
  readingPath: [section],
  limitations: ["固定测试回复，不代表模型质量"],
};
const keys: string[] = [];
let hold = false;
let release = () => {};
let gate = Promise.resolve();
const userModels = createUserModelService(db, randomBytes(32), (env) => ({
  configuration: {
    provider: "fixture",
    model: env.MODEL_NAME!,
    endpoint: env.MODEL_BASE_URL!,
  },
  complete: async (input) => {
    keys.push(env.MODEL_API_KEY!);
    if (hold) await gate;
    const data = JSON.parse(input.user);
    return {
      content: JSON.stringify(
        data.purpose
          ? { status: "ok" }
          : data.draft
            ? data.checkShape || data.shape
              ? { report, checks: [] }
              : { reads: [], searches: [] }
            : data.shape
              ? report
              : { paths: ["sample/main.py"] },
      ),
      raw: "fixture",
      requestId: null,
      usage: { inputTokens: 24, outputTokens: 8 },
    };
  },
}));
const config: Config = {
  packs: [await createDevelopmentPack('new-only', {
    packVersion:'personal-model-browser-fixture', templateVersion:'vue-board-v1',
    templateHash:hashTemplateFiles(await templateFiles()), dependencyLockHash:'b'.repeat(64),
    initializationVersion:'fixture-v1', caseImplementationHashes:{'NEW-01':'c'.repeat(64)},
  })],
  origin: "http://127.0.0.1",
  secure: false,
  // No worker is started. Course queues below are generated fixtures and explicitly cancelled.
  executionApproved: true,
  model: "fixture",
  image: "none",
  businessVersion: 2,
  userModels,
};
const app = await createApp(db, config);
const apiOrigin = await app.listen({ host: "127.0.0.1", port: 0 });
const webRequire = createRequire(path.join(root, "apps/web/package.json"));
const { createServer } = await import(
  pathToFileURL(webRequire.resolve("vite")).href
);
const web = await createServer({
  root: path.join(root, "apps/web"),
  server: { host: "127.0.0.1", port: 0, proxy: { "/api": apiOrigin } },
});
await web.listen();
config.origin = `http://127.0.0.1:${web.httpServer.address().port}`;
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1040 } });
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
const result: Record<string, unknown> = { externalModelCalls: 0 };
try {
  async function login(p: typeof page, email: string) {
    await p.goto(config.origin + "/projects");
    await p.getByLabel("邮箱").fill(email);
    await p.getByLabel("密码", { exact: true }).fill(password);
    await p.getByRole("button", { name: "登录", exact: true }).click();
    await expect(p.getByLabel("上传项目 ZIP")).toBeVisible();
  }
  await login(page, "student@codelab.local");
  await expect(page.getByLabel("上传项目 ZIP")).toBeDisabled();
  await page.getByRole("button", { name: "配置我的模型" }).click();
  const dialog = page.getByRole("dialog", { name: "个人模型设置" });
  await expect(dialog.getByLabel("API Key", { exact: true })).toBeEnabled();
  await dialog
    .getByLabel("API Key", { exact: true })
    .fill("fixture-student-key");
  await dialog.getByRole("button", { name: "测试连接", exact: true }).click();
  await expect(dialog).toContainText("连接通过");
  assert.equal(keys.length, 1);
  await dialog.getByRole("button", { name: "保存配置", exact: true }).click();
  await expect(dialog).toContainText("配置已保存");
  await expect(dialog.getByLabel("API Key", { exact: true })).toHaveValue("");
  assert.equal(keys.length, 1);
  await page.screenshot({
    path: path.join(directory, "settings-desktop.png"),
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(page.getByLabel("上传项目 ZIP")).toBeEnabled();
  await page.getByRole("button", { name: "模型设置", exact: true }).click();
  await expect(dialog.getByLabel("API Key", { exact: true })).toHaveValue("");
  await expect(dialog).toContainText("已保存密钥");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: path.join(directory, "settings-mobile.png"),
    fullPage: true,
  });
  assert(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1));
  for (let i = 0; i < 14; i++) {
    await page.keyboard.press("Tab");
    assert(await dialog.evaluate((el) => el.contains(document.activeElement)));
  }
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1440, height: 1040 });
  hold = true;
  gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page
    .getByLabel("上传项目 ZIP")
    .setInputFiles({
      name: "personal-sample.zip",
      mimeType: "application/zip",
      buffer: Buffer.from(zipSync({ "sample/main.py": strToU8("print(1)") })),
    });
  await page.waitForURL(/\/projects\/[a-f0-9-]+$/);
  const projectId = page.url().split("/").at(-1)!;
  await page.getByRole("button", { name: "模型设置", exact: true }).click();
  await expect(dialog).toContainText("当前账号有正在排队或执行的分析");
  await expect(dialog.getByRole("button", { name: "保存配置" })).toBeDisabled();
  await expect(
    dialog.getByRole("button", { name: "移除密钥", exact: true }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  hold = false;
  release();
  await expect(page.locator(".source-report")).toBeVisible({ timeout: 30000 });
  const before = await (
    await page.request.get(config.origin + "/api/v2/projects/" + projectId)
  ).json();
  assert.equal(before.analyses[0].status, "succeeded");
  assert(before.analyses[0].execution_snapshot.model.credentialRevision);
  assert(keys.every((k) => k === "fixture-student-key"));
  const other = await browser.newPage();
  await login(other, "teacher@codelab.local");
  await expect(other.getByLabel("上传项目 ZIP")).toBeDisabled();
  assert.equal(
    (
      await other.request.get(config.origin + "/api/v2/projects/" + projectId)
    ).status(),
    404,
  );
  await other.getByRole("button", { name: "配置我的模型" }).click();
  await other
    .getByLabel("API Key", { exact: true })
    .fill("fixture-teacher-key");
  await other.getByRole("button", { name: "测试连接", exact: true }).click();
  await expect(other.getByRole("dialog")).toContainText("连接通过");
  assert.equal(keys.at(-1), "fixture-teacher-key");
  await other.keyboard.press('Escape');
  const taskId=(await db.query('SELECT id FROM tasks LIMIT 1')).rows[0].id;
  await other.goto(config.origin+'/tasks/'+taskId);
  await expect(other.getByLabel('检查后的 AI 分析')).toHaveValue('off');
  const approval=other.getByLabel('我已确认以上要求与本次课程任务一致');
  if (!await approval.isVisible()) await other.getByText('选择验收包并发布新规则', {exact:true}).click();
  await approval.check();
  await other.getByRole('button',{name:'发布新规则',exact:true}).click();
  await expect(other.getByRole('status')).toContainText('新规则已发布');
  await page.goto(config.origin+'/tasks/'+taskId);
  const selection=page.getByLabel('检查后的 AI 分析');
  await expect(selection).toHaveValue('off');
  await page.getByLabel('项目 ZIP',{exact:true}).setInputFiles(path.join(root,'fixtures/correct.zip'));
  await page.getByRole('button',{name:'保存提交',exact:true}).click();
  await expect(page.getByRole('button',{name:'创建检查',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'创建检查',exact:true}).click();
  await expect(page.getByRole('status')).toContainText('已进入检查队列');
  let course=(await db.query('SELECT * FROM runs WHERE contract_version=2 ORDER BY created_at DESC')).rows[0];
  assert.equal(course.execution_config.initialAnalysisMode,'off');
  assert.equal(course.execution_config.initialModel,undefined);
  await page.getByRole('button',{name:'取消排队',exact:true}).click();
  await selection.selectOption('summary');
  await page.getByRole('button',{name:'再次检查此提交',exact:true}).click();
  await expect(page.getByRole('status')).toContainText('已进入检查队列');
  course=(await db.query('SELECT * FROM runs WHERE contract_version=2 ORDER BY created_at DESC')).rows[0];
  assert.equal(course.execution_config.initialAnalysisMode,'summary');
  const studentId=(await db.query("SELECT id FROM users WHERE role='student'")).rows[0].id;
  assert.equal(course.execution_config.initialModel.billingUserId,studentId);
  await expect(selection).toHaveValue('off');
  await page.getByRole('button',{name:'模型设置',exact:true}).click();
  await expect(page.getByRole('dialog')).toContainText('当前账号有正在排队或执行的分析');
  await expect(page.getByRole('button',{name:'保存配置',exact:true})).toBeDisabled();
  await page.keyboard.press('Escape');
  await page.screenshot({path:path.join(directory,'course-settings-desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1));
  await page.screenshot({path:path.join(directory,'course-settings-mobile.png'),fullPage:true});
  await page.getByRole('button',{name:'取消排队',exact:true}).click();
  assert.equal((await userModels.state(studentId)).active,false);
  await page.setViewportSize({width:1440,height:1040});
  await page.goto(config.origin+'/projects/'+projectId);
  await expect(page.locator('.source-report')).toBeVisible();
  result.courseChecks=['default no model','explicit summary choice','actor billing snapshot','selection reset','queued profile locked','cancel unlocks','mobile no overflow'];
  await other.close();
  await page.getByRole("button", { name: "模型设置", exact: true }).click();
  await expect(
    dialog.getByRole("button", { name: "移除密钥", exact: true }),
  ).toBeEnabled();
  await dialog.getByRole("button", { name: "移除密钥", exact: true }).click();
  await dialog.getByRole("button", { name: "确认移除密钥" }).click();
  await expect(dialog).toContainText("密钥已移除");
  await page.keyboard.press("Escape");
  await page.reload();
  await expect(page.locator(".source-report")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "配置我的模型" }),
  ).toBeVisible();
  const after = await (
    await page.request.get(config.origin + "/api/v2/projects/" + projectId)
  ).json();
  assert.equal(after.available, false);
  assert.deepEqual(after.analyses, before.analyses);
  await page.screenshot({
    path: path.join(directory, "history-after-key-removal.png"),
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  Object.assign(result, {
    state: "passed",
    fixtureCalls: keys.length,
    checks: [
      "per-account isolation",
      "test without saving",
      "save without billing",
      "masked after reopen",
      "mobile no overflow",
      "keyboard focus trap",
      "active profile locked",
      "upload through personal provider",
      "snapshot revision",
      "remove preserves reports",
    ],
    pageErrors: errors,
  });
} catch (error) {
  Object.assign(result, {
    state: "failed",
    error: error instanceof Error ? error.message : String(error),
  });
  await page.screenshot({
    path: path.join(directory, "failure.png"),
    fullPage: true,
  });
  process.exitCode = 1;
} finally {
  hold = false;
  release();
  await browser.close();
  await web.close();
  await app.close();
  await db.close();
  await writeFile(
    path.join(directory, "result.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify({ directory, ...result }));
}
