import { describe, it, expect, beforeAll } from "vitest";
import { zipSync } from "fflate";
import { templateFiles } from "../apps/api/src/template";
import { validateZip } from "../apps/api/src/zip";
import { compareResults, probeSchema } from "../packages/contracts/src/index";
let files: Record<string, Buffer>;
beforeAll(async () => {
  files = await templateFiles();
});
describe("ZIP admission", () => {
  it("accepts an intact template and hashes the exact upload", async () => {
    const out = await validateZip(Buffer.from(zipSync(files)));
    expect(out.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(out.files["src/App.vue"]).toBeTruthy();
  });
  it.each([
    "../escape.js",
    "src/../../escape.js",
    "node_modules/evil.js",
    ".git/config",
    ".env",
    "public/secret.key",
    "src/a.zip",
    "src/evil.cjs",
    "src//evil.js",
    "src/CON.js",
    "src/app.vue",
  ])("rejects forbidden path %s", async (name) => {
    await expect(
      validateZip(
        Buffer.from(zipSync({ ...files, [name]: Buffer.from("bad") })),
      ),
    ).rejects.toThrow();
  });
  it("rejects changed protected configuration", async () => {
    await expect(
      validateZip(
        Buffer.from(zipSync({ ...files, "package.json": Buffer.from("{}") })),
      ),
    ).rejects.toThrow("模板配置");
  });
  it("rejects missing protected configuration", async () => {
    const copy = { ...files };
    delete copy["vite.config.js"];
    await expect(validateZip(Buffer.from(zipSync(copy)))).rejects.toThrow(
      "缺少模板",
    );
  });
  it("rejects expanded oversized file before reading it", async () => {
    await expect(
      validateZip(
        Buffer.from(
          zipSync({ ...files, "src/large.js": Buffer.alloc(2100000) }),
        ),
      ),
    ).rejects.toThrow("超限");
  });
  it("rejects corrupt archives", async () => {
    await expect(validateZip(Buffer.from("not zip"))).rejects.toThrow();
  });
});
describe("restricted probes and comparisons", () => {
  it("rejects arbitrary code and external navigation", () => {
    for (const actions of [
      [{ type: "evaluate", code: "process.exit()" }],
      [{ type: "open", path: "//evil.com" }],
      [{ type: "open", path: "https://evil.com" }],
      [{ type: "click", testId: "button >> nth=0" }],
    ])
      expect(probeSchema.safeParse({ actions }).success).toBe(false);
  });
  it("distinguishes resolved, regressed and unobservable", () => {
    const r = (id: string, status: any) => ({
      criterionId: id,
      status,
      observation: "",
      steps: [],
      evidenceIds: [],
    });
    expect(
      compareResults(
        [r("a", "failed"), r("b", "passed"), r("c", "failed")],
        [r("a", "passed"), r("b", "failed"), r("c", "not_run")],
      ).map((r) => r.change),
    ).toEqual(["resolved", "regression", "unknown"]);
  });
});
