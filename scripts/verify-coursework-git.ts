import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { CourseGitAdapter } from "../apps/api/src/coursework-sources.js";
const directory = path.resolve("docs/verification/2026-10-18/coursework");
const result: any = {
  at: new Date().toISOString(),
  kind: "live-public-api-probe",
  privateRepositories: "not-tested-no-authorized-credentials",
  modelCalls: 0,
  providers: [],
};
for (const item of [
  {
    provider: "gitee" as const,
    owner: "oschina",
    name: "git-osc",
    ref: "master",
  },
  {
    provider: "github" as const,
    owner: "octocat",
    name: "Hello-World",
    ref: "master",
  },
]) {
  const git = new CourseGitAdapter(item.provider);
  const record: any = { ...item, origin: git.origin };
  try {
    const signal = AbortSignal.timeout(90000),
      commit = await git.resolve(item.owner, item.name, item.ref, signal);
    const tree = await git.json(
      `${git.repo(item.owner, item.name)}/git/trees/${commit}?recursive=1`,
      signal,
    );
    const file = tree.tree?.find(
      (f: any) =>
        f.type === "blob" &&
        f.mode !== "120000" &&
        f.size > 0 &&
        f.size < 50000,
    );
    if (!file) throw new Error("NO_SMALL_BLOB");
    const blob = await git.json(
      `${git.repo(item.owner, item.name)}/git/blobs/${file.sha}`,
      signal,
    );
    if (
      blob.encoding !== "base64" ||
      !Buffer.from(blob.content, "base64").length
    )
      throw new Error("BLOB_INVALID");
    const compare = await git.compare(
      item.owner,
      item.name,
      commit,
      commit,
      signal,
    );
    Object.assign(record, {
      state: "passed",
      commit,
      treeEntries: tree.tree.length,
      blob: {
        path: file.path,
        sha: file.sha,
        bytes: Buffer.from(blob.content, "base64").length,
      },
      compareStatus: compare.status,
    });
    {
      const all = await git.files(
        item.owner,
        item.name,
        commit,
        signal,
        item.provider === "gitee" ? [file.path] : [],
      );
      record.fullSnapshotFiles = Object.keys(all.files);
      record.omitted = all.omitted;
    }
  } catch (e) {
    record.state = "failed";
    record.code = (e as any).code ?? "PROBE_FAILED";
    process.exitCode = 1;
  }
  result.providers.push(record);
}
const docs = (await (
  await fetch("https://gitee.com/api/v5/swagger_doc", {
    signal: AbortSignal.timeout(20000),
  })
).json()) as any;
result.giteeContract = {
  url: "https://gitee.com/api/v5/swagger_doc",
  info: docs.info,
  paths: Object.fromEntries(
    Object.entries(docs.paths).filter(
      ([p]) =>
        p.includes("/git/trees/") ||
        p.includes("/git/blobs/") ||
        p.includes("/compare/") ||
        p === "/v5/user",
    ),
  ),
};
await mkdir(directory, { recursive: true });
await writeFile(
  path.join(directory, "git-public-probe.json"),
  JSON.stringify(result, null, 2),
);
console.log(
  JSON.stringify({
    ...result,
    giteeContract: {
      url: result.giteeContract.url,
      version: docs.info?.version,
    },
  }),
);
