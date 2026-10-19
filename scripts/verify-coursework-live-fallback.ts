import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { chromium } from "@playwright/test";

const id = process.argv[2];
assert.match(id ?? "", /^[a-f0-9-]{36}$/);
const directory = path.resolve("docs/verification/2026-10-18/coursework");
const source = JSON.parse(
  await readFile(path.join(directory, `live-${id}`, "result.json"), "utf8"),
);
assert.equal(source.mode, "live-synthetic-development");
assert.equal(source.stopReason, "STOP_ANALYSIS_REPORT_EXECUTION_CLAIM");
assert.match(source.submissionPath, /^\/course-submissions\/[a-f0-9-]{36}$/);
const base = "http://127.0.0.1:5174";
const { loginPassword } = JSON.parse(
  await readFile(".data/business-v2/development-credentials.json", "utf8"),
);
type Session = { cookie: string; csrf: string };
const sessions: Session[] = [];
const result: any = {
  id: randomUUID(),
  startedAt: new Date().toISOString(),
  sourceReceipt: id,
  kind: "synthetic-model-failure-manual-fallback",
  realTeacherReview: false,
  externalModelCalls: 0,
  passed: false,
};
async function request(
  session: Session | undefined,
  route: string,
  body?: unknown,
) {
  // This verifier cannot enqueue a model analysis or modify model settings.
  if (body !== undefined)
    assert(
      /^\/api\/v1\/session\/(login|logout)$|^\/api\/v2\/course-submissions\/[a-f0-9-]{36}\/evaluations$|^\/api\/v2\/course-evaluations\/[a-f0-9-]{36}\/publish$/.test(
        route,
      ),
    );
  const response = await fetch(base + route, {
    method: body === undefined ? "GET" : "POST",
    redirect: "error",
    signal: AbortSignal.timeout(15000),
    headers: {
      origin: base,
      ...(session
        ? { cookie: session.cookie, "x-csrf-token": session.csrf }
        : {}),
      ...(body === undefined
        ? {}
        : {
            "content-type": "application/json",
            "idempotency-key": randomUUID(),
          }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert(response.ok, `HTTP_${response.status}`);
  return { response, data: await response.json() };
}
try {
  for (const role of ["teacher", "student"]) {
    const { response, data } = await request(
      undefined,
      "/api/v1/session/login",
      { email: `${role}@codelab.local`, password: loginPassword },
    );
    sessions.push({
      cookie: response.headers
        .getSetCookie()
        .map((c) => c.split(";")[0])
        .join("; "),
      csrf: data.csrf,
    });
  }
  const [teacher, student] = sessions;
  const route = "/api/v2" + source.submissionPath;
  const before = (await request(teacher, route)).data;
  assert(before.task.assignment.title.startsWith("[合成评测]"));
  assert(
    before.analyses.some(
      (a: any) =>
        a.status === "failed" &&
        a.failure_code === "REPORT_EXECUTION_CLAIM" &&
        a.report === null,
    ),
  );
  assert.equal((await request(student, route)).data.analyses.length, 0);
  const feedback = `[合成评测人工兜底 ${id.slice(0, 8)}] 模型候选报告被拦截，本条由开发代理使用教师角色验证人工评价流程，不是真人教师评阅。保留原固定提交，尚待教师核对；未执行代码，不采用失败候选报告。`;
  let evaluation = before.evaluations.find((e: any) => e.feedback === feedback);
  if (!evaluation) {
    const created = await request(teacher, route + "/evaluations", {
      feedback,
      outcome: "pending",
      analysisId: null,
    });
    evaluation = { id: created.data.id, status: "draft" };
  }
  if (evaluation.status !== "published")
    await request(
      teacher,
      `/api/v2/course-evaluations/${evaluation.id}/publish`,
      {},
    );
  const after = (await request(student, route)).data;
  assert.deepEqual(after.submission, before.submission);
  assert.equal(after.analyses.length, 0);
  assert(
    after.evaluations.some(
      (e: any) =>
        e.id === evaluation.id &&
        e.status === "published" &&
        e.analysis_id === null &&
        e.outcome === "pending",
    ),
  );
  result.submissionPath = source.submissionPath;
  result.evaluationId = evaluation.id;
  result.fixedSubmissionUnchanged = true;
  result.failedCandidateStillHidden = true;
  result.manualPendingFeedbackReadable = true;
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const browserErrors: string[] = [];
    for (const [role, width, height] of [["teacher", 1440, 1000], ["student", 390, 844]] as const) {
      const page = await browser.newPage({ baseURL: base, viewport: { width, height }, reducedMotion: "reduce" });
      page.on("pageerror", error => browserErrors.push(error.name));
      await page.goto("/");
      await page.getByLabel("邮箱", { exact: true }).fill(`${role}@codelab.local`);
      await page.getByLabel("密码", { exact: true }).fill(loginPassword);
      await page.getByRole("button", { name: "登录", exact: true }).click();
      await page.getByRole("heading", { name: "实训任务", exact: true }).waitFor();
      // Logged-in page checks are read-only, even if an accidental control is activated.
      await page.route("**/api/**", route => ["GET", "HEAD"].includes(route.request().method()) ? route.continue() : route.abort("blockedbyclient"));
      await page.goto(source.submissionPath);
      await page.getByText(feedback, { exact: true }).waitFor();
      if (role === "teacher") await page.getByText(/REPORT_EXECUTION_CLAIM/).waitFor();
      else assert.equal(await page.getByText(/REPORT_EXECUTION_CLAIM/).count(), 0);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "PAGE_OVERFLOW");
      const screenshot = `live-fallback-${role}.png`;
      await page.screenshot({ path: path.join(directory, screenshot), fullPage: true, animations: "disabled" });
      await page.close();
    }
    assert.deepEqual(browserErrors, []);
    result.browser = { teacherDesktop: true, studentMobile: true, businessWritesAfterLogin: 0, externalModelCalls: 0 };
  } finally { await browser.close(); }
  result.passed = true;
} catch {
  result.error = "LIVE_FALLBACK_VERIFICATION_FAILED";
  process.exitCode = 1;
} finally {
  for (const session of sessions) {
    try {
      await request(session, "/api/v1/session/logout", {});
    } catch {
      /* Session expires server-side. */
    }
  }
  result.finishedAt = new Date().toISOString();
  const receipt = path.join(directory, `fallback-${result.id}.json`);
  await writeFile(receipt, JSON.stringify(result, null, 2), { flag: "wx" });
  console.log(
    JSON.stringify({
      passed: result.passed,
      externalModelCalls: 0,
      evidence: path.relative(process.cwd(), receipt),
    }),
  );
}
