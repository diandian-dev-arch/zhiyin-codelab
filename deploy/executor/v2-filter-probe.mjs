import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { CheckerFault } from "./v2-new-case.mjs";

const setup = [
  ["setup:open-clean-context", "setup"],
  ["setup:create-mixed-tasks", "setup"],
];
export const FILTER_ORDER_PATHS = Object.freeze({
  A: [...setup, ["action:select-done", "action"], ["assert:observe-done-set", "assert"]],
  B: [...setup, ["action:select-active", "action"], ["assert:observe-active-set", "assert"],
    ["action:select-done", "action"], ["assert:observe-done-set", "assert"]],
});

export function validateFilterProbe(definition, parameters = {}) {
  if (!definition || definition.probeId !== "FILTER_ORDER_CHECK" ||
      definition.setupPlanId !== "mixed-ui-v1" || !Array.isArray(definition.applicableCriterionIds) ||
      definition.applicableCriterionIds.length !== 1 || definition.applicableCriterionIds[0] !== "filter" ||
      !definition.parameterSchema || Object.keys(definition.parameterSchema).length ||
      !parameters || Array.isArray(parameters) || Object.getPrototypeOf(parameters) !== Object.prototype || Object.keys(parameters).length ||
      !Number.isSafeInteger(definition.maxDurationMs) || definition.maxDurationMs < 1 || definition.maxDurationMs > 20_000 ||
      !/^[a-f0-9]{64}$/.test(definition.implementationHash ?? "") ||
      !Array.isArray(definition.plannedPaths) || definition.plannedPaths.length !== 2 ||
      definition.plannedPaths.some((path, index) => {
        const id = ["A", "B"][index], fixed = FILTER_ORDER_PATHS[id];
        return path.pathId !== id || !Array.isArray(path.plannedSteps) || path.plannedSteps.length !== fixed.length ||
          path.plannedSteps.some((step, i) => step.stepId !== fixed[i][0] || step.phase !== fixed[i][1]);
      })) throw new Error("FILTER_PROBE_DEFINITION_INVALID");
  return definition;
}

function rows(value) {
  if (!Array.isArray(value) || value.length > 100 || value.some(row =>
    !row || typeof row.title !== "string" || row.title.length > 200 || typeof row.done !== "boolean"))
    throw new CheckerFault("OBSERVATION_AMBIGUOUS", "任务集合无法完整观察。");
  return value.map(({ title, done }) => ({ title, done }));
}

/** Fixed two-path investigation. Supplemental observations never change a base verdict. */
export async function runFilterOrderProbe(definitionValue, parameters, createDriver, remainingWorkMs, captureStep) {
  const definition = validateFilterProbe(definitionValue, parameters);
  const duration = Math.min(definition.maxDurationMs, remainingWorkMs ?? definition.maxDurationMs);
  if (!Number.isSafeInteger(duration) || duration < 1) throw new Error("FILTER_PROBE_BUDGET_INVALID");
  const started = performance.now(), wall = Date.now(), deadline = started + duration;
  const stamp = () => new Date(wall + performance.now() - started).toISOString();
  const paths = [];
  let budgetExhausted = false;
  async function bounded(action) {
    const ms = Math.floor(deadline - performance.now());
    if (budgetExhausted || ms <= 0) throw new CheckerFault("TIME_BUDGET", "探查的共享预算已耗尽。", "deadline");
    let timer;
    try {
      return await Promise.race([Promise.resolve().then(() => action(ms)), new Promise((_, reject) => {
        timer = setTimeout(() => { budgetExhausted = true; reject(new CheckerFault("TIME_BUDGET", "探查操作超过共享预算。", "deadline")); }, ms);
      })]);
    } finally { clearTimeout(timer); }
  }
  for (const plan of definition.plannedPaths) {
    const result = { pathId: plan.pathId, status: "not_run", reasonCode: "TIME_BUDGET", preconditionStatus: "uncertain",
      titles: [0,1,2].map(() => `CodeLab-Probe-${randomUUID()}`), executedSteps: [],
      unexecutedStepIds: plan.plannedSteps.map(step => step.stepId), observations: [] };
    paths.push(result);
    if (budgetExhausted || Math.floor(deadline - performance.now()) <= 0) continue;
    const driver = createDriver();
    try {
      for (const step of plan.plannedSteps) {
        if (Math.floor(deadline - performance.now()) <= 0) { result.status = "interrupted"; result.reasonCode = "TIME_BUDGET"; break; }
        const actual = { stepId: step.stepId, phase: step.phase, startedAt: stamp(), state: "interrupted", observation: "步骤未完成。" };
        result.executedSteps.push(actual);
        try {
          if (step.stepId === "setup:open-clean-context") actual.observation = await bounded(ms => driver.open(ms));
          else if (step.stepId === "setup:create-mixed-tasks") {
            if (rows(await bounded(ms => driver.snapshotStates(ms))).length)
              throw new CheckerFault("SETUP_BLOCKED", "新上下文初始任务非空。");
            for (const title of result.titles) await bounded(ms => driver.create(title, ms));
            await bounded(ms => driver.complete(result.titles[2], ms));
            const before = rows(await bounded(ms => driver.snapshotStates(ms)));
            if (before.length !== 3 || !result.titles.every((title, index) =>
              before.filter(row => row.title === title && row.done === (index === 2)).length === 1))
              throw new CheckerFault("SETUP_BLOCKED", "未确认两个未完成和一个已完成任务，停止此路径。");
            result.preconditionStatus = "satisfied";
            actual.observation = "通过公开页面操作建立并核对三个独立任务。";
          } else if (step.phase === "action") {
            const target = step.stepId === "action:select-active" ? "active" : "done";
            const from = plan.pathId === "B" && target === "done" ? "active" : "all";
            await bounded(ms => driver.transitionFilter(target, from, ms));
            actual.observation = `执行预置操作：选择 ${target}。`;
          } else {
            const visible = rows(await bounded(ms => driver.snapshotStates(ms)));
            const controlValue = await bounded(ms => driver.filterValue(ms));
            if (!["all","active","done"].includes(controlValue))
              throw new CheckerFault("OBSERVATION_AMBIGUOUS", "无法确认筛选控件实际值。");
            const target = step.stepId === "assert:observe-active-set" ? "active" : "done";
            const expectedIndices = target === "active" ? [0,1] : [2];
            const taskIndices = visible.map(row => ({ index: result.titles.indexOf(row.title), done: row.done }));
            const matches = controlValue === target && visible.length === expectedIndices.length &&
              expectedIndices.every(index => visible.filter(row => row.title === result.titles[index] && row.done === (index === 2)).length === 1);
            result.observations.push({ stepId: step.stepId, target, controlValue, visible, taskIndices, matches });
            actual.observation = `控件实际值 ${controlValue}，可见 ${visible.length} 项，${matches ? "符合" : "不符合"}本次目标集合。`;
          }
          actual.state = "completed";
          result.status = "completed";
          result.reasonCode = "OBSERVED";
        } catch (error) {
          const code = error instanceof CheckerFault ? error.reasonCode : error?.name === "TimeoutError" ? "TIME_BUDGET" : "INFRA_ERROR";
          const blocked = step.phase === "setup" && ["SETUP_BLOCKED","OBSERVATION_AMBIGUOUS"].includes(code);
          result.status = blocked ? "blocked" : "interrupted";
          result.reasonCode = blocked ? "SETUP_BLOCKED" : code;
          if (blocked) result.preconditionStatus = "blocked";
          actual.state = blocked ? "failed" : "interrupted";
          actual.observation = String(error?.message ?? "探查中断").slice(0, 1000);
          if (captureStep && code !== 'TIME_BUDGET') await captureStep(driver, {pathId:plan.pathId,stepId:step.stepId,remainingMs:Math.max(0,Math.floor(deadline-performance.now()))});
          await driver.interrupt?.();
          actual.finishedAt = stamp();
          break;
        }
        actual.finishedAt = stamp();
        if (captureStep) await captureStep(driver, {pathId:plan.pathId,stepId:step.stepId,remainingMs:Math.max(0,Math.floor(deadline-performance.now()))});
      }
    } finally {
      result.unexecutedStepIds = plan.plannedSteps.slice(result.executedSteps.length).map(step => step.stepId);
      await driver.close();
    }
  }
  const final = paths.map(path => path.status === "completed" && !path.unexecutedStepIds.length
    ? path.observations.findLast(item => item.target === "done") : undefined);
  const signature = observation => JSON.stringify({ value: observation.controlValue,
    tasks: [...observation.taskIndices].sort((a,b) => a.index-b.index || Number(a.done)-Number(b.done)) });
  // Unknown titles are kept in evidence but cannot be compared across fresh contexts.
  const comparable = final.every(item => item && item.taskIndices.every(row => row.index >= 0));
  return { format: "filter-order-probe-v1", probeId: "FILTER_ORDER_CHECK", paths,
    comparison: comparable ? signature(final[0]) === signature(final[1]) ? "same_observed_set" : "different_observed_set" : "inconclusive",
    coverage: { A: "repeats_FILTER-03_direct_transition", B: "additional_active_then_done_transition" },
    baseResultsModified: false, startedAt: new Date(wall).toISOString(), finishedAt: stamp() };
}
