import { expect, it } from "vitest";
import {
  readSourceContextSettings,
  sourceContextPolicy,
  sourceTokenCounter,
  checkSourceRequestBudget,
} from "../apps/api/src/source-context";
import { SourceReader, citationWasRead } from "../apps/api/src/source-reader";
import { analyzeSource } from "../apps/api/src/source-agent";
import {
  buildSourceCatalog,
  planningIndex,
} from "../apps/api/src/source-catalog";
import {
  createSummaryProviderV2,
  type SummaryProviderV2,
} from "../apps/api/src/model-provider-v2";

it("keeps unknown capacity distinct from application limits and rejects inconsistent operator settings", () => {
  const defaults = sourceContextPolicy(readSourceContextSettings({}));
  expect(defaults).toMatchObject({
    contextWindowTokens: null,
    capacitySource: "application-fallback",
    tokenizer: "utf8-conservative",
  });
  for (const env of [
    { SOURCE_MODEL_CONTEXT_TOKENS: "16384" },
    { SOURCE_MODEL_CONTEXT_TOKENS: "1e6" },
    { SOURCE_MODEL_TOKENIZER: "qwen-guessed" },
    { SOURCE_MODEL_MAX_OUTPUT_TOKENS: "-1" },
  ])
    expect(() => readSourceContextSettings(env)).toThrow(
      "SOURCE_CONTEXT_CONFIGURATION_INVALID",
    );
  const provider = createSummaryProviderV2({
    MODEL_API_KEY: "fixture",
    MODEL_BASE_URL: "http://localhost/v1",
    MODEL_NAME: "unknown-model",
    SOURCE_MODEL_CONTEXT_TOKENS: "32768",
    SOURCE_MODEL_MAX_OUTPUT_TOKENS: "4096",
  })!;
  expect(provider.sourceContext).toMatchObject({
    contextWindowTokens: 32768,
    maxOutputTokens: 4096,
    tokenizer: "utf8-conservative",
  });
  expect(provider.configuration).not.toHaveProperty("contextWindowTokens");
});

it.each(["cl100k_base", "o200k_base"] as const)(
  "uses configured %s text tokens, including literal special-token-looking text",
  (name) => {
    const count = sourceTokenCounter(name);
    expect(count("hello world")).toBe(2);
    expect(count("博物馆入口：登录、预约。🚀")).toBeLessThan(
      Buffer.byteLength("博物馆入口：登录、预约。🚀"),
    );
    expect(count("<|endoftext|>")).toBeGreaterThan(0);
    expect(count(" ")).toBeGreaterThan(0);
  },
);

it("reserves output and framing, rejects over-budget full prompts before dispatch, and keeps a byte guard", () => {
  const policy = sourceContextPolicy({
    contextWindowTokens: 32768,
    maxOutputTokens: 4096,
    tokenizer: "utf8-conservative",
  });
  const count = sourceTokenCounter(policy.tokenizer);
  const request = {
    system: "",
    user: "x".repeat(policy.inputTokenLimit),
    maxOutputTokens: 12000,
  };
  expect(checkSourceRequestBudget(policy, count, request).outputTokens).toBe(
    4096,
  );
  expect(() =>
    checkSourceRequestBudget(policy, count, {
      ...request,
      user: request.user + "x",
    }),
  ).toThrow("MODEL_CONTEXT_BUDGET");
  expect(() =>
    checkSourceRequestBudget(policy, () => 1, {
      ...request,
      user: "x".repeat(768 * 1024 + 1),
    }),
  ).toThrow("MODEL_CONTEXT_BUDGET");
});

it("shrinks excerpts on complete source lines and never authorizes unread lines", () => {
  const count = sourceTokenCounter("utf8-conservative");
  const reader = new SourceReader({ "a.ts": "中文🚀\n".repeat(30) }, 10000, {
    limit: 220,
    count,
  });
  reader.reserveTokens(60);
  const excerpt = reader.read("a.ts", 1, 30)!;
  expect(excerpt.source.endsWith("\n")).toBe(true);
  expect(reader.estimatedSourceTokens).toBeLessThanOrEqual(160);
  const end = reader.ranges["a.ts"][0].end;
  expect(end).toBeLessThan(30);
  expect(
    citationWasRead(
      { path: "a.ts", start: end + 1, end: end + 1 },
      reader.ranges,
    ),
  ).toBe(false);
  const before = reader.remainingCharacters;
  reader.reserveTokens(reader.remainingTokens);
  expect(reader.read("a.ts", end + 1, 2)).toBeUndefined();
  expect(reader.remainingCharacters).toBe(before);
  reader.reserveTokens(0);
  expect(reader.read("a.ts", end + 1, 2)).toBeTruthy();
  expect(reader.estimatedSourceTokens).toBeLessThanOrEqual(220);
});

it("retains cross-module planning representatives under a token allocation", () => {
  const files = Object.fromEntries(
    Array.from({ length: 300 }, (_, i) => [`app/frontend/f${i}.ts`, "x"]),
  );
  files["app/backend/main.ts"] = "x";
  const count = sourceTokenCounter("utf8-conservative");
  const index = planningIndex(buildSourceCatalog(files), [], {
    limit: 800,
    count,
  });
  expect(index.some((f) => f.path.includes("backend"))).toBe(true);
  expect(count(JSON.stringify(index))).toBeLessThanOrEqual(800);
  expect(index.length).toBeLessThan(301);
});

it.each(["utf8-conservative", "cl100k_base"] as const)(
  "completes deep analysis with %s admission and reports missing usage honestly",
  async (tokenizer) => {
    const path = "app/main.ts",
      requests: any[] = [];
    const citation = { path, start: 1, end: 1 },
      section = { title: "入口", body: "夹具", citations: [citation] };
    const report = {
      overview: "夹具",
      stack: [],
      modules: [section],
      flows: [section],
      findings: [],
      readingPath: [section],
      limitations: ["静态夹具"],
    };
    const provider: SummaryProviderV2 = {
      configuration: {
        provider: "fixture",
        model: "fixture",
        endpoint: "http://test.invalid",
      },
      sourceContext: {
        contextWindowTokens: 32768,
        maxOutputTokens: 4096,
        tokenizer,
      },
      complete: async (request) => {
        requests.push(request);
        const body = JSON.parse(request.user);
        const value =
          body.phase === "investigation"
            ? {
                goal: "补读",
                searches: [],
                reads: [{ path, start: body.round === 1 ? 50 : 90, count: 30 }],
              }
            : body.draft
              ? body.checkShape
                ? { checks: [], report }
                : { reads: [], searches: [] }
              : body.shape
                ? report
                : { paths: [path] };
        return {
          content: JSON.stringify(value),
          raw: "fixture",
          requestId: null,
          usage:
            requests.length === 1 ? { inputTokens: 17, outputTokens: 5 } : null,
        };
      },
    };
    const result = await analyzeSource({
      files: { [path]: "const 博物馆 = '中文数据';\n".repeat(300) },
      provider,
      signal: new AbortController().signal,
      options: { version: 1, mode: "deep", modules: [] },
      emit: async () => {},
    });
    expect(result.investigation).toHaveLength(2);
    expect(requests).toHaveLength(6);
    const policy = sourceContextPolicy(provider.sourceContext),
      count = sourceTokenCounter(tokenizer);
    for (const r of requests) {
      expect(r.maxOutputTokens).toBeLessThanOrEqual(4096);
      expect(
        count(r.system) +
          count(r.user) +
          r.maxOutputTokens +
          policy.safetyTokens,
      ).toBeLessThanOrEqual(32768);
    }
    expect(result.context).toMatchObject({
      callsWithUsage: 1,
      callsWithoutUsage: 5,
      knownInputTokens: 17,
      knownOutputTokens: 5,
    });
    expect(result.context.estimatedSourceTokens).toBeLessThanOrEqual(
      result.context.sourceTokenLimit,
    );
  },
);
