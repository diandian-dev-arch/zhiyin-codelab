// Generated fixture databases only. Never connects to a user's existing database.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { postgres, migrate, type DB } from "../apps/api/src/db.js";
import { loadMigrations } from "../apps/api/src/migrations.js";
import { seed } from "../apps/api/src/seed.js";
import { digest } from "../apps/api/src/auth.js";
import { createApp } from "../apps/api/src/app.js";
import { createUserModelService } from "../apps/api/src/user-model-settings.js";
import {
  courseAnalysisTick,
  courseRecipient,
} from "../apps/api/src/coursework-agent.js";
import {
  backupModelVault,
  checkRestoredModelVault,
} from "./backup-model-vault.js";

const id = randomUUID(),
  container = `codelab-coursework-restore-${id}`,
  label = `codelab.coursework-restore=${id}`,
  password = randomUUID();
const directory = path.resolve(".data/coursework-backups", id),
  record = path.resolve(
    "docs/verification/2026-10-18/coursework",
    `restore-${id}.json`,
  ),
  keyDirectory = path.resolve(".data/model-key-backups", id);
const exec = promisify(execFile),
  origin = "http://127.0.0.1";
const result: any = {
  id,
  startedAt: new Date().toISOString(),
  kind: "isolated-generated-fixture-pg-dump-restore-http",
  liveWorkspaceAccess: false,
  externalModelCalls: 0,
  passed: false,
};
let owned = false,
  source: DB | undefined,
  target: DB | undefined;
const docker = async (args: string[]) => {
  try {
    return (
      await exec("docker", args, {
        windowsHide: true,
        timeout: 60000,
        maxBuffer: 2 * 1024 * 1024,
      })
    ).stdout;
  } catch {
    throw new Error("RESTORE_DOCKER_FAILED");
  }
};
async function inventory(db: DB) {
  const tables = (
    await db.query(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
    )
  ).rows;
  const output: Record<string, unknown> = {};
  for (const { tablename } of tables) {
    assert.match(tablename, /^[a-z_]+$/);
    const rows = (
      await db.query(
        `SELECT to_jsonb(t) AS value FROM "${tablename}" t ORDER BY to_jsonb(t)::text COLLATE "C"`,
      )
    ).rows;
    output[tablename] = {
      rows: rows.length,
      sha256: createHash("sha256").update(JSON.stringify(rows)).digest("hex"),
    };
  }
  return output;
}
try {
  await mkdir(directory, { recursive: true });
  await mkdir(path.dirname(record), { recursive: true });
  await docker([
    "run",
    "--detach",
    "--name",
    container,
    "--label",
    label,
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
    "POSTGRES_DB=coursework_fixture",
    "postgres:17-alpine",
  ]);
  owned = true;
  const info = JSON.parse(await docker(["inspect", container]))[0];
  assert.equal(info.Config.Labels["codelab.coursework-restore"], id);
  let ready = false;
  for (let i = 0; i < 60; i++) {
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
        "coursework_fixture",
      ]);
      ready = true;
      break;
    } catch {
      await delay(250);
    }
  }
  assert(ready, "DATABASE_NOT_READY");
  const port = info.NetworkSettings.Ports["5432/tcp"][0].HostPort;
  source = postgres(
    `postgres://postgres:${password}@127.0.0.1:${port}/coursework_fixture`,
  );
  const migrations = await loadMigrations();
  await migrate(
    source,
    migrations.filter((m) => m.version <= 20),
  );
  await seed(source, randomUUID());
  const teacher = (
      await source.query("SELECT id FROM users WHERE role='teacher'")
    ).rows[0].id,
    student = (await source.query("SELECT id FROM users WHERE role='student'"))
      .rows[0].id,
    classId = (await source.query("SELECT id FROM classes")).rows[0].id;
  const legacyTask = randomUUID(),
    legacySource = randomUUID(),
    legacySubmission = randomUUID();
  await source.query(
    "INSERT INTO tasks(id,class_id,title,description,kind,due_at) VALUES($1,$2,'历史任务','原共享成果','project',now()-interval '1 day')",
    [legacyTask, classId],
  );
  await source.query(
    "INSERT INTO source_projects(id,owner_id,name,sha256,files,omitted) VALUES($1,$2,'历史源码','legacy-hash','{\"old.ts\":\"old\"}','[]')",
    [legacySource, student],
  );
  await source.query(
    "INSERT INTO project_submissions(id,task_id,user_id,project_id,project_sha256,version,share_with_class,request_key,request_hash) VALUES($1,$2,$3,$4,'legacy-hash',1,true,'legacy-request','legacy-request-hash')",
    [legacySubmission, legacyTask, student, legacySource],
  );
  const legacyBefore = (await source.query("SELECT * FROM project_submissions"))
    .rows;
  await migrate(source);
  assert.deepEqual(
    (await source.query("SELECT * FROM project_submissions")).rows,
    legacyBefore,
  );
  const projected = (
    await source.query(
      "SELECT * FROM course_legacy_submission_projection WHERE id=$1",
      [legacySubmission],
    )
  ).rows[0];
  assert.equal(projected.timing, "historical-late");
  assert.equal(projected.share_with_class, true);
  assert.equal(projected.snapshot_status, "historical-incomplete");
  const sessions: any = {};
  for (const [role, userId] of [
    ["teacher", teacher],
    ["student", student],
  ]) {
    const sid = randomUUID(),
      csrf = randomUUID();
    await source.query(
      "INSERT INTO sessions(id,user_id,csrf,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",
      [digest(sid), userId, csrf],
    );
    sessions[role] = {
      origin,
      cookie: `sid=${sid}`,
      "x-csrf-token": csrf,
      "content-type": "application/json",
    };
  }
  const key = randomBytes(32);
  let calls = 0;
  const models = createUserModelService(source, key, () => ({
    configuration: {
      provider: "fixture",
      model: "fixture",
      endpoint: "https://fixture.invalid",
    },
    complete: async (input) => {
      calls++;
      const data = JSON.parse(input.user);
      return {
        content: JSON.stringify({
          summary: "恢复演练，未运行测试",
          findings: data.task.requirements.map((r: any) => ({
            requirementId: r.id,
            verdict: "unknown",
            explanation: "静态夹具",
            evidence: [],
            suggestion: "本地验证",
            verification: "检查边界",
          })),
          limitations: ["合成模型"],
        }),
        raw: "",
        requestId: "fixture",
        usage: { inputTokens: 10, outputTokens: 10 },
      };
    },
  }));
  for (const userId of [teacher, student])
    await models.save(userId, {
      vendor: "openai",
      model: "fixture",
      apiKey: "synthetic-offline-key",
    });
  const app = await createApp(source, {
    origin,
    secure: false,
    businessVersion: 2,
    executionApproved: false,
    model: "fixture",
    image: "fixture",
    userModels: models,
    coursework: { background: false },
  });
  let submissionId: string, checkId: string, snapshotHash: string;
  try {
    const post = async (url: string, role: string, payload: any = {}) => {
      const r = await app.inject({
        method: "POST",
        url: "/api/v2" + url,
        headers: { ...sessions[role], "idempotency-key": randomUUID() },
        payload,
      });
      assert(r.statusCode < 300, `${url}: ${r.statusCode}`);
      return r.json();
    };
    const a = await post("/assignments", "teacher", {
      classId,
      title: "恢复演练",
      tasks: [
        {
          title: "固定版本",
          description: "只读源码",
          requirements: [{ id: "R1", title: "处理边界" }],
        },
      ],
    });
    const t = (
      await app.inject({
        url: "/api/v2/assignments/" + a.id,
        headers: sessions.student,
      })
    ).json().tasks[0];
    const snapshot = await post("/imports", "student", {
      taskId: t.task_id,
      type: "snippet",
      files: [{ path: "a.ts", content: "export const value = 1;" }],
    });
    const submission = await post(
      `/course-tasks/${t.task_id}/submissions`,
      "student",
      {
        snapshotId: snapshot.snapshot_id,
        taskRevisionId: t.current_revision_id,
      },
    );
    submissionId = submission.submission.id;
    snapshotHash = (
      await source.query(
        "SELECT content_hash FROM course_snapshots WHERE id=$1",
        [snapshot.snapshot_id],
      )
    ).rows[0].content_hash;
    const studentRecipient = (await courseRecipient(models.resolve, student))!,
      teacherRecipient = (await courseRecipient(models.resolve, teacher))!;
    const check = await post(
      `/course-tasks/${t.task_id}/self-checks`,
      "student",
      {
        snapshotId: snapshot.snapshot_id,
        confirmed: true,
        recipientHash: studentRecipient.hash,
      },
    );
    checkId = check.id;
    await courseAnalysisTick(
      source,
      models.resolve,
      new AbortController().signal,
    );
    await post(`/course-submissions/${submissionId}/model-consent`, "student", {
      confirmed: true,
      recipientHash: teacherRecipient.hash,
    });
    const analysis = await post(
      `/course-submissions/${submissionId}/analyses`,
      "teacher",
      { confirmed: true, recipientHash: teacherRecipient.hash },
    );
    await courseAnalysisTick(
      source,
      models.resolve,
      new AbortController().signal,
    );
    const evaluation = await post(
      `/course-submissions/${submissionId}/evaluations`,
      "teacher",
      {
        feedback: "恢复后仍关联固定版本",
        outcome: "pending",
        analysisId: analysis.id,
      },
    );
    await post(`/course-evaluations/${evaluation.id}/publish`, "teacher");
    await post("/repository-connections", "student", {
      provider: "gitee",
      label: "离线凭据夹具",
      token: "synthetic-repository-token",
      confirmed: true,
    });
  } finally {
    await app.close();
  }
  const before = await inventory(source),
    vault = await backupModelVault(source, directory, keyDirectory, {
      MODEL_CREDENTIAL_KEY: key.toString("hex"),
    });
  await docker([
    "exec",
    container,
    "pg_dump",
    "-U",
    "postgres",
    "-d",
    "coursework_fixture",
    "-Fc",
    "-f",
    "/tmp/coursework.dump",
  ]);
  await docker([
    "cp",
    `${container}:/tmp/coursework.dump`,
    path.join(directory, "database.dump"),
  ]);
  await docker([
    "exec",
    container,
    "createdb",
    "-U",
    "postgres",
    "coursework_restored",
  ]);
  await docker([
    "exec",
    container,
    "pg_restore",
    "--exit-on-error",
    "-U",
    "postgres",
    "-d",
    "coursework_restored",
    "/tmp/coursework.dump",
  ]);
  target = postgres(
    `postgres://postgres:${password}@127.0.0.1:${port}/coursework_restored`,
  );
  assert.deepEqual(await inventory(target), before);
  assert.deepEqual(await migrate(target), {
    registeredLegacyBaseline: false,
    applied: [],
  });
  const credentials = await checkRestoredModelVault(
    target,
    keyDirectory,
    vault,
  );
  const restoredModels = createUserModelService(
    target,
    await readFile(path.join(keyDirectory, "model-credentials.key")),
  );
  const restored = await createApp(target, {
    origin,
    secure: false,
    businessVersion: 2,
    executionApproved: false,
    model: "fixture",
    image: "fixture",
    userModels: restoredModels,
    coursework: { background: false },
  });
  try {
    const base = await restored.listen({ host: "127.0.0.1", port: 0 });
    const r = await fetch(
      base + "/api/v2/course-submissions/" + submissionId!,
      { headers: sessions.student },
    );
    assert.equal(r.status, 200);
    const body = (await r.json()) as any;
    assert.equal(body.snapshot.content_hash, snapshotHash!);
    assert.equal(body.evaluations[0].feedback, "恢复后仍关联固定版本");
    assert.equal(body.analyses[0].status, "succeeded");
    assert.equal(
      (
        await fetch(base + "/api/v2/self-checks/" + checkId!, {
          headers: sessions.teacher,
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await fetch(base + "/api/v2/self-checks/" + checkId!, {
          headers: sessions.student,
        })
      ).status,
      200,
    );
    const code = await fetch(
      base + `/api/v2/course-submissions/${submissionId!}/source?path=a.ts`,
      { headers: sessions.teacher },
    );
    assert.equal(
      ((await code.json()) as any).content,
      "export const value = 1;",
    );
    assert.equal(
      (
        await fetch(base + "/api/v2/project-tasks/" + legacyTask, {
          headers: sessions.student,
        })
      ).status,
      200,
    );
  } finally {
    await restored.close();
  }
  await assert.rejects(
    target.query("UPDATE course_submissions SET sequence=99 WHERE id=$1", [
      submissionId!,
    ]),
    /immutable/,
  );
  assert.deepEqual(await inventory(source), before);
  Object.assign(result, {
    passed: true,
    migrationFrom: 20,
    migrationTo: migrations.at(-1)!.version,
    fixtureModelCalls: calls,
    sourceUnchanged: true,
    tables: before,
    credentials,
    legacyProjection: projected,
    checks: {
      fixedSnapshot: true,
      publishedEvaluation: true,
      formalReport: true,
      privateSelfCheckIsolation: true,
      legacyProjectReadable: true,
      immutableSubmission: true,
    },
    dumpSha256: createHash("sha256")
      .update(await readFile(path.join(directory, "database.dump")))
      .digest("hex"),
  });
  await writeFile(
    path.join(directory, "manifest.json"),
    JSON.stringify({ id, tables: before, modelVault: vault }, null, 2),
  );
} catch (e) {
  result.failure = (e as any).code ?? (e as Error).message;
  process.exitCode = 1;
} finally {
  await target?.close();
  await source?.close();
  if (owned) {
    try {
      const info = JSON.parse(await docker(["inspect", container]))[0];
      assert.equal(info.Config.Labels["codelab.coursework-restore"], id);
      await docker(["rm", "-f", "-v", container]);
      result.cleanup = "owned-temporary-container-and-volume-removed";
    } catch {
      result.cleanup = "failed";
      process.exitCode = 1;
    }
  }
  result.finishedAt = new Date().toISOString();
  await writeFile(record, JSON.stringify(result, null, 2));
  console.log(
    JSON.stringify({
      id,
      passed: result.passed,
      checks: result.checks,
      credentials: result.credentials,
      cleanup: result.cleanup,
      failure: result.failure,
      record,
    }),
  );
}
