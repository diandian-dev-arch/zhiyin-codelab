import { chromium } from "playwright";
import { readFile, writeFile } from "node:fs/promises";
const mode = process.argv[2],
  input = JSON.parse(await readFile("/input.json", "utf8"));
const browser = await chromium.launch({
  headless: true,
  args: [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-features=WebRtcHideLocalIpsWithMdns",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
  ],
});
const result = {
  outcome: "complete",
  results: [],
  evidence: [],
  screenshots: {},
};
// Check the trusted static server before attributing browser failures to student code.
const readyUntil = Date.now() + 18000;
let ready = false;
while (Date.now() < readyUntil) {
  try {
    const response = await fetch("http://project:8080/", {
      signal: AbortSignal.timeout(1000),
    });
    if (response.ok) {
      ready = true;
      await response.body?.cancel();
      break;
    }
  } catch {}
  await new Promise((r) => setTimeout(r, 200));
}
if (!ready) {
  await browser.close();
  throw new Error("Project server readiness failed; infrastructure error");
}
async function setup() {
  const context = await browser.newContext({
    viewport: { width: 1120, height: 760 },
    acceptDownloads: false,
    serviceWorkers: "block",
  });
  await context.route("**/*", (route) => {
    let u;
    try {
      u = new URL(route.request().url());
    } catch {
      return route.abort();
    }
    return u.origin === "http://project:8080" && !u.username && !u.password
      ? route.continue()
      : route.abort();
  });
  await context.routeWebSocket("**/*", (ws) => ws.close());
  context.setDefaultTimeout(1800);
  const page = await context.newPage();
  page.on("popup", (p) => p.close());
  return { page, context };
}
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
async function add(page, title) {
  await page.getByTestId("task-input").fill(title);
  await page.getByTestId("add-task").click();
}
const definitions = {
  create: {
    steps: ["输入任务名称“验收任务 A”", "点击新增任务", "检查列表出现该任务"],
    run: async (p) => {
      await add(p, "验收任务 A");
      assert(
        await p
          .getByTestId("task-title")
          .allTextContents()
          .then((x) => x.includes("验收任务 A")),
        "新增后列表中未出现任务名称",
      );
    },
  },
  edit: {
    steps: ["新增任务 A", "点击编辑", "改为任务 B 并保存", "检查新名称"],
    run: async (p) => {
      await add(p, "任务 A");
      await p.getByTestId("edit-task").first().click();
      await p.getByTestId("edit-input").fill("任务 B");
      await p.getByTestId("save-task").click();
      assert(
        (await p.getByTestId("task-title").allTextContents()).includes(
          "任务 B",
        ),
        "保存后未显示修改的名称",
      );
    },
  },
  delete: {
    steps: ["新增任务 A", "点击删除", "检查列表不再包含任务"],
    run: async (p) => {
      await add(p, "任务 A");
      await p.getByTestId("delete-task").first().click();
      assert(
        (await p.getByTestId("task-row").count()) === 0,
        "删除后任务仍存在",
      );
    },
  },
  toggle: {
    steps: ["新增任务 A", "勾选完成", "确认状态并切回未完成"],
    run: async (p) => {
      await add(p, "任务 A");
      const t = p.getByTestId("task-toggle").first();
      await t.check();
      assert(await t.isChecked(), "任务没有变为已完成");
      await t.uncheck();
      assert(!(await t.isChecked()), "任务没有恢复未完成");
    },
  },
  filter: {
    steps: [
      "新增任务 A 和 B",
      "将 A 标记已完成",
      "选择已完成筛选，应只有 A",
      "选择未完成筛选，应只有 B",
      "切回全部，应有两项",
    ],
    run: async (p) => {
      await add(p, "任务 A");
      await add(p, "任务 B");
      await p.getByTestId("task-toggle").first().check();
      await p.getByTestId("filter").selectOption("done");
      assert(
        JSON.stringify(await p.getByTestId("task-title").allTextContents()) ===
          JSON.stringify(["任务 A"]),
        "已完成筛选显示了不符合条件的任务",
      );
      await p.getByTestId("filter").selectOption("active");
      assert(
        JSON.stringify(await p.getByTestId("task-title").allTextContents()) ===
          JSON.stringify(["任务 B"]),
        "未完成筛选结果不正确",
      );
      await p.getByTestId("filter").selectOption("all");
      assert(
        (await p.getByTestId("task-row").count()) === 2,
        "切回全部时任务数量不正确",
      );
    },
  },
  validation: {
    steps: ["输入纯空白并新增", "检查没有空任务且出现提示"],
    run: async (p) => {
      await add(p, "   ");
      assert((await p.getByTestId("task-row").count()) === 0, "创建了空白任务");
      assert(
        (await p.getByTestId("validation-error").innerText()).trim().length > 0,
        "缺少空白输入提示",
      );
    },
  },
  persistence: {
    steps: ["新增任务 A 并完成", "刷新页面", "检查任务名称及状态仍保留"],
    run: async (p) => {
      await add(p, "任务 A");
      await p.getByTestId("task-toggle").first().check();
      await p.reload({ waitUntil: "domcontentloaded" });
      assert(
        (await p.getByTestId("task-title").allTextContents()).includes(
          "任务 A",
        ),
        "刷新后任务丢失",
      );
      assert(
        await p.getByTestId("task-toggle").first().isChecked(),
        "刷新后完成状态丢失",
      );
    },
  },
};
try {
  if (mode === "probe") {
    const { page, context } = await setup();
    await page.goto("http://project:8080/", {
      waitUntil: "domcontentloaded",
      timeout: 5000,
    });
    const observations = [];
    for (const a of input.actions) {
      switch (a.type) {
        case "open": {
          const url = new URL(a.path, "http://project:8080");
          if (url.origin !== "http://project:8080")
            throw new Error("external navigation");
          await page.goto(url.href, {
            waitUntil: "domcontentloaded",
            timeout: 3000,
          });
          break;
        }
        case "click":
          await page.getByTestId(a.testId).click();
          break;
        case "fill":
          await page.getByTestId(a.testId).fill(a.value);
          break;
        case "select":
          await page.getByTestId(a.testId).selectOption(a.value);
          break;
        case "read":
          observations.push(
            (await page.getByTestId(a.testId).allTextContents())
              .join("\n")
              .slice(0, 3000),
          );
          break;
        default:
          throw new Error("unsupported action");
      }
    }
    await writeFile(
      "/evidence/probe.json",
      JSON.stringify({
        observations,
        body: (await page.locator("body").innerText()).slice(0, 6000),
      }),
    );
    await context.close();
  } else {
    for (const c of input) {
      if (c.mode === "manual") {
        result.results.push({
          criterionId: c.id,
          status: "manual",
          observation: "此项需要教师人工判断。",
          steps: [],
          evidenceIds: [],
        });
        continue;
      }
      const def = definitions[c.check];
      const { page, context } = await setup();
      const errors = [];
      page.on("pageerror", (e) => {
        if (errors.length < 10) errors.push(e.message.slice(0, 1000));
      });
      page.on("console", (m) => {
        if (m.type() === "error" && errors.length < 10)
          errors.push(m.text().slice(0, 1000));
      });
      let status = "passed",
        observation = "指定行为检查通过。";
      try {
        await page.goto("http://project:8080/", {
          waitUntil: "domcontentloaded",
          timeout: 5000,
        });
        await def.run(page);
      } catch (e) {
        status = "failed";
        observation = String(e.message).slice(0, 2000);
      }
      const evidenceIds = [];
      const dom = c.id + "-dom";
      let body = "";
      try {
        body = (await page.locator("body").innerText({ timeout: 1000 })).slice(
          0,
          12000,
        );
      } catch {}
      result.evidence.push({
        id: dom,
        kind: "dom",
        title: "检查结束时的页面文本",
        text: body,
      });
      evidenceIds.push(dom);
      const shot = c.id + "-screen";
      try {
        await page.screenshot({
          path: "/evidence/" + shot + ".png",
          timeout: 2500,
          animations: "disabled",
        });
        result.evidence.push({
          id: shot,
          kind: "screenshot",
          title: "检查结束时的页面截图",
        });
        evidenceIds.push(shot);
      } catch {}
      const log = c.id + "-log";
      result.evidence.push({
        id: log,
        kind: "log",
        title: "检查记录与页面错误",
        text: JSON.stringify({
          steps: def.steps,
          observation,
          consoleErrors: errors,
        }),
      });
      evidenceIds.push(log);
      result.results.push({
        criterionId: c.id,
        status,
        observation,
        steps: def.steps,
        evidenceIds,
      });
      await context.close();
    }
    await writeFile("/evidence/result.json", JSON.stringify(result));
  }
} finally {
  await browser.close();
}
