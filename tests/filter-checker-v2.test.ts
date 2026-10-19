import { describe, it, expect, vi } from "vitest";
import { createDevelopmentPack, validateCaseResult } from "../packages/contracts/src/v2/index";
const modulePath = "../deploy/executor/v2-filter-case.mjs";
const { runFilterCase } = await import(modulePath);
const hash = "a".repeat(64);
const pack = await createDevelopmentPack("new-filter", { packVersion: "unit-v1", templateVersion: "vue-board-v1", templateHash: hash, dependencyLockHash: hash, initializationVersion: "clean-ui-v1", caseImplementationHashes: { "NEW-01": hash, "FILTER-03": hash } });
const definition = pack.cases.find(c => c.caseId === "FILTER-03")!;
function driver(mode = "correct") {
  let values: { title: string; done: boolean }[] = [], filtered = false;
  return {
    open: vi.fn(async () => "独立受控测试上下文"),
    create: vi.fn(async (title: string) => { values.push({ title, done: false }); }),
    complete: vi.fn(async (title: string) => { if (mode !== "blocked") values.find(v => v.title === title)!.done = true; }),
    snapshotStates: vi.fn(async () => filtered && mode !== "defect" ? values.filter(v => v.done).map(v => ({ ...v })) : values.map(v => ({ ...v }))),
    selectDone: vi.fn(async () => { filtered = true; }),
    interrupt: vi.fn(async () => {}),
  };
}
describe("FILTER-03 independent setup and evidence semantics", () => {
  it.each([["correct", "passed"], ["defect", "failed"], ["blocked", "not_run"]])("%s gives %s with a contract-valid prefix trace", async (mode, verdict) => {
    const browser = driver(mode);
    const { caseResult } = await runFilterCase(definition, browser);
    expect(caseResult.verdict).toBe(verdict);
    const evidenceId = "00000000-0000-4000-8000-000000000001";
    expect(() => validateCaseResult(definition, { ...caseResult, evidenceIds: [evidenceId],
      executedSteps: caseResult.executedSteps.map((step: any) => ({ ...step, evidenceIds: [evidenceId] })) })).not.toThrow();
    if (mode === "blocked") {
      expect(browser.selectDone).not.toHaveBeenCalled();
      expect(caseResult.preconditionStatus).toBe("blocked");
      expect(caseResult.unexecutedStepIds).toEqual(["action:select-done", "assert:done-exact-set"]);
    } else expect(caseResult.executedSteps).toHaveLength(4);
  });
  it("a hung preparation consumes its budget without reporting a functional failure", async () => {
    const browser = driver();
    browser.complete.mockImplementation(() => new Promise(() => {}));
    const { caseResult } = await runFilterCase(definition, browser, 30);
    expect(caseResult.verdict).toBe("not_run");
    expect(caseResult.reasonCode).toBe("TIME_BUDGET");
    expect(browser.interrupt).toHaveBeenCalledOnce();
    expect(browser.selectDone).not.toHaveBeenCalled();
  });
  it("refuses model-supplied steps outside the fixed plan", async () => {
    await expect(runFilterCase({ ...definition, plannedSteps: [...definition.plannedSteps, { stepId: "execute-script", phase: "action" }] }, driver())).rejects.toThrow("FILTER_DEFINITION_INVALID");
  });
  it("ambiguous post-action observations remain unknown instead of becoming failures", async () => {
    const browser = driver();
    browser.snapshotStates.mockResolvedValueOnce([]).mockImplementationOnce(async () => {
      // Delegate the normal preparation snapshot after dynamically generated titles.
      return browser.create.mock.calls.map(([title], index) => ({ title, done: index === 2 }));
    }).mockResolvedValueOnce([{ title: "ambiguous", done: undefined as unknown as boolean }]);
    const { caseResult } = await runFilterCase(definition, browser);
    expect(caseResult.preconditionStatus).toBe("satisfied");
    expect(caseResult.verdict).toBe("manual");
    expect(caseResult.reasonCode).toBe("OBSERVATION_AMBIGUOUS");
  });
});
