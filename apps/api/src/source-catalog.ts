import path from "node:path";
import type { SourceModule } from "@codelab/contracts/source";

type FileEntry = {
  path: string;
  lines: number;
  module: string;
  role: string;
  priority: number;
};
const manifestPattern =
  /^(package\.json|pom\.xml|build\.gradle(?:\.kts)?|go\.mod|Cargo\.toml|pyproject\.toml|requirements\.txt)$/i;
function role(name: string): [string, number] {
  const base = path.posix.basename(name);
  if (manifestPattern.test(base)) return ["项目配置", 0];
  if (
    /^(main|app|index|server|application)\.[^.]+$/i.test(base) ||
    /Application\.java$/.test(base)
  )
    return ["入口候选", 1];
  if (
    /(route|router|controller|handler|service|repository|mapper|store|auth|guard|middleware)/i.test(
      name,
    )
  )
    return ["业务或调用链候选", 2];
  if (/\.(vue|svelte|[cm]?[jt]sx?|java|py|go|rs|cs|php|rb|sql)$/i.test(base))
    return ["实现", 3];
  return ["配置或说明", 4];
}

/** Path-based navigation hints, never a claim that dependencies or business semantics were proved. */
export function buildSourceCatalog(files: Record<string, string>) {
  const paths = Object.keys(files).sort();
  const rootParts = paths[0]?.split("/").slice(0, -1) ?? [];
  while (
    rootParts.length &&
    !paths.every((p) => p.startsWith(rootParts.join("/") + "/"))
  )
    rootParts.pop();
  const archiveRoot = rootParts.length ? rootParts.join("/") + "/" : "";
  const packageRoots = [
    ...new Set(
      paths
        .filter((p) => manifestPattern.test(path.posix.basename(p)))
        .map((p) => path.posix.dirname(p)),
    ),
  ].sort((a, b) => b.length - a.length || a.localeCompare(b));
  const groups = new Map<string, FileEntry[]>();
  for (const file of paths) {
    const nearestPackage = packageRoots.find(
      (p) => p === "." || file.startsWith(p + "/"),
    );
    const relative = file.slice(archiveRoot.length);
    // Package roots keep monorepos distinct. Inside the outer root, show logical directory areas.
    const packageLabel =
      nearestPackage &&
      nearestPackage !== "." &&
      nearestPackage + "/" !== archiveRoot
        ? nearestPackage.startsWith(archiveRoot)
          ? nearestPackage.slice(archiveRoot.length)
          : nearestPackage
        : "";
    const parts = relative.split("/");
    const id = packageLabel || (parts.length > 1 ? parts[0] : ".");
    const [hint, priority] = role(relative);
    const entry = {
      path: file,
      lines: files[file].split("\n").length,
      module: id,
      role: hint,
      priority,
    };
    const bucket = groups.get(id) ?? [];
    bucket.push(entry);
    groups.set(id, bucket);
  }
  for (const entries of groups.values())
    entries.sort(
      (a, b) => a.priority - b.priority || a.path.localeCompare(b.path),
    );
  const modules: SourceModule[] = [...groups].map(([id, entries]) => ({
    id,
    label: id === "." ? "项目根目录" : id,
    fileCount: entries.length,
    lines: entries.reduce((n, f) => n + f.lines, 0),
    examples: entries.slice(0, 3).map((f) => f.path),
  }));
  modules.sort(
    (a, b) =>
      groups.get(a.id)![0].priority - groups.get(b.id)![0].priority ||
      a.id.localeCompare(b.id),
  );
  return { archiveRoot, groups, modules, fileCount: paths.length };
}

/** Round-robin representatives avoid dropping the backend behind hundreds of alphabetically earlier files. */
export function planningIndex(
  catalog: ReturnType<typeof buildSourceCatalog>,
  focus: string[] = [],
  budget?: { limit: number; count: (text: string) => number },
) {
  const order = [...catalog.modules].sort(
    (a, b) => Number(focus.includes(b.id)) - Number(focus.includes(a.id)),
  );
  const index: Omit<FileEntry, "priority">[] = [];
  const positions = new Map<string, number>();
  let characters = 2;
  let tokens = 2;
  let progress = true;
  while (progress && index.length < 1200) {
    progress = false;
    for (const module of order) {
      const offset = positions.get(module.id) ?? 0;
      const next = catalog.groups.get(module.id)![offset];
      if (!next) continue;
      positions.set(module.id, offset + 1);
      progress = true;
      const { priority, ...entry } = next;
      const cost = JSON.stringify(entry).length + 1;
      if (characters + cost > 48_000) continue;
      const tokenCost = budget ? budget.count(JSON.stringify(entry)) + 1 : 0;
      if (budget && tokens + tokenCost > budget.limit) continue;
      index.push(entry);
      characters += cost;
      tokens += tokenCost;
      if (index.length === 1200) break;
    }
  }
  return index;
}
