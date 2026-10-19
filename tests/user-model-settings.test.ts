import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isolatedTestDB, type IsolatedTestDatabase } from "./isolated-db";
import { migrate } from "../apps/api/src/db";
import { createApp } from "../apps/api/src/app";
import { seed } from "../apps/api/src/seed";
import {
  createUserModelService,
  loadModelVaultKey,
} from "../apps/api/src/user-model-settings";
import {
  ModelRequestError,
  type SummaryProviderV2,
} from "../apps/api/src/model-provider-v2";
import { sourceWorkerTick } from "../apps/api/src/source-projects";
import { sourceExecutionSnapshot } from "../apps/api/src/source-execution";
import { modelVendors } from "../packages/contracts/src/model-settings";

let db: IsolatedTestDatabase;
const vault = randomBytes(32),
  password = randomUUID();
const settings = {
  vendor: "deepseek",
  model: "deepseek-flash",
  contextWindowTokens: 1000000,
  maxOutputTokens: 12000,
};
const keyA = "test-personal-secret-a",
  keyB = "test-personal-secret-b";
let calls: { key: string; input: any }[] = [];
let onCall: (() => Promise<void>) | undefined;
const section = {
  title: "入口",
  body: "打印输出",
  citations: [{ path: "main.py", start: 1, end: 1 }],
};
const report = {
  overview: "项目结构",
  stack: ["Python"],
  modules: [section],
  flows: [section],
  findings: [],
  readingPath: [section],
  limitations: ["静态分析"],
};
const makeProvider = (env: NodeJS.ProcessEnv): SummaryProviderV2 => ({
  configuration: {
    provider: "fixture",
    model: env.MODEL_NAME!,
    endpoint: env.MODEL_BASE_URL!,
  },
  complete: async (input) => {
    calls.push({ key: env.MODEL_API_KEY!, input });
    await onCall?.();
    const data = JSON.parse(input.user);
    return {
      raw: "fixture",
      content: JSON.stringify(
        data.purpose
          ? { status: "ok" }
          : data.draft
            ? data.checkShape || data.shape
              ? { report, checks: [] }
              : { reads: [], searches: [] }
            : data.shape
              ? report
              : { paths: ["main.py"] },
      ),
      requestId: null,
      usage: { inputTokens: 20, outputTokens: 8 },
    };
  },
});
const service = () => createUserModelService(db, vault, makeProvider);
async function user(role: "student" | "teacher" = "student") {
  const id = randomUUID();
  await db.query("INSERT INTO users VALUES($1,$2,'U',$3,'hash')", [
    id,
    `${id}@test.local`,
    role,
  ]);
  return id;
}
async function queue(
  owner: string,
  provider?: SummaryProviderV2,
  billingUser?: string,
) {
  const project = randomUUID(),
    id = randomUUID();
  await db.query(
    "INSERT INTO source_projects(id,owner_id,name,sha256,files,omitted) VALUES($1,$2,'x.zip',$3,'{\"main.py\":\"print(1)\"}','[]')",
    [project, owner, randomBytes(32).toString("hex")],
  );
  await db.query(
    "INSERT INTO source_analyses(id,project_id,status,execution_snapshot,billing_user_id) VALUES($1,$2,'queued',$3,$4)",
    [
      id,
      project,
      provider ? JSON.stringify(sourceExecutionSnapshot(provider)) : null,
      billingUser ?? null,
    ],
  );
  return { project, id };
}
beforeAll(async () => {
  db = await isolatedTestDB();
  await migrate(db);
  await seed(db, password);
});
afterAll(async () => {
  await db.close();
});
describe("personal model credentials and billing boundary", () => {
  it('offers the requested OpenAI presets without rewriting stored legacy or custom models', async () => {
    expect(modelVendors.openai.defaultModel).toBe('gpt-6.1-sol');
    expect(modelVendors.openai.models).toEqual(['gpt-6.1-sol', 'gpt-6-astra']);
    const s = service(), id = await user();
    calls = [];
    for (const model of ['gpt-4.1-mini', 'gpt-4.1', 'custom-openai-model', ...modelVendors.openai.models]) {
      const saved = await s.save(id, {...settings, vendor:'openai', model, apiKey:keyA});
      expect(saved.settings?.model).toBe(model);
      expect((await s.state(id)).settings?.model).toBe(model);
      expect((await s.resolve(id))?.configuration.model).toBe(model);
    }
    expect(calls).toHaveLength(0);
  });
  it.each(['gpt-6.1-sol', 'gpt-6-astra'])('bounds the reasoning-inclusive connectivity probe for %s without saving', async model => {
    const s = service(), id = await user();
    calls = [];
    await expect(s.test(id, {...settings, vendor:'openai', model, apiKey:keyA})).resolves.toMatchObject({ok:true,model});
    expect(calls).toHaveLength(1);
    expect(calls[0].input.maxOutputTokens).toBe(1024);
    expect((await s.state(id)).configured).toBe(false);
  });
  it("encrypts per user, never returns a key, and does not inherit another account", async () => {
    const s = service(),
      a = await user(),
      b = await user();
    const state = await s.save(a, { ...settings, apiKey: keyA });
    expect(state.configured).toBe(true);
    expect(JSON.stringify(state)).not.toContain(keyA);
    expect((await s.state(b)).configured).toBe(false);
    expect(await s.resolve(b)).toBeUndefined();
    const row = (
      await db.query("SELECT * FROM user_model_settings WHERE user_id=$1", [a])
    ).rows[0];
    expect(row.encrypted_key).not.toContain(keyA);
    await s.save(b, { ...settings, apiKey: keyB });
    await db.query(
      "UPDATE user_model_settings SET encrypted_key=$1 WHERE user_id=$2",
      [row.encrypted_key, b],
    );
    await expect(s.resolve(b)).rejects.toThrow("无法读取已保存的密钥");
    await s.save(b, { ...settings, apiKey: keyB });
    const revision = state.revision;
    await s.save(a, { ...settings, model: "deepseek-v4-pro" });
    expect((await s.state(a)).revision).not.toBe(revision);
    calls = [];
    await s.test(a, { ...settings });
    expect(calls.at(-1)?.key).toBe(keyA);
    await s.remove(a);
    expect(await s.resolve(a)).toBeUndefined();
    expect((await s.state(b)).configured).toBe(true);
  });
  it("tests exactly once without saving or sending source and sanitizes provider failures", async () => {
    const id = await user(),
      s = service();
    calls = [];
    const result = await s.test(id, { ...settings, apiKey: keyA });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].input.maxOutputTokens).toBe(64);
    expect(calls[0].input.user).not.toContain("main.py");
    expect((await s.state(id)).configured).toBe(false);
    for (const error of [
      new ModelRequestError("MODEL_HTTP_403", "failed"),
      new Error(`unsafe ${keyA}`),
    ]) {
      let count = 0;
      const bad = createUserModelService(db, vault, (env) => ({
        ...makeProvider(env),
        complete: async () => {
          count++;
          throw error;
        },
      }));
      await expect(
        bad.test(id, { ...settings, apiKey: keyA }),
      ).rejects.not.toThrow(keyA);
      expect(count).toBe(1);
    }
  });
  it("requires a new key when switching vendor and disallows arbitrary endpoints and foreign owner input", async () => {
    const s = service(),
      id = await user();
    await s.save(id, { ...settings, apiKey: keyA });
    await expect(s.save(id, { ...settings, vendor: "openai" })).rejects.toThrow(
      "请填写此服务商",
    );
    for (const extra of [
      { baseUrl: "http://127.0.0.1" },
      { userId: randomUUID() },
      { vendor: "other" },
      { maxOutputTokens: 99999 },
    ])
      await expect(s.save(id, { ...settings, ...extra })).rejects.toMatchObject(
        { statusCode: 400 },
      );
    const real = createUserModelService(db, vault);
    await expect(
      real.save(id, {
        ...settings,
        contextWindowTokens: 16384,
        maxOutputTokens: 12000,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
  it("uses the project owner for legacy analyses without an explicit payer and retains history after removal", async () => {
    const s = service(),
      id = await user();
    await s.save(id, { ...settings, apiKey: keyA });
    const q = await queue(id, await s.resolve(id));
    expect(
      (await db.query("SELECT billing_user_id FROM source_analyses WHERE id=$1", [q.id]))
        .rows[0].billing_user_id,
    ).toBeNull();
    expect((await s.state(id)).active).toBe(true);
    await expect(
      s.save(id, { ...settings, apiKey: keyB }),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(s.remove(id)).rejects.toMatchObject({ statusCode: 409 });
    await db.query(
      "UPDATE source_analyses SET status='cancelled',finished_at=now() WHERE id=$1",
      [q.id],
    );
    await s.remove(id);
    expect(
      (await db.query("SELECT status FROM source_analyses WHERE id=$1", [q.id]))
        .rows[0].status,
    ).toBe("cancelled");
  });
  it.each(["queued", "running"])(
    "protects only the teacher's credentials when the teacher pays for a %s analysis of a student's project",
    async (status) => {
      const s = service(),
        student = await user(),
        teacher = await user("teacher"),
        unrelated = await user();
      await s.save(student, { ...settings, apiKey: keyA });
      await s.save(teacher, { ...settings, apiKey: keyB });
      await s.save(unrelated, { ...settings, apiKey: keyA });
      const q = await queue(student, await s.resolve(teacher), teacher);
      await db.query("UPDATE source_analyses SET status=$1 WHERE id=$2", [status, q.id]);

      expect((await s.state(teacher)).active).toBe(true);
      expect((await s.state(student)).active).toBe(false);
      expect((await s.state(unrelated)).active).toBe(false);
      await expect(
        s.save(teacher, { ...settings, apiKey: keyA }),
      ).rejects.toMatchObject({ statusCode: 409, code: "MODEL_ANALYSIS_ACTIVE" });
      await expect(s.remove(teacher)).rejects.toMatchObject({
        statusCode: 409,
        code: "MODEL_ANALYSIS_ACTIVE",
      });
      for (const nonpayer of [student, unrelated]) {
        await expect(s.save(nonpayer, { ...settings, apiKey: keyB })).resolves.toMatchObject({
          configured: true,
          active: false,
        });
        await s.remove(nonpayer);
        expect((await s.state(nonpayer)).configured).toBe(false);
      }

      await db.query(
        "UPDATE source_analyses SET status='cancelled',finished_at=now() WHERE id=$1",
        [q.id],
      );
      expect((await s.state(teacher)).active).toBe(false);
      await s.save(teacher, { ...settings, apiKey: keyA });
      await s.remove(teacher);
      expect(
        (await db.query("SELECT status,billing_user_id FROM source_analyses WHERE id=$1", [q.id]))
          .rows[0],
      ).toEqual({ status: "cancelled", billing_user_id: teacher });
    },
  );
  it("runs a queued analysis only with its project owner key", async () => {
    const s = service(),
      a = await user(),
      b = await user();
    await s.save(a, { ...settings, apiKey: keyA });
    await s.save(b, { ...settings, apiKey: keyB });
    const q = await queue(b, await s.resolve(b));
    calls = [];
    await sourceWorkerTick(db, s.resolve, new AbortController().signal);
    expect(
      (
        await db.query("SELECT status,code FROM source_analyses WHERE id=$1", [
          q.id,
        ])
      ).rows[0],
    ).toEqual({ status: "succeeded", code: null });
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.every((c) => c.key === keyB)).toBe(true);
  });
  it("fails without personal configuration before any call, with no fallback", async () => {
    const s = service(),
      id = await user(),
      q = await queue(id);
    calls = [];
    await sourceWorkerTick(db, s.resolve, new AbortController().signal);
    expect(
      (await db.query("SELECT code FROM source_analyses WHERE id=$1", [q.id]))
        .rows[0].code,
    ).toBe("MODEL_NOT_CONFIGURED");
    expect(calls).toHaveLength(0);
  });
  it("refuses legacy queued work without a billing snapshot even after a personal key is configured", async () => {
    const s = service(), id = await user();
    // Emulate a migrated legacy queue next to a pre-existing profile using
    // the service's normal credential encryption.
    await s.save(id, { ...settings, apiKey: keyA });
    const legacy = await queue(id);
    calls = [];
    await sourceWorkerTick(db, s.resolve, new AbortController().signal);
    expect(calls).toHaveLength(0);
    expect((await db.query("SELECT status,code,execution_snapshot,report FROM source_analyses WHERE id=$1", [legacy.id])).rows[0])
      .toEqual({status:'failed',code:'SOURCE_CONFIGURATION_CHANGED',execution_snapshot:null,report:null});
    expect((await s.state(id)).configured).toBe(true);
  });
  it("rechecks revision between calls and never uses a rotated account silently", async () => {
    const s = service(),
      id = await user();
    await s.save(id, { ...settings, apiKey: keyA });
    const q = await queue(id, await s.resolve(id));
    calls = [];
    onCall = async () => {
      await db.query(
        "UPDATE user_model_settings SET revision=$1 WHERE user_id=$2",
        [randomUUID(), id],
      );
    };
    try {
      await sourceWorkerTick(db, s.resolve, new AbortController().signal);
    } finally {
      onCall = undefined;
    }
    expect(calls).toHaveLength(1);
    expect(
      (await db.query("SELECT code FROM source_analyses WHERE id=$1", [q.id]))
        .rows[0].code,
    ).toBe("SOURCE_CONFIGURATION_CHANGED");
  });
  it("authenticates settings, applies CSRF and personal rate limits, and overrides an injected platform provider", async () => {
    const s = service();
    const app = await createApp(db, {
      origin: "http://test.local",
      secure: false,
      executionApproved: false,
      model: "test",
      image: "test",
      businessVersion: 2,
      userModels: s,
      sourceProvider: makeProvider({ MODEL_API_KEY: "shared-platform-key" }),
    });
    try {
      expect(
        (await app.inject({ method: "GET", url: "/api/v2/model-settings" }))
          .statusCode,
      ).toBe(401);
      async function login(email: string) {
        const r = await app.inject({
          method: "POST",
          url: "/api/v1/session/login",
          headers: { origin: "http://test.local" },
          payload: { email, password },
        });
        expect(r.statusCode).toBe(200);
        return {
          cookie: r.headers["set-cookie"]!.toString().split(";")[0],
          origin: "http://test.local",
          "x-csrf-token": r.json().csrf,
        };
      }
      const a = await login("student@codelab.local"),
        b = await login("teacher@codelab.local");
      const put = (headers: Record<string, string>, body: object) =>
        app.inject({
          method: "PUT",
          url: "/api/v2/model-settings",
          headers,
          payload: body,
        });
      expect(
        (
          await put(
            { cookie: a.cookie, origin: a.origin },
            { ...settings, apiKey: keyA },
          )
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/api/v2/projects",
            headers: a,
          })
        ).json().available,
      ).toBe(false);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/v2/projects",
            headers: a,
          })
        ).statusCode,
      ).toBe(409);
      expect((await put(a, { ...settings, apiKey: keyA })).statusCode).toBe(
        200,
      );
      const get = await app.inject({
        method: "GET",
        url: "/api/v2/model-settings",
        headers: a,
      });
      expect(get.body).not.toContain(keyA);
      expect(get.json().configured).toBe(true);
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/api/v2/model-settings",
            headers: b,
          })
        ).json().configured,
      ).toBe(false);
      calls = [];
      for (let n = 0; n < 3; n++)
        expect(
          (
            await app.inject({
              method: "POST",
              url: "/api/v2/model-settings/test",
              headers: a,
              payload: settings,
            })
          ).statusCode,
        ).toBe(200);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/v2/model-settings/test",
            headers: a,
            payload: settings,
          })
        ).statusCode,
      ).toBe(429);
      expect(calls).toHaveLength(3);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/v2/model-settings/test",
            headers: b,
            payload: { ...settings, apiKey: keyB },
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await app.inject({
            method: "DELETE",
            url: "/api/v2/model-settings",
            headers: b,
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/api/v2/model-settings",
            headers: a,
          })
        ).json().configured,
      ).toBe(true);
    } finally {
      await app.close();
    }
  });
  it("does not create a replacement master key when database credentials already exist", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "codelab-vault-test-"));
    try {
      await expect(loadModelVaultKey(db, directory, {})).rejects.toThrow(
        "MODEL_VAULT_KEY_MISSING",
      );
      await expect(
        loadModelVaultKey(db, directory, { MODEL_CREDENTIAL_KEY: "bad" }),
      ).rejects.toThrow("MODEL_VAULT_KEY_INVALID");
      expect(
        (
          await loadModelVaultKey(db, directory, {
            MODEL_CREDENTIAL_KEY: vault.toString("hex"),
          })
        ).equals(vault),
      ).toBe(true);
      const fresh = await isolatedTestDB();
      try {
        await migrate(fresh);
        const first = await loadModelVaultKey(fresh, directory, {});
        expect(first.length).toBe(32);
        expect(
          (await loadModelVaultKey(fresh, directory, {})).equals(first),
        ).toBe(true);
        expect(
          (
            await readFile(path.join(directory, "model-credentials.key"))
          ).equals(first),
        ).toBe(true);
        await unlink(path.join(directory, "model-credentials.key"));
      } finally {
        await fresh.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
