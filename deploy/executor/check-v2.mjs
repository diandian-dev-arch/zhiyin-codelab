import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CheckerFault,
  CONTEXT_OPTIONS,
  ENVIRONMENT_POLICIES,
  PROJECT_ORIGIN,
  isAllowedProjectUrl,
  runNewCase,
  validateCheckerInput,
} from "./v2-new-case.mjs";
import { runFilterCase, validateFilterDefinition } from "./v2-filter-case.mjs";
import { runCoreCase, validateCoreDefinition } from "./v2-core-case.mjs";

const require = createRequire(import.meta.url);
const INPUT_PATH = "/artifacts/check-request.json";
const OUTPUT_DIRECTORY = "/artifacts";
const PNG_MAX_BYTES = 1024 * 1024;
const TEXT_MAX_BYTES = 64 * 1024;
const BUNDLE_FILENAMES = ["check-v2.mjs", "v2-new-case.mjs", "v2-filter-case.mjs", "v2-core-case.mjs", "probe-v2.mjs", "v2-filter-probe.mjs", "v2-probe-capture.mjs"];

export function validateBatchInput(input) {
  if (!input || !Array.isArray(input.caseDefinitions) || !input.caseDefinitions.length || input.caseDefinitions.length > 8 ||
    new Set(input.caseDefinitions.map(c => c.caseId)).size !== input.caseDefinitions.length)
    throw new Error("CHECKER_INPUT_INVALID");
  if (!input.parameterValues || Object.keys(input.parameterValues).some(key => key !== "requireValidationMessage") ||
      ("requireValidationMessage" in input.parameterValues && typeof input.parameterValues.requireValidationMessage !== "boolean") ||
          Object.keys(input).some(key => !["caseDefinitions", "parameterValues", "remainingWorkMs"].includes(key)) ||
          (input.remainingWorkMs !== undefined && (!Number.isSafeInteger(input.remainingWorkMs) || input.remainingWorkMs < 1 || input.remainingWorkMs > 300000)))
        throw new Error("CHECKER_INPUT_INVALID");
  for (const definition of input.caseDefinitions) {
    if (definition.caseId === "NEW-01") validateCheckerInput({ ...input, parameterValues: {}, caseDefinitions: [definition] });
    else if (definition.caseId?.startsWith("FILTER-")) validateFilterDefinition(definition);
    else validateCoreDefinition(definition);
  }
  return input;
}

async function checkerIdentity() {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const files = [];
  for (const filename of BUNDLE_FILENAMES) {
    const bytes = await readFile(path.join(directory, filename));
    files.push({
      filename,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  return {
    checkerFiles: files,
    checkerImplementationHash: createHash("sha256")
      .update(JSON.stringify({ version: "new01-checker-bundle-v1", files }))
      .digest("hex"),
  };
}

export async function installNetworkPolicy(context, onBlocked = () => {}) {
  // HTTP routing does not intercept WebRTC. This course does not use peer
  // connections; disable page constructors before student scripts, including
  // child frames. This is page capability reduction, not a host firewall.
  await context.addInitScript(() => {
    for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection']) {
      Object.defineProperty(globalThis, name, {
        value: undefined, writable: false, configurable: false,
      });
    }
  });
  await context.route("**/*", async (route) => {
    if (!isAllowedProjectUrl(route.request().url())) {
      onBlocked();
      await route.abort("blockedbyclient");
      return;
    }
    // Playwright does not route the subsequent requests in an HTTP redirect
    // chain after route.continue(). The trusted project server only serves
    // static files; reject redirects rather than letting Chromium follow one
    // outside the fixed origin. Fetch exactly one hop, with no retry.
    let response;
    try {
      response = await route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: 10000 });
      if (response.status() >= 300 && response.status() < 400) {
        onBlocked();
        await route.abort("blockedbyclient");
      } else {
        await route.fulfill({ response });
      }
    } catch {
      // A closed context or failed upstream request must never fall back to
      // continue(), which would reopen the redirect bypass.
      await route.abort("failed").catch(() => {});
    } finally {
      await response?.dispose().catch(() => {});
    }
  });
  // This task has no WebSocket feature; never let a socket bypass HTTP routing.
  await context.routeWebSocket("**/*", (socket) => {
    onBlocked();
    socket.close();
  });
}

export async function measuredEnvironment(browser, playwrightVersion) {
  const context = await browser.newContext(CONTEXT_OPTIONS);
  try {
    const probeUrl = `${PROJECT_ORIGIN}/__codelab_platform_probe__`;
    // The fixed origin is fulfilled in-process. No request reaches a network or
    // student page, so the probe observes native browser behavior only.
    await context.route("**/*", async (route) => {
      if (route.request().url() === probeUrl)
        await route.fulfill({
          status: 200,
          contentType: "text/html; charset=utf-8",
          headers: { "content-security-policy": "default-src 'none'" },
          body: "<!doctype html><title>Trusted platform measurement</title>",
        });
      else await route.abort("blockedbyclient");
    });
    await context.routeWebSocket("**/*", (socket) => socket.close());
    const page = await context.newPage();
    await page.goto(probeUrl, { waitUntil: "domcontentloaded", timeout: 5000 });
    const actual = await page.evaluate(() => ({
      viewport: {
        width: innerWidth,
        height: innerHeight,
        deviceScaleFactor: devicePixelRatio,
      },
      locale: navigator.language,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      origin: location.origin,
      secureContext: isSecureContext,
      uuidSamples:
        typeof crypto.randomUUID === "function"
          ? [crypto.randomUUID(), crypto.randomUUID()]
          : [],
    }));
    if (
      actual.origin !== PROJECT_ORIGIN ||
      actual.secureContext !== true ||
      actual.uuidSamples.length !== 2 ||
      actual.uuidSamples[0] === actual.uuidSamples[1] ||
      actual.uuidSamples.some(
        (uuid) =>
          !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
            uuid,
          ),
      )
    )
      throw new Error("CHECKER_PAGE_SERVER_POLICY_MISMATCH");
    return {
      browserVersion: browser.version(),
      playwrightVersion,
      environment: {
        viewport: actual.viewport,
        locale: actual.locale,
        timezone: actual.timezone,
        ...ENVIRONMENT_POLICIES,
      },
      ...(await checkerIdentity()),
    };
  } finally {
    await context.close();
  }
}

export function createDriver(browser) {
  let context;
  let page;
  let blockedRequests = 0;
  let interrupted = false;
  const consoleEntries = [];
  const recordConsole = (kind, message) => {
    if (consoleEntries.length < 20)
      consoleEntries.push({
        kind,
        message: String(message).slice(0, 500),
        capturedAt: new Date().toISOString(),
      });
  };
  const close = async () => {
    if (context) {
      const closing = context.close().catch(() => {});
      let timer;
      try {
        await Promise.race([
          closing,
          new Promise((resolve) => {
            timer = setTimeout(resolve, 1000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }
  };
  const snapshot = async () => {
    if (!page || page.isClosed())
      throw new CheckerFault(
        "INFRA_ERROR",
        "浏览器页面已关闭，无法取得任务观察。",
        "browser",
      );
    return page.getByTestId("task-row").evaluateAll((rows) => ({
      count: rows.length,
      titles: rows.slice(0, 101).map((row) => {
        const titles = row.querySelectorAll('[data-testid="task-title"]');
        if (titles.length !== 1) return null;
        const text = titles[0].textContent ?? "";
        return text.length > 200 ? null : text.trim();
      }),
    }));
  };
  return {
    async open(timeoutMs) {
      context = await browser.newContext(CONTEXT_OPTIONS);
      await installNetworkPolicy(context, () => {
        blockedRequests += 1;
      });
      context.on("page", (newPage) => {
        if (page && newPage !== page) void newPage.close().catch(() => {});
      });
      page = await context.newPage();
      page.on("pageerror", (error) =>
        recordConsole("pageerror", error.message),
      );
      page.on("console", (message) => {
        if (["error", "warning"].includes(message.type()))
          recordConsole(message.type(), message.text());
      });
      page.on("dialog", (dialog) => {
        recordConsole("dialog", dialog.message());
        void dialog.dismiss().catch(() => {});
      });
      page.setDefaultTimeout(Math.min(3000, timeoutMs));
      const response = await page.goto(`${PROJECT_ORIGIN}/`, {
        waitUntil: "domcontentloaded",
        timeout: timeoutMs,
      });
      if (!response || !response.ok() || !isAllowedProjectUrl(page.url()))
        throw new CheckerFault(
          "INFRA_ERROR",
          "可信页面服务没有返回成功的同源页面。",
          "page_service",
        );
      const input = page.getByTestId("task-input");
      const button = page.getByTestId("add-task");
      await input.waitFor({ state: "visible" });
      await button.waitFor({ state: "visible" });
      if (
        (await input.count()) !== 1 ||
        (await button.count()) !== 1 ||
        !(await input.isEditable()) ||
        !(await button.isEnabled())
      )
        throw new CheckerFault(
          "SETUP_BLOCKED",
          "公开新增输入与按钮不能被唯一定位或不可交互。",
          "base_checks",
        );
      return `已创建独立、空存储浏览器上下文；${PROJECT_ORIGIN}/ 返回 HTTP ${response.status()}，确认新增输入与按钮可交互。`;
    },
    snapshot,
    async snapshotStates() {
      await page.waitForTimeout(200);
      return page.getByTestId("task-row").evaluateAll(rows => rows.length > 100 ? null : rows.map(row => {
        const titles = row.querySelectorAll('[data-testid="task-title"]');
        const toggles = row.querySelectorAll('[data-testid="task-toggle"]');
        return titles.length === 1 && toggles.length === 1 && toggles[0].type === "checkbox"
          ? { title: (titles[0].textContent ?? "").trim(), done: toggles[0].checked } : null;
      }));
    },
    async complete(title, timeoutMs) {
      // A title is a generated literal; no student-provided selector is executed.
      const exactRow = page.getByTestId("task-row").filter({ has: page.getByText(title, { exact: true }) });
      if (await exactRow.count() !== 1) throw new CheckerFault("SETUP_BLOCKED", "准备任务不能唯一定位。");
      const toggle = exactRow.getByTestId("task-toggle");
      if (await toggle.count() !== 1 || !(await toggle.isEnabled())) throw new CheckerFault("SETUP_BLOCKED", "准备任务的状态控件不可用。");
      await toggle.check({ timeout: Math.min(3000, timeoutMs) });
    },
    async selectDone(timeoutMs) {
      const filter = page.getByTestId("filter");
      if (await filter.inputValue() !== "all") throw new CheckerFault("OBSERVATION_AMBIGUOUS", "筛选器未处于初始全部状态。");
      await filter.selectOption("done", { timeout: Math.min(3000, timeoutMs) });
    },
    async selectFilter(value, timeoutMs) {
      if (!["all", "active", "done"].includes(value)) throw new Error("FILTER_TARGET_INVALID");
      const filter = page.getByTestId("filter");
      if (await filter.inputValue() !== "all") throw new CheckerFault("OBSERVATION_AMBIGUOUS", "筛选器未处于初始全部状态。");
      await filter.selectOption(value, { timeout: Math.min(3000, timeoutMs) });
    },
    async filterValue(timeoutMs) {
      return page.getByTestId("filter").inputValue({ timeout: Math.min(3000, timeoutMs) });
    },
    async transitionFilter(value, from, timeoutMs) {
      if (!["active", "done"].includes(value) || !["all", "active"].includes(from))
        throw new Error("FILTER_TRANSITION_INVALID");
      const filter = page.getByTestId("filter");
      if (await filter.inputValue({ timeout: Math.min(3000, timeoutMs) }) !== from)
        throw new CheckerFault("OBSERVATION_AMBIGUOUS", "筛选控件不在此预置路径要求的起始值。");
      await filter.selectOption(value, { timeout: Math.min(3000, timeoutMs) });
    },
    async setDone(title, done, timeoutMs) {
      const row = page.getByTestId("task-row").filter({ has: page.getByText(title, { exact: true }) });
      if (await row.count() !== 1) throw new CheckerFault("OBSERVATION_AMBIGUOUS", "目标任务不能唯一定位。");
      const toggle = row.getByTestId("task-toggle");
      if (await toggle.count() !== 1) throw new CheckerFault("OBSERVATION_AMBIGUOUS", "目标状态控件不能唯一定位。");
      if (!(await toggle.isEnabled())) return "目标状态控件被禁用，未点击；后续独立读取实际状态。";
      // Do not wait for the desired checked state: the following independent
      // observation decides whether the requested transition actually happened.
      if (await toggle.isChecked() !== done) await toggle.click({ timeout: Math.min(3000, timeoutMs) });
      return "已通过公开状态控件请求切换，结果由下一步骤独立读取。";
    },
    async reload(timeoutMs) {
      const response = await page.reload({ waitUntil: "domcontentloaded", timeout: timeoutMs });
      if (!response?.ok()) throw new CheckerFault("INFRA_ERROR", "刷新未取得成功页面。", "page_service");
      await page.getByTestId("task-input").waitFor({ state: "visible", timeout: Math.min(3000, timeoutMs) });
    },
    async validationMessage() {
      const message = page.getByTestId("validation-error");
      if (await message.count() === 0) return "";
      if (await message.count() !== 1) throw new CheckerFault("OBSERVATION_AMBIGUOUS", "校验提示不能唯一定位。");
      return await message.isVisible() ? (await message.innerText()).trim().slice(0, 1000) : "";
    },
    async create(title, timeoutMs) {
      await page
        .getByTestId("task-input")
        .fill(title, { timeout: Math.min(3000, timeoutMs) });
      await page
        .getByTestId("add-task")
        .click({ timeout: Math.min(3000, timeoutMs) });
    },
    async observeAfterAction() {
      // A successful click is followed by an actual bounded DOM observation.
      // We do not turn a wait-for-desired-state timeout into a failed assertion.
      await page.waitForTimeout(200);
      return snapshot();
    },
    async interrupt() {
      interrupted = true;
      await close();
    },
    async screenshot() {
      if (!page || page.isClosed() || interrupted) return null;
      return page.screenshot({
        type: "png",
        fullPage: false,
        animations: "disabled",
        timeout: 2000,
      });
    },
    diagnostics: () => ({ blockedRequests, consoleEntries }),
    close,
  };
}

async function writeEvidence(filename, bytes, mediaType, contentOrigin, files, caseId) {
  const limit = mediaType === "image/png" ? PNG_MAX_BYTES : TEXT_MAX_BYTES;
  if (bytes.byteLength > limit) throw new Error("CHECKER_EVIDENCE_TOO_LARGE");
  await writeFile(path.join(OUTPUT_DIRECTORY, filename), bytes, { flag: "wx" });
  files.push({
    filename,
    mediaType,
    caseId,
    contentOrigin,
    capturedAt: new Date().toISOString(),
  });
}

export async function main(args = process.argv.slice(2)) {
  if (args.length && (args.length !== 1 || args[0] !== "--measure"))
    throw new Error("CHECKER_ARGUMENT_INVALID");
  let input;
  if (!args.length) {
    const metadata = await stat(INPUT_PATH);
    if (!metadata.isFile() || metadata.size > TEXT_MAX_BYTES)
      throw new Error("CHECKER_INPUT_TOO_LARGE");
    const bytes = await readFile(INPUT_PATH);
    if (bytes.byteLength > TEXT_MAX_BYTES)
      throw new Error("CHECKER_INPUT_TOO_LARGE");
    input = validateBatchInput(JSON.parse(bytes.toString("utf8")));
  }
  const playwrightVersion = require("playwright/package.json").version;
  if (playwrightVersion !== "1.58.2")
    throw new Error("CHECKER_PLAYWRIGHT_VERSION_MISMATCH");
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({
    // Full Chromium's new headless mode honors the fixed secure-origin policy;
    // the bundled headless shell does not expose native randomUUID at this URL.
    channel: "chromium",
    headless: true,
    chromiumSandbox: true,
    args: [
      "--disable-dev-shm-usage",
      "--disable-background-networking",
      "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
      `--unsafely-treat-insecure-origin-as-secure=${PROJECT_ORIGIN}`,
    ],
  });
  try {
    const measurement = await measuredEnvironment(browser, playwrightVersion);
    if (args[0] === "--measure") {
      process.stdout.write(JSON.stringify(measurement) + "\n");
      return;
    }
    const files = [];
    const caseResults = [];
    const started = performance.now();
    for (const definition of input.caseDefinitions) {
    const caseId = definition.caseId;
    const driver = createDriver(browser);
    const evidenceDiagnostics = [];
    try {
      const remainingWorkMs = Math.max(1, Math.floor((input.remainingWorkMs ?? 150000) - (performance.now() - started)));
      const { caseResult, observation } = caseId === "NEW-01"
        ? await runNewCase({ ...input, parameterValues: {}, caseDefinitions: [definition], remainingWorkMs }, driver)
        : caseId.startsWith("FILTER-") ? await runFilterCase(definition, driver, remainingWorkMs)
        : await runCoreCase(definition, driver, input.parameterValues, remainingWorkMs);
      await mkdir(OUTPUT_DIRECTORY, { recursive: true });
      try {
        const png = await driver.screenshot();
        if (png && png.byteLength <= PNG_MAX_BYTES) {
          const filename = `${caseId}-screen.png`;
          await writeEvidence(
            filename,
            png,
            "image/png",
            "rendered_page",
            files,
            caseId,
          );
          caseResult.evidenceIds.push(filename);
        } else
          evidenceDiagnostics.push(
            png
              ? "Screenshot exceeded 1MiB and was not retained."
              : "No live page remained for a screenshot.",
          );
      } catch (error) {
        evidenceDiagnostics.push(
          `Screenshot not retained: ${error instanceof Error ? error.name : "UnknownError"}`,
        );
      }
      const diagnostics = driver.diagnostics();
      if (diagnostics.consoleEntries.length) {
        const filename = `${caseId}-console.json`;
        await writeEvidence(
          filename,
          Buffer.from(
            JSON.stringify({
              entries: diagnostics.consoleEntries,
              entryLimit: 20,
            }),
          ),
          "application/json",
          "student_console",
          files,
          caseId,
        );
        caseResult.evidenceIds.push(filename);
      }
      await writeEvidence(
        `${caseId}-observation.json`,
        Buffer.from(
          JSON.stringify({
            ...observation,
            caseResult,
            blockedRequests: diagnostics.blockedRequests,
            evidenceDiagnostics,
          }),
        ),
        "application/json",
        "checker_observation",
        files,
        caseId,
      );
      caseResults.push(caseResult);
    } finally {
      await driver.close();
    }
    }
    await writeFile(path.join(OUTPUT_DIRECTORY, "check-result.json"), JSON.stringify({ caseResults, files, ...measurement }), { flag: "wx" });
  } finally {
    await browser.close();
  }
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  main().catch((error) => {
    // Do not serialize input, tokens, environment values or complete browser errors.
    process.stderr.write(
      JSON.stringify({
        error: "CHECKER_FAILED",
        kind: error instanceof Error ? error.name : "UnknownError",
      }) + "\n",
    );
    process.exitCode = 1;
  });
}
