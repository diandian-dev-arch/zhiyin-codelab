import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { CheckerFault } from "./v2-new-case.mjs";

export const FILTER03_STEPS = Object.freeze([
  { stepId: "setup:open-clean-context", phase: "setup" },
  { stepId: "setup:create-mixed-tasks", phase: "setup" },
  { stepId: "action:select-done", phase: "action" },
  { stepId: "assert:done-exact-set", phase: "assert" },
]);

export function validateFilterDefinition(definition) {
  const suffix = { "FILTER-01": "all", "FILTER-02": "active", "FILTER-03": "done" }[definition?.caseId];
  const steps = FILTER03_STEPS.map(s => ({ ...s, stepId: s.stepId.replace("done", suffix) }));
  if (!suffix || definition.criterionId !== "filter" ||
      definition.setupPlanId !== "mixed-ui-v1" || !Number.isSafeInteger(definition.timeoutMs) ||
      definition.timeoutMs < 1 || definition.timeoutMs > 75000 ||
      typeof definition.expected !== "string" || !definition.expected.length ||
      !/^[a-f0-9]{64}$/.test(definition.implementationHash ?? "") ||
      !Array.isArray(definition.plannedSteps) || definition.plannedSteps.length !== 4 ||
      definition.plannedSteps.some((step, index) => step.stepId !== steps[index].stepId || step.phase !== steps[index].phase))
    throw new Error("FILTER_DEFINITION_INVALID");
  return definition;
}

function rows(value) {
  if (!Array.isArray(value) || value.length > 100 || value.some(row =>
    !row || typeof row.title !== "string" || row.title.length > 200 || typeof row.done !== "boolean"))
    throw new CheckerFault("OBSERVATION_AMBIGUOUS", "任务标题或完成状态无法完整读取。");
  return value;
}

/** Uses independent UI setup; no localStorage injection or dependence on NEW-01. */
export async function runFilterCase(definitionValue, driver, remainingWorkMs) {
  const definition = validateFilterDefinition(definitionValue);
  const started = performance.now(), wall = Date.now();
  const duration = Math.min(definition.timeoutMs, remainingWorkMs ?? definition.timeoutMs);
  if (!Number.isSafeInteger(duration) || duration <= 0) throw new Error("FILTER_BUDGET_INVALID");
  const deadline = started + duration;
  const stamp = () => new Date(wall + performance.now() - started).toISOString();
  const target = { "FILTER-01": "all", "FILTER-02": "active", "FILTER-03": "done" }[definition.caseId];
  const filename = `${definition.caseId}-observation.json`;
  const observation = { format: "filter03-browser-observation-v1", titles: [0, 1, 2].map(() => `CodeLab-${randomUUID()}`), before: null, after: null };
  const result = { criterionId: "filter", caseId: definition.caseId, verdict: "not_run", preconditionStatus: "uncertain",
    reasonCode: "INTERRUPTED", expected: definition.expected, observed: "筛选检查尚未完成。",
    executedSteps: [], unexecutedStepIds: definition.plannedSteps.map(s => s.stepId), blockedBy: [], evidenceIds: [filename] };
  async function bounded(operation) {
    const remaining = Math.floor(deadline - performance.now());
    if (remaining <= 0) throw new CheckerFault("TIME_BUDGET", "案例预算耗尽。", "deadline");
    let timer;
    try {
      return await Promise.race([Promise.resolve().then(() => operation(remaining)), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new CheckerFault("TIME_BUDGET", "浏览器操作超过案例预算。", "deadline")), remaining);
      })]);
    } finally { clearTimeout(timer); }
  }
  for (const step of definition.plannedSteps) {
    if (performance.now() >= deadline) {
      result.reasonCode = "TIME_BUDGET";
      result.observed = "下一步骤开始前预算已耗尽。";
      result.blockedBy = [{ kind: "execution_stage", id: "deadline", reasonCode: "TIME_BUDGET" }];
      break;
    }
    const actual = { stepId: step.stepId, phase: step.phase, startedAt: stamp(), state: "interrupted", observation: "步骤尚未完成。", evidenceIds: [filename] };
    result.executedSteps.push(actual);
    try {
      if (step.stepId === FILTER03_STEPS[0].stepId) actual.observation = await bounded(ms => driver.open(ms));
      else if (step.stepId === FILTER03_STEPS[1].stepId) {
        const initial = rows(await bounded(ms => driver.snapshotStates(ms)));
        if (initial.length) throw new CheckerFault("SETUP_BLOCKED", "独立上下文初始任务不为空。");
        for (const title of observation.titles) await bounded(ms => driver.create(title, ms));
        await bounded(ms => driver.complete(observation.titles[2], ms));
        observation.before = rows(await bounded(ms => driver.snapshotStates(ms)));
        const verified = observation.before.length === 3 && observation.titles.every((title, index) => {
          const matches = observation.before.filter(row => row.title === title);
          return matches.length === 1 && matches[0].done === (index === 2);
        });
        if (!verified) throw new CheckerFault("SETUP_BLOCKED", "通过页面操作未能确认两个未完成和一个已完成任务。");
        result.preconditionStatus = "satisfied";
        actual.observation = "已通过公开操作建立并核对三个唯一标题、两个未完成和一个已完成状态。";
      } else if (step.phase === "action") {
        await bounded(ms => target === "done" ? driver.selectDone(ms) : driver.selectFilter(target, ms));
        actual.observation = `从初始全部直接选择 ${target}，未先选择其他筛选项。`;
      } else {
        observation.after = rows(await bounded(ms => driver.snapshotStates(ms)));
        const expected = observation.before.filter(row => target === "all" || row.done === (target === "done"));
        const matched = observation.after.length === expected.length && expected.every(row => observation.after.filter(actual => actual.title === row.title && actual.done === row.done).length === 1);
        result.verdict = matched ? "passed" : "failed";
        result.reasonCode = matched ? "ASSERTION_SATISFIED" : "ASSERTION_MISMATCH";
        result.observed = `切换 ${target} 后实际显示 ${observation.after.length} 项；预期 ${expected.length} 项，${matched ? "任务身份和状态完全匹配" : "可见集合与预期不一致"}。`;
        actual.observation = result.observed;
        actual.state = matched ? "completed" : "failed";
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
      if (reason !== "OBSERVATION_AMBIGUOUS" || blocked) result.blockedBy = [{
        kind: blocked ? "setup_step" : "execution_stage", id: blocked ? step.stepId : reason === "TIME_BUDGET" ? "deadline" : "browser", reasonCode: result.reasonCode,
      }];
      if (!blocked && reason !== "OBSERVATION_AMBIGUOUS") await driver.interrupt?.();
      actual.finishedAt = stamp();
      break;
    }
    actual.finishedAt = stamp();
  }
  result.unexecutedStepIds = definition.plannedSteps.slice(result.executedSteps.length).map(s => s.stepId);
  return { caseResult: result, observation };
}
