import { expect, it } from "vitest";
import {
  sourceExecutionSnapshot,
  assertSourceExecutionSnapshot,
} from "../apps/api/src/source-execution";
import type { SummaryProviderV2 } from "../apps/api/src/model-provider-v2";

const provider: SummaryProviderV2 = {
  configuration: {
    provider: "test",
    model: "test",
    endpoint: "http://test",
    temperature: 0,
  },
  complete: async () => {
    throw new Error("must not call model");
  },
};
it("compares JSONB snapshots independent of key order and excludes credentials", () => {
  const snapshot = sourceExecutionSnapshot({
    ...provider,
    configuration: { ...provider.configuration, apiKey: "excluded" },
  } as SummaryProviderV2);
  const reordered = JSON.parse(JSON.stringify(snapshot), (_key, value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).reverse())
      : value,
  );
  expect(() =>
    assertSourceExecutionSnapshot(reordered, provider),
  ).not.toThrow();
  expect(JSON.stringify(snapshot)).not.toContain("excluded");
});
it.each([
  { model: "changed" },
  { provider: "changed" },
  { endpoint: "https://other.test" },
  { temperature: 0.1 },
  { enableThinking: false },
])("rejects changed model configuration %j", (change) => {
  expect(() =>
    assertSourceExecutionSnapshot(sourceExecutionSnapshot(provider), {
      ...provider,
      configuration: { ...provider.configuration, ...change },
    }),
  ).toThrow("SOURCE_CONFIGURATION_CHANGED");
});
it.each([
  { contextWindowTokens: 128000 },
  { maxOutputTokens: 8192 },
  { tokenizer: "o200k_base" as const },
])("rejects changed capacity policy %j", (change) => {
  expect(() =>
    assertSourceExecutionSnapshot(sourceExecutionSnapshot(provider), {
      ...provider,
      sourceContext: {
        contextWindowTokens: null,
        maxOutputTokens: 12000,
        tokenizer: "utf8-conservative",
        ...change,
      },
    }),
  ).toThrow("SOURCE_CONFIGURATION_CHANGED");
});
it.each([
  {},
  null,
  { version: 2 },
  { ...sourceExecutionSnapshot(provider), extra: true },
])("rejects invalid snapshots without a provider call", (saved) => {
  expect(() => assertSourceExecutionSnapshot(saved, provider)).toThrow(
    "SOURCE_CONFIGURATION_CHANGED",
  );
});
