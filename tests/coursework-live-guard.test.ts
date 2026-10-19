import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  coursePromptBound,
  reserveLiveCall,
} from "../eval/coursework-live-guard";

describe("real coursework evaluation safeguards (offline)", () => {
  it("bounds nested prompt branches and the fixed one-digit help level", () => {
    const result = coursePromptBound(
      'const request = {system: `a${flag ? `b${job.level}` : "longer"}z`};',
    );
    expect(result.systemBytesUpperBound).toBe(8);
    expect(result.templateSha256).toMatch(/^[a-f0-9]{64}$/);
  });
  it("fails closed when the application prompt gains an unbounded input", () => {
    expect(() =>
      coursePromptBound("const request = {system: `a${student.question}`};"),
    ).toThrow("PROMPT_DYNAMIC_VALUE_UNBOUNDED");
    expect(() => coursePromptBound("const other = {};")).toThrow(
      "PROMPT_SHAPE_CHANGED",
    );
  });
  it("binds the current production prompt without a model call", async () => {
    const result = coursePromptBound(
      await readFile("apps/api/src/coursework-agent.ts", "utf8"),
    );
    expect(result.systemBytesUpperBound).toBeGreaterThan(1000);
    expect(result.systemBytesUpperBound).toBeLessThan(5000);
  });
  it("reserves no more than ten bounded calls under the published-price estimate", () => {
    expect(reserveLiveCall(9, 8000)).toEqual({
      call: 10,
      batchUpperEstimateUsd: 0.072,
    });
    for (const calls of [-1, 10, 1.5, NaN])
      expect(() => reserveLiveCall(calls, 8000)).toThrow(
        "EVALUATION_CALL_LIMIT",
      );
    for (const bytes of [0, 8001, Infinity, 1.1])
      expect(() => reserveLiveCall(0, bytes)).toThrow("EVALUATION_INPUT_LIMIT");
  });
});
