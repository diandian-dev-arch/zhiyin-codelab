import { randomBytes, randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { createApp } from "../apps/api/src/app.js";
import { digest } from "../apps/api/src/auth.js";
import { migrate } from "../apps/api/src/db.js";
import {
  courseAnalysisTick,
  courseRecipient,
} from "../apps/api/src/coursework-agent.js";
import { ModelRequestError } from "../apps/api/src/model-provider-v2.js";
import { createUserModelService } from "../apps/api/src/user-model-settings.js";
import { testDB } from "./db.js";

it("serially drains 20 account-owned course analyses without external calls or cross-account candidates", async () => {
  // An explicit in-memory database ignores all persistent DATABASE_URL/test URL settings.
  const db = await testDB();
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  let release!: () => void;
  let entered!: () => void;
  const firstProviderGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const firstProviderEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let firstTick: Promise<boolean> | undefined;
  const fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => {
      throw new Error("NETWORK_FORBIDDEN_IN_QUEUE_TEST");
    });
  const origin = "http://queue-test.invalid";
  const accounts = new Map<string, { owner: string; ordinal: number }>();
  const calls: {
    model: string;
    owner: string;
    requirementId: string;
    sourcePaths: string[];
  }[] = [];
  let active = 0;
  let maxActive = 0;
  let providerFailureModel = "";
  type Person = { id: string; model: string; headers: Record<string, string> };
  type Fixture = {
    index: number;
    teacher: Person;
    student: Person;
    classId: string;
    taskId: string;
    snapshotId: string;
    submissionId: string;
    formalId: string;
    checkId: string;
    privateId: string;
  };
  const fixtures: Fixture[] = [];
  try {
    await migrate(db);
    const models = createUserModelService(db, randomBytes(32), (env) => ({
      configuration: {
        provider: "local-queue-fixture",
        model: env.MODEL_NAME!,
        endpoint: "https://provider.invalid/not-used",
      },
      complete: async (input) => {
        const model = env.MODEL_NAME!;
        const account = accounts.get(model)!;
        expect(account).toBeDefined();
        const payload = JSON.parse(input.user);
        calls.push({
          model,
          owner: account.owner,
          requirementId: payload.task.requirements[0].id,
          sourcePaths: Object.keys(payload.files),
        });
        active++;
        maxActive = Math.max(maxActive, active);
        try {
          if (calls.length === 1) {
            entered();
            await firstProviderGate;
          }
          if (model === providerFailureModel)
            throw new ModelRequestError("MODEL_HTTP_503", "failed");
          return {
            raw: "",
            content: JSON.stringify({
              summary: "本地确定性队列夹具，不是教学质量结论",
              findings: payload.task.requirements.map(
                (requirement: { id: string }) => ({
                  requirementId: requirement.id,
                  verdict: "unknown",
                  explanation: "工程替身不执行语义评价",
                  impact: "需后续人工确认",
                  evidence: [
                    { path: Object.keys(payload.files)[0], start: 1, end: 1 },
                  ],
                  suggestion: "核对当前目标",
                  verification: "自行观察当前输入",
                }),
              ),
              limitations: [],
            }),
            usage: {
              inputTokens: 100 + account.ordinal,
              outputTokens: 20 + account.ordinal,
            },
            requestId: `local-${model}`,
          };
        } finally {
          active--;
        }
      },
    }));
    app = await createApp(db, {
      origin,
      secure: false,
      executionApproved: false,
      businessVersion: 2,
      model: "unused",
      image: "unused",
      packs: [],
      userModels: models,
      coursework: { background: false },
    });
    const get = (url: string, person: Person) =>
      app!.inject({ url: "/api/v2" + url, headers: person.headers });
    const post = (
      url: string,
      person: Person,
      payload: Record<string, unknown>,
    ) =>
      app!.inject({
        method: "POST",
        url: "/api/v2" + url,
        headers: { ...person.headers, "idempotency-key": randomUUID() },
        payload,
      });
    async function person(
      role: "teacher" | "student",
      index: number,
    ): Promise<Person> {
      const id = randomUUID(),
        sid = randomUUID(),
        csrf = randomUUID(),
        model = `local-queue-${index}-${role}`;
      await db.query(
        "INSERT INTO users(id,email,name,role,password_hash) VALUES($1,$2,$3,$4,$5)",
        [id, `${id}@queue.invalid`, role, role, "not-used-for-login"],
      );
      await db.query(
        "INSERT INTO sessions(id,user_id,csrf,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",
        [digest(sid), id, csrf],
      );
      accounts.set(model, { owner: id, ordinal: accounts.size });
      await models.save(id, {
        vendor: "openai",
        model,
        apiKey: "synthetic-offline-fixture-not-a-key",
      });
      return {
        id,
        model,
        headers: { origin, cookie: `sid=${sid}`, "x-csrf-token": csrf },
      };
    }
    for (let index = 0; index < 10; index++) {
      const teacher = await person("teacher", index),
        student = await person("student", index),
        classId = randomUUID();
      await db.query(
        "INSERT INTO classes(id,name,teacher_id) VALUES($1,$2,$3)",
        [classId, `queue class ${index}`, teacher.id],
      );
      await db.query(
        "INSERT INTO memberships(class_id,user_id) VALUES($1,$2)",
        [classId, student.id],
      );
      const created = await post("/assignments", teacher, {
        classId,
        title: `queue assignment ${index}`,
        tasks: [
          {
            title: `queue task ${index}`,
            description: "仅验证队列工程归属",
            requirements: [{ id: `R${index}`, title: `本账号目标 ${index}` }],
          },
        ],
      });
      expect(created.statusCode, created.body).toBe(201);
      const detail = (
        await get(`/assignments/${created.json().id}`, teacher)
      ).json();
      const task = detail.tasks[0];
      const imported = await post("/imports", student, {
        taskId: task.task_id,
        type: "snippet",
        files: [
          {
            path: `src/account-${index}.ts`,
            content: `export const account = ${index};\n`,
          },
        ],
      });
      expect(imported.statusCode, imported.body).toBe(201);
      const snapshotId = imported.json().snapshot_id;
      const submitted = await post(
        `/course-tasks/${task.task_id}/submissions`,
        student,
        { snapshotId, taskRevisionId: task.current_revision_id },
      );
      expect(submitted.statusCode, submitted.body).toBe(201);
      const submissionId = submitted.json().submission.id;
      const teacherRecipient = (await courseRecipient(
          models.resolve,
          teacher.id,
        ))!,
        studentRecipient = (await courseRecipient(models.resolve, student.id))!;
      const body = { recipientHash: teacherRecipient.hash, confirmed: true };
      expect(
        (
          await post(
            `/course-submissions/${submissionId}/model-consent`,
            student,
            body,
          )
        ).statusCode,
      ).toBe(201);
      const formal = await post(
        `/course-submissions/${submissionId}/analyses`,
        teacher,
        body,
      );
      expect(formal.statusCode, formal.body).toBe(202);
      const privateCheck = await post(
        `/course-tasks/${task.task_id}/self-checks`,
        student,
        { snapshotId, recipientHash: studentRecipient.hash, confirmed: true },
      );
      expect(privateCheck.statusCode, privateCheck.body).toBe(202);
      fixtures.push({
        index,
        teacher,
        student,
        classId,
        taskId: task.task_id,
        snapshotId,
        submissionId,
        formalId: formal.json().id,
        checkId: privateCheck.json().id,
        privateId: privateCheck.json().analysisId,
      });
    }
    const first = fixtures[0];
    const repeatRecipient = (await courseRecipient(
      models.resolve,
      first.student.id,
    ))!;
    const repeated = await post(
      `/course-tasks/${first.taskId}/self-checks`,
      first.student,
      {
        snapshotId: first.snapshotId,
        recipientHash: repeatRecipient.hash,
        confirmed: true,
      },
    );
    expect(repeated.statusCode).toBe(409);
    expect(repeated.json().error.code).toBe("MODEL_ANALYSIS_ACTIVE");
    expect(
      (await db.query("SELECT count(*)::int AS n FROM course_self_checks"))
        .rows[0].n,
    ).toBe(10);
    providerFailureModel = fixtures[2].teacher.model;
    await db.query("DELETE FROM memberships WHERE class_id=$1 AND user_id=$2", [
      fixtures[4].classId,
      fixtures[4].student.id,
    ]);
    await expect(
      models.save(fixtures[6].teacher.id, {
        vendor: "openai",
        model: "local-queue-changed-after-enqueue",
        apiKey: "synthetic-offline-fixture-not-a-key",
      }),
    ).rejects.toThrow("请等待当前分析完成");
    const resolveForTick = async (userId: string) => {
      const provider = await models.resolve(userId);
      return provider && userId === fixtures[6].teacher.id
        ? {
            ...provider,
            configuration: {
              ...provider.configuration,
              model: "local-simulated-configuration-drift",
            },
          }
        : provider;
    };
    expect(
      (
        await db.query(
          "SELECT count(*)::int AS n FROM course_analyses WHERE status='queued'",
        )
      ).rows[0].n,
    ).toBe(20);
    const shutdown = new AbortController().signal;
    firstTick = courseAnalysisTick(db, resolveForTick, shutdown);
    await firstProviderEntered;
    expect(
      (
        await db.query(
          "SELECT count(*)::int AS n FROM course_analyses WHERE status='running'",
        )
      ).rows[0].n,
    ).toBe(1);
    expect(
      await Promise.all(
        Array.from({ length: 4 }, () =>
          courseAnalysisTick(db, resolveForTick, shutdown),
        ),
      ),
    ).toEqual([false, false, false, false]);
    expect(calls).toHaveLength(1);
    expect(
      (
        await db.query(
          "SELECT count(*)::int AS n FROM course_analyses WHERE status='queued'",
        )
      ).rows[0].n,
    ).toBe(19);
    release();
    expect(await firstTick).toBe(true);
    let processed = 1;
    for (let batch = 0; batch < 25; batch++) {
      const results = await Promise.all(
        Array.from({ length: 4 }, () =>
          courseAnalysisTick(db, resolveForTick, shutdown),
        ),
      );
      processed += results.filter(Boolean).length;
      if (!results.some(Boolean)) break;
    }
    const rows = (
      await db.query("SELECT * FROM course_analyses ORDER BY created_at")
    ).rows;
    expect(processed).toBe(20);
    expect(rows).toHaveLength(20);
    expect(rows.filter((row) => row.status === "succeeded")).toHaveLength(17);
    expect(
      rows
        .filter((row) => row.status === "failed")
        .map((row) => row.failure_code)
        .sort(),
    ).toEqual([
      "ANALYSIS_ACCESS_REVOKED",
      "MODEL_CONFIGURATION_CHANGED",
      "MODEL_HTTP_503",
    ]);
    expect(rows.some((row) => ["queued", "running"].includes(row.status))).toBe(
      false,
    );
    expect(maxActive).toBe(1);
    expect(active).toBe(0);
    expect(calls).toHaveLength(18);
    expect(
      calls.some(
        (call) =>
          call.owner === fixtures[4].student.id ||
          call.owner === fixtures[6].teacher.id,
      ),
    ).toBe(false);
    for (const fixture of fixtures) {
      for (const [id, payer, mode] of [
        [fixture.formalId, fixture.teacher, "formal"],
        [fixture.privateId, fixture.student, "self-check"],
      ] as const) {
        const row = rows.find((row) => row.id === id)!;
        expect(row).toMatchObject({
          billing_user_id: payer.id,
          snapshot_id: fixture.snapshotId,
          model_config: { model: payer.model },
        });
        if (row.status === "succeeded") {
          const account = accounts.get(payer.model)!;
          expect(row.report).toMatchObject({
            billingUserId: payer.id,
            snapshotId: fixture.snapshotId,
            mode,
            coveredPaths: [`src/account-${fixture.index}.ts`],
            execution: { ran: false },
            findings: [{ requirementId: `R${fixture.index}` }],
          });
          expect(row.usage).toEqual({
            inputTokens: 100 + account.ordinal,
            outputTokens: 20 + account.ordinal,
          });
          expect(row.request_id).toBe(`local-${payer.model}`);
        } else expect(row.report).toBeNull();
      }
      const visible = await get(
        `/course-submissions/${fixture.submissionId}`,
        fixture.teacher,
      );
      expect(visible.statusCode, visible.body).toBe(200);
      expect(visible.json().analyses.map((row: any) => row.id)).toEqual([
        fixture.formalId,
      ]);
      expect(
        (await get(`/self-checks/${fixture.checkId}`, fixture.teacher))
          .statusCode,
      ).toBe(404);
      const stranger = fixtures[(fixture.index + 1) % fixtures.length].student;
      expect(
        (await get(`/self-checks/${fixture.checkId}`, stranger)).statusCode,
      ).toBe(404);
      expect([403, 404]).toContain(
        (await get(`/course-submissions/${fixture.submissionId}`, stranger))
          .statusCode,
      );
      if (fixture.index !== 4) {
        const studentView = await get(
          `/course-submissions/${fixture.submissionId}`,
          fixture.student,
        );
        expect(studentView.statusCode).toBe(200);
        expect(studentView.json().analyses).toEqual([]);
        expect(
          (await get(`/self-checks/${fixture.checkId}`, fixture.student))
            .json()
            .messages.map((row: any) => row.id),
        ).toEqual([fixture.privateId]);
      }
    }
    expect(
      (await db.query("SELECT count(*)::int AS n FROM course_evaluations"))
        .rows[0].n,
    ).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    console.info(
      JSON.stringify({
        scope: "in-memory-pglite-local-provider-queue-engineering-only",
        accounts: 20,
        queued: 20,
        terminal: 20,
        succeeded: 17,
        failed: 3,
        providerAttempts: 18,
        maxConcurrentProviders: maxActive,
        externalFetchAttempts: fetchSpy.mock.calls.length,
        publishedEvaluations: 0,
        realModelQualityMeasured: false,
      }),
    );
  } finally {
    release();
    await firstTick?.catch(() => undefined);
    await app?.close();
    await db.close();
    fetchSpy.mockRestore();
  }
}, 60000);
