import { randomUUID } from "node:crypto";
import { zipSync, strToU8 } from "fflate";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp, type Config } from "../apps/api/src/app.js";
import { digest, hashPassword } from "../apps/api/src/auth.js";
import { migrate, type DB } from "../apps/api/src/db.js";
import { testDB } from "./db.js";

const { reap } = vi.hoisted(() => ({
  reap: vi.fn(async () => ({ removed: 0, preserved: 0, failed: 0 })),
}));
// The normal app's upload-spool reaper is unrelated to this cookie test; never inspect shared temp files.
vi.mock("../apps/api/src/source-spool.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../apps/api/src/source-spool.js")>()),
  reapSourceSpools: reap,
}));

type App = Awaited<ReturnType<typeof createApp>>;
type Session = {
  cookie: string;
  csrf: string;
  user: { id: string; role: string };
};
const originalOrigin = "http://127.0.0.1:5174",
  trialOrigin = "http://127.0.0.1:5186";
const trialCookie = "codelab_teacher_trial_sid";
const password = "Only-synthetic-trial-tests-2026!";
const base: Config = {
  origin: originalOrigin,
  secure: false,
  executionApproved: false,
  businessVersion: 2,
  model: "unconfigured",
  image: "unused",
  packs: [],
  coursework: { background: false },
};
let originalDb: DB, trialDb: DB, original: App, trial: App;
let originalTeacher: Session,
  originalStudent: Session,
  trialTeacher: Session,
  trialStudent: Session;
let trialClass: string;
let externalFetch = vi.fn();

async function seedAccounts(db: DB) {
  const teacher = randomUUID(),
    student = randomUUID(),
    classId = randomUUID(),
    hash = hashPassword(password);
  for (const [id, role] of [
    [teacher, "teacher"],
    [student, "student"],
  ])
    await db.query(
      "INSERT INTO users(id,email,name,role,password_hash) VALUES($1,$2,$3,$4,$5)",
      [id, `${role}@teacher-trial.invalid`, `Synthetic ${role}`, role, hash],
    );
  await db.query("INSERT INTO classes(id,name,teacher_id) VALUES($1,$2,$3)", [
    classId,
    "Isolated trial fixture",
    teacher,
  ]);
  await db.query("INSERT INTO memberships(class_id,user_id) VALUES($1,$2)", [
    classId,
    student,
  ]);
  return classId;
}
async function login(
  app: App,
  origin: string,
  role: "teacher" | "student",
): Promise<Session> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/session/login",
    headers: { origin },
    payload: { email: `${role}@teacher-trial.invalid`, password },
  });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.cookies).toHaveLength(1);
  return {
    cookie: `${response.cookies[0].name}=${response.cookies[0].value}`,
    csrf: response.json().csrf,
    user: response.json().user,
  };
}
const headers = (session: Session, origin = trialOrigin) => ({
  cookie: session.cookie,
  origin,
  "x-csrf-token": session.csrf,
});
const get = (url: string, session = trialTeacher) =>
  trial.inject({ url, headers: headers(session) });
const post = (
  url: string,
  payload: Record<string, unknown> = {},
  session = trialTeacher,
) =>
  trial.inject({
    method: "POST",
    url,
    headers: { ...headers(session), "idempotency-key": randomUUID() },
    payload,
  });

beforeAll(async () => {
  // Both databases are explicitly in memory; environment connection URLs are never selected.
  originalDb = await testDB();
  trialDb = await testDB();
  await migrate(originalDb);
  await migrate(trialDb);
  await seedAccounts(originalDb);
  trialClass = await seedAccounts(trialDb);
  // PGlite module/bootstrap initialization is complete before observing external fetch attempts.
  externalFetch = vi.fn(async () => {
    throw new Error("NO_EXTERNAL_FETCH_IN_TRIAL_TEST");
  });
  vi.stubGlobal("fetch", externalFetch);
  original = await createApp(originalDb, base);
  trial = await createApp(trialDb, {
    ...base,
    origin: trialOrigin,
    teacherTrial: true,
    sessionCookieName: trialCookie,
    coursework: { background: true },
  });
  await original.ready();
  const reapedByNormalApp = reap.mock.calls.length;
  await trial.ready();
  expect(reap).toHaveBeenCalledTimes(reapedByNormalApp);
  originalTeacher = await login(original, originalOrigin, "teacher");
  originalStudent = await login(original, originalOrigin, "student");
  trialTeacher = await login(trial, trialOrigin, "teacher");
  trialStudent = await login(trial, trialOrigin, "student");
});
afterAll(async () => {
  try {
    await trial?.close();
    await original?.close();
  } finally {
    await trialDb?.close();
    await originalDb?.close();
    vi.unstubAllGlobals();
  }
});

describe("isolated first teacher trial API and cookie namespace", () => {
  it("reports disabled capabilities only on the opt-in trial and uses a distinct host-wide cookie name", async () => {
    const status = await trial.inject({ url: "/api/v1/health" });
    expect(status.json()).toMatchObject({
      ok: true,
      businessVersion: 2,
      executionApproved: false,
      workspace: "teacher-trial",
      modelsEnabled: false,
      codeExecutionEnabled: false,
    });
    const normal = (await original.inject({ url: "/api/v1/health" })).json();
    expect(normal.workspace).toBeUndefined();
    expect((await get('/api/v1/session')).json().workspace).toBe('teacher-trial');
    const normalSession = await original.inject({ url: '/api/v1/session', headers: headers(originalTeacher, originalOrigin) });
    expect(normalSession.json().workspace).toBeUndefined();
    expect(originalTeacher.cookie).toMatch(/^sid=/);
    expect(trialTeacher.cookie.startsWith(`${trialCookie}=`)).toBe(true);
    const projects = await get("/api/v2/projects");
    expect(projects.json()).toEqual({ projects: [], available: false });
    expect((await get("/api/v2/model-settings")).json().configured).toBe(false);
    expect(
      (await get("/api/v2/course-model-recipient")).json().recipient,
    ).toBeNull();
  });

  it("does not accept the other app cookie, while a same-host mixed cookie header selects the correct database account", async () => {
    expect(
      (
        await trial.inject({
          url: "/api/v1/session",
          headers: { cookie: originalTeacher.cookie },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await original.inject({
          url: "/api/v1/session",
          headers: { cookie: trialTeacher.cookie },
        })
      ).statusCode,
    ).toBe(401);
    const cookie = `${originalTeacher.cookie}; ${trialTeacher.cookie}`;
    expect(
      (
        await trial.inject({ url: "/api/v1/session", headers: { cookie } })
      ).json().user.id,
    ).toBe(trialTeacher.user.id);
    expect(
      (
        await original.inject({ url: "/api/v1/session", headers: { cookie } })
      ).json().user.id,
    ).toBe(originalTeacher.user.id);
    expect(trialTeacher.user.id).not.toBe(originalTeacher.user.id);
  });

  it("clears only its own cookie and does not delete either other-app session", async () => {
    const separateTrial = await login(trial, trialOrigin, "teacher");
    const cookie = `${originalTeacher.cookie}; ${separateTrial.cookie}`;
    const response = await trial.inject({
      method: "POST",
      url: "/api/v1/session/logout",
      headers: { ...headers(separateTrial), cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.cookies.map((c) => c.name)).toEqual([trialCookie]);
    expect(response.cookies[0].value).toBe("");
    expect(
      (await original.inject({ url: "/api/v1/session", headers: { cookie } }))
        .statusCode,
    ).toBe(200);
    expect(
      (
        await trial.inject({
          url: "/api/v1/session",
          headers: { cookie: separateTrial.cookie },
        })
      ).statusCode,
    ).toBe(401);
    const separateOriginal = await login(original, originalOrigin, "teacher");
    const mixed = `${separateOriginal.cookie}; ${trialTeacher.cookie}`;
    const originalLogout = await original.inject({
      method: "POST",
      url: "/api/v1/session/logout",
      headers: { ...headers(separateOriginal, originalOrigin), cookie: mixed },
    });
    expect(originalLogout.cookies.map((c) => c.name)).toEqual(["sid"]);
    expect(
      (
        await trial.inject({
          url: "/api/v1/session",
          headers: { cookie: mixed },
        })
      ).json().user.id,
    ).toBe(trialTeacher.user.id);
  });

  it("does not clear sid when the trial session has already expired", async () => {
    const expired = await login(trial, trialOrigin, "teacher");
    const rawToken = expired.cookie.slice(expired.cookie.indexOf("=") + 1);
    await trialDb.query(
      "UPDATE sessions SET expires_at=now()-interval '1 minute' WHERE id=$1",
      [digest(rawToken)],
    );
    const cookie = `${originalTeacher.cookie}; ${expired.cookie}`;
    const response = await trial.inject({
      method: "POST",
      url: "/api/v1/session/logout",
      headers: { ...headers(expired), cookie },
    });
    expect(response.statusCode).toBe(401);
    expect(response.cookies.some((c) => c.name === "sid")).toBe(false);
    expect(
      (await original.inject({ url: "/api/v1/session", headers: { cookie } }))
        .statusCode,
    ).toBe(200);
  });

  it("retains authentication, CSRF, origin and teacher ownership checks before manual writes", async () => {
    expect(
      (await trial.inject({ url: "/api/v2/assignments" })).statusCode,
    ).toBe(401);
    expect(
      (
        await trial.inject({
          url: "/api/v2/assignments",
          headers: { cookie: `${trialCookie}=invalid` },
        })
      ).statusCode,
    ).toBe(401);
    const payload = {
      classId: trialClass,
      title: "not-created",
      tasks: [
        {
          title: "test",
          description: "test",
          requirements: [{ id: "R1", title: "test" }],
        },
      ],
    };
    const noCsrf = await trial.inject({
      method: "POST",
      url: "/api/v2/assignments",
      headers: { origin: trialOrigin, cookie: trialTeacher.cookie },
      payload,
    });
    expect(noCsrf.statusCode).toBe(403);
    expect(noCsrf.json().error.code).toBe("FORBIDDEN");
    const wrongOrigin = await trial.inject({
      method: "POST",
      url: "/api/v2/assignments",
      headers: { ...headers(trialTeacher), origin: originalOrigin },
      payload,
    });
    expect(wrongOrigin.statusCode).toBe(403);
    expect(wrongOrigin.json().error.message).toContain("请求来源不受信任");
    expect(
      (await post("/api/v2/assignments", payload, trialStudent)).statusCode,
    ).toBe(403);
    const originalClass = (
      await originalDb.query("SELECT id FROM classes LIMIT 1")
    ).rows[0].id;
    expect(
      (
        await post("/api/v2/assignments", {
          ...payload,
          classId: originalClass,
        })
      ).statusCode,
    ).toBe(404);
  });

  it.each([
    ["PUT", "/api/v2/model-settings"],
    ["DELETE", "/api/v2/model-settings"],
    ["POST", "/api/v2/model-settings/test"],
    ["POST", "/api/v2/repository-connections"],
    ["POST", `/api/v2/repository-connections/${randomUUID()}/verify`],
    ["POST", `/api/v2/repository-connections/${randomUUID()}/revoke`],
    ["POST", `/api/v2/imports/${randomUUID()}/retry`],
    ["POST", `/api/v2/course-tasks/${randomUUID()}/self-checks`],
    ["POST", `/api/v2/self-checks/${randomUUID()}/messages`],
    ["POST", `/api/v2/course-submissions/${randomUUID()}/analyses`],
    ["POST", `/api/v2/course-submissions/${randomUUID()}/model-consent`],
    ["POST", `/api/v2/course-analyses/${randomUUID()}/cancel`],
    ["POST", "/api/v2/projects"],
    ["POST", `/api/v2/projects/${randomUUID()}/analyze`],
    ["POST", "/api/v2/tasks"],
    ["POST", `/api/v2/tasks/${randomUUID()}/rules`],
    ["POST", `/api/v2/submissions/${randomUUID()}/runs`],
    ["POST", `/api/v2/runs/${randomUUID()}/analyses`],
    ["POST", "/api/v1/tasks"],
    ["POST", `/api/v1/tasks/${randomUUID()}/rules`],
    ["POST", `/api/v1/submissions/${randomUUID()}/runs`],
  ] as const)(
    "rejects %s %s with a valid trial session and CSRF, before feature handling",
    async (method, url) => {
      const response = await trial.inject({
        method,
        url,
        headers: headers(trialTeacher),
        payload: {},
      });
      expect(response.statusCode, response.body).toBe(403);
      if (url.startsWith("/api/v2/"))
        expect(response.json().error.code).toBe("TEACHER_TRIAL_RESTRICTED");
      else expect(response.json().error).toContain("校园试用");
    },
  );

  it.each(["github", "gitee"])(
    "blocks parsed %s imports before credentials or remote access",
    async (type) => {
      const response = await post(
        "/api/v2/imports",
        {
          taskId: randomUUID(),
          type,
          repository: {
            provider: type,
            owner: "synthetic",
            name: "not-fetched",
            ref: "main",
          },
        },
        trialStudent,
      );
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe("TEACHER_TRIAL_RESTRICTED");
    },
  );

  it("completes local material preparation, fixed submission, manual draft and teacher-only publication without original data changes", async () => {
    const businessCounts = async (db: DB) => {
      const result: Record<string, number> = {};
      for (const table of [
        "users",
        "classes",
        "course_assignments",
        "course_snapshots",
        "course_submissions",
        "course_evaluations",
        "course_analyses",
        "source_projects",
        "runs",
      ])
        result[table] = (
          await db.query(`SELECT count(*)::int AS n FROM ${table}`)
        ).rows[0].n;
      return result;
    };
    const before = await businessCounts(originalDb);
    const created = await post("/api/v2/assignments", {
      classId: trialClass,
      title: "Manual synthetic teacher trial",
      status: "published",
      tasks: [
        {
          title: "Local fixed source",
          description: "No model or execution",
          requirements: [{ id: "R1", title: "Human review only" }],
          allowedSources: ["snippet", "files", "zip"],
          allowCode: false,
        },
      ],
    });
    expect(created.statusCode, created.body).toBe(201);
    const assignmentId = created.json().id;
    const detail = (await get(`/api/v2/assignments/${assignmentId}`)).json();
    const task = detail.tasks[0];
    const localBodies = [
      {
        type: "snippet",
        files: [{ path: "solution.ts", content: "export const value = 1;" }],
      },
      {
        type: "files",
        files: [
          { path: "main.ts", content: "export const value = 2;" },
          { path: "helper.ts", content: "export const helper = 2;" },
        ],
      },
      {
        type: "zip",
        zipBase64: Buffer.from(
          zipSync({ "solution.ts": strToU8("export const value = 3;") }),
        ).toString("base64"),
      },
    ];
    const snapshotIds: string[] = [];
    for (const body of localBodies) {
      const imported = await post(
        "/api/v2/imports",
        { taskId: task.task_id, ...body },
        trialStudent,
      );
      expect(imported.statusCode, imported.body).toBe(201);
      expect(imported.json().status).toBe("ready");
      snapshotIds.push(imported.json().snapshot_id);
    }
    const submitted = await post(
      `/api/v2/course-tasks/${task.task_id}/submissions`,
      {
        snapshotId: snapshotIds[0],
        taskRevisionId: task.current_revision_id,
        note: "Synthetic fixed submission",
      },
      trialStudent,
    );
    expect(submitted.statusCode, submitted.body).toBe(201);
    const submissionId = submitted.json().submission.id;
    const source = await get(
      `/api/v2/course-submissions/${submissionId}/source?path=solution.ts`,
      trialStudent,
    );
    expect(source.json().content).toContain("value = 1");
    const evaluated = await post(
      `/api/v2/course-submissions/${submissionId}/evaluations`,
      {
        feedback:
          "Synthetic manual trial feedback; not independent teacher evaluation",
        outcome: "pending",
        analysisId: null,
      },
    );
    expect(evaluated.statusCode, evaluated.body).toBe(201);
    const evaluationId = evaluated.json().id;
    expect(
      (
        await get(`/api/v2/course-submissions/${submissionId}`, trialStudent)
      ).json().evaluations,
    ).toEqual([]);
    expect(
      (
        await post(
          `/api/v2/course-evaluations/${evaluationId}/publish`,
          {},
          trialStudent,
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (await post(`/api/v2/course-evaluations/${evaluationId}/publish`))
        .statusCode,
    ).toBe(200);
    const studentView = (
      await get(`/api/v2/course-submissions/${submissionId}`, trialStudent)
    ).json();
    expect(studentView.evaluations).toMatchObject([
      {
        id: evaluationId,
        status: "published",
        outcome: "pending",
        analysis_id: null,
      },
    ]);
    expect(studentView.analyses).toEqual([]);
    expect(await businessCounts(originalDb)).toEqual(before);
    for (const table of [
      "course_analyses",
      "source_analyses",
      "runs",
      "user_model_settings",
      "course_repository_connections",
      "course_model_consents",
    ])
      expect(
        (await trialDb.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]
          .n,
      ).toBe(0);
    expect(externalFetch).not.toHaveBeenCalled();
  });

  it("keeps the default sid API and the default upgrade guard unchanged", async () => {
    const created = await original.inject({
      method: "POST",
      url: "/api/v1/classes",
      headers: headers(originalTeacher, originalOrigin),
      payload: { name: "Normal default-sid fixture" },
    });
    expect(created.statusCode, created.body).toBe(200);
    const oldWrite = await original.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: headers(originalTeacher, originalOrigin),
      payload: {},
    });
    expect(oldWrite.statusCode).toBe(409);
    expect(oldWrite.json().error.code).toBe("CLIENT_UPGRADE_REQUIRED");
    expect(
      (
        await original.inject({
          url: "/api/v1/session",
          headers: { cookie: originalStudent.cookie },
        })
      ).json().user.id,
    ).toBe(originalStudent.user.id);
    expect(externalFetch).not.toHaveBeenCalled();
  });

  it.each([
    { executionApproved: true },
    { userModels: {} },
    { sourceProvider: {} },
    { packs: [{}] },
    { evidenceReader: async () => new Uint8Array() },
    { approvedFingerprint: async () => ({}) },
  ])(
    "fails closed for capabilities accidentally supplied to a trial: %#",
    async (extra) => {
      await expect(
        createApp(trialDb, { ...base, teacherTrial: true, ...extra } as Config),
      ).rejects.toThrow("TEACHER_TRIAL_CAPABILITIES_MUST_BE_DISABLED");
    },
  );
  it.each(["sid", "", "invalid;cookie"])(
    "rejects a conflicting or invalid trial cookie name %j",
    async (sessionCookieName) => {
      await expect(
        createApp(trialDb, { ...base, teacherTrial: true, sessionCookieName }),
      ).rejects.toThrow("SESSION_COOKIE_NAME_INVALID");
    },
  );
});
