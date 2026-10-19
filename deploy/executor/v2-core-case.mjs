import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { CheckerFault } from "./v2-new-case.mjs";

const plans = {
  "VALID-01": ["validation", "clean-ui-v1", "setup:record-initial-tasks", "action:submit-empty", "assert:empty-rejected"],
  "VALID-02": ["validation", "clean-ui-v1", "setup:record-initial-tasks", "action:submit-whitespace", "assert:whitespace-rejected"],
  "STATE-01": ["toggle", "target-ui-v1", "setup:create-target", "action:mark-done", "assert:done-same-target", "action:mark-active", "assert:active-same-target"],
  "SAVE-01": ["persistence", "persist-ui-v1", "setup:create-and-confirm-state", "action:reload", "assert:persisted-snapshot"],
};
export function validateCoreDefinition(definition) {
  const plan = plans[definition?.caseId];
  const ids = plan && ["setup:open-clean-context", ...plan.slice(2)];
  if (!plan || definition.criterionId !== plan[0] || definition.setupPlanId !== plan[1] ||
      !Number.isSafeInteger(definition.timeoutMs) || definition.timeoutMs < 1 || definition.timeoutMs > 75000 ||
      typeof definition.expected !== "string" || !definition.expected.length || !/^[a-f0-9]{64}$/.test(definition.implementationHash ?? "") ||
      !Array.isArray(definition.plannedSteps) || definition.plannedSteps.length !== ids.length ||
      definition.plannedSteps.some((s, i) => s.stepId !== ids[i] || s.phase !== ids[i].split(":")[0]))
    throw new Error("CORE_DEFINITION_INVALID");
  return definition;
}
function rows(value) {
  if (!Array.isArray(value) || value.length > 100 || value.some(r => !r || typeof r.title !== "string" || r.title.length > 200 || typeof r.done !== "boolean"))
    throw new CheckerFault("OBSERVATION_AMBIGUOUS", "无法完整读取任务身份和状态。");
  return value;
}
const same = (a, b) => a.length === b.length && b.every(expected => a.filter(actual => actual.title === expected.title && actual.done === expected.done).length === 1);

export async function runCoreCase(value, driver, parameters = {}, remainingWorkMs) {
  const definition = validateCoreDefinition(value);
  const start = performance.now(), wall = Date.now();
  const budget = Math.min(definition.timeoutMs, remainingWorkMs ?? definition.timeoutMs);
  if (!Number.isSafeInteger(budget) || budget <= 0) throw new Error("CORE_BUDGET_INVALID");
  const deadline = start + budget;
  const stamp = () => new Date(wall + performance.now() - start).toISOString();
  const filename = `${definition.caseId}-observation.json`;
  const observation = { format: "core-browser-observation-v1", title: `CodeLab-${randomUUID()}`, before: null, observations: [] };
  const result = { criterionId: definition.criterionId, caseId: definition.caseId, verdict: "not_run", preconditionStatus: "uncertain",
    reasonCode: "INTERRUPTED", expected: definition.expected, observed: "检查尚未完成。", executedSteps: [],
    unexecutedStepIds: definition.plannedSteps.map(s => s.stepId), blockedBy: [], evidenceIds: [filename] };
  async function bounded(action) {
    const ms = Math.floor(deadline - performance.now());
    if (ms <= 0) throw new CheckerFault("TIME_BUDGET", "案例预算耗尽。", "deadline");
    let timer;
    try { return await Promise.race([Promise.resolve().then(() => action(ms)), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new CheckerFault("TIME_BUDGET", "操作超出案例预算。", "deadline")), ms);
    })]); } finally { clearTimeout(timer); }
  }
  for (const step of definition.plannedSteps) {
    if (performance.now() >= deadline) {
      result.verdict = "not_run"; result.reasonCode = "TIME_BUDGET"; result.observed = "下一步骤开始前预算耗尽。";
      result.blockedBy = [{ kind: "execution_stage", id: "deadline", reasonCode: "TIME_BUDGET" }]; break;
    }
    const actual = { stepId: step.stepId, phase: step.phase, startedAt: stamp(), state: "interrupted", observation: "步骤未完成。", evidenceIds: [filename] };
    result.executedSteps.push(actual);
    try {
      if (step.stepId === "setup:open-clean-context") actual.observation = await bounded(ms => driver.open(ms));
      else if (step.phase === "setup") {
        const initial = rows(await bounded(ms => driver.snapshotStates(ms)));
        if (initial.length) throw new CheckerFault("SETUP_BLOCKED", "独立浏览器上下文初始任务不为空。");
        if (definition.caseId !== "VALID-01" && definition.caseId !== "VALID-02") {
          await bounded(ms => driver.create(observation.title, ms));
          const created = rows(await bounded(ms => driver.snapshotStates(ms)));
          if (!same(created, [{ title: observation.title, done: false }])) throw new CheckerFault("SETUP_BLOCKED", "未能建立唯一未完成目标任务。");
          if (definition.caseId === "SAVE-01") {
            await bounded(ms => driver.complete(observation.title, ms));
            const marked = rows(await bounded(ms => driver.snapshotStates(ms)));
            if (!same(marked, [{ title: observation.title, done: true }])) throw new CheckerFault("SETUP_BLOCKED", "持久化检查准备的完成状态未确认。");
          }
        }
        observation.before = rows(await bounded(ms => driver.snapshotStates(ms)));
        result.preconditionStatus = "satisfied";
        actual.observation = `独立准备已核对，当前 ${observation.before.length} 项。`;
      } else if (step.phase === "action") {
        if (definition.caseId.startsWith("VALID")) await bounded(ms => driver.create(definition.caseId === "VALID-01" ? "" : "   ", ms));
        else if (step.stepId === "action:reload") await bounded(ms => driver.reload(ms));
        else actual.observation = await bounded(ms => driver.setDone(observation.title, step.stepId === "action:mark-done", ms)) ?? "已请求状态切换。";
        if (definition.caseId !== "STATE-01") actual.observation = `已执行 ${step.stepId} 的固定公开页面操作。`;
      } else {
        const observed = rows(await bounded(ms => driver.snapshotStates(ms)));
        let expected = observation.before, message = null;
        if (definition.caseId === "STATE-01") expected = [{ title: observation.title, done: step.stepId === "assert:done-same-target" }];
        if (definition.caseId.startsWith("VALID") && parameters.requireValidationMessage) message = await bounded(ms => driver.validationMessage(ms));
        const passed = same(observed, expected) && (message === null || message.length > 0);
        observation.observations.push({ stepId: step.stepId, rows: observed, validationMessage: message });
        result.verdict = passed ? "passed" : "failed";
        result.reasonCode = passed ? "ASSERTION_SATISFIED" : "ASSERTION_MISMATCH";
        actual.state = passed ? "completed" : "failed";
        result.observed = `${step.stepId}：实际 ${observed.length} 项，${passed ? "身份、状态及必要提示符合要求" : "身份、状态或必要提示不符合要求"}。`;
        actual.observation = result.observed;
        if (!passed) { actual.finishedAt = stamp(); break; }
      }
      if (step.phase !== "assert") actual.state = "completed";
    } catch (error) {
      const reason = error instanceof CheckerFault ? error.reasonCode : error?.name === "TimeoutError" ? "TIME_BUDGET" : "INFRA_ERROR";
      const blocked = step.phase === "setup" && ["SETUP_BLOCKED", "OBSERVATION_AMBIGUOUS"].includes(reason);
      result.reasonCode = blocked ? "SETUP_BLOCKED" : reason;
      result.preconditionStatus = blocked ? "blocked" : result.preconditionStatus;
      result.verdict = !blocked && reason === "OBSERVATION_AMBIGUOUS" ? "manual" : "not_run";
      actual.state = blocked ? "failed" : "interrupted";
      actual.observation = String(error?.message ?? "检查中断").slice(0, 1200);
      result.observed = actual.observation;
      if (blocked || reason !== "OBSERVATION_AMBIGUOUS") result.blockedBy = [{ kind: blocked ? "setup_step" : "execution_stage", id: blocked ? step.stepId : reason === "TIME_BUDGET" ? "deadline" : "browser", reasonCode: result.reasonCode }];
      if (!blocked && reason !== "OBSERVATION_AMBIGUOUS") await driver.interrupt?.();
      actual.finishedAt = stamp(); break;
    }
    actual.finishedAt = stamp();
  }
  result.unexecutedStepIds = definition.plannedSteps.slice(result.executedSteps.length).map(s => s.stepId);
  return { caseResult: result, observation };
}
