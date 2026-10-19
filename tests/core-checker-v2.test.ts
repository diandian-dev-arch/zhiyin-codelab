import { describe, expect, it, vi } from "vitest";
import { CORE_CASE_IDS, createCoursePack, validateCaseResult } from "../packages/contracts/src/v2/index";
const corePath = "../deploy/executor/v2-core-case.mjs";
const filterPath = "../deploy/executor/v2-filter-case.mjs";
const { runCoreCase } = await import(corePath);
const { runFilterCase } = await import(filterPath);
const hash = "a".repeat(64);
const pack = await createCoursePack({ packVersion: "test-v1", templateVersion: "vue-board-v1", templateHash: hash,
  dependencyLockHash: hash, initializationVersion: "clean-v1", caseImplementationHashes: Object.fromEntries(CORE_CASE_IDS.map(id => [id, hash])) });
function driver(mode = "correct") {
  let values: { title: string; done: boolean }[] = [], filter = "all", message = "";
  return {
    open: vi.fn(async () => "isolated test context"),
    snapshotStates: vi.fn(async () => values.filter(v => filter === "all" || v.done === (filter === "done")).map(v => ({ ...v }))),
    create: vi.fn(async (title: string) => {
      if (mode === "setup-blocked") return;
      if (!title.trim() && mode !== "validation-defect") { message = "请输入名称"; return; }
      values.push({ title: title.trim(), done: false });
    }),
    complete: vi.fn(async (title: string) => { values.find(v => v.title === title)!.done = true; }),
    setDone: vi.fn(async (title: string, done: boolean) => { if (mode !== "state-defect") values.find(v => v.title === title)!.done = done; }),
    reload: vi.fn(async () => { if (mode === "save-defect") values = []; }),
    validationMessage: vi.fn(async () => mode === "no-message" ? "" : message),
    selectFilter: vi.fn(async (target: string) => { filter = target; }),
    selectDone: vi.fn(async () => { filter = "done"; }),
    interrupt: vi.fn(async () => {}),
  };
}
function contract(definition: any, result: any) {
  const id = "00000000-0000-4000-8000-000000000001";
  expect(() => validateCaseResult(definition, { ...result, evidenceIds: [id], executedSteps: result.executedSteps.map((s: any) => ({ ...s, evidenceIds: [id] })) })).not.toThrow();
}
describe("fixed core cases and independent observations", () => {
  it.each(["VALID-01", "VALID-02", "STATE-01", "SAVE-01", "FILTER-01", "FILTER-02"])("%s passes with an independent driver and contract-valid trace", async caseId => {
    const definition = pack.cases.find(c => c.caseId === caseId)!;
    const run = caseId.startsWith("FILTER") ? runFilterCase : runCoreCase;
    const { caseResult } = await run(definition, driver());
    expect(caseResult.verdict).toBe("passed"); contract(definition, caseResult);
  });
  it.each([["VALID-01", "validation-defect"], ["VALID-02", "validation-defect"], ["STATE-01", "state-defect"], ["SAVE-01", "save-defect"]])("%s detects observed %s", async (caseId, mode) => {
    const definition = pack.cases.find(c => c.caseId === caseId)!;
    const browser = driver(mode);
    const { caseResult } = await runCoreCase(definition, browser);
    expect(caseResult.verdict).toBe("failed"); contract(definition, caseResult);
    if (caseId === "STATE-01") expect(browser.setDone).toHaveBeenCalledTimes(1);
  });
  it.each(["STATE-01", "SAVE-01"])("%s blocks before action when creation cannot be established", async caseId => {
    const definition = pack.cases.find(c => c.caseId === caseId)!;
    const browser = driver("setup-blocked");
    const { caseResult } = await runCoreCase(definition, browser);
    expect(caseResult.verdict).toBe("not_run"); expect(caseResult.preconditionStatus).toBe("blocked");
    expect(browser.setDone).not.toHaveBeenCalled(); expect(browser.reload).not.toHaveBeenCalled(); contract(definition, caseResult);
  });
  it("checks validation messages only when required by the rule", async () => {
    const definition = pack.cases.find(c => c.caseId === "VALID-01")!;
    expect((await runCoreCase(definition, driver("no-message"), { requireValidationMessage: false })).caseResult.verdict).toBe("passed");
    expect((await runCoreCase(definition, driver("no-message"), { requireValidationMessage: true })).caseResult.verdict).toBe("failed");
  });
  it("does not keep a provisional pass when the reverse transition times out", async () => {
    const definition = pack.cases.find(c => c.caseId === "STATE-01")!;
    const browser = driver();
    browser.setDone.mockImplementationOnce(async () => { await browser.complete(browser.create.mock.calls[0][0]); }).mockImplementationOnce(() => new Promise(() => {}));
    const { caseResult } = await runCoreCase(definition, browser, {}, 40);
    expect(caseResult.verdict).toBe("not_run"); expect(caseResult.reasonCode).toBe("TIME_BUDGET"); contract(definition, caseResult);
  });
});
