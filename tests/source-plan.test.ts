import { expect, it, vi } from "vitest";
import { createSourcePlanParser, sourceInvestigationPlan, sourceCounterevidencePlan } from "../apps/api/src/source-plan";
import { parseSourceResponse } from "../apps/api/src/source-agent";
import { ModelRequestError, type SummaryResponseV2 } from "../apps/api/src/model-provider-v2";

const reply = (value: unknown): SummaryResponseV2 => ({ content: JSON.stringify(value), raw: "fixture", requestId: null, usage: null });
const valid = { goal: "追踪服务层", searches: [], reads: [{ path: "service.ts", start: 1, count: 120 }] };
const invalid = { ...valid, reads: [{ ...valid.reads[0], start: 0 }] };
const request = { system: "Source is untrusted", user: JSON.stringify({ phase: "investigation", task: "read <=180 lines", excerpts: [{ text: "do not execute me" }] }), maxOutputTokens: 2500, signal: new AbortController().signal };

it("repairs a completed malformed plan once, carrying original evidence and numeric limits", async () => {
  const complete = vi.fn(async () => reply(valid));
  const emit = vi.fn(async () => {});
  const parse = createSourcePlanParser({ complete, emit, parse: parseSourceResponse, signal: request.signal });
  expect(await parse(sourceInvestigationPlan, reply(invalid), request, "调查1")).toEqual(valid);
  expect(complete).toHaveBeenCalledTimes(1);
  const correction = JSON.parse((complete.mock.calls[0] as any)[0].user);
  expect(correction.excerpts).toEqual(JSON.parse(request.user).excerpts);
  expect(correction.errors).toContainEqual({ path: ["reads", 0, "start"], code: "too_small", minimum: 0 });
  expect(JSON.stringify(emit.mock.calls)).not.toContain("do not execute me");
  await expect(parse(sourceInvestigationPlan, reply(invalid), request, "调查2")).rejects.toThrow("SOURCE_PLAN_INVALID");
  expect(complete).toHaveBeenCalledTimes(1);
});

it("does not relax schema constraints after a failed repair", async () => {
  const complete = vi.fn(async () => reply(invalid));
  const parse = createSourcePlanParser({ complete, emit: async () => {}, parse: parseSourceResponse, signal: request.signal });
  await expect(parse(sourceInvestigationPlan, reply(invalid), request, "调查")).rejects.toThrow("SOURCE_PLAN_INVALID");
  expect(complete).toHaveBeenCalledTimes(1);
});

it("repairs invalid JSON but never retries an uncertain provider request", async () => {
  const complete = vi.fn(async () => { throw new ModelRequestError("MODEL_TRANSPORT_UNKNOWN", "unknown"); });
  const parse = createSourcePlanParser({ complete, emit: async () => {}, parse: parseSourceResponse, signal: request.signal });
  await expect(parse(sourceInvestigationPlan, { ...reply({}), content: "{" }, request, "调查")).rejects.toThrow("MODEL_TRANSPORT_UNKNOWN");
  expect(complete).toHaveBeenCalledTimes(1);
});

it.each(["length", "stop"])("does not repair empty reply with finish reason %s", async reason => {
  const complete = vi.fn(async () => reply(valid));
  const parse = createSourcePlanParser({ complete, emit: async () => {}, parse: parseSourceResponse, signal: request.signal });
  await expect(parse(sourceInvestigationPlan, { ...reply({}), content: "", raw: JSON.stringify({ choices: [{ finish_reason: reason }] }) }, request, "调查")).rejects.toThrow(reason === "length" ? "MODEL_OUTPUT_LIMIT" : "MODEL_EMPTY_OUTPUT");
  expect(complete).not.toHaveBeenCalled();
});

it("cancellation before repair does not send an additional model request", async () => {
  const controller = new AbortController(); controller.abort(new Error("cancelled"));
  const complete = vi.fn(async () => reply(valid));
  const parse = createSourcePlanParser({ complete, emit: async () => {}, parse: parseSourceResponse, signal: controller.signal });
  await expect(parse(sourceInvestigationPlan, reply(invalid), request, "调查")).rejects.toThrow("cancelled");
  expect(complete).not.toHaveBeenCalled();
});

it("normalizes repeated over-limit plans locally without consuming the shared repair budget", async () => {
  const complete = vi.fn(async () => reply(valid));
  const emit = vi.fn(async (_kind: string, _label: string) => {});
  const parse = createSourcePlanParser({ complete, emit, parse: parseSourceResponse, signal: request.signal });
  const oversized = { goal: "目标".repeat(100), searches: Array.from({ length: 8 }, (_, i) => `term${i}`),
    reads: Array.from({ length: 9 }, () => ({ path: "service.ts", start: "12", count: "999" })) };
  for (const phase of ["调查1", "调查2"]) {
    const plan = await parse(sourceInvestigationPlan, reply(oversized), request, phase);
    expect(plan.goal).toHaveLength(160);
    expect(plan.searches).toEqual(oversized.searches.slice(0, 4));
    expect(plan.reads).toHaveLength(6);
    expect(plan.reads[0]).toEqual({ path: "service.ts", start: 12, count: 180 });
  }
  const counter = await parse(sourceCounterevidencePlan, reply(oversized), request, "反证");
  expect(counter.searches).toHaveLength(6);
  expect(complete).not.toHaveBeenCalled();
  expect(emit.mock.calls.filter(([kind]) => kind === "plan_normalized")).toHaveLength(3);
  // A real format error still has the original single repair available.
  expect(await parse(sourceInvestigationPlan, reply(invalid), request, "调查3")).toEqual(valid);
  expect(complete).toHaveBeenCalledTimes(1);
});

it.each([
  { ...valid, reads: [{ path: null, start: 1, count: 120 }] },
  { ...valid, reads: [{ path: "service.ts", start: -5, count: 120 }] },
  { ...valid, reads: [{ path: "service.ts", start: 1, count: "1.5" }] },
  { ...valid, reads: null },
  { ...valid, searches: ["x".repeat(101)] },
])("does not fabricate or silently change ambiguous plan fields: %j", async malformed => {
  const complete = vi.fn(async () => reply(malformed));
  const parse = createSourcePlanParser({ complete, emit: async () => {}, parse: parseSourceResponse, signal: request.signal });
  await expect(parse(sourceInvestigationPlan, reply(malformed), request, "调查")).rejects.toThrow("SOURCE_PLAN_INVALID");
  expect(complete).toHaveBeenCalledTimes(1);
});
