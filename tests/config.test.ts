import { describe, it, expect } from "vitest";
import { readApiConfig, readWorkerConfig } from "../apps/api/src/config.js";
import { readRunnerConfig } from "../apps/runner/src/config.js";
import { readInitialAnalysisModeV2 } from '../apps/api/src/analysis-mode-v2.js';

describe("service configuration boundaries", () => {
  it('requires explicit known initial analysis strategies and defaults production to agent', () => {
    expect(readInitialAnalysisModeV2({})).toBe('agent');
    for (const mode of ['off', 'summary', 'agent']) expect(readInitialAnalysisModeV2({ CODELAB_INITIAL_ANALYSIS_MODE: mode })).toBe(mode);
    expect(() => readInitialAnalysisModeV2({ CODELAB_INITIAL_ANALYSIS_MODE: 'summry' })).toThrow('INITIAL_ANALYSIS_MODE_INVALID');
  });
  it("rejects invalid ports and booleans without leaking the database password", () => {
    const env = { DATABASE_URL: "postgres://user:secret@localhost/db", API_PORT: "NaN" };
    expect(() => readApiConfig(env)).toThrow("API_PORT");
    expect(() => readApiConfig({ ...env, API_PORT: "3100", EXECUTION_APPROVED: "yes" })).toThrow("EXECUTION_APPROVED");
    try { readApiConfig(env); } catch (error) { expect(String(error)).not.toContain("secret"); }
  });
  it("fails closed for worker and runner", () => {
    expect(() => readWorkerConfig({})).toThrow("worker 拒绝启动");
    expect(() => readWorkerConfig({ EXECUTION_APPROVED: "true", DATABASE_URL: "postgres://localhost/db", RUNNER_URL: "file:///tmp", RUNNER_TOKEN: "x" })).toThrow("配置无效");
    expect(() => readRunnerConfig({ RUNNER_APPROVED: "true", RUNNER_TOKEN: "x".repeat(32) }, "win32")).toThrow("Linux");
    expect(() => readRunnerConfig({ RUNNER_APPROVED: "true", RUNNER_TOKEN: "replace-with-at-least-32-random-characters" }, "linux")).toThrow("RUNNER_TOKEN");
  });
  it("requires complete model configuration only when a model key is provided", () => {
    const env = { EXECUTION_APPROVED: "true", DATABASE_URL: "postgres://localhost/db", RUNNER_URL: "http://localhost:3200", RUNNER_TOKEN: "t".repeat(32), MODEL_API_KEY: "" };
    expect(readWorkerConfig(env).MODEL_API_KEY).toBeUndefined();
    expect(() => readWorkerConfig({ ...env, MODEL_API_KEY: "private" })).toThrow("MODEL_NAME/MODEL_BASE_URL");
  });
});
