import { describe, expect, it, vi } from "vitest";
import { createDevelopmentPack } from "../packages/contracts/src/v2/index";
const modulePath = "../deploy/executor/v2-filter-probe.mjs";
const { runFilterOrderProbe } = await import(modulePath);
const hash = "a".repeat(64);
const pack = await createDevelopmentPack("new-filter", { packVersion: "probe-unit-v1", templateVersion: "vue-board-v1", templateHash: hash,
  dependencyLockHash: hash, initializationVersion: "clean-ui-v1", caseImplementationHashes: { "NEW-01": hash, "FILTER-03": hash }, probeImplementationHashes: { FILTER_ORDER_CHECK: hash } });
const definition = pack.probes[0];

function factory(mode = "correct") {
  const drivers: any[] = [];
  const create = vi.fn(() => {
    const values: { title: string; done: boolean }[] = [];
    let selected = "all", precededByActive = false;
    const driver = {
      open: vi.fn(async () => "synthetic empty context"),
      create: vi.fn(async (title: string) => { values.push({ title, done: false }); }),
      complete: vi.fn(async (title: string) => { if (mode !== "blocked") values.find(row => row.title === title)!.done = true; }),
      snapshotStates: vi.fn(async () => {
        const target = mode === "order-defect" && selected === "done" && !precededByActive ? "all" : selected;
        return values.filter(row => target === "all" || row.done === (target === "done")).map(row => ({ ...row }));
      }),
      transitionFilter: vi.fn(async (value: string, from: string) => {
        expect(selected).toBe(from);
        if (selected === "active") precededByActive = true;
        selected = value;
      }),
      filterValue: vi.fn(async () => selected),
      interrupt: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    if (mode === "timeout") driver.open.mockImplementation(() => new Promise(() => {}));
    drivers.push(driver);
    return driver;
  });
  return { create, drivers };
}

describe("fixed FILTER_ORDER_CHECK supplemental investigation", () => {
  it('captures only actually executed steps in path order, including blocked preparation', async () => {
    for (const mode of ['correct','blocked']) {
      const f = factory(mode), captured: string[] = [];
      const result = await runFilterOrderProbe(definition,{},f.create,undefined,async (_driver:any, identity:any)=>{
        expect(identity.remainingMs).toBeGreaterThanOrEqual(0);
        captured.push(`${identity.pathId}:${identity.stepId}`);
      });
      expect(captured).toEqual(result.paths.flatMap((p:any)=>p.executedSteps.map((s:any)=>`${p.pathId}:${s.stepId}`)));
      expect(captured).toHaveLength(mode==='correct'?10:4);
    }
  });
  it("uses distinct empty contexts and reports the repeated baseline path honestly", async () => {
    const f = factory();
    const result = await runFilterOrderProbe(definition, {}, f.create);
    expect(result.comparison).toBe("same_observed_set");
    expect(result.paths.map((path: any) => path.executedSteps.length)).toEqual([4,6]);
    expect(new Set(result.paths.flatMap((path: any) => path.titles)).size).toBe(6);
    expect(result.coverage.A).toContain("repeats_FILTER-03");
    expect(result.baseResultsModified).toBe(false);
    for (const driver of f.drivers) expect(driver.close).toHaveBeenCalledOnce();
  });
  it("observes an order-dependent difference without replacing a failed baseline", async () => {
    const f = factory("order-defect");
    const result = await runFilterOrderProbe(definition, {}, f.create);
    expect(result.comparison).toBe("different_observed_set");
    expect(result.paths[0].observations.at(-1).matches).toBe(false);
    expect(result.paths[1].observations.at(-1).matches).toBe(true);
    expect(result).not.toHaveProperty("verdict");
    expect(result).not.toHaveProperty("caseResults");
  });
  it("keeps blocked preparation inconclusive and never runs downstream transitions", async () => {
    const f = factory("blocked");
    const result = await runFilterOrderProbe(definition, {}, f.create);
    expect(result.comparison).toBe("inconclusive");
    expect(result.paths.every((path: any) => path.status === "blocked" && path.executedSteps.length === 2)).toBe(true);
    for (const driver of f.drivers) expect(driver.transitionFilter).not.toHaveBeenCalled();
  });
  it("shares one deadline across both paths and does not manufacture path B steps", async () => {
    const f = factory("timeout");
    const result = await runFilterOrderProbe(definition, {}, f.create, 25);
    expect(result.comparison).toBe("inconclusive");
    expect(result.paths[0].reasonCode).toBe("TIME_BUDGET");
    expect(result.paths[1].executedSteps).toEqual([]);
    expect(f.create).toHaveBeenCalledOnce();
    expect(f.drivers[0].interrupt).toHaveBeenCalledOnce();
  });
  it("does not infer equivalence when a control value cannot be observed", async () => {
    const f = factory();
    const create = () => { const driver = f.create(); driver.filterValue.mockResolvedValue("ambiguous"); return driver; };
    const result = await runFilterOrderProbe(definition, {}, create);
    expect(result.comparison).toBe("inconclusive");
    expect(result.paths[1].unexecutedStepIds).toEqual(["action:select-done", "assert:observe-done-set"]);
  });
  it("rejects model-supplied URL, selector, script or altered plan before opening a page", async () => {
    const f = factory();
    for (const parameters of [{ url: "https://example.com" }, { selector: "body" }, { script: "alert(1)" }])
      await expect(runFilterOrderProbe(definition, parameters, f.create)).rejects.toThrow("FILTER_PROBE_DEFINITION_INVALID");
    const changed = structuredClone(definition);
    changed.plannedPaths[1].plannedSteps[2].stepId = "run-script";
    await expect(runFilterOrderProbe(changed, {}, f.create)).rejects.toThrow("FILTER_PROBE_DEFINITION_INVALID");
    expect(f.create).not.toHaveBeenCalled();
  });
});
