import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { DB } from "./db.js";
import {
  courseworkFiles,
  courseworkPath,
} from "../../../packages/contracts/src/coursework.js";
import { courseFail, courseHash } from "./coursework-common.js";
import { importSourceZip, redactSource } from "./source-zip.js";

export type CourseVault = {
  sealRepository(owner: string, secret: string): string;
  openRepository(owner: string, secret: string): string;
};
export function excludedCoursePath(p: string) {
  return p
    .split("/")
    .some((s) =>
      /^(node_modules|\.git|dist|build|coverage|vendor|\.venv|venv|__pycache__)$/i.test(
        s,
      ),
    )
    ? "依赖或生成文件"
    : /(^|\/)(\.env(?:\.|$)|\.npmrc$|\.pypirc$|id_rsa|.*credential.*|.*secret.*)|\.(pem|key|p12|pfx)$/i.test(
          p,
        )
      ? "敏感配置"
      : /(?:\.lock|lock\.json|lock\.yaml)$/i.test(p)
        ? "依赖锁文件"
        : null;
}
export function normalizeCourseFiles(
  input: { path: string; content: string }[],
) {
  courseworkFiles.parse(input);
  const files: Record<string, string> = Object.create(null),
    omitted: { path: string; reason: string }[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const item of input) {
    courseworkPath.parse(item.path);
    if (Buffer.byteLength(item.content) > 524288)
      courseFail("SOURCE_FILE_TOO_LARGE", "单文件最多 512 KB");
    if (seen.has(item.path.toLowerCase()))
      courseFail("DUPLICATE_PATH", "存在重复路径");
    seen.add(item.path.toLowerCase());
    if ((total += Buffer.byteLength(item.content)) > 4 * 1024 * 1024)
      courseFail("SOURCE_TOO_LARGE", "保留源码不能超过 4 MB");
    const reason =
      excludedCoursePath(item.path) ??
      (item.content.includes("\0")
        ? "二进制文件"
        : redactSource(item.content) !== item.content
          ? "疑似秘密，请移除后重新上传"
          : null);
    if (reason) omitted.push({ path: item.path, reason });
    else files[item.path] = item.content;
  }
  if (!Object.keys(files).length)
    courseFail("NO_SOURCE_FILES", "没有可读取源码，请检查文件和敏感信息");
  return { files, omitted };
}
export class CourseGitAdapter {
  readonly origin: string;
  constructor(
    readonly provider: "github" | "gitee",
    readonly token?: string,
    readonly transport: typeof fetch = fetch,
  ) {
    this.origin =
      provider === "github" ? "https://api.github.com" : "https://gitee.com";
  }
  async json(route: string, signal?: AbortSignal) {
    // Only server-constructed official API routes. No arbitrary URLs, redirects, archives or hooks.
    if (!route.startsWith("/repos/") && route !== "/user")
      courseFail("REPOSITORY_URL_INVALID", "无效的仓库地址");
    const url = new URL(
      this.origin + (this.provider === "gitee" ? "/api/v5" : "") + route,
    );
    // Gitee's official v5 contract specifies access_token. Never log or return this URL.
    if (this.provider === "gitee" && this.token)
      url.searchParams.set("access_token", this.token);
    try {
      const response = await this.transport(url, {
        redirect: "error",
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(20000)])
          : AbortSignal.timeout(20000),
        headers: {
          Accept: "application/json",
          "User-Agent": "CodeLab-coursework",
          ...(this.token && this.provider === "github"
            ? { Authorization: `Bearer ${this.token}` }
            : {}),
        },
      });
      if (!response.ok)
        courseFail(
          response.status === 401
            ? "REPOSITORY_AUTH_REQUIRED"
            : response.status === 404
              ? "REPOSITORY_NOT_FOUND"
              : response.status === 429 || response.status === 403
                ? "REPOSITORY_LIMIT_OR_PERMISSION"
                : "REPOSITORY_NETWORK_ERROR",
          "仓库读取失败，请检查授权、配额和网络",
          409,
        );
      const reader = response.body?.getReader();
      if (!reader) courseFail("REPOSITORY_EMPTY", "仓库接口未返回内容");
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 6 * 1024 * 1024)
            courseFail("REPOSITORY_TOO_LARGE", "仓库响应超限");
          chunks.push(value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch (error) {
      if ((error as any).statusCode) throw error;
      courseFail(
        "REPOSITORY_NETWORK_ERROR",
        "仓库网络异常，可按原提交重试或改用上传",
        409,
      );
    }
  }
  repo(owner: string, name: string) {
    const safe = z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/);
    safe.parse(owner);
    safe.parse(name);
    if ([owner, name].some((s) => s === "." || s === ".."))
      courseFail("REPOSITORY_URL_INVALID", "仓库名称无效");
    return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  }
  async identity(signal?: AbortSignal) {
    if (!this.token)
      courseFail("REPOSITORY_AUTH_REQUIRED", "核验账号需要本人读取授权", 409);
    const account = await this.json("/user", signal);
    if (
      !Number.isSafeInteger(account.id) ||
      account.id <= 0 ||
      typeof account.login !== "string"
    )
      courseFail("REPOSITORY_IDENTITY_INVALID", "无法核验平台账号");
    return { id: String(account.id), login: account.login.slice(0, 100) };
  }
  async resolve(
    owner: string,
    name: string,
    ref: string,
    signal?: AbortSignal,
  ) {
    const commit = await this.json(
      `${this.repo(owner, name)}/commits/${encodeURIComponent(ref)}`,
      signal,
    );
    if (!/^[a-f0-9]{40,64}$/i.test(commit.sha))
      courseFail("REPOSITORY_COMMIT_INVALID", "无法固定仓库提交");
    return commit.sha as string;
  }
  async files(
    owner: string,
    name: string,
    sha: string,
    signal?: AbortSignal,
    scope: string[] = [],
  ) {
    const repo = this.repo(owner, name);
    const tree = await this.json(
      `${repo}/git/trees/${encodeURIComponent(sha)}?recursive=1`,
      signal,
    );
    if (tree.truncated || !Array.isArray(tree.tree) || tree.tree.length > 5000)
      courseFail(
        "REPOSITORY_TOO_LARGE",
        "仓库文件清单超限，请缩小仓库或改为文件上传",
      );
    const result: { path: string; content: string }[] = [],
      omitted: { path: string; reason: string }[] = [];
    for (const file of tree.tree) {
      if (file.type === "tree") continue;
      courseworkPath.parse(file.path);
      if (
        scope.length &&
        !scope.some((p) => file.path === p || file.path.startsWith(p + "/"))
      ) {
        omitted.push({ path: file.path, reason: "任务范围之外，未读取内容" });
        continue;
      }
      const reason =
        excludedCoursePath(file.path) ??
        (file.mode === "120000" || file.type === "commit"
          ? "符号链接或子模块未获取"
          : file.size > 524288
            ? "单文件超限"
            : null);
      if (reason) {
        omitted.push({ path: file.path, reason });
        continue;
      }
      if (result.length >= 200)
        courseFail(
          "REPOSITORY_TOO_LARGE",
          "源码文件超过 200，请改用局部文件上传",
        );
      if (!/^[a-f0-9]{40,64}$/i.test(file.sha))
        courseFail("REPOSITORY_COMMIT_INVALID", "文件标识无效");
      const blob = await this.json(`${repo}/git/blobs/${file.sha}`, signal);
      if (
        blob.encoding !== "base64" ||
        typeof blob.content !== "string" ||
        blob.content.length > 750000
      )
        courseFail("REPOSITORY_CONTENT_INVALID", "文件编码或大小无效");
      const buffer = Buffer.from(blob.content, "base64");
      let content: string;
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
      } catch {
        omitted.push({ path: file.path, reason: "不是 UTF-8 文本" });
        continue;
      }
      if (content.startsWith("version https://git-lfs.github.com/spec/")) {
        omitted.push({ path: file.path, reason: "Git LFS 未获取" });
        continue;
      }
      result.push({ path: file.path, content });
    }
    const normalized = normalizeCourseFiles(result);
    return {
      files: normalized.files,
      omitted: [...omitted, ...normalized.omitted],
    };
  }
  async compare(
    owner: string,
    name: string,
    base: string,
    head: string,
    signal?: AbortSignal,
  ) {
    if (![base, head].every((v) => /^[a-f0-9]{40,64}$/i.test(v)))
      courseFail("REPOSITORY_COMMIT_INVALID", "比较必须使用完整提交标识");
    const data = await this.json(
      `${this.repo(owner, name)}/compare/${base}...${head}`,
      signal,
    );
    const commits = Array.isArray(data.commits)
      ? data.commits.slice(0, 100).map((c: any) => ({
          sha: c.sha,
          author: c.commit?.author?.name ?? c.author?.name ?? "未知作者",
          message: String(c.commit?.message ?? c.message ?? "").slice(0, 1000),
          verifiedIdentity: false,
          providerUserId: c.author?.id ? String(c.author.id) : null,
          merge: Array.isArray(c.parents) && c.parents.length > 1,
        }))
      : [];
    return {
      status:
        data.status ??
        (data.merge_base_commit?.sha === base
          ? head === base
            ? "identical"
            : "ahead"
          : data.merge_base_commit?.sha
            ? "diverged"
            : "unknown"),
      ancestryConfirmed:
        (["ahead", "identical"].includes(data.status) &&
          (!data.merge_base_commit?.sha ||
            data.merge_base_commit.sha === base)) ||
        (this.provider === "gitee" && data.merge_base_commit?.sha === base),
      changedFiles: Array.isArray(data.files)
        ? data.files
            .slice(0, 200)
            .map((f: any) => f.filename ?? f.path)
            .filter(
              (p: unknown) =>
                typeof p === "string" &&
                courseworkPath.safeParse(p).success &&
                !excludedCoursePath(p as string),
            )
        : [],
      commits,
      limited: !data.commits || data.commits.length >= 100,
      limitation:
        "仅平台返回的作者账号 ID 可关联已核验成员；作者姓名不用于认领。合并、squash、历史缺失不代表零贡献，不推断个人比例。",
    };
  }
}
export async function courseGitConnection(
  db: DB,
  owner: string,
  source: any,
  vault?: CourseVault,
) {
  if (!source.connectionId) return new CourseGitAdapter(source.provider);
  const connection = (
    await db.query(
      "SELECT * FROM course_repository_connections WHERE id=$1 AND owner_id=$2 AND provider=$3 AND revoked_at IS NULL",
      [source.connectionId, owner, source.provider],
    )
  ).rows[0];
  if (!connection || !vault)
    courseFail("REPOSITORY_AUTH_REQUIRED", "仓库授权已失效，请重新授权", 409);
  return new CourseGitAdapter(
    source.provider,
    vault.openRepository(owner, connection.credential),
  );
}
export async function courseContributionEvidence(
  git: CourseGitAdapter,
  source: any,
  base: string,
  members: any[],
) {
  const evidence = await git.compare(
    source.owner,
    source.name,
    base,
    source.commit,
  );
  if (!evidence.ancestryConfirmed)
    return {
      ...evidence,
      commits: evidence.commits.map((c: any) => ({
        ...c,
        verifiedIdentity: false,
      })),
      limitation:
        "未确认起点是当前提交的祖先；不归因个人贡献，也不判定零贡献。",
    };
  return {
    ...evidence,
    commits: evidence.commits.map((commit: any) => {
      const member = members.find((m) =>
        m.gitIdentities?.some(
          (i: any) =>
            i.provider === source.provider &&
            i.provider_user_id === commit.providerUserId,
        ),
      );
      return {
        ...commit,
        verifiedIdentity: !!member,
        memberUserId: member?.userId ?? null,
        memberName: member?.name ?? null,
      };
    }),
  };
}
export async function persistCourseSnapshot(
  db: DB,
  job: any,
  files: Record<string, string>,
  omitted: any[],
  source: any,
) {
  const manifest = Object.keys(files)
    .sort()
    .map((path) => ({
      path,
      bytes: Buffer.byteLength(files[path]),
      hash: createHash("sha256").update(files[path]).digest("hex"),
      language: path.split(".").pop() ?? "text",
    }));
  const id = randomUUID(),
    hash = await courseHash(manifest);
  return db.transaction(async (tx) => {
    const current = (
      await tx.query(
        "SELECT status FROM course_imports WHERE id=$1 FOR UPDATE",
        [job.id],
      )
    ).rows[0];
    if (
      !current ||
      !["created", "fetching", "validating"].includes(current.status)
    )
      return null;
    await tx.query(
      "INSERT INTO course_snapshots(id,import_id,owner_id,files,manifest,content_hash,source,omitted) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [
        id,
        job.id,
        job.owner_id,
        JSON.stringify(files),
        JSON.stringify(manifest),
        hash,
        JSON.stringify(source),
        JSON.stringify(omitted),
      ],
    );
    await tx.query(
      "UPDATE course_imports SET snapshot_id=$2,status='ready',finished_at=clock_timestamp(),failure_code=NULL WHERE id=$1",
      [job.id, id],
    );
    return id;
  });
}
export async function courseImportTick(
  db: DB,
  signal: AbortSignal,
  vault?: CourseVault,
) {
  await db.query(
    "UPDATE course_imports SET status='failed',failure_code='IMPORT_INTERRUPTED',finished_at=clock_timestamp() WHERE status IN ('fetching','validating') AND COALESCE(started_at,created_at)<clock_timestamp()-interval '5 minutes'",
  );
  const job = await db.transaction(async (tx) => {
    const row = (
      await tx.query(
        "SELECT * FROM course_imports WHERE status='created' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED",
      )
    ).rows[0];
    if (row)
      await tx.query(
        "UPDATE course_imports SET status='fetching',started_at=clock_timestamp() WHERE id=$1",
        [row.id],
      );
    return row;
  });
  if (!job) return false;
  signal = AbortSignal.any([signal, AbortSignal.timeout(240000)]);
  try {
    const source = job.source,
      adapter = await courseGitConnection(db, job.owner_id, source, vault);
    // Once resolved, retries use this SHA even if the branch moves.
    const sha =
      job.resolved_commit ??
      (await adapter.resolve(source.owner, source.name, source.ref, signal));
    await db.query(
      "UPDATE course_imports SET resolved_commit=$2 WHERE id=$1 AND status='fetching'",
      [job.id, sha],
    );
    const content = await adapter.files(
      source.owner,
      source.name,
      sha,
      signal,
      source.scope ?? [],
    );
    await persistCourseSnapshot(db, job, content.files, content.omitted, {
      ...source,
      commit: sha,
    });
  } catch (error) {
    await db.query(
      "UPDATE course_imports SET status='failed',failure_code=$2,finished_at=clock_timestamp() WHERE id=$1 AND status IN ('fetching','validating')",
      [job.id, (error as any).code ?? "IMPORT_FAILED"],
    );
  }
  return true;
}
export async function courseUploadedFiles(input: any) {
  if (input.type === "zip") {
    if (!input.zipBase64 || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.zipBase64))
      courseFail("ZIP_INVALID", "ZIP 编码无效");
    const result = await importSourceZip(
      Buffer.from(input.zipBase64, "base64"),
      { redact: false },
    );
    const normalized = normalizeCourseFiles(
      Object.entries(result.files).map(([path, content]) => ({
        path,
        content,
      })),
    );
    return {
      files: normalized.files,
      omitted: [...result.omitted, ...normalized.omitted],
    };
  }
  return normalizeCourseFiles(input.files ?? []);
}
