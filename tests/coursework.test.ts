import { randomBytes, randomUUID } from "node:crypto";
import {
  beforeAll,
  beforeEach,
  afterAll,
  describe,
  it,
  expect,
  vi,
} from "vitest";
import { courseImportTick } from "../apps/api/src/coursework-sources";
import { planCourseRetention } from "../apps/api/src/course-retention-plan";
import { createApp } from "../apps/api/src/app";
import { migrate } from "../apps/api/src/db";
import { digest } from "../apps/api/src/auth";
import { isolatedTestDB, type IsolatedTestDatabase } from "./isolated-db";
import { courseWindow } from "../apps/api/src/coursework";
import {
  courseAnalysisTick,
  courseRecipient,
  validateCourseReport,
  courseHelpPolicyDiagnostic,
} from "../apps/api/src/coursework-agent";
import { ModelRequestError } from "../apps/api/src/model-provider-v2";
import { createUserModelService } from "../apps/api/src/user-model-settings";
import { zipSync, strToU8, unzipSync, strFromU8 } from "fflate";
type Person = { id: string; headers: Record<string, string> };
const origin = "http://localhost:5173",
  config = {
    title: "搜索函数",
    description: "空关键词返回所有项目",
    requirements: [{ id: "R1", title: "正确处理空关键词" }],
  };
describe("task coursework: immutable submissions, private teaching and authorization", () => {
  let db: IsolatedTestDatabase,
    app: Awaited<ReturnType<typeof createApp>>,
    teacher: Person,
    student: Person,
    peer: Person,
    outsider: Person,
    classId: string;
  let models: ReturnType<typeof createUserModelService>,
    inputs: any[] = [],
    providerMode = "ok";
  let clientAddress = "127.0.0.1",
    clientSequence = 0;
  // Each case represents a fresh client; it must not share a minute's IP quota with all preceding cases.
  beforeEach(() => {
    clientAddress = `127.0.1.${++clientSequence}`;
  });
  async function person(role: string) {
    const id = randomUUID(),
      sid = randomUUID(),
      csrf = randomUUID();
    await db.query(
      "INSERT INTO users(id,email,name,role,password_hash) VALUES($1,$2,$3,$4,$5)",
      [
        id,
        `${id}@course.invalid`,
        role + "-" + id.slice(0, 5),
        role,
        "test-only",
      ],
    );
    await db.query(
      "INSERT INTO sessions(id,user_id,csrf,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",
      [digest(sid), id, csrf],
    );
    return {
      id,
      headers: { origin, cookie: `sid=${sid}`, "x-csrf-token": csrf },
    };
  }
  beforeAll(async () => {
    db = await isolatedTestDB();
    await migrate(db);
    teacher = await person("teacher");
    student = await person("student");
    peer = await person("student");
    outsider = await person("student");
    classId = randomUUID();
    await db.query(
      "INSERT INTO classes(id,name,teacher_id) VALUES($1,'升级测试班',$2)",
      [classId, teacher.id],
    );
    await db.query(
      "INSERT INTO memberships(class_id,user_id) VALUES($1,$2),($1,$3)",
      [classId, student.id, peer.id],
    );
    models = createUserModelService(db, randomBytes(32), (env) => ({
      configuration: {
        provider: "unit-provider",
        model: env.MODEL_NAME!,
        endpoint: "https://model.invalid/chat/completions",
      },
      complete: async (input) => {
        inputs.push(input);
        if (providerMode === "fail") throw new Error("provider down");
        if (providerMode === "quota")
          throw new ModelRequestError("MODEL_HTTP_402", "failed");
        const data = JSON.parse(input.user);
        return {
          raw: "",
          content: JSON.stringify({
            summary:
              providerMode === "injected"
                ? "运行通过"
                : providerMode === "code-summary"
                  ? "const PRIVATE_SUMMARY = [];"
                  : "尚需验证，未执行代码",
            findings: data.task.requirements.map((r: any) => ({
              requirementId: r.id,
              verdict:
                providerMode === "no-code-delivery" ? "unmet" : "unknown",
              explanation: "缺少运行证据",
              impact: "尚不能确认边界输入是否影响目标",
              evidence:
                providerMode === "no-code-delivery"
                  ? [{ path: Object.keys(data.files)[0], start: 1, end: 1 }]
                  : [],
              suggestion:
                providerMode === "code"
                  ? data.analysisContext?.codeHelpRequested
                    ? "局部示意，仍需结合当前输入验证：\n```ts\nconst example = [];\n```"
                    : "const example = [];"
                  : "请自行验证边界输入",
              verification: "在本地执行测试",
            })),
            limitations: ["仅静态分析"],
          }),
          usage: { inputTokens: 123, outputTokens: 45 },
          requestId: "mock-receipt",
        };
      },
    }));
    for (const p of [teacher, student])
      await models.save(p.id, {
        vendor: "openai",
        model: "test-model",
        apiKey: "test-key-for-isolated-fixture",
      });
    app = await createApp(db, {
      origin,
      secure: false,
      executionApproved: false,
      businessVersion: 2,
      model: "fixture",
      image: "fixture",
      packs: [],
      userModels: models,
      coursework: { background: false },
    });
  });
  afterAll(async () => {
    await app?.close();
    await db?.close();
  });
  const get = (url: string, p = student) =>
    app.inject({
      url: "/api/v2" + url,
      headers: p.headers,
      remoteAddress: clientAddress,
    });
  const post = (
    url: string,
    p: Person,
    payload: any = {},
    key = randomUUID(),
  ) =>
    app.inject({
      method: "POST",
      remoteAddress: clientAddress,
      url: "/api/v2" + url,
      headers: { ...p.headers, "idempotency-key": key },
      payload,
    });
  async function assignment(extra: any = {}) {
    const r = await post("/assignments", teacher, {
      classId,
      title: "任务化练习",
      tasks: [config],
      ...extra,
    });
    expect(r.statusCode, r.body).toBe(201);
    const d = await get("/assignments/" + r.json().id);
    expect(d.statusCode, d.body).toBe(200);
    return { id: r.json().id, task: d.json().tasks[0] };
  }
  async function taskData(taskId: string, p = student) {
    const r = await get(`/course-tasks/${taskId}`, p);
    expect(r.statusCode, r.body).toBe(200);
    return r.json();
  }
  async function snapshot(
    taskId: string,
    p = student,
    files = [
      {
        path: "search.ts",
        content:
          "export function search(items: string[], q: string) { return items.filter(x => x.includes(q)); }",
      },
    ],
  ) {
    const r = await post("/imports", p, {
      taskId,
      type: files.length === 1 ? "snippet" : "files",
      files,
    });
    expect(r.statusCode, r.body).toBe(201);
    return r.json().snapshot_id as string;
  }
  async function submit(
    taskId: string,
    snapshotId: string,
    extra: any = {},
    p = student,
    key = randomUUID(),
  ) {
    const t = await taskData(taskId, p);
    return post(
      `/course-tasks/${taskId}/submissions`,
      p,
      { snapshotId, taskRevisionId: t.task.current_revision_id, ...extra },
      key,
    );
  }
  async function fixture() {
    const a = await assignment(),
      s = await snapshot(a.task.task_id),
      r = await submit(a.task.task_id, s);
    expect(r.statusCode, r.body).toBe(201);
    return { ...a, snapshotId: s, submission: r.json().submission };
  }
  it("accepts a snippet with no model calls; independent tasks do not share sources or submissions", async () => {
    const f = await fixture();
    expect(inputs).toHaveLength(0);
    const second = await assignment();
    expect(
      (await submit(second.task.task_id, f.snapshotId)).json().error.code,
    ).toBe("SOURCE_NOT_READY");
    expect((await taskData(second.task.task_id)).submissions).toEqual([]);
    const detail = await get(`/course-submissions/${f.submission.id}`);
    expect(detail.json()).toMatchObject({
      submission: { sequence: 1, late_grant_id: null },
      analyses: [],
      evaluations: [],
    });
    for (const who of [peer, outsider])
      expect(
        (
          await get(
            `/course-submissions/${f.submission.id}/source?path=search.ts`,
            who,
          )
        ).statusCode,
      ).toBeGreaterThanOrEqual(403);
    expect((await get(`/snapshots/${f.snapshotId}`, teacher)).statusCode).toBe(
      409,
    );
    expect(
      (await get(`/project-tasks/${f.task.task_id}`, teacher)).json().error
        .code,
    ).toBe("COURSEWORK_ROUTE_REQUIRED");
    const download = await get(
      `/course-submissions/${f.submission.id}/download`,
    );
    expect(download.headers["content-type"]).toContain("application/zip");
    expect(strFromU8(unzipSync(download.rawPayload)["search.ts"])).toContain(
      "search",
    );
    for (const who of [peer, outsider])
      expect(
        (await get(`/course-submissions/${f.submission.id}/download`, who))
          .statusCode,
      ).toBeGreaterThanOrEqual(403);
    expect(
      (await get(`/assignments/${f.id}`, teacher)).json().tasks[0].progress,
    ).toEqual({ expected: 2, submitted: 1, reviewed: 0 });
    expect(
      (await get(`/assignments/${f.id}`, peer)).json().tasks[0].progress,
    ).toEqual({ expected: 1, submitted: 0, reviewed: 0 });
    for (const [who, expected] of [
      [teacher, { expected: 2, submitted: 1, reviewed: 0 }],
      [student, { expected: 1, submitted: 1, reviewed: 0 }],
      [peer, { expected: 1, submitted: 0, reviewed: 0 }],
    ] as const) {
      const list = (await get("/assignments", who)).json();
      expect(list.items.find((a: any) => a.id === f.id).progress).toEqual(
        expected,
      );
    }
  });
  it("lists only the viewer's progress and pending deadlines without creating subjects on a read", async () => {
    const created = await post("/assignments", teacher, {
      classId,
      title: "列表待办",
      tasks: [
        { ...config, dueAt: "2099-01-01T12:00:00.000Z" },
        { ...config, dueAt: "2099-02-01T12:00:00.000Z" },
      ],
    });
    const id = created.json().id;
    const listed = async (who: Person) =>
      (await get("/assignments", who))
        .json()
        .items.find((a: any) => a.id === id);
    expect(await listed(student)).toMatchObject({
      progress: { expected: 2, submitted: 0, reviewed: 0 },
      pendingDueAt: "2099-01-01T12:00:00.000Z",
    });
    expect(
      (
        await db.query(
          "SELECT count(*)::int AS n FROM course_subjects WHERE assignment_id=$1",
          [id],
        )
      ).rows[0].n,
    ).toBe(0);
    const task = (await get(`/assignments/${id}`)).json().tasks[0];
    const saved = await submit(task.task_id, await snapshot(task.task_id));
    expect(saved.statusCode).toBe(201);
    expect(await listed(student)).toMatchObject({
      progress: { expected: 2, submitted: 1, reviewed: 0 },
      pendingDueAt: "2099-02-01T12:00:00.000Z",
    });
    expect(await listed(teacher)).toMatchObject({
      progress: { expected: 4, submitted: 1, reviewed: 0 },
      pendingDueAt: "2099-01-01T12:00:00.000Z",
    });
    expect(await listed(peer)).toMatchObject({
      progress: { expected: 2, submitted: 0, reviewed: 0 },
    });
    // Historical work remains readable to its teacher; roster statistics count current learners.
    await db.query("DELETE FROM memberships WHERE class_id=$1 AND user_id=$2", [
      classId,
      student.id,
    ]);
    try {
      expect(await listed(teacher)).toMatchObject({
        progress: { expected: 2, submitted: 0, reviewed: 0 },
      });
    } finally {
      await db.query(
        "INSERT INTO memberships(class_id,user_id) VALUES($1,$2)",
        [classId, student.id],
      );
    }
  });
  it("replays duplicate concurrent requests once and rejects same-key different payloads", async () => {
    const a = await assignment(),
      s = await snapshot(a.task.task_id),
      key = randomUUID();
    const t = await taskData(a.task.task_id),
      body = { snapshotId: s, taskRevisionId: t.task.current_revision_id };
    const results = await Promise.all([
      post(`/course-tasks/${a.task.task_id}/submissions`, student, body, key),
      post(`/course-tasks/${a.task.task_id}/submissions`, student, body, key),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 201]);
    expect(results[0].json().submission.id).toBe(
      results[1].json().submission.id,
    );
    const conflict = await post(
      `/course-tasks/${a.task.task_id}/submissions`,
      student,
      { ...body, note: "changed" },
      key,
    );
    expect(conflict.json().error.code).toBe("IDEMPOTENCY_CONFLICT");
    expect((await taskData(a.task.task_id)).submissions).toHaveLength(1);
  });
  it("uses strict server deadline boundaries and narrow revocable late grants", async () => {
    const due = "2026-01-01T12:00:00.000Z";
    expect(courseWindow(new Date("2026-01-01T11:59:59.999Z"), due)).toBe(
      "normal",
    );
    expect(courseWindow(new Date(due), due)).toBe("closed");
    const grant = { opens_at: due, closes_at: "2026-01-01T13:00:00.000Z" };
    expect(courseWindow(new Date(due), due, grant)).toBe("late");
    expect(courseWindow(new Date(grant.closes_at), due, grant)).toBe("closed");
    const a = await assignment({
        tasks: [{ ...config, dueAt: "2020-01-01T00:00:00.000Z" }],
      }),
      s = await snapshot(a.task.task_id),
      t = await taskData(a.task.task_id);
    const subject = t.subjects[0].id;
    expect((await submit(a.task.task_id, s)).json().error.code).toBe(
      "SUBMISSION_CLOSED",
    );
    const r = await post(
      `/course-tasks/${a.task.task_id}/late-grants`,
      teacher,
      {
        subjectId: subject,
        opensAt: new Date(Date.now() - 60000).toISOString(),
        closesAt: new Date(Date.now() + 60000).toISOString(),
        reason: "明确测试补交",
      },
    );
    expect(r.statusCode, r.body).toBe(201);
    const ps = await snapshot(a.task.task_id, peer);
    expect((await submit(a.task.task_id, ps, {}, peer)).json().error.code).toBe(
      "SUBMISSION_CLOSED",
    );
    const accepted = await submit(a.task.task_id, s);
    expect(accepted.statusCode, accepted.body).toBe(201);
    expect(accepted.json().submission.late_grant_id).toBe(r.json().id);
    await post(`/late-grants/${r.json().id}/revoke`, teacher);
    expect((await submit(a.task.task_id, s)).json().error.code).toBe(
      "SUBMISSION_CLOSED",
    );
    expect(
      (await get(`/course-submissions/${accepted.json().submission.id}`))
        .statusCode,
    ).toBe(200);
  });
  it("unlocks continuous work on accepted submission, fixes baseline, and prevents cycles/revision races", async () => {
    const f = await fixture();
    const second = await post(`/assignments/${f.id}/tasks`, teacher, {
      ...config,
      title: "后续搜索",
      predecessorTaskId: f.task.task_id,
    });
    expect(second.statusCode, second.body).toBe(201);
    const next = second.json().taskId,
      s = await snapshot(next);
    expect((await submit(next, s)).json().error.code).toBe(
      "PREREQUISITE_MISSING",
    );
    const r = await submit(next, s, { baseSubmissionId: f.submission.id });
    expect(r.statusCode, r.body).toBe(201);
    const newer = await submit(f.task.task_id, f.snapshotId);
    expect(newer.json().submission.sequence).toBe(2);
    expect(
      (await get(`/course-submissions/${r.json().submission.id}`)).json()
        .submission.base_submission_id,
    ).toBe(f.submission.id);
    const cycle = await post(
      `/course-tasks/${f.task.task_id}/revisions`,
      teacher,
      { ...config, predecessorTaskId: next },
    );
    expect(cycle.json().error.code).toBe("DEPENDENCY_INVALID");
    const changed = await post(
      `/course-tasks/${f.task.task_id}/revisions`,
      teacher,
      { ...config, allowCode: false },
    );
    expect(changed.statusCode).toBe(201);
    const stale = await post(
      `/course-tasks/${f.task.task_id}/submissions`,
      student,
      { snapshotId: f.snapshotId, taskRevisionId: f.task.current_revision_id },
    );
    expect(stale.json().error.code).toBe("TASK_REVISION_CHANGED");
    await expect(
      db.query("UPDATE course_submissions SET sequence=99 WHERE id=$1", [
        f.submission.id,
      ]),
    ).rejects.toThrow("immutable");
    await expect(
      db.query("UPDATE course_snapshots SET files='{}' WHERE id=$1", [
        f.snapshotId,
      ]),
    ).rejects.toThrow("immutable");
  });
  it("requires team confirmation and designated submission role, snapshots membership, and isolates self-checks", async () => {
    const a = await assignment({ subjectMode: "team" });
    const r = await post(`/assignments/${a.id}/teams`, teacher, {
      name: "小组 A",
      members: [
        { userId: student.id, role: "submitter" },
        { userId: peer.id, role: "member" },
      ],
    });
    expect(r.statusCode, r.body).toBe(201);
    const subjectId = r.json().id,
      s = await snapshot(a.task.task_id);
    expect(
      (await submit(a.task.task_id, s, { subjectId })).json().error.code,
    ).toBe("SUBJECT_FORBIDDEN");
    await post(`/course-teams/${subjectId}/accept`, student);
    await post(`/course-teams/${subjectId}/accept`, peer);
    const ps = await snapshot(a.task.task_id, peer);
    expect(
      (await submit(a.task.task_id, ps, { subjectId }, peer)).json().error.code,
    ).toBe("SUBJECT_FORBIDDEN");
    const accepted = await submit(a.task.task_id, s, { subjectId });
    expect(accepted.statusCode, accepted.body).toBe(201);
    expect(accepted.json().submission.member_snapshot).toHaveLength(2);
    expect(
      (await get(`/course-submissions/${accepted.json().submission.id}`, peer))
        .statusCode,
    ).toBe(200);
    await post(`/course-teams/${subjectId}/members/${peer.id}`, teacher, {
      role: "member",
      status: "left",
    });
    expect(
      (await get(`/course-submissions/${accepted.json().submission.id}`, peer))
        .statusCode,
    ).toBe(403);
    expect(
      (await get(`/course-submissions/${accepted.json().submission.id}`)).json()
        .submission.member_snapshot,
    ).toHaveLength(2);
  });
  it("keeps self-checks private, enforces layers and help policy, bills only the initiator", async () => {
    const f = await fixture(),
      recipient = (await courseRecipient(models.resolve, student.id))!;
    const r = await post(
      `/course-tasks/${f.task.task_id}/self-checks`,
      student,
      {
        snapshotId: f.snapshotId,
        recipientHash: recipient.hash,
        confirmed: true,
      },
    );
    expect(r.statusCode, r.body).toBe(202);
    const checkId = r.json().id;
    for (const who of [teacher, peer, outsider])
      for (const suffix of ["", "/export"])
        expect(
          (await get(`/self-checks/${checkId}${suffix}`, who)).statusCode,
        ).toBe(404);
    const help = {
      recipientHash: recipient.hash,
      confirmed: true,
      level: 3,
      question: "PRIVATE_PROCESS_MARKER",
    };
    expect(
      (await post(`/self-checks/${checkId}/messages`, student, help)).json()
        .error.code,
    ).toBe("HELP_ORDER_REQUIRED");
    await courseAnalysisTick(db, models.resolve, new AbortController().signal);
    let messages = (await get(`/self-checks/${checkId}`)).json().messages;
    expect(messages[0].status).toBe("succeeded");
    expect(messages[0].billing_user_id).toBe(student.id);
    expect(messages[0].report).toMatchObject({
      qualityReview: {
        status: "not-reviewed",
        semanticSupportVerified: false,
        modelLimitations: ["仅静态分析"],
        codeDelivery: { status: "not-requested" },
      },
      execution: { ran: false },
    });
    expect(messages[0].report.limitations.join(" ")).toContain(
      "引用可定位不代表结论已被人工确认",
    );
    expect(JSON.parse(inputs.at(-1).user).analysisContext).toMatchObject({
      codeHelpRequested: false,
      unreadPaths: [],
    });
    expect(inputs.at(-1).system).toContain("L1 只定位问题");
    expect(inputs.at(-1).system).toContain(
      "不能在其他字段绕过层级给出修复动作",
    );
    expect(inputs.at(-1).system).toContain(
      "已提供的类型、函数或文件不能写成缺失",
    );
    const l2 = await post(`/self-checks/${checkId}/messages`, student, {
      ...help,
      level: 2,
    });
    expect(l2.statusCode, l2.body).toBe(202);
    await courseAnalysisTick(db, models.resolve, new AbortController().signal);
    expect(inputs.at(-1).system).toContain("L2 在定位原因后");
    expect(inputs.at(-1).system).toContain("围绕当前一个卡点");
    providerMode = "code";
    try {
      expect(
        (await post(`/self-checks/${checkId}/messages`, student, help))
          .statusCode,
      ).toBe(202);
      await courseAnalysisTick(
        db,
        models.resolve,
        new AbortController().signal,
      );
      const l3 = (await get(`/self-checks/${checkId}`))
        .json()
        .messages.find((m: any) => m.level === 3);
      expect(l3.status).toBe("succeeded");
      expect(l3.report.findings[0].suggestion).toContain("const example");
      expect(l3.report.qualityReview.codeDelivery.status).toBe(
        "snippet-provided",
      );
      expect(inputs.at(-1).system).toContain("仅在对应 finding 的 suggestion");
      providerMode = "no-code-delivery";
      const missingCode = await post(
        `/self-checks/${checkId}/messages`,
        student,
        help,
      );
      expect(missingCode.statusCode).toBe(202);
      await courseAnalysisTick(
        db,
        models.resolve,
        new AbortController().signal,
      );
      const missingDelivery = (await get(`/self-checks/${checkId}`))
        .json()
        .messages.find((m: any) => m.id === missingCode.json().id);
      expect(missingDelivery).toMatchObject({
        status: "failed",
        failure_code: "REPORT_HELP_NOT_DELIVERED",
        report: null,
        usage: {
          inputTokens: 123,
          outputTokens: 45,
          validationFailure: { codeDelivery: { status: "invalid" } },
        },
      });
      providerMode = "ok";
      const needsContext = await post(
        `/self-checks/${checkId}/messages`,
        student,
        help,
      );
      await courseAnalysisTick(
        db,
        models.resolve,
        new AbortController().signal,
      );
      const contextResult = (await get(`/self-checks/${checkId}`))
        .json()
        .messages.find((m: any) => m.id === needsContext.json().id);
      expect(contextResult).toMatchObject({
        status: "succeeded",
        report: {
          qualityReview: {
            codeDelivery: { status: "context-needed", requirementIds: ["R1"] },
          },
        },
      });
      providerMode = "code-summary";
      const rejected = await post(
        `/self-checks/${checkId}/messages`,
        student,
        help,
      );
      expect(rejected.statusCode).toBe(202);
      await courseAnalysisTick(
        db,
        models.resolve,
        new AbortController().signal,
      );
      const blocked = (await get(`/self-checks/${checkId}`))
        .json()
        .messages.find((m: any) => m.id === rejected.json().id);
      expect(blocked).toMatchObject({
        status: "failed",
        failure_code: "REPORT_HELP_POLICY",
        report: null,
        usage: {
          inputTokens: 123,
          outputTokens: 45,
          validationFailure: {
            violations: [
              { field: "summary", rule: "statement-keyword" },
              { field: "summary", rule: "code-punctuation" },
            ],
          },
        },
      });
      expect(JSON.stringify(blocked)).not.toContain("PRIVATE_SUMMARY");
    } finally {
      providerMode = "ok";
    }
    await post(`/course-tasks/${f.task.task_id}/revisions`, teacher, {
      ...config,
      allowCode: false,
    });
    expect(
      (await post(`/self-checks/${checkId}/messages`, student, help)).json()
        .error.code,
    ).toBe("HELP_CODE_DISABLED");
    expect(
      (await get(`/course-submissions/${f.submission.id}`, teacher)).body,
    ).not.toContain("PRIVATE_PROCESS_MARKER");
  });
  it("keeps safe validation diagnostics and numeric provider failure codes without exposing rejected answers", async () => {
    const f = await fixture(),
      recipient = (await courseRecipient(models.resolve, student.id))!;
    for (const mode of ["code", "quota"]) {
      providerMode = mode;
      try {
        const r = await post(
          `/course-tasks/${f.task.task_id}/self-checks`,
          student,
          {
            snapshotId: f.snapshotId,
            recipientHash: recipient.hash,
            confirmed: true,
          },
        );
        expect(r.statusCode).toBe(202);
        await courseAnalysisTick(
          db,
          models.resolve,
          new AbortController().signal,
        );
        const job = (await get(`/self-checks/${r.json().id}`)).json()
          .messages[0];
        expect(job.status).toBe("failed");
        expect(job.report).toBeNull();
        expect(job.failure_code).toBe(
          mode === "code" ? "REPORT_HELP_POLICY" : "MODEL_HTTP_402",
        );
        if (mode === "code") {
          expect(job.usage).toMatchObject({
            inputTokens: 123,
            outputTokens: 45,
            validationFailure: {
              violations: [
                { field: "findings.0.suggestion", rule: "statement-keyword" },
                { field: "findings.0.suggestion", rule: "code-punctuation" },
              ],
            },
          });
          expect(job.usage.validationFailure.responseSha256).toMatch(
            /^[a-f0-9]{64}$/,
          );
          expect(JSON.stringify(job.usage)).not.toContain("const example");
        }
        expect(
          (await get(`/self-checks/${r.json().id}`, teacher)).statusCode,
        ).toBe(404);
      } finally {
        providerMode = "ok";
      }
    }
  });
  it("diagnoses forbidden forms using only field names and rule names", () => {
    expect(
      courseHelpPolicyDiagnostic({
        summary: "const PRIVATE_CONTENT = [];",
        findings: [],
        limitations: [],
      }),
    ).toEqual([
      { field: "summary", rule: "statement-keyword" },
      { field: "summary", rule: "code-punctuation" },
    ]);
    expect(
      courseHelpPolicyDiagnostic({
        summary: "请自行核对空关键词的结果",
        findings: [],
        limitations: [],
      }),
    ).toEqual([]);
  });
  it("separates formal consent, private context, candidate reports, evaluation drafts and publication revisions", async () => {
    const f = await fixture(),
      recipient = (await courseRecipient(models.resolve, teacher.id))!,
      body = { recipientHash: recipient.hash, confirmed: true };
    expect(
      (
        await post(
          `/course-submissions/${f.submission.id}/analyses`,
          teacher,
          body,
        )
      ).json().error.code,
    ).toBe("MODEL_CONSENT_REQUIRED");
    expect(
      (
        await post(
          `/course-submissions/${f.submission.id}/model-consent`,
          student,
          body,
        )
      ).statusCode,
    ).toBe(201);
    const r = await post(
      `/course-submissions/${f.submission.id}/analyses`,
      teacher,
      body,
    );
    expect(r.statusCode, r.body).toBe(202);
    await courseAnalysisTick(db, models.resolve, new AbortController().signal);
    expect(inputs.at(-1).user).not.toContain("PRIVATE_PROCESS_MARKER");
    expect(
      (await get(`/course-submissions/${f.submission.id}`)).json().analyses,
    ).toHaveLength(0);
    const report = (
      await get(`/course-submissions/${f.submission.id}`, teacher)
    ).json().analyses[0];
    expect(report).toMatchObject({
      status: "succeeded",
      billing_user_id: teacher.id,
      report: { execution: { ran: false } },
    });
    const e = await post(
      `/course-submissions/${f.submission.id}/evaluations`,
      teacher,
      { feedback: "人工确认", outcome: "achieved", analysisId: r.json().id },
    );
    expect(e.statusCode, e.body).toBe(201);
    expect(
      (await get(`/course-submissions/${f.submission.id}`)).json().evaluations,
    ).toEqual([]);
    expect(
      (await post(`/course-evaluations/${e.json().id}/publish`, teacher))
        .statusCode,
    ).toBe(200);
    expect(
      (await get(`/course-submissions/${f.submission.id}`)).json().analyses,
    ).toHaveLength(1);
    expect(
      (await get(`/assignments/${f.id}`, teacher)).json().tasks[0].progress
        .reviewed,
    ).toBe(1);
    const newVersion = await submit(f.task.task_id, f.snapshotId);
    expect(
      (await get(`/assignments/${f.id}`, teacher)).json().tasks[0].progress
        .reviewed,
    ).toBe(0);
    expect(
      (
        await get(`/course-submissions/${newVersion.json().submission.id}`)
      ).json().evaluations,
    ).toEqual([]);
    const correction = await post(
      `/course-submissions/${f.submission.id}/evaluations`,
      teacher,
      { feedback: "更正说明", outcome: "needs_revision" },
    );
    expect(correction.statusCode).toBe(201);
    expect(
      (await get(`/course-submissions/${f.submission.id}`, teacher)).json()
        .evaluations,
    ).toHaveLength(2);
    await expect(
      db.query("UPDATE course_evaluations SET feedback=$2 WHERE id=$1", [
        e.json().id,
        "改写已发布",
      ]),
    ).rejects.toThrow("PUBLISHED_EVALUATION_IMMUTABLE");
    const diff = await get(
      `/course-submissions/${newVersion.json().submission.id}/diff?base=${f.submission.id}`,
    );
    expect(diff.json()).toMatchObject({ added: [], modified: [], removed: [] });
  });
  it("model failure, invalid execution claims and cancellation never revoke submissions; known usage survives invalid report", async () => {
    const f = await fixture(),
      recipient = (await courseRecipient(models.resolve, teacher.id))!,
      body = { recipientHash: recipient.hash, confirmed: true };
    await post(
      `/course-submissions/${f.submission.id}/model-consent`,
      student,
      body,
    );
    providerMode = "injected";
    const r = await post(
      `/course-submissions/${f.submission.id}/analyses`,
      teacher,
      body,
    );
    await courseAnalysisTick(db, models.resolve, new AbortController().signal);
    providerMode = "ok";
    const a = (
      await get(`/course-submissions/${f.submission.id}`, teacher)
    ).json().analyses[0];
    expect(a.status).toBe("failed");
    expect(a.failure_code).toBe("REPORT_EXECUTION_CLAIM");
    expect(a.usage.inputTokens).toBe(123);
    expect(a.report).toBeNull();
    expect(a.usage.validationFailure.executionClaims).toEqual([
      { field: "summary", rule: "unsupported-execution-success" },
    ]);
    expect(a.usage.validationFailure.responseSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(a.usage.validationFailure)).not.toContain("运行通过");
    const again = await post(
      `/course-submissions/${f.submission.id}/analyses`,
      teacher,
      body,
    );
    expect(again.statusCode).toBe(202);
    await post(`/course-analyses/${again.json().id}/cancel`, teacher);
    expect(
      await courseAnalysisTick(
        db,
        models.resolve,
        new AbortController().signal,
      ),
    ).toBe(false);
    expect(
      (await get(`/course-submissions/${f.submission.id}`)).statusCode,
    ).toBe(200);
    expect((await taskData(f.task.task_id)).submissions).toHaveLength(1);
  });
  it("rejects unsafe file names, excludes secrets and generation files; ZIP does not run code", async () => {
    const a = await assignment();
    expect(
      (
        await post("/imports", student, {
          taskId: a.task.task_id,
          type: "files",
          files: [{ path: "../outside.ts", content: "x" }],
        })
      ).statusCode,
    ).toBe(400);
    const files = [
      { path: "main.ts", content: "console.log(42)" },
      { path: ".env", content: "secret=123" },
      { path: "token.ts", content: 'const apiKey="sensitive-value"' },
      { path: "dist/main.js", content: "generated" },
    ];
    const r = await post("/imports", student, {
      taskId: a.task.task_id,
      type: "files",
      files,
    });
    expect(r.statusCode, r.body).toBe(201);
    const s = (await get(`/snapshots/${r.json().snapshot_id}`)).json();
    expect(s.manifest.map((f: any) => f.path)).toEqual(["main.ts"]);
    expect(s.omitted).toHaveLength(3);
    const archive = Buffer.from(
      zipSync({
        "src/main.ts": strToU8("console.log(42)"),
        "package.json": strToU8('{"scripts":{"install":"danger"}}'),
      }),
    ).toString("base64");
    expect(
      (
        await post("/imports", student, {
          taskId: a.task.task_id,
          type: "zip",
          zipBase64: archive,
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await get(
          "/course-submissions/" +
            (await fixture()).submission.id +
            "/contributions",
        )
      ).json().status,
    ).toBe("insufficient");
  });
  it("pins Git retry to the first resolved commit, recovers interrupted uploads and keeps previous accepted work", async () => {
    const f = await fixture(),
      sha = "a".repeat(40),
      blob = "b".repeat(40);
    let failTree = true,
      resolveCalls = 0;
    const transport = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input: any) => {
        const u = String(input);
        if (u.includes("/commits/")) {
          resolveCalls++;
          return Response.json({
            sha: resolveCalls === 1 ? sha : "c".repeat(40),
          });
        }
        if (u.includes("/trees/")) {
          expect(u).toContain(sha);
          return failTree
            ? new Response("{}", { status: 503 })
            : Response.json({
                tree: [{ type: "blob", path: "a.ts", sha: blob }],
              });
        }
        return Response.json({
          encoding: "base64",
          content: Buffer.from("export const a=1;").toString("base64"),
        });
      });
    try {
      const r = await post("/imports", student, {
        taskId: f.task.task_id,
        type: "github",
        repository: { provider: "github", owner: "o", name: "r", ref: "main" },
      });
      expect(r.statusCode, r.body).toBe(202);
      await courseImportTick(db, new AbortController().signal, models);
      let job = (await get("/imports/" + r.json().id)).json();
      expect(job).toMatchObject({ status: "failed", resolved_commit: sha });
      failTree = false;
      await post("/imports/" + r.json().id + "/retry", student);
      await courseImportTick(db, new AbortController().signal, models);
      job = (await get("/imports/" + r.json().id)).json();
      expect(job.status).toBe("ready");
      expect(resolveCalls).toBe(1);
      expect((await taskData(f.task.task_id)).submissions[0].id).toBe(
        f.submission.id,
      );
      await db.query(
        "INSERT INTO course_imports(id,task_id,owner_id,source_type,status,source,created_at) VALUES($1,$2,$3,'files','validating','{}',now()-interval '6 minutes')",
        [randomUUID(), f.task.task_id, student.id],
      );
      await courseImportTick(db, new AbortController().signal, models);
      expect(
        (
          await db.query(
            "SELECT status FROM course_imports WHERE source_type='files' AND task_id=$1",
            [f.task.task_id],
          )
        ).rows[0].status,
      ).toBe("failed");
    } finally {
      transport.mockRestore();
    }
  });
  it("verifies provider account ownership, refuses duplicate claims, and freezes identity mapping at submission", async () => {
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ id: 42, login: "same-name" }));
    try {
      const connection = await post("/repository-connections", student, {
        provider: "github",
        label: "identity-test",
        token: "fixture-token",
        confirmed: true,
      });
      expect(
        (
          await post(
            `/repository-connections/${connection.json().id}/verify`,
            student,
          )
        ).statusCode,
      ).toBe(200);
      const other = await post("/repository-connections", peer, {
        provider: "github",
        label: "identity-other",
        token: "fixture-peer-token",
        confirmed: true,
      });
      fetcher.mockImplementation(async () =>
        Response.json({ id: 42, login: "same-name" }),
      );
      expect(
        (
          await post(`/repository-connections/${other.json().id}/verify`, peer)
        ).json().error.code,
      ).toBe("GIT_IDENTITY_IN_USE");
      const f = await fixture();
      expect(
        f.submission.member_snapshot[0].gitIdentities[0].provider_user_id,
      ).toBe("42");
      await post(
        `/repository-connections/${connection.json().id}/revoke`,
        student,
      );
      expect(
        (await get(`/course-submissions/${f.submission.id}`)).json().submission
          .member_snapshot[0].gitIdentities[0].provider_user_id,
      ).toBe("42");
      const next = await submit(f.task.task_id, f.snapshotId, {
        baseSubmissionId: f.submission.id,
      });
      expect(next.statusCode, next.body).toBe(201);
      expect(next.json().submission.member_snapshot[0].gitIdentities).toEqual(
        [],
      );
      const otherTask = await fixture();
      expect(
        (
          await submit(f.task.task_id, f.snapshotId, {
            baseSubmissionId: otherTask.submission.id,
          })
        ).json().error.code,
      ).toBe("BASE_SUBMISSION_INVALID");
    } finally {
      fetcher.mockRestore();
    }
  });
  it("honors revoked queued consent and protects new immutable work from legacy retention", async () => {
    const f = await fixture(),
      recipient = (await courseRecipient(models.resolve, teacher.id))!,
      body = { confirmed: true, recipientHash: recipient.hash };
    const consent = await post(
      `/course-submissions/${f.submission.id}/model-consent`,
      student,
      body,
    );
    const job = await post(
      `/course-submissions/${f.submission.id}/analyses`,
      teacher,
      body,
    );
    await post(`/course-model-consents/${consent.json().id}/revoke`, student);
    const before = inputs.length;
    await courseAnalysisTick(db, models.resolve, new AbortController().signal);
    expect(inputs.length).toBe(before);
    expect(
      (
        await db.query("SELECT failure_code FROM course_analyses WHERE id=$1", [
          job.json().id,
        ])
      ).rows[0].failure_code,
    ).toBe("MODEL_CONSENT_REQUIRED");
    await expect(
      planCourseRetention(db, {
        taskId: f.task.task_id,
        studentId: student.id,
      }),
    ).rejects.toThrow("RETENTION_COURSEWORK_POLICY_REQUIRED");
    await post(`/course-tasks/${f.task.task_id}/revisions`, teacher, {
      ...config,
      title: "新目标说明",
    });
    expect(
      (await get(`/course-submissions/${f.submission.id}`)).json().task.config
        .title,
    ).toBe(config.title);
  });
  it("shrinks context to the payer's model budget and reports the unread files", async () => {
    const a = await assignment({
        tasks: [{ ...config, requiredPaths: ["required.ts"] }],
      }),
      s = await snapshot(a.task.task_id, student, [
        { path: "required.ts", content: "// required\n" + "x".repeat(1000) },
        { path: "other.ts", content: "// context\n" + "y".repeat(15000) },
      ]),
      recipient = (await courseRecipient(models.resolve, student.id))!;
    const response = await post(
      `/course-tasks/${a.task.task_id}/self-checks`,
      student,
      { snapshotId: s, recipientHash: recipient.hash, confirmed: true },
    );
    expect(response.statusCode, response.body).toBe(202);
    await courseAnalysisTick(
      db,
      async (userId) => {
        const provider = await models.resolve(userId);
        return provider
          ? {
              ...provider,
              sourceContext: {
                contextWindowTokens: 16384,
                maxOutputTokens: 4000,
                tokenizer: "utf8-conservative" as const,
              },
            }
          : undefined;
      },
      new AbortController().signal,
    );
    const job = (await get(`/self-checks/${response.json().id}`)).json()
      .messages[0];
    expect(job.status).toBe("succeeded");
    expect(job.report.coveredPaths).toEqual(["required.ts"]);
    expect(job.report.unreadPaths).toEqual(["other.ts"]);
    expect(JSON.parse(inputs.at(-1).user).analysisContext.unreadPaths).toEqual([
      "other.ts",
    ]);
    expect(job.report.limitations.join(" ")).toContain(
      "1 个快照文件未提供给模型",
    );
    expect(
      job.report.budget.inputTokens +
        job.report.budget.outputTokens +
        job.report.budget.safetyTokens,
    ).toBeLessThanOrEqual(16384);
    expect(JSON.parse(inputs.at(-1).user).files["other.ts"]).toBeUndefined();
  });
  it("draft coursework is invisible through both new and legacy read paths; private tokens never echo", async () => {
    const r = await post("/assignments", teacher, {
      classId,
      title: "未发布任务",
      status: "draft",
      tasks: [config],
    });
    expect(r.statusCode).toBe(201);
    const d = (await get("/assignments/" + r.json().id, teacher)).json(),
      taskId = d.tasks[0].task_id;
    expect((await get("/assignments/" + r.json().id)).statusCode).toBe(404);
    expect((await get("/tasks")).body).not.toContain(taskId);
    expect((await get("/tasks/" + taskId)).statusCode).toBe(409);
    const token = "test-private-repository-token";
    const c = await post("/repository-connections", student, {
      provider: "gitee",
      label: "只读仓库",
      token,
      confirmed: true,
    });
    expect(c.statusCode, c.body).toBe(201);
    expect((await get("/repository-connections")).body).not.toContain(token);
    const saved = (
      await db.query(
        "SELECT credential FROM course_repository_connections WHERE id=$1",
        [c.json().id],
      )
    ).rows[0].credential;
    expect(saved).not.toContain(token);
    expect(models.openRepository(student.id, saved)).toBe(token);
    expect(() => models.openRepository(peer.id, saved)).toThrow();
    await post(`/repository-connections/${c.json().id}/revoke`, student);
    expect(
      (
        await db.query(
          "SELECT credential FROM course_repository_connections WHERE id=$1",
          [c.json().id],
        )
      ).rows[0].credential,
    ).toBe("");
  });
});
describe("structured report validation", () => {
  const report = {
    summary: "静态结果",
    findings: [
      {
        requirementId: "R1",
        verdict: "met",
        explanation: "可见分支",
        impact: "空输入保留原结果",
        evidence: [{ path: "a.ts", start: 1, end: 1 }],
        suggestion: "补充边界测试",
        verification: "自行验证空输入",
      },
    ],
    limitations: ["未运行代码"],
  };
  it("requires valid citations and forbids generated code when hints only", () => {
    expect(() =>
      validateCourseReport(report, { "a.ts": "x" }, [{ id: "R1" }], false),
    ).not.toThrow();
    expect(() =>
      validateCourseReport(
        {
          ...report,
          findings: [
            {
              ...report.findings[0],
              evidence: [{ path: "a.ts", start: 1, end: 2 }],
            },
          ],
        },
        { "a.ts": "x" },
        [{ id: "R1" }],
        true,
      ),
    ).toThrow();
    expect(() =>
      validateCourseReport(
        { ...report, summary: "const answer = 42;" },
        { "a.ts": "x" },
        [{ id: "R1" }],
        false,
      ),
    ).toThrow();
    expect(() =>
      validateCourseReport(
        { ...report, summary: "all tests passed" },
        { "a.ts": "x" },
        [{ id: "R1" }],
        true,
      ),
    ).toThrow();
    expect(() =>
      validateCourseReport(
        {
          ...report,
          findings: [{ ...report.findings[0], impact: "tests passed" }],
        },
        { "a.ts": "x" },
        [{ id: "R1" }],
        true,
      ),
    ).toThrow();
  });
});
