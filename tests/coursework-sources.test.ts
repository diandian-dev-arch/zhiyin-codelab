import { describe, it, expect, vi } from "vitest";
import {
  CourseGitAdapter,
  courseContributionEvidence,
} from "../apps/api/src/coursework-sources";
const sha = "a".repeat(40),
  blobSha = "b".repeat(40);
function adapter(
  provider: "github" | "gitee",
  handler: (url: URL, init: RequestInit) => unknown,
  token?: string,
) {
  const transport = vi.fn(
    async (input: any, init: any) =>
      new Response(
        JSON.stringify(await handler(new URL(String(input)), init)),
        { headers: { "content-type": "application/json" } },
      ),
  );
  return {
    git: new CourseGitAdapter(provider, token, transport as typeof fetch),
    transport,
  };
}
describe("bounded official Git adapters", () => {
  it.each(["github", "gitee"] as const)(
    "pins %s resolution; reads only SHA blobs, omits links/LFS/secrets and never follows redirects",
    async (provider) => {
      const { git, transport } = adapter(provider, (url, init) => {
        expect(url.origin).toBe(
          provider === "github"
            ? "https://api.github.com"
            : "https://gitee.com",
        );
        expect(init.redirect).toBe("error");
        if (url.pathname.includes("/commits/")) return { sha };
        if (url.pathname.includes("/trees/"))
          return {
            tree: [
              { path: "src/a.ts", sha: blobSha, type: "blob", size: 20 },
              { path: ".env", sha: blobSha, type: "blob" },
              { path: "link", sha: blobSha, type: "blob", mode: "120000" },
              { path: "sub", sha: blobSha, type: "commit" },
              { path: "lfs", sha: "c".repeat(40), type: "blob" },
            ],
          };
        return {
          encoding: "base64",
          content: Buffer.from(
            url.pathname.endsWith(blobSha)
              ? "export const a=1;"
              : "version https://git-lfs.github.com/spec/v1",
          ).toString("base64"),
        };
      });
      expect(await git.resolve("owner", "repo", "feature/a")).toBe(sha);
      const files = await git.files("owner", "repo", sha);
      expect(files.files).toEqual({ "src/a.ts": "export const a=1;" });
      expect(files.omitted).toHaveLength(4);
      expect(transport).toHaveBeenCalledTimes(4);
    },
  );
  it.each(["github", "gitee"] as const)(
    "uses documented %s authentication without exposing credentials in results",
    async (provider) => {
      const { git } = adapter(
        provider,
        (url, init) => {
          if (provider === "github") {
            expect((init.headers as any).Authorization).toBe(
              "Bearer fixture-token",
            );
            expect(url.searchParams.has("access_token")).toBe(false);
          } else {
            expect(url.searchParams.get("access_token")).toBe("fixture-token");
            expect((init.headers as any).Authorization).toBeUndefined();
          }
          return { id: 123, login: "verified-user" };
        },
        "fixture-token",
      );
      expect(await git.identity()).toEqual({
        id: "123",
        login: "verified-user",
      });
    },
  );
  it("rejects arbitrary URLs, traversal, oversized and truncated responses", async () => {
    const { git, transport } = adapter("github", () => ({
      tree: [],
      truncated: true,
    }));
    await expect(git.json("http://127.0.0.1/internal")).rejects.toMatchObject({
      code: "REPOSITORY_URL_INVALID",
    });
    expect(transport).not.toHaveBeenCalled();
    await expect(git.resolve("..", "repo", "main")).rejects.toThrow();
    await expect(git.files("o", "r", sha)).rejects.toMatchObject({
      code: "REPOSITORY_TOO_LARGE",
    });
    const huge = new CourseGitAdapter(
      "github",
      undefined,
      (async () =>
        new Response("x".repeat(6 * 1024 * 1024 + 1))) as typeof fetch,
    );
    await expect(huge.json("/repos/o/r")).rejects.toMatchObject({
      code: "REPOSITORY_TOO_LARGE",
    });
  });
  it("only maps exact verified provider IDs, marks merge/squash/unknown histories and filters generated paths", async () => {
    const { git } = adapter("github", () => ({
      status: "ahead",
      merge_base_commit: { sha },
      commits: [
        {
          sha: blobSha,
          author: { id: 42, name: "same name" },
          commit: { author: { name: "same name" }, message: "work" },
          parents: [{}, {}],
        },
        {
          sha: "c".repeat(40),
          author: { id: 43, name: "same name" },
          commit: { author: { name: "same name" }, message: "other" },
        },
      ],
      files: [{ filename: "src/a.ts" }, { filename: "node_modules/a.js" }],
    }));
    const e = await courseContributionEvidence(
      git,
      { provider: "github", owner: "o", name: "r", commit: blobSha },
      sha,
      [
        {
          userId: "member1",
          name: "student",
          gitIdentities: [{ provider: "github", provider_user_id: "42" }],
        },
      ],
    );
    expect(e.commits[0]).toMatchObject({
      verifiedIdentity: true,
      memberUserId: "member1",
      merge: true,
    });
    expect(e.commits[1].verifiedIdentity).toBe(false);
    expect(e.changedFiles).toEqual(["src/a.ts"]);
    expect(JSON.stringify(e)).not.toMatch(/percentage|percent|贡献率/);
    const unknown = adapter("github", () => ({
      status: "diverged",
      commits: [{ sha, author: { id: 42 } }],
    })).git;
    expect(
      (
        await courseContributionEvidence(
          unknown,
          { provider: "github", owner: "o", name: "r", commit: blobSha },
          sha,
          [],
        )
      ).ancestryConfirmed,
    ).toBe(false);
  });
});
