import { describe, expect, it } from "vitest";
import { enforceTeacherTrialRequest } from "../apps/api/src/teacher-trial-policy.js";

const id = "8f095fe3-5f93-40ec-b80d-f53355172666";
const memberId = "5543302c-4b56-4e87-8ef8-cb060b44fc9a";
const check = (url: string, method = "POST", body?: unknown) =>
  enforceTeacherTrialRequest({ method, url, body });
function expectRestricted(url: string, method = "POST", body?: unknown) {
  let failure: unknown;
  try {
    check(url, method, body);
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({
    statusCode: 403,
    code: "TEACHER_TRIAL_RESTRICTED",
  });
  expect((failure as Error).message).toContain("人工教学流程");
}

describe("first teacher trial allowlist, not an execution sandbox", () => {
  it.each(["GET", "HEAD"])(
    "keeps %s reads available while normal authorization still applies",
    (method) => {
      for (const url of [
        "/api/v1/session",
        "/api/v2/assignments",
        `/api/v2/course-submissions/${id}`,
        "/api/v2/model-settings",
        `/api/v2/projects/${id}`,
        `/api/v2/runs/${id}`,
      ])
        expect(() => check(url, method)).not.toThrow();
    },
  );

  it.each([
    "/api/v1/session/login",
    "/api/v1/session/logout",
    "/api/v1/classes",
    `/api/v1/classes/${id}/students`,
    "/api/v2/assignments",
    `/api/v2/assignments/${id}/publish`,
    `/api/v2/assignments/${id}/tasks`,
    `/api/v2/assignments/${id}/teams`,
    `/api/v2/course-tasks/${id}/revisions`,
    `/api/v2/course-tasks/${id}/submissions`,
    `/api/v2/course-tasks/${id}/late-grants`,
    `/api/v2/course-teams/${id}/accept`,
    `/api/v2/course-teams/${id}/members/${memberId}`,
    `/api/v2/late-grants/${id}/revoke`,
    `/api/v2/course-submissions/${id}/evaluations`,
    `/api/v2/course-submissions/${id}/contribution-statements`,
    `/api/v2/course-evaluations/${id}/publish`,
    `/api/v2/imports/${id}/cancel`,
  ])("allows the existing manual-flow POST %s", (url) => {
    expect(() => check(url)).not.toThrow();
  });

  it.each(["snippet", "files", "zip"])(
    "allows parsed local %s materials only at the import endpoint",
    (type) => {
      expect(() => check("/api/v2/imports", "POST", { type })).not.toThrow();
      expect(() =>
        check("/api/v2/imports?type=github&analyze=true", "POST", { type }),
      ).not.toThrow();
      expectRestricted("/api/v2/imports", "PUT", { type });
      expectRestricted("/api/v2/imports", "POST", {
        type,
        repository: { provider: "github" },
      });
    },
  );

  it.each([
    undefined,
    null,
    [],
    "{}",
    {},
    { type: "gitee" },
    { type: "github" },
    { type: "ZIP" },
    { type: "snippet", repository: null },
    Object.create({ type: "snippet" }),
  ])("rejects missing, remote or ambiguous import data %#", (body) => {
    expectRestricted("/api/v2/imports", "POST", body);
  });

  it.each([
    "/api/v2/model-settings",
    "/api/v2/model-settings/test",
    "/api/v2/source-cost-preview",
    `/api/v2/course-tasks/${id}/self-checks`,
    `/api/v2/self-checks/${id}/messages`,
    `/api/v2/course-submissions/${id}/analyses`,
    `/api/v2/course-submissions/${id}/model-consent`,
    `/api/v2/course-model-consents/${id}/revoke`,
    `/api/v2/course-analyses/${id}/cancel`,
    "/api/v2/repository-connections",
    `/api/v2/repository-connections/${id}/verify`,
    `/api/v2/repository-connections/${id}/revoke`,
    "/api/v2/repository-identities",
    `/api/v2/imports/${id}/retry`,
    "/api/v2/projects",
    `/api/v2/projects/${id}/analyze`,
    `/api/v2/projects/${id}/cancel`,
    `/api/v2/project-submissions/${id}/analyze`,
    `/api/v2/project-submissions/${id}/cancel`,
    "/api/v1/tasks",
    `/api/v1/tasks/${id}/rules`,
    `/api/v1/tasks/${id}/submissions`,
    `/api/v1/submissions/${id}/runs`,
    `/api/v1/runs/${id}/publish`,
    "/api/v2/tasks",
    `/api/v2/tasks/${id}/rules`,
    `/api/v2/tasks/${id}/submissions`,
    `/api/v2/submissions/${id}/runs`,
    `/api/v2/runs/${id}/analyses`,
    `/api/v2/runs/${id}/cancel`,
    `/api/v2/runs/${id}/publications`,
    "/api/v2/future-write-endpoint",
  ])("denies out-of-scope writes before a handler: %s", (url) => {
    expectRestricted(url);
  });

  it.each(["PUT", "PATCH", "DELETE", "OPTIONS", "TRACE", "CONNECT"])(
    "does not broaden a permitted pathname to method %s",
    (method) => {
      expectRestricted("/api/v2/assignments", method);
      expectRestricted("/api/v2/model-settings", method);
    },
  );

  it("uses URL pathname and exact routes rather than keyword or prefix matching", () => {
    expect(() =>
      check(`/api/v2/assignments?description=analyses&title=github`),
    ).not.toThrow();
    expect(() => check("/api/v2/local/../assignments")).not.toThrow();
    expectRestricted("/api/v2/model-settings?path=/api/v2/assignments");
    expectRestricted(`/api/v2/assignments/${id}/publish/analyses`);
    expectRestricted(`/api/v2/assignments/${id}/publish%2Fanalyses`);
    expectRestricted(`/api/v2/course-submissions/${id}/%61nalyses`);
    expectRestricted(`/api/v2/course-tasks/${id}%2Fself-checks/submissions`);
    expectRestricted("/api/v2/assignments-extra");
    expectRestricted("/api/v2/assignments/");
    expectRestricted("/api/v2/assignments/not-a-uuid/tasks");
    expectRestricted(
      "/api/v2/course-submissions/" + id + "/model-consent/../analyses",
    );
    expectRestricted("http://[");
  });
});
