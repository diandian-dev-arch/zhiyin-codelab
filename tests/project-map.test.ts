import { describe, expect, it } from "vitest";
import {
  buildFileTree,
  buildProjectMap,
  normalizeMapPath,
  type MapCitation,
  type MapReport,
  type MapSection,
} from "../apps/web/src/lib/project-map.js";

const cite = (path: string, start = 1, end = 10): MapCitation => ({ path, start, end });
const section = (title: string, citations: MapCitation[] = []): MapSection => ({
  title,
  body: `${title}说明`,
  citations,
});
const report = (overrides: Partial<MapReport> = {}): MapReport => ({
  overview: "用于理解和学习真实项目。",
  stack: ["TypeScript"],
  modules: [],
  flows: [],
  readingPath: [],
  ...overrides,
});

describe("project map evidence", () => {
  it("matches exact full source paths and never guesses a relationship from titles or basenames", () => {
    const map = buildProjectMap(report({
      modules: [
        section("权限模块", [cite("src/auth/index.ts")]),
        section("订单模块", [cite("src/orders/index.ts")]),
        section("权限模块", [cite("src/Auth/index.ts")]),
      ],
      flows: [
        section("权限模块", [cite("src/unrelated/index.ts")]),
        section("登录", [cite("src/auth/index.ts", 30, 40)]),
        section("无依据", []),
      ],
    }));
    expect(map.flows.map((node) => node.relatedModuleIds)).toEqual([[], ["module-0"], []]);
    expect(map.modules.every((node) => node.relatedModuleIds.length === 0)).toBe(true);
  });

  it("normalizes Windows separators, deduplicates exact citation ranges, and keeps distinct ranges", () => {
    const original = report({
      modules: [section("导入", [
        cite("src\\lib\\import.ts", 3, 9),
        cite("./src/lib/import.ts", 3, 9),
        cite("src/lib/import.ts", 20, 24),
      ])],
      flows: [section("上传文件", [cite("src//lib/import.ts", 30, 35)])],
    });
    const snapshot = structuredClone(original);
    const map = buildProjectMap(original);
    expect(map.modules[0].citations).toEqual([
      cite("src/lib/import.ts", 3, 9),
      cite("src/lib/import.ts", 20, 24),
    ]);
    expect(map.flows[0].relatedModuleIds).toEqual(["module-0"]);
    expect(original).toEqual(snapshot);
  });

  it("keeps the stated reading order and returns related modules in stable report order", () => {
    const map = buildProjectMap(report({
      modules: [section("界面", [cite("src/view.ts")]), section("服务", [cite("src/service.ts")])],
      readingPath: [
        { ...section("先理解入口", [cite("src/service.ts"), cite("src/view.ts"), cite("src/service.ts")]), nextStep: "运行示例" },
        section("再看界面", [cite("src/view.ts")]),
      ],
    }));
    expect(map.reading.map(({ id, order, title }) => ({ id, order, title }))).toEqual([
      { id: "reading-0", order: 0, title: "先理解入口" },
      { id: "reading-1", order: 1, title: "再看界面" },
    ]);
    expect(map.reading[0].relatedModuleIds).toEqual(["module-0", "module-1"]);
    expect(map.reading[0].nextStep).toBe("运行示例");
  });

  it("handles a partial report without inventing citations or module relations", () => {
    const map = buildProjectMap(report(), "  示例项目  ");
    expect(map.root).toMatchObject({ id: "project", title: "示例项目", citations: [], relatedModuleIds: [] });
    expect(map.modules).toEqual([]);
    expect(map.flows).toEqual([]);
    expect(map.reading).toEqual([]);
    expect(buildProjectMap(report(), "  ").root.title).toBe("当前项目");
    const emptyPaths = buildProjectMap(report({
      modules: [section("缺少路径", [cite("")])],
      flows: [section("缺少路径", [cite("")])],
    }));
    expect(emptyPaths.flows[0].relatedModuleIds).toEqual([]);
  });

  it("preserves case, absolute path identity, and dot-dot segments during separator normalization", () => {
    expect(normalizeMapPath(".\\Src\\Models\\Item.ts")).toBe("Src/Models/Item.ts");
    expect(normalizeMapPath("/src/index.ts")).not.toBe(normalizeMapPath("src/index.ts"));
    expect(normalizeMapPath("src/../index.ts")).toBe("src/../index.ts");
  });
});

describe("project file explorer", () => {
  it("builds expandable directories while keeping duplicate basenames in their real parent folders", () => {
    const tree = buildFileTree([
      "src/auth/index.ts",
      "src/orders/index.ts",
      "src\\auth\\index.ts",
      "./src/auth/index.ts",
      "README.md",
    ]);
    expect(tree.map(({ name, kind }) => ({ name, kind }))).toEqual([
      { name: "src", kind: "directory" },
      { name: "README.md", kind: "file" },
    ]);
    expect(tree[0].children.map((node) => node.path)).toEqual(["src/auth", "src/orders"]);
    expect(tree[0].children[0].children).toEqual([
      { id: "file:src/auth/index.ts", name: "index.ts", path: "src/auth/index.ts", kind: "file", children: [] },
    ]);
    expect(tree[0].children[1].children[0].path).toBe("src/orders/index.ts");
  });

  it("sorts directories first and numbered names naturally at each depth", () => {
    const tree = buildFileTree([
      "chapter10/readme10.md", "chapter2/readme10.md", "chapter2/readme2.md",
      "file10.ts", "file2.ts", "chapter2/examples/demo.ts",
    ]);
    expect(tree.map((node) => node.name)).toEqual(["chapter2", "chapter10", "file2.ts", "file10.ts"]);
    expect(tree[0].children.map((node) => node.name)).toEqual(["examples", "readme2.md", "readme10.md"]);
  });

  it("handles empty inputs and retains distinct case-sensitive files without mutating the list", () => {
    expect(buildFileTree([])).toEqual([]);
    expect(buildFileTree(["", "./", "/"])).toEqual([]);
    const paths = Object.freeze(["src/File.ts", "src/file.ts", "src/File.ts"]);
    const tree = buildFileTree(paths);
    expect(tree[0].children).toHaveLength(2);
    expect(new Set(tree[0].children.map((node) => node.path))).toEqual(new Set(["src/File.ts", "src/file.ts"]));
    expect(paths).toEqual(["src/File.ts", "src/file.ts", "src/File.ts"]);
  });

  it("does not confuse file and folder identity if an incomplete catalog contains both", () => {
    const tree = buildFileTree(["src", "src/main.ts"]);
    expect(tree.map((node) => node.id)).toEqual(["directory:src", "file:src"]);
    expect(tree[0].children[0].path).toBe("src/main.ts");
  });
});
