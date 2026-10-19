import assert from "node:assert/strict";
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { courseworkDevelopmentCorpus as corpus } from "../eval/coursework-development-corpus.js";
import {
  coursePromptBound,
  liveEvaluationLimits as limits,
  reserveLiveCall,
  sha256,
} from "../eval/coursework-live-guard.js";
import { courseworkTask } from "../packages/contracts/src/coursework.js";
import { validateCourseReport } from "../apps/api/src/coursework-agent.js";
import { courseAnalysisContext } from "../apps/api/src/coursework-quality.js";

// Defaults to offline preflight. --request creates only labeled synthetic records.
const args = process.argv.slice(2);
assert(
  args.length <= 1 && args.every((a) => a === "--request"),
  "EXPECTED_OPTIONAL_REQUEST",
);
const execute = args.includes("--request");
const base = "http://127.0.0.1:5174";
const id = randomUUID();
const directory = path.resolve(
  "docs/verification/2026-10-18/coursework",
  `live-${id}`,
);
await mkdir(directory, { recursive: true });
const agentSource = await readFile("apps/api/src/coursework-agent.ts", "utf8");
const prompt = coursePromptBound(agentSource);
const result: any = {
  id,
  startedAt: new Date().toISOString(),
  mode: execute ? "live-synthetic-development" : "offline-preflight",
  sourceAuthorization:
    "User delegated sample/model/budget planning; authored synthetic corpus only",
  samplePartition: "development-not-held-out",
  teacherReviews: 0,
  heldOutSamples: 0,
  model: "deepseek-flash",
  endpoint: "https://api.deepseek.com/chat/completions",
  limits,
  priceSource: "https://api-docs.deepseek.com/quick_start/pricing/",
  pricingBasis:
    "Peak input cache miss and output USD rates; conservative estimate, not settled invoice or account spend cap",
  agentSha256: sha256(agentSource),
  qualityHelperSha256: sha256(
    await readFile("apps/api/src/coursework-quality.ts", "utf8"),
  ),
  prompt,
  corpusSha256: sha256(JSON.stringify(corpus)),
  providerSha256: sha256(
    await readFile("apps/api/src/model-provider-v2.ts", "utf8"),
  ),
  stage: "offline-preflight",
  reservedCalls: 0,
  attempts: [],
  businessRecords: [],
  developerChecks: [],
  usage: { inputTokens: 0, outputTokens: 0, unknownUsageRequests: 0 },
  publishedPriceUpperEstimateUsd: 0,
  qualityAcceptancePassed: false,
  passed: false,
};
let priorReservedCalls = 0;
const save = () =>
  writeFile(
    path.join(directory, "result.json"),
    JSON.stringify(result, null, 2),
  );
const sessions: Session[] = [];
type Session = { cookie: string; csrf: string; role: string };
let password = "";
class CheckFailure extends Error {}
async function request(
  session: Session | undefined,
  route: string,
  body?: unknown,
) {
  assert(route.startsWith("/api/v"));
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
  const data = await response.json();
  return { response, data };
}
async function api(session: Session, route: string, body?: unknown) {
  const { response, data } = await request(session, "/api/v2" + route, body);
  if (!response.ok)
    throw new CheckFailure(
      `API_${response.status}_${data.error?.code ?? "FAILED"}`,
    );
  return data;
}
async function login(role: "teacher" | "student") {
  const { response, data } = await request(undefined, "/api/v1/session/login", {
    email: `${role}@codelab.local`,
    password,
  });
  if (!response.ok) throw new CheckFailure(`LOGIN_${response.status}`);
  const session = {
    cookie: response.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; "),
    csrf: data.csrf,
    role,
  };
  sessions.push(session);
  return session;
}
async function receiver(session: Session) {
  const [state, target] = await Promise.all([
    api(session, "/model-settings"),
    api(session, "/course-model-recipient"),
  ]);
  assert(state.configured && !state.active, "MODEL_UNAVAILABLE_OR_BUSY");
  assert.equal(state.settings.vendor, "deepseek");
  assert.equal(state.settings.model, result.model);
  assert(state.settings.maxOutputTokens >= limits.outputTokens);
  assert.equal(target.recipient?.endpoint, result.endpoint);
  assert.equal(target.recipient?.model, result.model);
  return { recipient: target.recipient, revision: state.revision };
}
async function waitFor(session: Session, route: string, analysisId: string) {
  for (let i = 0; i < 120; i++) {
    const data = await api(session, route);
    const analysis = (data.messages ?? data.analyses).find(
      (a: any) => a.id === analysisId,
    );
    assert(analysis, "ANALYSIS_NOT_VISIBLE");
    if (!["queued", "running"].includes(analysis.status)) return analysis;
    await pause(1000);
  }
  await api(session, `/course-analyses/${analysisId}/cancel`, {});
  throw new CheckFailure("ANALYSIS_POLL_TIMEOUT_CANCEL_REQUESTED_NO_RETRY");
}
async function analyze(
  session: Session,
  frozen: any,
  fixture: any,
  level: number,
  question = "",
  formalSubmissionId?: string,
) {
  assert.equal(
    sha256(await readFile("apps/api/src/coursework-agent.ts", "utf8")),
    result.agentSha256,
    "APPLICATION_CHANGED",
  );
  assert.equal(
    sha256(await readFile("apps/api/src/coursework-quality.ts", "utf8")),
    result.qualityHelperSha256,
    "APPLICATION_CHANGED",
  );
  const current = await receiver(session);
  assert.deepEqual(current, frozen, "MODEL_CONFIGURATION_CHANGED");
  const user = JSON.stringify({
    task: fixture.config,
    source: {
      hash: fixture.snapshot.hash,
      manifest: fixture.snapshot.manifest,
    },
    files: fixture.sample.files,
    analysisContext: courseAnalysisContext(
      fixture.sample.files,
      Object.keys(fixture.sample.files),
      !formalSubmissionId && level === 3 && fixture.config.allowCode,
    ),
    question,
  });
  // Byte-count upper estimate includes all prompt branches plus 2,048 framing tokens.
  const inputBound =
    prompt.systemBytesUpperBound + Buffer.byteLength(user) + 2048;
  reserveLiveCall(priorReservedCalls + result.reservedCalls, inputBound);
  const attempt: any = {
    sampleId: fixture.sample.id,
    level,
    mode: formalSubmissionId ? "formal" : "self-check",
    taskId: fixture.taskId,
    taskRevisionId: fixture.revisionId,
    snapshotId: fixture.snapshot.id,
    recipientHash: frozen.recipient.hash,
    credentialRevision: frozen.revision,
    sampleSha256: sha256(JSON.stringify(fixture.sample)),
    userPayloadSha256: sha256(user),
    question,
    startedAt: new Date().toISOString(),
    inputTokensUpperEstimate: inputBound,
    status: "reserved-before-enqueue",
  };
  result.reservedCalls++;
  result.attempts.push(attempt);
  await save();
  const start = performance.now();
  try {
    const body = { recipientHash: frozen.recipient.hash, confirmed: true };
    let queued;
    if (formalSubmissionId)
      queued = await api(
        session,
        `/course-submissions/${formalSubmissionId}/analyses`,
        body,
      );
    else if (level === 1) {
      queued = await api(
        session,
        `/course-tasks/${fixture.taskId}/self-checks`,
        { ...body, snapshotId: fixture.snapshot.id },
      );
      fixture.checkId = queued.id;
    } else
      queued = await api(session, `/self-checks/${fixture.checkId}/messages`, {
        ...body,
        level,
        question,
      });
    attempt.analysisId = queued.analysisId ?? queued.id;
    attempt.selfCheckId = fixture.checkId ?? null;
    attempt.status = "enqueued";
    await save();
    const analysis = await waitFor(
      session,
      formalSubmissionId
        ? `/course-submissions/${formalSubmissionId}`
        : `/self-checks/${fixture.checkId}`,
      attempt.analysisId,
    );
    attempt.status = analysis.status;
    attempt.failureCode = analysis.failure_code;
    attempt.usage = analysis.usage;
    attempt.report = analysis.report;
    if (
      Number.isSafeInteger(analysis.usage?.inputTokens) &&
      Number.isSafeInteger(analysis.usage?.outputTokens)
    ) {
      const { inputTokens, outputTokens } = analysis.usage;
      assert(
        Number.isSafeInteger(inputTokens) &&
          Number.isSafeInteger(outputTokens) &&
          inputTokens >= 0 &&
          outputTokens >= 0,
      );
      result.usage.inputTokens += inputTokens;
      result.usage.outputTokens += outputTokens;
      result.publishedPriceUpperEstimateUsd =
        (result.usage.inputTokens * limits.peakInputUsdPerMillion +
          result.usage.outputTokens * limits.peakOutputUsdPerMillion) /
        1e6;
      assert(
        inputTokens <= limits.inputTokens &&
          outputTokens <= limits.outputTokens,
        "PROVIDER_USAGE_EXCEEDS_RESERVATION",
      );
    } else {
      result.usage.unknownUsageRequests++;
      throw new CheckFailure(
        `STOP_UNKNOWN_USAGE_${analysis.failure_code ?? analysis.status}`,
      );
    }
    if (analysis.status !== "succeeded")
      throw new CheckFailure(`STOP_ANALYSIS_${analysis.failure_code}`);
    const { summary, findings, limitations } = analysis.report;
    validateCourseReport(
      { summary, findings, limitations },
      fixture.sample.files,
      fixture.config.requirements,
      level === 3 && fixture.config.allowCode && !formalSubmissionId,
    );
    assert.equal(analysis.report.snapshotId, fixture.snapshot.id);
    assert.equal(analysis.report.taskRevisionId, fixture.revisionId);
    assert.equal(analysis.report.execution.ran, false);
    assert.deepEqual(
      new Set(analysis.report.coveredPaths),
      new Set(Object.keys(fixture.sample.files)),
    );
    assert.deepEqual(analysis.report.unreadPaths, []);
    attempt.developerReferenceVerdictsMatch = fixture.sample.review.every(
      (r: any) =>
        findings.find((f: any) => f.requirementId === r.requirementId)
          ?.verdict === r.expectedVerdict,
    );
    if (!attempt.developerReferenceVerdictsMatch)
      throw new CheckFailure("STOP_DEVELOPER_REFERENCE_MISMATCH");
    if (fixture.sample.id === "course-cross-file")
      assert.deepEqual(
        new Set(
          findings.flatMap((f: any) => f.evidence.map((e: any) => e.path)),
        ),
        new Set(Object.keys(fixture.sample.files)),
      );
    return attempt;
  } catch (error) {
    if (["reserved-before-enqueue", "enqueued"].includes(attempt.status)) {
      attempt.status = "unconfirmed-no-retry";
      result.usage.unknownUsageRequests++;
    }
    throw error;
  } finally {
    attempt.elapsedMs = Math.round(performance.now() - start);
    attempt.finishedAt = new Date().toISOString();
    await save();
  }
}
try {
  // Entire development corpus is tiny; the request guard still runs against each actual snapshot.
  for (const sample of corpus) {
    const bytes =
      prompt.systemBytesUpperBound +
      Buffer.byteLength(JSON.stringify(sample)) +
      Buffer.byteLength(
        JSON.stringify(
          courseAnalysisContext(
            sample.files,
            Object.keys(sample.files),
            sample.level === 3 && sample.task.allowCode,
          ),
        ),
      ) +
      2048;
    reserveLiveCall(0, bytes);
  }
  result.preflight = {
    ...reserveLiveCall(0, limits.inputTokens),
    samples: corpus.length,
  };
  if (execute) {
    result.stage = "cumulative-budget";
    const priorReceipts = [];
    for (const entry of await readdir(path.dirname(directory), {
      withFileTypes: true,
    })) {
      if (
        !entry.isDirectory() ||
        !/^live-[a-f0-9-]{36}$/.test(entry.name) ||
        entry.name === `live-${id}`
      )
        continue;
      let prior;
      try {
        prior = JSON.parse(
          await readFile(
            path.join(path.dirname(directory), entry.name, "result.json"),
            "utf8",
          ),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          throw new CheckFailure("OTHER_EVALUATION_MAY_BE_RUNNING");
        throw error;
      }
      if (prior.mode !== "live-synthetic-development") continue;
      assert(
        Number.isSafeInteger(prior.reservedCalls) && prior.reservedCalls >= 0,
        "INVALID_PRIOR_BUDGET",
      );
      priorReservedCalls += prior.reservedCalls;
      assert.equal(
        prior.usage.unknownUsageRequests,
        0,
        "PRIOR_UNKNOWN_USAGE_STOP",
      );
      priorReceipts.push({
        id: prior.id,
        reservedCalls: prior.reservedCalls,
        usage: prior.usage,
        publishedPriceUpperEstimateUsd: prior.publishedPriceUpperEstimateUsd,
      });
    }
    result.priorBudget = {
      reservedCalls: priorReservedCalls,
      receipts: priorReceipts,
    };
    assert(
      priorReservedCalls + 9 <= limits.calls,
      "REMAINING_BUDGET_INSUFFICIENT_NO_MODEL_CALL",
    );
    result.stage = "official-pricing";
    const pricing = await fetch(result.priceSource, {
      signal: AbortSignal.timeout(20000),
      redirect: "error",
    });
    assert(pricing.ok, "PRICE_SOURCE_UNAVAILABLE");
    const html = await pricing.text();
    assert(
      html.includes("deepseek-flash") &&
        html.includes("$0.3") &&
        html.includes("$1.2"),
      "PUBLISHED_PRICE_CHANGED",
    );
    await writeFile(path.join(directory, "pricing.html"), html, { flag: "wx" });
    result.priceSnapshot = {
      fetchedAt: new Date().toISOString(),
      sha256: sha256(html),
    };
    result.stage = "authenticated-model-preflight";
    ({ loginPassword: password } = JSON.parse(
      await readFile(".data/business-v2/development-credentials.json", "utf8"),
    ));
    const teacher = await login("teacher"),
      student = await login("student");
    const teacherReceiver = await receiver(teacher),
      studentReceiver = await receiver(student);
    result.receivers = { teacher: teacherReceiver, student: studentReceiver };
    const tClasses = (await request(teacher, "/api/v1/classes")).data.items;
    const sClasses = (await request(student, "/api/v1/classes")).data.items;
    const classId = tClasses.find((c: any) =>
      sClasses.some((s: any) => s.id === c.id),
    )?.id;
    assert(classId, "SHARED_CLASS_REQUIRED");
    result.stage = "synthetic-workspace-records";
    const samples = [
      ...corpus.slice(0, 5),
      corpus.find((s) => s.id === "course-code-policy-allow")!,
    ];
    const assignment = await api(teacher, "/assignments", {
      classId,
      title: `[合成评测] DeepSeek ${id.slice(0, 8)}`,
      subjectMode: "individual",
      status: "published",
      tasks: samples.map((s) =>
        courseworkTask.parse({
          ...s.task,
          title: `[合成评测] ${s.id}`,
          allowedSources: ["snippet", "files"],
        }),
      ),
    });
    result.assignmentPath = `/assignments/${assignment.id}`;
    await save();
    const tasks = (await api(teacher, `/assignments/${assignment.id}`)).tasks;
    const fixtures: any[] = [];
    for (const [i, sample] of samples.entries()) {
      const task = tasks[i];
      const imported = await api(student, "/imports", {
        taskId: task.task_id,
        type: Object.keys(sample.files).length === 1 ? "snippet" : "files",
        files: Object.entries(sample.files).map(([path, content]) => ({
          path,
          content,
        })),
      });
      assert(imported.snapshot_id, "SYNTHETIC_SNAPSHOT_NOT_READY");
      const snapshot = await api(student, `/snapshots/${imported.snapshot_id}`);
      for (const [file, content] of Object.entries(sample.files)) {
        assert.equal(
          (
            await api(
              student,
              `/snapshots/${snapshot.id}/source?path=${encodeURIComponent(file)}`,
            )
          ).content,
          content,
        );
        assert.equal(
          snapshot.manifest.find((m: any) => m.path === file)?.hash,
          sha256(content),
        );
      }
      const fixture = {
        sample,
        taskId: task.task_id,
        revisionId: task.current_revision_id,
        config: task.config,
        snapshot,
      };
      fixtures.push(fixture);
      result.businessRecords.push({
        sampleId: sample.id,
        taskId: fixture.taskId,
        snapshotId: snapshot.id,
        revisionId: fixture.revisionId,
      });
      // Fail before reserving a paid call if the teacher can read a private self-check.
      result.stage = `self-check-${sample.id}`;
      // Correct-code sample is assessed formally below, not retried as a private L1.
      if (i !== 0) {
        await analyze(student, studentReceiver, fixture, 1);
        const denied = await request(
          teacher,
          `/api/v2/self-checks/${(fixture as any).checkId}`,
        );
        assert.equal(denied.response.status, 404);
        result.developerChecks.push({
          sampleId: sample.id,
          teacherPrivateReadDenied: true,
        });
      }
      if (sample.id === "course-reversed-search") {
        await analyze(
          student,
          studentReceiver,
          fixture,
          2,
          corpus.find((s) => s.level === 2)!.question,
        );
        const before = (
          await api(student, `/self-checks/${(fixture as any).checkId}`)
        ).messages.map((m: any) => m.id);
        const deniedL3 = await request(
          student,
          `/api/v2/self-checks/${(fixture as any).checkId}/messages`,
          {
            level: 3,
            question: corpus.find((s) => s.id === "course-code-policy-deny")!
              .question,
            recipientHash: studentReceiver.recipient.hash,
            confirmed: true,
          },
        );
        assert.equal(deniedL3.response.status, 409);
        assert.equal(deniedL3.data.error?.code, "HELP_CODE_DISABLED");
        assert.deepEqual(
          (
            await api(student, `/self-checks/${(fixture as any).checkId}`)
          ).messages.map((m: any) => m.id),
          before,
        );
        result.developerChecks.push({
          sampleId: "course-code-policy-deny",
          rejectedBeforeEnqueue: true,
          modelCalls: 0,
        });
      }
      if (sample.task.allowCode) {
        await analyze(
          student,
          studentReceiver,
          fixture,
          2,
          "只解释过滤条件，给一个可自行验证的小步骤。",
        );
        await analyze(student, studentReceiver, fixture, 3, sample.question);
      }
    }
    const fixture = fixtures[0];
    result.stage = "formal-consent-analysis-publication";
    const submitted = await api(
      student,
      `/course-tasks/${fixture.taskId}/submissions`,
      {
        snapshotId: fixture.snapshot.id,
        taskRevisionId: fixture.revisionId,
        note: "自编合成评测；不是学生真实成果或教师评阅样本",
      },
    );
    const submissionId = submitted.submission.id;
    result.submissionPath = `/course-submissions/${submissionId}`;
    await api(student, `/course-submissions/${submissionId}/model-consent`, {
      recipientHash: teacherReceiver.recipient.hash,
      confirmed: true,
    });
    const formal = await analyze(
      teacher,
      teacherReceiver,
      fixture,
      1,
      "",
      submissionId,
    );
    const beforePublish = await api(
      student,
      `/course-submissions/${submissionId}`,
    );
    assert.equal(beforePublish.analyses.length, 0);
    const evaluation = await api(
      teacher,
      `/course-submissions/${submissionId}/evaluations`,
      {
        feedback:
          "合成工程评测：静态报告与固定源码已由开发代理核对；并非真人教师评阅，未运行代码，不代表教学质量验收。",
        outcome: "pending",
        analysisId: formal.analysisId,
      },
    );
    await api(teacher, `/course-evaluations/${evaluation.id}/publish`, {});
    const published = await api(student, `/course-submissions/${submissionId}`);
    assert(
      published.evaluations.some(
        (e: any) => e.id === evaluation.id && e.status === "published",
      ),
    );
    assert(published.analyses.some((a: any) => a.id === formal.analysisId));
    result.developerChecks.push({
      formalHiddenBeforePublish: true,
      formalVisibleAfterPublish: true,
      evaluationId: evaluation.id,
    });
    assert.equal(result.reservedCalls, 9);
    assert(priorReservedCalls + result.reservedCalls <= limits.calls);
  }
  result.passed = true;
  result.stage = "finished";
} catch (error) {
  process.exitCode = 1;
  // No raw responses, credential-bearing exceptions, or account identifiers in public failure logs.
  result.stopReason =
    error instanceof Error && /^[A-Z_0-9]+$/.test(error.message)
      ? error.message
      : "LIVE_EVALUATION_CHECK_FAILED";
} finally {
  for (const session of sessions) {
    try {
      await request(session, "/api/v1/session/logout", {});
    } catch {
      /* Session expires server-side. */
    }
  }
  result.finishedAt = new Date().toISOString();
  await save();
  console.log(
    JSON.stringify({
      passed: result.passed,
      reservedCalls: result.reservedCalls,
      stopReason: result.stopReason,
      usage: result.usage,
      evidence: path.relative(
        process.cwd(),
        path.join(directory, "result.json"),
      ),
    }),
  );
}
