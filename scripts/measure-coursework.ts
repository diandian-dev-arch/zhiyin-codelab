// Local engineering baseline using generated data and real loopback HTTP/PostgreSQL.
// Never connects to an existing workspace or calls a model.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { postgres, migrate, type DB } from "../apps/api/src/db.js";
import { digest } from "../apps/api/src/auth.js";
import { createApp } from "../apps/api/src/app.js";

assert(
  process.argv
    .slice(2)
    .every((arg) => ["--classroom", "--classroom-cycle"].includes(arg)),
  "UNKNOWN_MEASUREMENT_ARGUMENT",
);
const cycle = process.argv.includes("--classroom-cycle");
const classroom = cycle || process.argv.includes("--classroom");
const snapshotCount = classroom ? 50 : 40;
const concurrency = classroom ? 50 : 4;
const listSamples = classroom ? 300 : 40;
const submitSamples = classroom ? 50 : 40;
const id = randomUUID(),
  container = `codelab-coursework-measure-${id}`;
const record = path.resolve(
  "docs/verification/2026-10-18/coursework",
  `performance-${id}.json`,
);
const password = randomUUID(),
  origin = "http://127.0.0.1";
const receipt: any = {
  id,
  startedAt: new Date().toISOString(),
  passed: false,
  scope: "isolated-generated-data-loopback-http",
  profile: cycle
    ? "50-students-shared-ip-write-cycle"
    : classroom
      ? "50-students-shared-ip"
      : "baseline",
  liveWorkspaceAccess: false,
  externalModelCalls: 0,
  runtime: { node: process.versions.node, platform: process.platform },
  database: { version: "PostgreSQL 17", memoryMiB: 384, cpuLimit: 1 },
  workload: {
    students: 50,
    assignments: 20,
    tasks: 60,
    readySnapshots: snapshotCount,
    concurrency,
    samplesPerOperation: { list: listSamples, submit: submitSamples },
    measuredClientIP: "127.0.0.1",
    submittingAccounts: classroom ? 50 : 1,
    distinctSubmissionTasks: classroom ? 1 : 40,
    measuredWriteCycle: cycle,
  },
  limitations: [
    "同机工程基线，非真实课程试点、长期压测或生产容量承诺",
    "不包含仓库导入、模型耗时或公网网络",
    "数据库为生成样本；无历史大体量代码与报告",
  ],
};
let owned = false,
  db: DB | undefined,
  app: Awaited<ReturnType<typeof createApp>> | undefined;
const exec = promisify(execFile);
async function docker(args: string[]) {
  try {
    return (
      await exec("docker", args, {
        windowsHide: true,
        timeout: 60000,
        maxBuffer: 1024 * 1024,
      })
    ).stdout;
  } catch {
    throw new Error("MEASUREMENT_DOCKER_FAILED");
  }
}
const headers = (p: { sid: string; csrf: string }) => ({
  cookie: `sid=${p.sid}`,
  "x-csrf-token": p.csrf,
  origin,
  "content-type": "application/json",
});
type FixtureResponse = { statusCode: number; json(): any };
try {
  receipt.phase = "source-binding";
  receipt.sourceSha256 = Object.fromEntries(
    await Promise.all(
      [
        "scripts/measure-coursework.ts",
        "apps/api/src/app.ts",
        "apps/api/src/coursework.ts",
        "apps/api/migrations/021_task_coursework.sql",
      ].map(async (file) => [
        file,
        createHash("sha256")
          .update(await readFile(file))
          .digest("hex"),
      ]),
    ),
  );
  receipt.phase = "database-start";
  await docker([
    "run",
    "--detach",
    "--name",
    container,
    "--label",
    `codelab.coursework-measure=${id}`,
    "--memory",
    "384m",
    "--cpus",
    "1",
    "--pids-limit",
    "128",
    "--publish",
    "127.0.0.1::5432",
    "--env",
    `POSTGRES_PASSWORD=${password}`,
    "--env",
    "POSTGRES_DB=coursework_measure",
    "postgres:17-alpine",
  ]);
  owned = true;
  const info = JSON.parse(await docker(["inspect", container]))[0];
  assert.equal(info.Config.Labels["codelab.coursework-measure"], id);
  let ready = false;
  for (let n = 0; n < 60; n++) {
    try {
      await docker([
        "exec",
        container,
        "pg_isready",
        "-h",
        "127.0.0.1",
        "-U",
        "postgres",
        "-d",
        "coursework_measure",
      ]);
      ready = true;
      break;
    } catch {
      await delay(250);
    }
  }
  assert(ready, "DATABASE_NOT_READY");
  receipt.phase = "database-migrate";
  db = postgres(
    `postgres://postgres:${password}@127.0.0.1:${info.NetworkSettings.Ports["5432/tcp"][0].HostPort}/coursework_measure`,
  );
  await migrate(db);
  receipt.phase = "fixture-accounts";
  const people: { id: string; sid: string; csrf: string }[] = [];
  for (let n = 0; n < 51; n++) {
    const p = { id: randomUUID(), sid: randomUUID(), csrf: randomUUID() };
    people.push(p);
    await db.query(
      "INSERT INTO users(id,email,name,role,password_hash) VALUES($1,$2,$3,$4,'measurement-only')",
      [
        p.id,
        `person-${n}@measurement.invalid`,
        `样本 ${n}`,
        n ? "student" : "teacher",
      ],
    );
    await db.query(
      "INSERT INTO sessions(id,user_id,csrf,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",
      [digest(p.sid), p.id, p.csrf],
    );
  }
  const teacher = people[0],
    student = people[1],
    classId = randomUUID();
  await db.query(
    "INSERT INTO classes(id,name,teacher_id) VALUES($1,'耗时测量样本班',$2)",
    [classId, teacher.id],
  );
  for (const p of people.slice(1))
    await db.query("INSERT INTO memberships(class_id,user_id) VALUES($1,$2)", [
      classId,
      p.id,
    ]);
  const appConfig = {
    origin,
    secure: false,
    executionApproved: false,
    businessVersion: 2 as const,
    model: "measurement-no-model",
    image: "not-used",
    packs: [],
    coursework: { background: false },
  };
  app = await createApp(db, appConfig);
  const prepared: {
    taskId: string;
    snapshotId: string;
    taskRevisionId: string;
    actor: (typeof people)[number];
  }[] = [];
  receipt.phase = "fixture-assignments-and-snapshots";
  for (let n = 0; n < 20; n++) {
    const created: FixtureResponse = await app.inject({
      method: "POST",
      url: "/api/v2/assignments",
      remoteAddress: "127.0.1.1",
      headers: headers(teacher),
      payload: {
        classId,
        title: `测量作业 ${n}`,
        tasks: [1, 2, 3].map((t) => ({
          title: `任务 ${t}`,
          description: "静态函数样本",
          requirements: [{ id: "R1", title: "保留输入" }],
        })),
      },
    });
    assert.equal(created.statusCode, 201, "FIXTURE_ASSIGNMENT_FAILED");
    const detail: FixtureResponse = await app.inject({
      url: `/api/v2/assignments/${created.json().id}`,
      remoteAddress: "127.0.1.1",
      headers: headers(teacher),
    });
    assert.equal(detail.statusCode, 200);
    for (const task of detail.json().tasks) {
      if (prepared.length === snapshotCount) break;
      for (const actor of classroom ? people.slice(1) : [student]) {
        const snapshot: FixtureResponse = await app.inject({
          method: "POST",
          url: "/api/v2/imports",
          remoteAddress: "127.0.1.1",
          headers: headers(actor),
          payload: {
            taskId: task.task_id,
            type: "snippet",
            files: [
              {
                path: "src/search.ts",
                content:
                  "export function search(items: string[], q: string) { return q ? items.filter(x => x.includes(q)) : items; }",
              },
            ],
          },
        });
        assert.equal(snapshot.statusCode, 201, "FIXTURE_SNAPSHOT_FAILED");
        prepared.push({
          taskId: task.task_id,
          taskRevisionId: task.current_revision_id,
          snapshotId: snapshot.json().snapshot_id,
          actor,
        });
      }
    }
  }
  assert.equal(prepared.length, snapshotCount, "FIXTURE_SNAPSHOT_COUNT");
  // Start measurement with fresh in-memory quotas; never reset during the workload.
  if (cycle) {
    await app.close();
    app = await createApp(db, appConfig);
  }
  const base = await app.listen({ host: "127.0.0.1", port: 0 });
  receipt.phase = "http-warmup";
  const submissionBody = (p: (typeof prepared)[number]) => ({
    snapshotId: p.snapshotId,
    taskRevisionId: p.taskRevisionId,
  });
  async function request(
    url: string,
    p: typeof teacher,
    body?: unknown,
    options: { status?: number; key?: string } = {},
  ) {
    const response = await fetch(base + "/api/v2" + url, {
      method: body ? "POST" : "GET",
      headers: {
        ...headers(p),
        "idempotency-key": options.key ?? randomUUID(),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10000),
    });
    const value = await response.json();
    if (cycle) {
      receipt.httpCounts ??= {};
      const bucket = `${receipt.phase}:${response.status}`;
      receipt.httpCounts[bucket] = (receipt.httpCounts[bucket] ?? 0) + 1;
    }
    assert.equal(
      response.status,
      options.status ?? (body ? 201 : 200),
      `HTTP_CHECK_FAILED:${response.status}`,
    );
    return value;
  }
  for (let n = 0; n < 4; n++) {
    await request("/assignments", teacher);
    if (!classroom)
      await request(
        `/course-tasks/${prepared[n].taskId}/submissions`,
        student,
        submissionBody(prepared[n]),
      );
  }
  async function measure(
    operation: (n: number) => Promise<unknown>,
    thresholdMs: number,
    sampleCount: number,
  ) {
    const times: number[] = [];
    for (let n = 0; n < sampleCount; n += concurrency)
      await Promise.all(
        Array.from(
          { length: Math.min(concurrency, sampleCount - n) },
          (_, offset) => offset,
        ).map(async (offset) => {
          const start = performance.now();
          await operation(n + offset);
          times.push(performance.now() - start);
        }),
      );
    times.sort((a, b) => a - b);
    const round = (v: number) => Math.round(v * 100) / 100;
    const p95Ms = round(times[Math.ceil(times.length * 0.95) - 1]);
    return {
      samples: times.length,
      failures: 0,
      medianMs: round(times[Math.ceil(times.length * 0.5) - 1]),
      p95Ms,
      maxMs: round(times.at(-1)!),
      thresholdMs,
      met: p95Ms < thresholdMs,
    };
  }
  receipt.phase = "http-list";
  receipt.list = await measure(
    async (n) => {
      const value = await request(
        "/assignments",
        classroom ? people[1 + (n % 50)] : teacher,
      );
      assert.equal(value.items.length, 20);
      assert.equal(
        value.items.reduce((n: number, a: any) => n + a.progress.expected, 0),
        classroom ? 60 : 3000,
      );
    },
    1000,
    listSamples,
  );
  receipt.phase = "http-submit";
  const cycleStarted = performance.now();
  if (cycle) {
    receipt.phase = "cycle-import-v1";
    receipt.importFirst = await measure(
      async (n) => {
        const p = prepared[n];
        const value = await request("/imports", p.actor, {
          taskId: p.taskId,
          type: "files",
          files: [
            {
              path: "src/search.ts",
              content: "export const version = 'FIRST';",
            },
          ],
        });
        assert.equal(value.status, "ready");
        p.snapshotId = value.snapshot_id;
      },
      2000,
      50,
    );
  }
  receipt.phase = cycle ? "cycle-submit-v1" : "http-submit";
  receipt.submit = await measure(
    async (n) => {
      const p = prepared[n],
        value = await request(
          `/course-tasks/${p.taskId}/submissions`,
          p.actor,
          submissionBody(p),
        );
      assert.equal(value.submission.snapshot_id, p.snapshotId);
      if (classroom) assert.equal(value.submission.sequence, 1);
    },
    2000,
    submitSamples,
  );
  if (cycle) {
    const accepted: { id: string; key: string; snapshotId: string }[] = [];
    receipt.phase = "cycle-import-v2";
    receipt.importSecond = await measure(
      async (n) => {
        const p = prepared[n];
        const value = await request("/imports", p.actor, {
          taskId: p.taskId,
          type: "files",
          files: [
            {
              path: "src/search.ts",
              content: "export const version = 'SECOND';",
            },
          ],
        });
        assert.equal(value.status, "ready");
        assert.notEqual(value.snapshot_id, p.snapshotId);
        p.snapshotId = value.snapshot_id;
      },
      2000,
      50,
    );
    receipt.phase = "cycle-submit-v2";
    receipt.submitSecond = await measure(
      async (n) => {
        const p = prepared[n],
          key = randomUUID();
        const value = await request(
          `/course-tasks/${p.taskId}/submissions`,
          p.actor,
          submissionBody(p),
          { key },
        );
        assert.equal(value.submission.sequence, 2);
        assert.equal(value.submission.snapshot_id, p.snapshotId);
        accepted[n] = {
          id: value.submission.id,
          key,
          snapshotId: p.snapshotId,
        };
      },
      2000,
      50,
    );
    receipt.phase = "cycle-replay-v2";
    receipt.replay = await measure(
      async (n) => {
        const p = prepared[n];
        const value = await request(
          `/course-tasks/${p.taskId}/submissions`,
          p.actor,
          submissionBody(p),
          { key: accepted[n].key, status: 200 },
        );
        assert.equal(value.replayed, true);
        assert.equal(value.submission.id, accepted[n].id);
        assert.equal(value.submission.sequence, 2);
      },
      2000,
      50,
    );
    receipt.phase = "cycle-teacher-publish";
    const evaluationIds: string[] = [];
    receipt.manualPublication = await measure(
      async (n) => {
        const draft = await request(
          `/course-submissions/${accepted[n].id}/evaluations`,
          teacher,
          {
            feedback: "构造样本人工流程检查，未运行代码或调用模型。",
            outcome: "pending",
          },
        );
        evaluationIds[n] = draft.id;
        await request(
          `/course-evaluations/${draft.id}/publish`,
          teacher,
          {},
          { status: 200 },
        );
      },
      4000,
      50,
    );
    receipt.phase = "cycle-student-feedback";
    receipt.studentFeedback = await measure(
      async (n) => {
        const value = await request(
          `/course-submissions/${accepted[n].id}`,
          prepared[n].actor,
        );
        assert.equal(value.submission.sequence, 2);
        assert.equal(value.snapshot.id, accepted[n].snapshotId);
        assert.equal(value.evaluations.length, 1);
        assert.equal(value.evaluations[0].id, evaluationIds[n]);
        assert.equal(value.evaluations[0].status, "published");
      },
      1000,
      50,
    );
    receipt.cycleDurationMs = Math.round(performance.now() - cycleStarted);
    assert(
      receipt.cycleDurationMs < 60000,
      "WRITE_CYCLE_EXCEEDED_QUOTA_WINDOW",
    );
    receipt.versionIntegrity = (
      await db.query(`SELECT
      count(*)::int AS versions,
      count(DISTINCT subject_id)::int AS subjects,
      count(*) FILTER (WHERE sequence=1)::int AS first,
      count(*) FILTER (WHERE sequence=2)::int AS second
      FROM course_submissions`)
    ).rows[0];
    assert.deepEqual(receipt.versionIntegrity, {
      versions: 100,
      subjects: 50,
      first: 50,
      second: 50,
    });
    receipt.frozenContentIntegrity = (
      await db.query(`SELECT
      count(*) FILTER (WHERE s.sequence=1 AND p.files->>'src/search.ts'='export const version = ''FIRST'';')::int AS first,
      count(*) FILTER (WHERE s.sequence=2 AND p.files->>'src/search.ts'='export const version = ''SECOND'';')::int AS second
      FROM course_submissions s JOIN course_snapshots p ON p.id=s.snapshot_id`)
    ).rows[0];
    assert.deepEqual(receipt.frozenContentIntegrity, { first: 50, second: 50 });
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int AS n FROM course_evaluations WHERE status='published'",
        )
      ).rows[0].n,
      50,
    );
  }
  receipt.acceptedSubmissions = (
    await db.query("SELECT count(*)::int AS count FROM course_submissions")
  ).rows[0].count;
  if (classroom) {
    assert.equal(receipt.acceptedSubmissions, cycle ? 100 : 50);
    receipt.submissionIntegrity = (
      await db.query(`SELECT
      count(DISTINCT s.subject_id)::int AS subjects,
      count(DISTINCT s.task_id)::int AS tasks,
      count(*) FILTER (WHERE s.sequence=1)::int AS firstVersions,
      count(*) FILTER (WHERE s.submitted_by=p.owner_id)::int AS ownedSnapshots
      FROM course_submissions s JOIN course_snapshots p ON p.id=s.snapshot_id`)
    ).rows[0];
    assert.deepEqual(receipt.submissionIntegrity, {
      subjects: 50,
      tasks: 1,
      firstversions: 50,
      ownedsnapshots: cycle ? 100 : 50,
    });
    const teacherList = await request("/assignments", teacher);
    receipt.teacherSubmitted = teacherList.items.reduce(
      (total: number, assignment: any) => total + assignment.progress.submitted,
      0,
    );
    assert.equal(receipt.teacherSubmitted, 50);
  }
  assert.equal(
    (await db.query("SELECT count(*)::int AS n FROM course_analyses")).rows[0]
      .n,
    0,
  );
  receipt.passed =
    receipt.list.met &&
    receipt.submit.met &&
    (!cycle ||
      [
        receipt.importFirst,
        receipt.importSecond,
        receipt.submitSecond,
        receipt.replay,
        receipt.manualPublication,
        receipt.studentFeedback,
      ].every((r) => r.met));
  receipt.phase = "completed";
  if (!receipt.passed) process.exitCode = 1;
} catch (error) {
  const code = (error as { code?: unknown })?.code;
  if (typeof code === "string" && /^[A-Z0-9_]{1,80}$/.test(code))
    receipt.failureCode = code;
  receipt.error =
    error instanceof assert.AssertionError
      ? error.message
      : "MEASUREMENT_FAILED";
  process.exitCode = 1;
} finally {
  await app?.close();
  await db?.close();
  if (owned) {
    try {
      const info = JSON.parse(await docker(["inspect", container]))[0];
      assert.equal(info.Config.Labels["codelab.coursework-measure"], id);
      await docker(["rm", "--force", "--volumes", container]);
      receipt.cleanup = "clean";
    } catch {
      receipt.cleanup = "needs-attention";
      receipt.passed = false;
      process.exitCode = 1;
    }
  }
  receipt.finishedAt = new Date().toISOString();
  await mkdir(path.dirname(record), { recursive: true });
  await writeFile(record, JSON.stringify(receipt, null, 2));
  console.log(
    JSON.stringify({
      passed: receipt.passed,
      list: receipt.list,
      submit: receipt.submit,
      error: receipt.error,
      cleanup: receipt.cleanup,
      record: path.relative(process.cwd(), record),
    }),
  );
}
