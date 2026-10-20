const uuid =
  "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const allowedPostPaths = [
  "/api/v1/session/(?:login|logout)",
  `/api/v1/classes(?:/${uuid}/students)?`,
  `/api/v2/assignments(?:/${uuid}/(?:publish|tasks|teams))?`,
  `/api/v2/course-tasks/${uuid}/(?:revisions|submissions|late-grants)`,
  `/api/v2/course-teams/${uuid}/(?:accept|members/${uuid})`,
  `/api/v2/late-grants/${uuid}/revoke`,
  `/api/v2/course-submissions/${uuid}/(?:evaluations|contribution-statements)`,
  `/api/v2/course-evaluations/${uuid}/publish`,
  `/api/v2/imports/${uuid}/cancel`,
].map((path) => new RegExp(`^${path}$`));
const aiOrRemotePath =
  /^\/api\/v2\/(?:model-settings|source-cost-preview|self-checks|course-analyses|course-model-consents|repository-connections|repository-identities)(?:\/|$)|^\/api\/v2\/(?:course-submissions\/[^/]+\/(?:analyses|model-consent)|course-tasks\/[^/]+\/self-checks)(?:\/|$)/;

function restricted(): never {
  courseFail(
    "TEACHER_TRIAL_RESTRICTED",
    "本轮校园试用仅开放本地材料与人工教学流程，模型、远程仓库和项目执行暂未开放。",
    403,
  );
}

// Scope gate only; existing authentication, CSRF, ownership and upload validation still apply.
export function enforceTeacherTrialRequest(request: {
  method: string;
  url: string;
  body?: unknown;
}): void {
  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD") return;
  let pathname: string;
  try {
    pathname = new URL(request.url, "http://teacher-trial.invalid").pathname;
  } catch {
    restricted();
  }
  if (aiOrRemotePath.test(pathname) || method !== "POST") restricted();
  if (pathname === "/api/v2/imports") {
    const body = request.body;
    if (
      body &&
      typeof body === "object" &&
      !Array.isArray(body) &&
      Object.hasOwn(body, "type") &&
      ["snippet", "files", "zip"].includes((body as { type: string }).type) &&
      !Object.hasOwn(body, "repository")
    )
      return;
    restricted();
  }
  if (!allowedPostPaths.some((path) => path.test(pathname))) restricted();
}
import { courseFail } from "./coursework-common.js";
