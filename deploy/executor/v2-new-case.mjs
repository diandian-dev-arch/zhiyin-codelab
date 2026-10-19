import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

export const PROJECT_ORIGIN = "http://project:8080";
export const CONTEXT_OPTIONS = Object.freeze({
  viewport: { width: 1200, height: 800 },
  deviceScaleFactor: 1,
  locale: "zh-CN",
  timezoneId: "Asia/Shanghai",
  serviceWorkers: "block",
  acceptDownloads: false,
  permissions: [],
});
export const ENVIRONMENT_POLICIES = Object.freeze({
  clockPolicy: "real-clock-monotonic-trace-v1",
  randomPolicy: "node-unique-title-browser-native-v1",
  pageServerPolicy: "static-project8080-secure-origin-v1",
});
export const NEW01_STEPS = Object.freeze([
  { stepId: "setup:open-clean-context", phase: "setup" },
  { stepId: "setup:record-initial-tasks", phase: "setup" },
  { stepId: "action:create-unique-task", phase: "action" },
  { stepId: "assert:exactly-one-created", phase: "assert" },
]);
const OBSERVATION_FILENAME = "NEW-01-observation.json";

export class CheckerFault extends Error {
  constructor(reasonCode, message, stage = "base_checks") {
    super(message);
    this.name = "CheckerFault";
    this.reasonCode = reasonCode;
    this.stage = stage;
  }
}

function inputError() {
  throw new Error(
    "CHECKER_INPUT_INVALID: only the published NEW-01 plan is supported",
  );
}
function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Runner validates the whole rule and its identity; this entry rejects unsupported plans. */
export function validateCheckerInput(input) {
  if (
    !plainObject(input) ||
    Object.keys(input).some(
      (key) =>
        !["caseDefinitions", "parameterValues", "remainingWorkMs"].includes(
          key,
        ),
    ) ||
    !Array.isArray(input.caseDefinitions) ||
    input.caseDefinitions.length !== 1 ||
    !plainObject(input.parameterValues) ||
    Object.keys(input.parameterValues).length !== 0 ||
    (input.remainingWorkMs !== undefined &&
      (!Number.isSafeInteger(input.remainingWorkMs) ||
        input.remainingWorkMs <= 0 ||
        input.remainingWorkMs > 300_000))
  )
    inputError();
  const definition = input.caseDefinitions[0];
  if (
    !plainObject(definition) ||
    Object.keys(definition).some(
      (key) =>
        ![
          "caseId",
          "criterionId",
          "setupPlanId",
          "expected",
          "plannedSteps",
          "timeoutMs",
          "implementationHash",
        ].includes(key),
    ) ||
    definition.caseId !== "NEW-01" ||
    definition.criterionId !== "create" ||
    definition.setupPlanId !== "clean-ui-v1" ||
    typeof definition.expected !== "string" ||
    !definition.expected.length ||
    definition.expected.length > 3000 ||
    !Number.isSafeInteger(definition.timeoutMs) ||
    definition.timeoutMs <= 0 ||
    definition.timeoutMs > 75_000 ||
    !/^[a-f0-9]{64}$/.test(definition.implementationHash ?? "") ||
    !Array.isArray(definition.plannedSteps) ||
    definition.plannedSteps.length !== NEW01_STEPS.length
  )
    inputError();
  for (const [index, step] of definition.plannedSteps.entries()) {
    if (
      !plainObject(step) ||
      Object.keys(step).some(
        (key) => !["stepId", "phase", "description"].includes(key),
      ) ||
      step.stepId !== NEW01_STEPS[index].stepId ||
      step.phase !== NEW01_STEPS[index].phase ||
      typeof step.description !== "string" ||
      !step.description.length ||
      step.description.length > 1000
    )
      inputError();
  }
  return input;
}

export function isAllowedProjectUrl(value) {
  try {
    const url = new URL(value);
    return url.origin === PROJECT_ORIGIN && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** Exact observable titles are retained; truncation must never manufacture a match. */
function checkedSnapshot(value) {
  if (
    !plainObject(value) ||
    !Number.isSafeInteger(value.count) ||
    value.count < 0 ||
    value.count > 100 ||
    !Array.isArray(value.titles) ||
    value.titles.length !== value.count ||
    value.titles.some(
      (title) => typeof title !== "string" || title.length > 200,
    ) ||
    Buffer.byteLength(JSON.stringify(value.titles), "utf8") > 16_384
  )
    throw new CheckerFault(
      "OBSERVATION_AMBIGUOUS",
      "无法完整读取有界任务集合：每个公开 task-row 必须恰有一个 task-title。",
    );
  return { count: value.count, titles: [...value.titles] };
}

function detail(error) {
  return (error instanceof Error ? error.message : String(error)).slice(
    0,
    1200,
  );
}

/**
 * The driver performs real browser operations in production. Injecting it makes the
 * classification and prefix-only trace independently testable without a browser.
 * evidenceIds are LOCAL FILENAMES until the trusted runner maps them to UUIDs.
 */
export async function runNewCase(inputValue, driver) {
  const input = validateCheckerInput(inputValue);
  const definition = input.caseDefinitions[0];
  const startedMonotonic = performance.now();
  const startedWall = Date.now();
  const deadline =
    startedMonotonic +
    Math.min(
      definition.timeoutMs,
      input.remainingWorkMs ?? definition.timeoutMs,
    );
  const stamp = () =>
    new Date(startedWall + performance.now() - startedMonotonic).toISOString();
  const result = {
    criterionId: definition.criterionId,
    caseId: definition.caseId,
    verdict: "not_run",
    preconditionStatus: "uncertain",
    reasonCode: "INTERRUPTED",
    expected: definition.expected,
    observed: "尚未取得新增操作的完整观察。",
    executedSteps: [],
    unexecutedStepIds: definition.plannedSteps.map((step) => step.stepId),
    blockedBy: [],
    evidenceIds: [OBSERVATION_FILENAME],
  };
  const observation = {
    format: "new01-browser-observation-v1",
    caseId: definition.caseId,
    pageOrigin: PROJECT_ORIGIN,
    targetTitle: null,
    before: null,
    after: null,
    assertion: null,
    observationPolicy:
      "Read task-row/task-title 200ms after completed UI click; a timeout is not a functional failure.",
  };
  async function withinBudget(operation) {
    const remaining = Math.floor(deadline - performance.now());
    if (remaining <= 0)
      throw new CheckerFault(
        "TIME_BUDGET",
        "案例工作时间预算已耗尽。",
        "deadline",
      );
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(() => operation(remaining)),
        new Promise((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new CheckerFault(
                  "TIME_BUDGET",
                  "当前浏览器步骤未在案例预算内完成。",
                  "deadline",
                ),
              ),
            remaining,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  for (const planned of definition.plannedSteps) {
    if (performance.now() >= deadline) {
      result.reasonCode = "TIME_BUDGET";
      result.observed = "开始下一步骤之前案例预算已耗尽；后续步骤未执行。";
      result.blockedBy = [
        { kind: "execution_stage", id: "deadline", reasonCode: "TIME_BUDGET" },
      ];
      break;
    }
    const actual = {
      stepId: planned.stepId,
      phase: planned.phase,
      startedAt: stamp(),
      state: "interrupted",
      observation: "当前步骤已开始，但尚未取得完整观察。",
      evidenceIds: [OBSERVATION_FILENAME],
    };
    result.executedSteps.push(actual);
    try {
      if (planned.stepId === "setup:open-clean-context") {
        actual.observation = await withinBudget((remaining) =>
          driver.open(remaining),
        );
      } else if (planned.stepId === "setup:record-initial-tasks") {
        observation.before = checkedSnapshot(
          await withinBudget((remaining) => driver.snapshot(remaining)),
        );
        do {
          observation.targetTitle = `CodeLab-${randomUUID()}`;
        } while (observation.before.titles.includes(observation.targetTitle));
        result.preconditionStatus = "satisfied";
        actual.observation = `实际读取初始 ${observation.before.count} 项任务；生成未出现的唯一标题 ${observation.targetTitle}。`;
      } else if (planned.stepId === "action:create-unique-task") {
        await withinBudget((remaining) =>
          driver.create(observation.targetTitle, remaining),
        );
        actual.observation = `已向 task-input 填入 ${observation.targetTitle}，并完成一次 add-task 点击；是否新增由下一步骤观察。`;
      } else {
        observation.after = checkedSnapshot(
          await withinBudget((remaining) =>
            driver.observeAfterAction(remaining),
          ),
        );
        const actualDelta = observation.after.count - observation.before.count;
        const titleMatches = observation.after.titles.filter(
          (title) => title === observation.targetTitle,
        ).length;
        const matched = actualDelta === 1 && titleMatches === 1;
        observation.assertion = {
          expectedDelta: 1,
          actualDelta,
          expectedTitleMatches: 1,
          titleMatches,
        };
        result.verdict = matched ? "passed" : "failed";
        result.reasonCode = matched
          ? "ASSERTION_SATISFIED"
          : "ASSERTION_MISMATCH";
        result.observed = `新增前 ${observation.before.count} 项，操作后 ${observation.after.count} 项，数量变化 ${actualDelta}；唯一标题实际匹配 ${titleMatches} 项。`;
        actual.observation = result.observed;
        actual.state = matched ? "completed" : "failed";
      }
      if (planned.phase !== "assert") actual.state = "completed";
      actual.finishedAt = stamp();
      if (actual.state === "failed") break;
    } catch (error) {
      actual.finishedAt = stamp();
      actual.observation = `步骤未完成：${detail(error)}`;
      const reason =
        error instanceof CheckerFault
          ? error.reasonCode
          : error instanceof Error && error.name === "TimeoutError"
            ? "TIME_BUDGET"
            : "INFRA_ERROR";
      const setupBlocked =
        planned.phase === "setup" &&
        ["SETUP_BLOCKED", "OBSERVATION_AMBIGUOUS"].includes(reason);
      if (setupBlocked) {
        actual.state = "failed";
        result.preconditionStatus = "blocked";
        result.reasonCode = "SETUP_BLOCKED";
        result.blockedBy = [
          {
            kind: "setup_step",
            id: planned.stepId,
            reasonCode: "SETUP_BLOCKED",
          },
        ];
      } else if (reason === "OBSERVATION_AMBIGUOUS") {
        result.verdict = "manual";
        result.reasonCode = reason;
      } else {
        result.reasonCode = reason;
        result.blockedBy = [
          {
            kind: "execution_stage",
            id:
              reason === "TIME_BUDGET"
                ? "deadline"
                : error instanceof CheckerFault
                  ? error.stage
                  : "browser",
            reasonCode: reason,
          },
        ];
      }
      result.observed = actual.observation;
      // Known, settled setup/observation failures may still yield a screenshot.
      // In-flight operations on timeouts or infrastructure errors must be stopped.
      if (!setupBlocked && reason !== "OBSERVATION_AMBIGUOUS")
        await driver.interrupt?.();
      break;
    }
  }
  result.unexecutedStepIds = definition.plannedSteps
    .slice(result.executedSteps.length)
    .map((step) => step.stepId);
  return { caseResult: result, observation };
}
