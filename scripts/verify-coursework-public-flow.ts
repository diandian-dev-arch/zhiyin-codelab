// Public Git reads and real loopback HTTP; isolated in-memory data, no model client.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { unzipSync } from "fflate";
import { testDB } from "../tests/db.js";
import { migrate } from "../apps/api/src/db.js";
import { seed } from "../apps/api/src/seed.js";
import { createApp } from "../apps/api/src/app.js";
import { courseImportTick } from "../apps/api/src/coursework-sources.js";

const id = randomUUID();
const record = path.resolve(
  "docs/verification/2026-10-18/coursework",
  `public-flow-${id}.json`,
);
const samples = [
  {
    provider: "gitee",
    owner: "oschina",
    name: "git-osc",
    ref: "8accea70d7df5356cafa40433d19ee95e52fcd72",
    path: "404.html",
  },
  {
    provider: "github",
    owner: "octocat",
    name: "Hello-World",
    ref: "7fd1a60b01f91b314f59955a4e4d4e80d8edf11d",
    path: "README",
  },
] as const;
const receipt: any = {
  id,
  startedAt: new Date().toISOString(),
  kind: "real-public-git-import-submit-manual-publish-loopback-http",
  database: "isolated-in-memory-PGlite",
  workspaceAccess: false,
  externalModelCalls: 0,
  remoteRepositoryWrites: 0,
  realTeacherReviews: 0,
  passed: false,
  limitations: [
    "工程角色与公开样本，不是真实课程或学生成果",
    "没有模型客户端、模型外发、候选报告或 AI 质量验收",
    "未验证私有授权、真实分支推进/强推及完整 A06",
    "PGlite 和同机 HTTP，不是 PostgreSQL 并发/生产容量或浏览器验收",
  ],
  providers: [],
};
let db: Awaited<ReturnType<typeof testDB>> | undefined;
let app: Awaited<ReturnType<typeof createApp>> | undefined;
let base = "";
const origin = "http://127.0.0.1";
type Session = { cookie: string; csrf: string };
type ProviderResult = {
  provider: string;
  submissionId: string;
  sourceHash: string;
};
const accepted: ProviderResult[] = [];
async function http(
  route: string,
  session?: Session,
  payload?: unknown,
  key: string = randomUUID(),
) {
  return fetch(base + route, {
    method: payload === undefined ? "GET" : "POST",
    signal: AbortSignal.timeout(20_000),
    redirect: "error",
    headers: {
      origin,
      ...(session
        ? { cookie: session.cookie, "x-csrf-token": session.csrf }
        : {}),
      ...(payload === undefined
        ? {}
        : { "content-type": "application/json", "idempotency-key": key }),
    },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
}
async function json(
  route: string,
  session: Session,
  payload?: unknown,
  expected = payload === undefined ? 200 : 201,
  key?: string,
) {
  const response = await http("/api/v2" + route, session, payload, key);
  assert.equal(response.status, expected, `HTTP_${response.status}:${route}`);
  return response.json() as Promise<any>;
}
try {
  receipt.implementationSha256 = Object.fromEntries(
    await Promise.all(
      [
        "scripts/verify-coursework-public-flow.ts",
        "apps/api/src/coursework.ts",
        "apps/api/src/coursework-sources.ts",
        "packages/contracts/src/coursework.ts",
      ].map(async (file) => [
        file,
        createHash("sha256")
          .update(await readFile(file))
          .digest("hex"),
      ]),
    ),
  );
  db = await testDB();
  await migrate(db);
  const password = randomUUID();
  await seed(db, password);
  app = await createApp(db, {
    origin,
    secure: false,
    executionApproved: false,
    businessVersion: 2,
    model: "unconfigured",
    image: "not-used",
    packs: [],
    coursework: { enabled: true, background: false },
  });
  base = await app.listen({ host: "127.0.0.1", port: 0 });
  async function login(email: string): Promise<Session> {
    const response = await http("/api/v1/session/login", undefined, {
      email,
      password,
    });
    assert.equal(response.status, 200);
    const cookie = response.headers.get("set-cookie")?.split(";")[0];
    assert(cookie && cookie.startsWith("sid="));
    const body = (await response.json()) as any;
    assert.equal(typeof body.csrf, "string");
    return { cookie, csrf: body.csrf };
  }
  const teacher = await login("teacher@codelab.local");
  const student = await login("student@codelab.local");
  const classes = await http("/api/v1/classes", teacher);
  assert.equal(classes.status, 200);
  const classId = ((await classes.json()) as any).items[0].id;
  const assignment = await json("/assignments", teacher, {
    classId,
    title: "[工程验收] 双平台公开 Git 固定版本",
    tasks: samples.map((s) => ({
      title: `${s.provider} 公开版本读取`,
      description: "只核对固定公开版本和发布链路，不作教学质量判断。",
      requirements: [{ id: "R1", title: "保留指定公开文件的固定版本" }],
      scope: [s.path],
      allowedSources: [s.provider],
    })),
  });
  const tasks = (await json(`/assignments/${assignment.id}`, student)).tasks;
  for (const sample of samples) {
    const result: any = { ...sample, passed: false, stage: "import" };
    receipt.providers.push(result);
    try {
      const task = tasks.find((t: any) =>
        t.config.title.startsWith(sample.provider),
      );
      assert(task, "TASK_MISSING");
      const job = await json(
        "/imports",
        student,
        {
          taskId: task.task_id,
          type: sample.provider,
          repository: {
            provider: sample.provider,
            owner: sample.owner,
            name: sample.name,
            ref: sample.ref,
          },
        },
        202,
      );
      assert.equal(job.status, "created");
      await courseImportTick(db, AbortSignal.timeout(100_000));
      const imported = await json(`/imports/${job.id}`, student);
      assert.equal(
        imported.status,
        "ready",
        imported.failure_code ?? "IMPORT_NOT_READY",
      );
      assert.equal(imported.resolved_commit, sample.ref);
      const snapshot = await json(
        `/snapshots/${imported.snapshot_id}`,
        student,
      );
      assert.equal(snapshot.source.commit, sample.ref);
      assert.deepEqual(
        snapshot.manifest.map((f: any) => f.path),
        [sample.path],
      );
      const source = await json(
        `/snapshots/${snapshot.id}/source?path=${encodeURIComponent(sample.path)}`,
        student,
      );
      const sourceHash = createHash("sha256")
        .update(source.content)
        .digest("hex");
      assert.equal(snapshot.manifest[0].hash, sourceHash);
      Object.assign(result, {
        stage: "submission",
        importId: job.id,
        snapshotId: snapshot.id,
        snapshotHash: snapshot.hash,
        sourceHash,
        bytes: Buffer.byteLength(source.content),
      });
      const payload = {
        snapshotId: snapshot.id,
        taskRevisionId: task.current_revision_id,
      };
      const key = randomUUID();
      const submitted = await json(
        `/course-tasks/${task.task_id}/submissions`,
        student,
        payload,
        201,
        key,
      );
      const replayed = await json(
        `/course-tasks/${task.task_id}/submissions`,
        student,
        payload,
        200,
        key,
      );
      assert.equal(replayed.replayed, true);
      assert.equal(replayed.submission.id, submitted.submission.id);
      assert.equal(submitted.submission.sequence, 1);
      const submissionId = submitted.submission.id;
      for (const role of [student, teacher]) {
        const fixed = await json(
          `/course-submissions/${submissionId}/source?path=${encodeURIComponent(sample.path)}`,
          role,
        );
        assert.equal(fixed.content, source.content);
        const zip = await http(
          `/api/v2/course-submissions/${submissionId}/download`,
          role,
        );
        assert.equal(zip.status, 200);
        assert.match(
          zip.headers.get("cache-control") ?? "",
          /private.*no-store/,
        );
        const files = unzipSync(new Uint8Array(await zip.arrayBuffer()));
        assert.deepEqual(Object.keys(files), [sample.path]);
        assert.equal(
          Buffer.from(files[sample.path]).toString("utf8"),
          source.content,
        );
      }
      const anonymous = await http(
        `/api/v2/course-submissions/${submissionId}/download`,
      );
      assert.equal(anonymous.status, 401);
      result.stage = "manual-publish";
      const blocked = await http(
        `/api/v2/course-submissions/${submissionId}/analyses`,
        teacher,
        { confirmed: true, recipientHash: "0".repeat(64) },
      );
      assert.equal(blocked.status, 409);
      assert.equal(
        ((await blocked.json()) as any).error.code,
        "MODEL_NOT_CONFIGURED",
      );
      const feedback = `[工程角色人工兜底] ${sample.provider} 固定版本已读取；未调用模型，未运行代码，不代表真实教师评价。`;
      const evaluation = await json(
        `/course-submissions/${submissionId}/evaluations`,
        teacher,
        { feedback, outcome: "pending" },
      );
      assert.equal(
        (await json(`/course-submissions/${submissionId}`, student)).evaluations
          .length,
        0,
      );
      await json(
        `/course-evaluations/${evaluation.id}/publish`,
        teacher,
        {},
        200,
      );
      const visible = await json(
        `/course-submissions/${submissionId}`,
        student,
      );
      assert.equal(visible.evaluations.length, 1);
      assert.equal(visible.evaluations[0].feedback, feedback);
      assert.equal(visible.evaluations[0].analysis_id, null);
      assert.equal(visible.snapshot.source.commit, sample.ref);
      assert.equal(visible.analyses.length, 0);
      Object.assign(result, {
        passed: true,
        stage: "complete",
        submissionId,
        evaluationId: evaluation.id,
        replayed: true,
        authenticatedSourceAndZip: true,
        anonymousDownloadDenied: true,
        unconfiguredAnalysisBlocked: true,
        draftHidden: true,
        pendingManualEvaluationPublished: true,
      });
      accepted.push({ provider: sample.provider, submissionId, sourceHash });
    } catch (error) {
      result.failure = (error as any).code ?? (error as Error).message;
    }
  }
  // Re-read both after the other task's import and publication, not just in isolation.
  for (const item of accepted) {
    const sample = samples.find((s) => s.provider === item.provider)!;
    const fixed = await json(
      `/course-submissions/${item.submissionId}/source?path=${encodeURIComponent(sample.path)}`,
      student,
    );
    assert.equal(
      createHash("sha256").update(fixed.content).digest("hex"),
      item.sourceHash,
    );
  }
  assert.equal(
    Number(
      (await db.query("SELECT count(*) AS n FROM course_analyses")).rows[0].n,
    ),
    0,
  );
  receipt.crossTaskSourcePreserved = accepted.length === 2;
  receipt.passed = receipt.providers.every((r: any) => r.passed);
  if (!receipt.passed) process.exitCode = 1;
} catch (error) {
  receipt.failure = (error as any).code ?? (error as Error).message;
  process.exitCode = 1;
} finally {
  await app?.close();
  await db?.close();
  receipt.finishedAt = new Date().toISOString();
  receipt.cleanup = "isolated-http-server-and-in-memory-database-closed";
  await mkdir(path.dirname(record), { recursive: true });
  await writeFile(record, JSON.stringify(receipt, null, 2), { flag: "wx" });
  console.log(
    JSON.stringify({
      record,
      passed: receipt.passed,
      providers: receipt.providers.map((r: any) => ({
        provider: r.provider,
        passed: r.passed,
        stage: r.stage,
        failure: r.failure,
      })),
      externalModelCalls: 0,
    }),
  );
}
