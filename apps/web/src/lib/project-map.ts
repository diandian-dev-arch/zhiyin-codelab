export type MapCitation = { path: string; start: number; end: number };

export type MapSection = {
  title: string;
  body: string;
  citations: MapCitation[];
  nextStep?: string;
};

export type MapReport = {
  overview: string;
  stack: string[];
  modules: MapSection[];
  flows: MapSection[];
  readingPath: MapSection[];
};

export type MapNode = {
  id: string;
  kind: "project" | "module" | "flow" | "reading";
  title: string;
  body: string;
  citations: MapCitation[];
  order: number;
  relatedModuleIds: string[];
  nextStep?: string;
};

export type FileTreeNode = {
  id: string;
  path: string;
  name: string;
  kind: "directory" | "file";
  children: FileTreeNode[];
};

/** Normalize separators without conflating case-sensitive source paths. */
export function normalizeMapPath(path: string): string {
  return path
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^(?:\.\/)+/, "");
}

function uniqueCitations(citations: readonly MapCitation[]): MapCitation[] {
  const seen = new Set<string>();
  return citations.flatMap((citation) => {
    const normalized = { ...citation, path: normalizeMapPath(citation.path) };
    const key = JSON.stringify([normalized.path, normalized.start, normalized.end]);
    if (seen.has(key)) return [];
    seen.add(key);
    return [normalized];
  });
}

/**
 * Relations express shared cited files only. A report does not provide a
 * dependency graph, so these relations must never be presented as call edges.
 */
export function buildProjectMap(report: MapReport, projectName?: string): {
  root: MapNode;
  modules: MapNode[];
  flows: MapNode[];
  reading: MapNode[];
} {
  const makeNode = (
    section: MapSection,
    kind: "module" | "flow" | "reading",
    order: number,
  ): MapNode => ({
    id: `${kind}-${order}`,
    kind,
    title: section.title,
    body: section.body,
    citations: uniqueCitations(section.citations),
    order,
    relatedModuleIds: [],
    ...(section.nextStep === undefined ? {} : { nextStep: section.nextStep }),
  });

  const modules = report.modules.map((section, index) => makeNode(section, "module", index));
  const modulesByPath = new Map<string, Set<string>>();
  for (const module of modules) {
    for (const citation of module.citations) {
      // Empty paths cannot establish a source relationship.
      if (!citation.path) continue;
      const ids = modulesByPath.get(citation.path) ?? new Set<string>();
      ids.add(module.id);
      modulesByPath.set(citation.path, ids);
    }
  }

  const relatedNode = (section: MapSection, kind: "flow" | "reading", order: number): MapNode => {
    const node = makeNode(section, kind, order);
    const related = new Set<string>();
    for (const citation of node.citations) {
      for (const id of modulesByPath.get(citation.path) ?? []) related.add(id);
    }
    // Follow report order, independent of the order of citations in a section.
    node.relatedModuleIds = modules.filter((module) => related.has(module.id)).map((module) => module.id);
    return node;
  };

  return {
    root: {
      id: "project",
      kind: "project",
      title: projectName?.trim() || "当前项目",
      body: report.overview,
      citations: [],
      order: 0,
      relatedModuleIds: [],
    },
    modules,
    flows: report.flows.map((section, index) => relatedNode(section, "flow", index)),
    reading: report.readingPath.map((section, index) => relatedNode(section, "reading", index)),
  };
}

const fileNameCollator = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "variant" });

/** Build the archive's file hierarchy; folders are derived only from path segments. */
export function buildFileTree(paths: readonly string[]): FileTreeNode[] {
  const roots: FileTreeNode[] = [];
  const nodes = new Map<string, FileTreeNode>();
  for (const input of paths) {
    const path = normalizeMapPath(input);
    if (!path || path.endsWith("/")) continue;
    const parts = path.split("/").filter(Boolean);
    const prefix = path.startsWith("/") ? "/" : "";
    let siblings = roots;
    for (let index = 0; index < parts.length; index += 1) {
      const kind = index === parts.length - 1 ? "file" : "directory";
      const nodePath = prefix + parts.slice(0, index + 1).join("/");
      const id = `${kind}:${nodePath}`;
      let node = nodes.get(id);
      if (!node) {
        node = { id, path: nodePath, name: parts[index], kind, children: [] };
        nodes.set(id, node);
        siblings.push(node);
      }
      siblings = node.children;
    }
  }

  const sortNodes = (siblings: FileTreeNode[]): void => {
    siblings.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
      return fileNameCollator.compare(a.name, b.name) || a.path.localeCompare(b.path);
    });
    for (const node of siblings) sortNodes(node.children);
  };
  sortNodes(roots);
  return roots;
}
