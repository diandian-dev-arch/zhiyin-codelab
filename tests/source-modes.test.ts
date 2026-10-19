import { expect, it } from "vitest";
import {
  buildSourceCatalog,
  planningIndex,
} from "../apps/api/src/source-catalog";
import { sourceOptionsSchema } from "../apps/api/src/source-options";
import { analyzeSource } from "../apps/api/src/source-agent";
import {
  SourceReader,
  readSearchContexts,
} from "../apps/api/src/source-reader";
import type { SummaryProviderV2 } from "../apps/api/src/model-provider-v2";

it("indexes nested packages without losing the backend behind a large frontend", () => {
  const files = Object.fromEntries(
    Array.from({ length: 1800 }, (_, i) => [
      `museum/frontend/src/page${i}.vue`,
      "page",
    ]),
  );
  Object.assign(files, {
    "museum/package.json": "{}",
    "museum/frontend/package.json": "{}",
    "museum/backend/pom.xml": "<project/>",
    "museum/backend/src/MuseumApplication.java": "main",
    "museum/README.md": "doc",
  });
  const catalog = buildSourceCatalog(files);
  expect(catalog.archiveRoot).toBe("museum/");
  expect(catalog.modules.map((m) => m.id).sort()).toEqual([
    ".",
    "backend",
    "frontend",
  ]);
  const index = planningIndex(catalog);
  expect(index.some((f) => f.path.endsWith("MuseumApplication.java"))).toBe(
    true,
  );
  expect(index.length).toBeLessThanOrEqual(1200);
  expect(JSON.stringify(index).length).toBeLessThanOrEqual(48000);
  expect(planningIndex(catalog, ["backend"])[0].module).toBe("backend");
  expect(
    planningIndex(
      buildSourceCatalog(Object.fromEntries(Object.entries(files).reverse())),
    ),
  ).toEqual(index);
});
it("handles flat sources, outer wrappers and long paths within the planning budget", () => {
  expect(buildSourceCatalog({ "app.py": "x" }).modules[0].id).toBe(".");
  expect(
    buildSourceCatalog({
      "root/package.json": "{}",
      "root/src/a.ts": "a",
      "root/test/a.ts": "b",
    })
      .modules.map((m) => m.id)
      .sort(),
  ).toEqual([".", "src", "test"]);
  const files = Object.fromEntries(
    Array.from({ length: 100 }, (_, i) => [
      `${"a".repeat(350)}/${i}/main.ts`,
      "main",
    ]),
  );
  const index = planningIndex(buildSourceCatalog(files));
  expect(index.length).toBeGreaterThan(0);
  expect(JSON.stringify(index).length).toBeLessThanOrEqual(48000);
});
it("validates mode selection and preserves a reserve when reading search results", () => {
  expect(sourceOptionsSchema.parse({})).toEqual({
    version: 1,
    mode: "quick",
    modules: [],
  });
  for (const options of [
    { mode: "other" },
    { mode: "quick", modules: ["src"] },
    { mode: "deep", modules: ["src", "src"] },
    { mode: "deep", modules: Array.from({ length: 7 }, (_, i) => String(i)) },
  ])
    expect(sourceOptionsSchema.safeParse(options).success).toBe(false);
  const reader = new SourceReader({ "a.ts": "match\n".repeat(1000) }, 5000);
  readSearchContexts(reader, [reader.search("match")], {
    reserveCharacters: 4000,
  });
  expect(reader.remainingCharacters).toBeGreaterThanOrEqual(4000);
  expect(reader.remainingCharacters).toBeLessThan(5000);
});

const files = {
  "project/main.ts": "entry",
  "project/service.ts": "first-round-actual-code",
  "project/data.ts": "second-round-actual-code",
};
const citation = { path: "project/main.ts", start: 1, end: 1 };
const section = { title: "入口", body: "测试", citations: [citation] };
const report = {
  overview: "项目",
  stack: [],
  modules: [section],
  flows: [section],
  findings: [],
  readingPath: [section],
  limitations: ["静态"],
};
function fixture(
  observe: (request: any) => void = () => {},
  plan?: (round: number) => any,
): SummaryProviderV2 {
  return {
    configuration: {
      provider: "test",
      model: "test",
      endpoint: "http://test.invalid",
    },
    complete: async (input) => {
      const request = JSON.parse(input.user);
      observe(request);
      const answer =
        request.phase === "investigation"
          ? (plan?.(request.round) ?? {
              goal: `调查${request.round}`,
              searches: [],
              reads: [
                {
                  path:
                    request.round === 1
                      ? "project/service.ts"
                      : "project/data.ts",
                  start: 1,
                  count: 10,
                },
              ],
            })
          : request.draft
            ? request.shape || request.checkShape
              ? { report, checks: [] }
              : { searches: [], reads: [] }
            : request.shape
              ? report
              : { paths: [citation.path] };
      return {
        content: JSON.stringify(answer),
        raw: "fixture",
        requestId: null,
        usage: null,
      };
    },
  };
}
it.each(["quick", "deep"] as const)(
  "%s consumes real prior evidence and records honest coverage",
  async (mode) => {
    const requests: any[] = [],
      events: any[] = [];
    const result = await analyzeSource({
      files,
      provider: fixture((r) => requests.push(r)),
      options: { version: 1, mode, modules: [] },
      signal: new AbortController().signal,
      emit: async (e) => {
        events.push(e);
      },
    });
    expect(requests).toHaveLength(mode === "deep" ? 6 : 4);
    expect(result.coverage.characterBudget).toBe(
      mode === "deep" ? 180000 : 100000,
    );
    expect(result.coverage.readFiles).toBe(mode === "deep" ? 3 : 1);
    expect(result.sourceMap[0].readFiles).toBe(mode === "deep" ? 3 : 1);
    if (mode === "deep") {
      const second = requests.find(
        (r) => r.phase === "investigation" && r.round === 2,
      );
      expect(JSON.stringify(second.excerpts)).toContain(
        "first-round-actual-code",
      );
      expect(JSON.stringify(second.excerpts)).not.toContain(
        "second-round-actual-code",
      );
      expect(second.previousRounds).toEqual([
        { round: 1, goal: "调查1", reads: 1, searches: 0 },
      ]);
      expect(
        events.filter((e) => e.kind === "investigate_done").map((e) => e.round),
      ).toEqual([1, 2]);
    } else expect(result.investigation).toEqual([]);
  },
);
it("rejects nonexistent focus directories and investigation paths", async () => {
  let calls = 0;
  await expect(
    analyzeSource({
      files,
      provider: fixture(() => calls++),
      options: { version: 1, mode: "deep", modules: ["foreign"] },
      signal: new AbortController().signal,
      emit: async () => {},
    }),
  ).rejects.toThrow("INVALID_SOURCE_MODULE");
  expect(calls).toBe(0);
  await expect(
    analyzeSource({
      files,
      provider: fixture(undefined, () => ({
        goal: "bad",
        searches: [],
        reads: [{ path: "missing.ts", start: 1, count: 10 }],
      })),
      options: { version: 1, mode: "deep", modules: [] },
      signal: new AbortController().signal,
      emit: async () => {},
    }),
  ).rejects.toThrow("INVALID_SOURCE_SELECTION");
});
it("a corrected investigation completes both real reading rounds without using invalid requests", async () => {
  const requests: any[] = [], events: any[] = [];
  let first = true;
  const provider = fixture(r => requests.push(r), round => {
    if (first) {
      first = false;
      // Excess count is safely capped locally; an invalid starting line must
      // instead exercise the bounded model repair without inventing a location.
      return { goal: "修正读取位置", searches: [], reads: [{ path: "project/service.ts", start: 0, count: 10 }] };
    }
    return { goal: `调查${round}`, searches: [], reads: [{ path: round === 1 ? "project/service.ts" : "project/data.ts", start: 1, count: 10 }] };
  });
  const result = await analyzeSource({ files, provider, options: { version: 1, mode: "deep", modules: [] }, signal: new AbortController().signal, emit: async e => { events.push(e); } });
  expect(requests).toHaveLength(7);
  expect(result.investigation).toHaveLength(2);
  expect(result.coverage.readFiles).toBe(3);
  expect(events.filter(e => e.kind === "repair_plan")).toHaveLength(1);
  expect(events.filter(e => e.kind === "read" && e.path === "project/service.ts")).toHaveLength(1);
  expect(result.model.calls).toHaveLength(7);
});
it("stops before further model requests after cancellation in an investigation", async () => {
  const controller = new AbortController();
  let calls = 0;
  await expect(
    analyzeSource({
      files,
      provider: fixture((r) => {
        calls++;
        if (r.phase === "investigation")
          controller.abort(new Error("cancelled"));
      }),
      options: { version: 1, mode: "deep", modules: [] },
      signal: controller.signal,
      emit: async () => {},
    }),
  ).rejects.toThrow("cancelled");
  expect(calls).toBe(2);
});
