import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { unzipSync } from "fflate";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { root, templateFiles } from "../apps/api/src/template";
import { validateZip } from "../apps/api/src/zip";
import { validateSourceManifest } from "../packages/contracts/src/v2/index";
import {
  createDevelopmentFixtures,
  DEVELOPMENT_CASE_IDS,
  DEVELOPMENT_FAMILY_ID,
  DEVELOPMENT_SAMPLE_IDS,
} from "../scripts/fixtures";

// Resolve the existing web workspace's Vue dependency; no browser is started.
const webRequire = createRequire(
  new URL("../apps/web/package.json", import.meta.url),
);
const { ref, computed, watch, nextTick } = webRequire("vue");
type SampleId = (typeof DEVELOPMENT_SAMPLE_IDS)[number];
type Task = { id: string; title: string; done: boolean };
type ScriptState = {
  tasks: { value: Task[] };
  title: { value: string };
  filter: { value: string };
  error: { value: string };
  visible: { value: Task[] };
  add: () => void;
};
let files: Record<string, Buffer>;
let generated: Awaited<ReturnType<typeof createDevelopmentFixtures>>;
const stopEffects: Array<() => void> = [];

function appSource(sampleId: SampleId) {
  return Buffer.from(
    unzipSync(generated.archives[sampleId])["src/App.vue"],
  ).toString("utf8");
}

/** Exercise only our generated script with Vue reactivity, not its DOM or runner. */
function loadSourceScript(sampleId: SampleId) {
  const source = appSource(sampleId);
  const script = source.match(/<script setup>([\s\S]*?)<\/script>/)?.[1];
  if (!script) throw new Error("Expected controlled fixture script setup");
  const importLine = /^import \{ref,computed,watch\} from 'vue';\r?$/m;
  if (!importLine.test(script)) throw new Error("Fixture Vue imports changed");
  const storage = new Map<string, string>();
  const context = {
    ref,
    computed,
    watch: (...args: unknown[]) => {
      const stop = watch(...args);
      stopEffects.push(stop);
      return stop;
    },
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
    crypto: { randomUUID },
    fixtureState: undefined as ScriptState | undefined,
  };
  runInNewContext(
    script.replace(importLine, "") +
      "\nglobalThis.fixtureState = {tasks,title,filter,error,visible,add};",
    context,
    { timeout: 1000, filename: `development-fixture:${sampleId}` },
  );
  return { state: context.fixtureState!, storage };
}

beforeAll(async () => {
  files = await templateFiles();
  generated = await createDevelopmentFixtures(files);
});

afterEach(() => {
  for (const stop of stopEffects.splice(0)) stop();
});

describe("registered development sample inputs", () => {
  it.each(DEVELOPMENT_SAMPLE_IDS)(
    "%s passes ZIP admission with exact input identities",
    async (sampleId) => {
      const archive = generated.archives[sampleId];
      const admitted = await validateZip(archive);
      const sample = generated.registry.samples.find(
        (value) => value.sampleId === sampleId,
      )!;
      expect(sample.originalZipSha256).toBe(
        createHash("sha256").update(archive).digest("hex"),
      );
      expect(sample.originalZipSha256).toBe(admitted.sha256);
      expect(sample.zipByteSize).toBe(archive.byteLength);
      const source = Object.fromEntries(
        Object.entries(admitted.files).filter(
          ([name]) => name.startsWith("src/") || name.startsWith("public/"),
        ),
      );
      await expect(
        validateSourceManifest(sample.sourceManifest, source),
      ).resolves.toEqual(sample.sourceManifest);
      for (const [name, content] of Object.entries(files)) {
        if (name !== "src/App.vue") {
          expect(Buffer.from(admitted.files[name], "base64"), name).toEqual(
            content,
          );
        }
      }
    },
  );

  it("keeps every derivative in one development family with expectations separate from measurements", () => {
    expect(generated.registry.samples.map((sample) => sample.sampleId)).toEqual(
      [
        "correct",
        "filter-defect",
        "build-error",
        "create-missing",
        "create-duplicate",
        "filter-setup-blocked",
        "fixed-with-regression",
      ],
    );
    const samples = new Map(
      generated.registry.samples.map((sample) => [sample.sampleId, sample]),
    );
    for (const sample of samples.values()) {
      expect(sample.implementationFamilyId).toBe(DEVELOPMENT_FAMILY_ID);
      expect(sample.purpose).toBe("development");
      expect(sample.frozenEvaluationEligible).toBe(false);
      expect(sample.authorization.containsStudentSubmission).toBe(false);
      expect(sample.verification).toEqual({
        status: "expected-only",
        browserExecution: "not_run",
        actualRunId: null,
        observedCaseResults: [],
      });
      expect(sample.expectedCases.map((result) => result.caseId)).toEqual(
        DEVELOPMENT_CASE_IDS,
      );
      expect(
        sample.expectedCases.every((result) => result.basis.length > 0),
      ).toBe(true);
      if (sample.origin.derivedFromSampleId) {
        expect(sample.origin.parentSourceManifestSha256).toBe(
          samples.get(sample.origin.derivedFromSampleId)!.sourceManifest
            .sourceManifestSha256,
        );
      }
    }
    expect(
      samples.get("fixed-with-regression")!.origin.derivedFromSampleId,
    ).toBe("filter-defect");
  });

  it("regenerates deterministic ZIPs without mutating the input template", async () => {
    const snapshots = Object.fromEntries(
      Object.entries(files).map(([name, bytes]) => [name, Buffer.from(bytes)]),
    );
    const repeated = await createDevelopmentFixtures(files);
    expect(repeated.registry).toEqual(generated.registry);
    for (const sampleId of DEVELOPMENT_SAMPLE_IDS) {
      expect(repeated.archives[sampleId]).toEqual(generated.archives[sampleId]);
    }
    expect(files).toEqual(snapshots);
    expect(unzipSync(generated.archives.correct)["src/App.vue"]).toEqual(
      new Uint8Array(files["src/App.vue"]),
    );
  });

  it("keeps the saved registry and archives aligned with the generator", async () => {
    const saved = JSON.parse(
      await readFile(path.join(root, "fixtures/manifest.json"), "utf8"),
    );
    expect(saved).toEqual(generated.registry);
    for (const sampleId of DEVELOPMENT_SAMPLE_IDS) {
      expect(
        await readFile(path.join(root, "fixtures", `${sampleId}.zip`)),
      ).toEqual(generated.archives[sampleId]);
    }
  });

  it("stops when a template mutation anchor drifts instead of silently emitting a correct negative sample", async () => {
    const changed = {
      ...files,
      "src/App.vue": Buffer.from(
        files["src/App.vue"]
          .toString("utf8")
          .replace("filter.value==='all'", "filter.value === 'all'"),
      ),
    };
    await expect(createDevelopmentFixtures(changed)).rejects.toThrow(
      "模板锚点",
    );
  });
});

describe("development defects at source level (not browser acceptance)", () => {
  it.each([
    ["correct", 1],
    ["create-missing", 0],
    ["create-duplicate", 2],
  ] as const)(
    "%s adds the intended number of rows in the extracted source logic",
    (sampleId, expectedCount) => {
      const { state } = loadSourceScript(sampleId);
      state.title.value = "唯一有效标题";
      state.add();
      expect(state.tasks.value).toHaveLength(expectedCount);
      expect(
        state.tasks.value.filter((task) => task.title === "唯一有效标题"),
      ).toHaveLength(expectedCount);
      expect(new Set(state.tasks.value.map((task) => task.id)).size).toBe(
        expectedCount,
      );
      expect(state.error.value).toBe("");
      for (const invalid of ["", "   "]) {
        state.title.value = invalid;
        state.add();
        expect(state.tasks.value).toHaveLength(expectedCount);
      }
    },
  );

  it("restores the filter predicate while introducing a persistence regression in the source logic", async () => {
    const before = loadSourceScript("filter-defect");
    const after = loadSourceScript("fixed-with-regression");
    for (const fixture of [before, after]) {
      fixture.state.tasks.value = [
        { id: "done-id", title: "已完成任务", done: true },
        { id: "active-id", title: "未完成任务", done: false },
      ];
      fixture.state.filter.value = "done";
    }
    await nextTick();
    expect(before.state.visible.value.map((task) => task.id)).toEqual([
      "done-id",
      "active-id",
    ]);
    expect(after.state.visible.value.map((task) => task.id)).toEqual([
      "done-id",
    ]);
    expect(JSON.parse(before.storage.get("codelab-tasks")!)).toHaveLength(2);
    expect(after.storage.has("codelab-tasks")).toBe(false);
    const expectations = generated.registry.samples.find(
      (sample) => sample.sampleId === "fixed-with-regression",
    )!.expectedCases;
    expect(
      expectations.find((result) => result.caseId === "FILTER-03")!.verdict,
    ).toBe("passed");
    expect(
      expectations.find((result) => result.caseId === "SAVE-01")!.verdict,
    ).toBe("failed");
  });

  it("blocks the public toggle control without injecting a false filter result", () => {
    const control = appSource("filter-setup-blocked").match(
      /<input\b[^>]*data-testid="task-toggle"[^>]*>/,
    )?.[0];
    expect(control).toMatch(/\sdisabled(?:\s|>)/);
    const baselineControl = appSource("correct").match(
      /<input\b[^>]*data-testid="task-toggle"[^>]*>/,
    )?.[0];
    expect(baselineControl).not.toMatch(/\sdisabled(?:\s|>)/);
    const { state } = loadSourceScript("filter-setup-blocked");
    state.title.value = "仍可新增";
    state.add();
    expect(state.tasks.value).toHaveLength(1);
    const expectations = generated.registry.samples.find(
      (sample) => sample.sampleId === "filter-setup-blocked",
    )!.expectedCases;
    for (const result of expectations.filter((result) =>
      result.caseId.startsWith("FILTER-"),
    )) {
      expect(result.verdict).toBe("not_run");
      expect(result.preconditionStatus).toBe("blocked");
      expect(result.reasonCode).toBe("SETUP_BLOCKED");
    }
  });

  it("registers the malformed SFC as a build-failure expectation, not eight feature failures", () => {
    expect(appSource("build-error")).toBe("<template><broken>");
    const sample = generated.registry.samples.find(
      (value) => value.sampleId === "build-error",
    )!;
    expect(sample.expectedRunStatus).toBe("build_error");
    expect(
      sample.expectedCases.every(
        (result) =>
          result.verdict === "not_run" && result.reasonCode === "BUILD_ERROR",
      ),
    ).toBe(true);
  });
});
