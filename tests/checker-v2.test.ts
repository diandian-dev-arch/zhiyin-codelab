import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  createDevelopmentPack,
  validateCaseResult,
  type CaseDefinition,
} from "../packages/contracts/src/v2/index";
// The trusted checker ships as plain ESM directly in the browser image.
const checkerModulePath = "../deploy/executor/v2-new-case.mjs";
const { CheckerFault, isAllowedProjectUrl, runNewCase, validateCheckerInput } =
  await import(checkerModulePath);
const browserCheckerModulePath = "../deploy/executor/check-v2.mjs";
const { measuredEnvironment, installNetworkPolicy } = await import(browserCheckerModulePath);

describe('network redirect fail-closed policy', () => {
  async function fixture(status = 200) {
    let handler: (route: unknown) => Promise<void> = async () => {};
    const blocked = vi.fn();
    await installNetworkPolicy({
      addInitScript: vi.fn(async () => {}),
      route: async (_pattern: string, fn: typeof handler) => { handler = fn; },
      routeWebSocket: vi.fn(async () => {}),
    }, blocked);
    const response = { status: () => status, dispose: vi.fn(async () => {}) };
    const route = {
      request: () => ({ url: () => 'http://project:8080/index.html' }),
      fetch: vi.fn(async () => response), fulfill: vi.fn(async () => {}),
      abort: vi.fn(async () => {}), continue: vi.fn(async () => {}),
    };
    return { handler, blocked, route, response };
  }
  it.each([301, 302, 303, 307, 308])('rejects HTTP %i before Chromium can follow it', async status => {
    const f = await fixture(status); await f.handler(f.route);
    expect(f.route.fetch).toHaveBeenCalledWith({ maxRedirects: 0, maxRetries: 0, timeout: 10000 });
    expect(f.route.abort).toHaveBeenCalledWith('blockedbyclient');
    expect(f.route.fulfill).not.toHaveBeenCalled(); expect(f.route.continue).not.toHaveBeenCalled();
    expect(f.blocked).toHaveBeenCalledOnce(); expect(f.response.dispose).toHaveBeenCalledOnce();
  });
  it('serves an allowed response and releases its buffered body', async () => {
    const f = await fixture(); await f.handler(f.route);
    expect(f.route.fulfill).toHaveBeenCalledWith({ response: f.response });
    expect(f.response.dispose).toHaveBeenCalledOnce(); expect(f.blocked).not.toHaveBeenCalled();
  });
  it('does not reopen network access after timeout or context cancellation', async () => {
    const f = await fixture(); f.route.fetch.mockRejectedValue(new Error('request timed out'));
    f.route.abort.mockRejectedValue(new Error('context closed')); await f.handler(f.route);
    expect(f.route.abort).toHaveBeenCalledWith('failed'); expect(f.route.continue).not.toHaveBeenCalled();
    expect(f.route.fulfill).not.toHaveBeenCalled();
  });
});

let definition: CaseDefinition;
beforeAll(async () => {
  const hash = "a".repeat(64);
  const pack = await createDevelopmentPack("new-only", {
    packVersion: "checker-unit-tests-v1",
    templateVersion: "vue-board-v1",
    templateHash: hash,
    dependencyLockHash: hash,
    initializationVersion: "clean-ui-v1",
    caseImplementationHashes: { "NEW-01": hash },
  });
  definition = pack.cases[0];
});

describe("trusted checker page-server policy measurement", () => {
  // Controlled browser boundary only; native Chromium behavior is verified by
  // the isolated browser-image probe, not asserted from these fake values.
  function measurementFixture(overrides: Record<string, unknown> = {}) {
    const page = {
      goto: vi.fn(async () => {}),
      evaluate: vi.fn(async () => ({
        viewport: { width: 1200, height: 800, deviceScaleFactor: 1 },
        locale: "zh-CN",
        timezone: "Asia/Shanghai",
        origin: "http://project:8080",
        secureContext: true,
        uuidSamples: [
          "00000000-0000-4000-8000-000000000001",
          "00000000-0000-4000-8000-000000000002",
        ],
        ...overrides,
      })),
    };
    const context = {
      route: vi.fn(async (_pattern: string, _handler: unknown) => {}),
      routeWebSocket: vi.fn(async () => {}),
      newPage: vi.fn(async () => page),
      close: vi.fn(async () => {}),
    };
    const browser = {
      newContext: vi.fn(async () => context),
      version: () => "synthetic-browser-test",
    };
    return { browser, context, page };
  }

  it("measures a trusted fixed-origin stub without fetching or executing student content", async () => {
    const { browser, context, page } = measurementFixture();
    const measured = await measuredEnvironment(browser, "1.58.2");
    expect(page.goto).toHaveBeenCalledWith(
      "http://project:8080/__codelab_platform_probe__",
      { waitUntil: "domcontentloaded", timeout: 5000 },
    );
    expect(measured.environment).toMatchObject({
      pageServerPolicy: "static-project8080-secure-origin-v1",
      randomPolicy: "node-unique-title-browser-native-v1",
    });
    const handler = context.route.mock.calls[0][1] as (
      route: unknown,
    ) => Promise<void>;
    const allowed = {
      request: () => ({
        url: () => "http://project:8080/__codelab_platform_probe__",
      }),
      fulfill: vi.fn(async () => {}),
      abort: vi.fn(async () => {}),
    };
    await handler(allowed);
    expect(allowed.fulfill).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 200,
        headers: { "content-security-policy": "default-src 'none'" },
        body: "<!doctype html><title>Trusted platform measurement</title>",
      }),
    );
    const other = {
      ...allowed,
      request: () => ({ url: () => "http://project:8080/student.js" }),
      fulfill: vi.fn(async () => {}),
      abort: vi.fn(async () => {}),
    };
    await handler(other);
    expect(other.abort).toHaveBeenCalledWith("blockedbyclient");
    expect(other.fulfill).not.toHaveBeenCalled();
    expect(context.close).toHaveBeenCalledTimes(1);
  });

  it.each([
    { secureContext: false },
    { uuidSamples: [] },
    { origin: "http://other.invalid:8080" },
    {
      uuidSamples: [
        "00000000-0000-4000-8000-000000000001",
        "00000000-0000-4000-8000-000000000001",
      ],
    },
  ])(
    "refuses to attest a policy the browser did not demonstrate: %j",
    async (overrides) => {
      const { browser, context } = measurementFixture(overrides);
      await expect(measuredEnvironment(browser, "1.58.2")).rejects.toThrow(
        "CHECKER_PAGE_SERVER_POLICY_MISMATCH",
      );
      expect(context.close).toHaveBeenCalledTimes(1);
    },
  );
});

function input(selected = definition) {
  return { caseDefinitions: [selected], parameterValues: {} };
}

/** Fake DOM boundary, not an executed browser or authoritative sample verdict. */
function driverFor(insertCount = 1) {
  const titles = ["Existing task"];
  let clickedTitle = "";
  const driver = {
    open: vi.fn(async () => "Test driver opened an isolated context."),
    snapshot: vi.fn(async () => ({
      count: titles.length,
      titles: [...titles],
    })),
    create: vi.fn(async (title: string) => {
      clickedTitle = title;
      for (let i = 0; i < insertCount; i++) titles.push(title);
    }),
    observeAfterAction: vi.fn(async () => ({
      count: titles.length,
      titles: [...titles],
    })),
    interrupt: vi.fn(async () => {}),
  };
  return { driver, titles, clickedTitle: () => clickedTitle };
}

function mappedResult(value: any) {
  const evidence = "00000000-0000-4000-8000-000000000101";
  return {
    ...value,
    evidenceIds: value.evidenceIds.map(() => evidence),
    executedSteps: value.executedSteps.map((step: any) => ({
      ...step,
      evidenceIds: step.evidenceIds.map(() => evidence),
    })),
  };
}

describe("NEW-01 trusted checker trace and classification", () => {
  it.each([
    { inserted: 0, verdict: "failed", expectedDelta: 0 },
    { inserted: 1, verdict: "passed", expectedDelta: 1 },
    { inserted: 2, verdict: "failed", expectedDelta: 2 },
  ])(
    "records observed count/title identity when inserted=$inserted",
    async ({ inserted, verdict, expectedDelta }) => {
      const { driver, clickedTitle } = driverFor(inserted);
      const actual = await runNewCase(input(), driver);
      const validated = validateCaseResult(
        definition,
        mappedResult(actual.caseResult),
      );
      expect(validated.verdict).toBe(verdict);
      expect(validated.preconditionStatus).toBe("satisfied");
      expect(actual.observation.before).toEqual({
        count: 1,
        titles: ["Existing task"],
      });
      expect(actual.observation.after.count).toBe(1 + inserted);
      expect(actual.observation.targetTitle).toBe(clickedTitle());
      expect(actual.observation.assertion).toEqual({
        expectedDelta: 1,
        actualDelta: expectedDelta,
        expectedTitleMatches: 1,
        titleMatches: inserted,
      });
      expect(driver.create).toHaveBeenCalledTimes(1);
      expect(validated.executedSteps.map((step) => step.stepId)).toEqual(
        definition.plannedSteps.map((step) => step.stepId),
      );
      expect(validated.executedSteps.at(-1)?.state).toBe(
        verdict === "passed" ? "completed" : "failed",
      );
      expect(validated.unexecutedStepIds).toEqual([]);
    },
  );

  it("stops at a confirmed setup blocker without inventing the click or assertion", async () => {
    const { driver } = driverFor();
    driver.open.mockRejectedValueOnce(
      new CheckerFault("SETUP_BLOCKED", "Public add control is disabled."),
    );
    const { caseResult } = await runNewCase(input(), driver);
    const actual = validateCaseResult(definition, mappedResult(caseResult));
    expect(actual.verdict).toBe("not_run");
    expect(actual.preconditionStatus).toBe("blocked");
    expect(actual.blockedBy).toEqual([
      {
        kind: "setup_step",
        id: definition.plannedSteps[0].stepId,
        reasonCode: "SETUP_BLOCKED",
      },
    ]);
    expect(actual.executedSteps).toHaveLength(1);
    expect(actual.executedSteps[0].state).toBe("failed");
    expect(actual.unexecutedStepIds).toEqual(
      definition.plannedSteps.slice(1).map((step) => step.stepId),
    );
    expect(driver.snapshot).not.toHaveBeenCalled();
    expect(driver.create).not.toHaveBeenCalled();
    expect(driver.interrupt).not.toHaveBeenCalled();
  });

  it("does not turn a timed-out action into a functional failure", async () => {
    const { driver } = driverFor();
    const timeout = Object.assign(new Error("Button click did not complete."), {
      name: "TimeoutError",
    });
    driver.create.mockRejectedValueOnce(timeout);
    const { caseResult } = await runNewCase(input(), driver);
    const actual = validateCaseResult(definition, mappedResult(caseResult));
    expect(actual.verdict).toBe("not_run");
    expect(actual.reasonCode).toBe("TIME_BUDGET");
    expect(actual.preconditionStatus).toBe("satisfied");
    expect(actual.executedSteps.at(-1)).toMatchObject({
      stepId: "action:create-unique-task",
      state: "interrupted",
    });
    expect(actual.unexecutedStepIds).toEqual(["assert:exactly-one-created"]);
    expect(driver.observeAfterAction).not.toHaveBeenCalled();
    expect(driver.interrupt).toHaveBeenCalledTimes(1);
  });

  it("enforces the remaining total budget even if a driver operation never settles", async () => {
    const { driver } = driverFor();
    driver.open.mockImplementationOnce(() => new Promise(() => {}));
    const { caseResult } = await runNewCase(
      { ...input(), remainingWorkMs: 20 },
      driver,
    );
    const actual = validateCaseResult(definition, mappedResult(caseResult));
    expect(actual.reasonCode).toBe("TIME_BUDGET");
    expect(actual.verdict).toBe("not_run");
    expect(actual.executedSteps).toHaveLength(1);
    expect(actual.executedSteps[0].state).toBe("interrupted");
    expect(driver.create).not.toHaveBeenCalled();
    expect(driver.interrupt).toHaveBeenCalledTimes(1);
  });

  it("treats an incomplete initial task identity as setup blocked", async () => {
    const { driver } = driverFor();
    driver.snapshot.mockResolvedValueOnce({
      count: 2,
      titles: ["Only one readable title"],
    });
    const { caseResult } = await runNewCase(input(), driver);
    const actual = validateCaseResult(definition, mappedResult(caseResult));
    expect(actual.verdict).toBe("not_run");
    expect(actual.preconditionStatus).toBe("blocked");
    expect(actual.executedSteps).toHaveLength(2);
    expect(actual.blockedBy[0].id).toBe("setup:record-initial-tasks");
    expect(driver.create).not.toHaveBeenCalled();
  });

  it("requires review for an ambiguous post-action DOM instead of guessing a verdict", async () => {
    const { driver } = driverFor();
    driver.observeAfterAction.mockResolvedValueOnce({ count: 2, titles: [] });
    const { caseResult } = await runNewCase(input(), driver);
    const actual = validateCaseResult(definition, mappedResult(caseResult));
    expect(actual.verdict).toBe("manual");
    expect(actual.reasonCode).toBe("OBSERVATION_AMBIGUOUS");
    expect(actual.preconditionStatus).toBe("satisfied");
    expect(actual.executedSteps.at(-1)?.state).toBe("interrupted");
  });

  it("keeps unavailable page service as an execution-stage interruption", async () => {
    const { driver } = driverFor();
    driver.open.mockRejectedValueOnce(
      new CheckerFault("INFRA_ERROR", "HTTP 503", "page_service"),
    );
    const { caseResult } = await runNewCase(input(), driver);
    const actual = validateCaseResult(definition, mappedResult(caseResult));
    expect(actual.verdict).toBe("not_run");
    expect(actual.reasonCode).toBe("INFRA_ERROR");
    expect(actual.blockedBy[0]).toMatchObject({
      kind: "execution_stage",
      id: "page_service",
    });
    expect(driver.create).not.toHaveBeenCalled();
  });

  it("rejects changed step identities, extra cases, parameters and arbitrary URLs before any action", async () => {
    const changed = structuredClone(definition);
    changed.plannedSteps[2].stepId = "action:untrusted-code";
    const { driver } = driverFor();
    await expect(runNewCase(input(changed), driver)).rejects.toThrow(
      "CHECKER_INPUT_INVALID",
    );
    expect(() =>
      validateCheckerInput({
        ...input(),
        caseDefinitions: [definition, definition],
      }),
    ).toThrow("CHECKER_INPUT_INVALID");
    expect(() =>
      validateCheckerInput({
        ...input(),
        parameterValues: { arbitrary: true },
      }),
    ).toThrow("CHECKER_INPUT_INVALID");
    expect(() =>
      validateCheckerInput({ ...input(), url: "http://localhost:3200" }),
    ).toThrow("CHECKER_INPUT_INVALID");
    expect(driver.open).not.toHaveBeenCalled();
  });

  it("allows only the fixed project HTTP origin and rejects credentials or alternate transports", () => {
    expect(isAllowedProjectUrl("http://project:8080/assets/app.js")).toBe(true);
    for (const target of [
      "http://project:4173/",
      "http://project:8080.evil.test/",
      "http://user:secret@project:8080/",
      "https://project:8080/",
      "ws://project:8080/",
      "http://127.0.0.1:3200/",
      "http://169.254.169.254/",
      "file:///etc/passwd",
    ])
      expect(isAllowedProjectUrl(target)).toBe(false);
  });
});
