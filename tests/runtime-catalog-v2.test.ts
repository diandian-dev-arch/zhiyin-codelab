import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp, type Config } from "../apps/api/src/app";
import { hashPassword } from "../apps/api/src/auth";
import { migrate, type DB } from "../apps/api/src/db";
import { createRuntimeCatalogV2 } from "../apps/api/src/runtime-catalog-v2";
import { seed } from "../apps/api/src/seed";
import { root, templateFiles, hashTemplateFiles } from "../apps/api/src/template";
import {
  createDevelopmentPack,
  createRuleSnapshot,
  hashRuleSnapshot,
  hashTaskPack,
  sha256,
  type MeasuredEnvironment,
  type RuleSnapshot,
  type TaskPackManifest,
} from "../packages/contracts/src/v2/index";
import { testDB } from "./db";

// Synthetic identities exercise approval boundaries, never claim real execution.
let pack: TaskPackManifest;
let actualEnvironment: MeasuredEnvironment;
beforeAll(async () => {
  pack = await createDevelopmentPack("new-only", {
    packVersion: "ui-fixture-runtime-v1",
    templateVersion: "vue-board-v1",
    templateHash: hashTemplateFiles(await templateFiles()),
    dependencyLockHash: await sha256("ui_fixture-lock"),
    initializationVersion: "ui-fixture-init-v1",
    caseImplementationHashes: { "NEW-01": await sha256("ui_fixture-checker") },
  });
  const image = {
    identifierType: "local_image_id" as const,
    value: `sha256:${await sha256("ui_fixture-not-an-image")}`,
  };
  actualEnvironment = {
    completeness: "partial",
    values: {
      packManifestHash: pack.contentHash,
      templateHash: pack.templateHash,
      dependencyLockHash: pack.dependencyLockHash,
      initializationVersion: pack.initializationVersion,
      aggregationVersion: pack.aggregationVersion,
      buildImage: image,
      webImage: image,
      browserImage: image,
      playwrightVersion: "ui-fixture-v1",
      chromiumVersion: "ui-fixture-v1",
      viewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
      locale: "zh-CN",
      timezone: "Asia/Shanghai",
      clockPolicy: "ui-fixture-v1",
      randomPolicy: "ui-fixture-v1",
      pageServerPolicy: "ui-fixture-v1",
      resourceTimeoutConfigVersion: "ui-fixture-v1",
    },
    missingFields: ["ruleHash", "parametersHash"],
  };
});

function makeRule(manifest = pack) {
  return createRuleSnapshot({
    ruleId: randomUUID(),
    taskId: randomUUID(),
    version: 1,
    packManifest: manifest,
    enabledCriterionIds: ["create"],
    parameterValues: {},
    confirmedBy: randomUUID(),
    confirmedAt: new Date().toISOString(),
  });
}

describe("trusted runtime catalog v2 (ui_fixture)", () => {
  it("preserves observed values and supplies only the immutable rule hashes", async () => {
    const input = structuredClone({ packs: [pack], actualEnvironment });
    const runtime = await createRuntimeCatalogV2(input);
    input.actualEnvironment.values.locale = "en-US";
    input.packs[0].templateHash = await sha256("changed after registration");
    const rule = await makeRule();
    expect(await runtime.approvedFingerprint(rule)).toEqual({
      ...actualEnvironment.values,
      ruleHash: await hashRuleSnapshot(rule),
      parametersHash: rule.parametersHash,
    });
    expect(Object.isFrozen(runtime.actualEnvironment.values.viewport)).toBe(
      true,
    );
    expect(Object.isFrozen(runtime.packs[0])).toBe(true);
  });

  it("rejects forged pack bodies and duplicate registered versions", async () => {
    const changed = structuredClone(pack);
    changed.templateHash = await sha256("unregistered content");
    await expect(
      createRuntimeCatalogV2({ packs: [changed], actualEnvironment }),
    ).rejects.toThrow("PACK_HASH_MISMATCH");
    await expect(
      createRuntimeCatalogV2({ packs: [pack, pack], actualEnvironment }),
    ).rejects.toThrow("DUPLICATE_PACK_VERSION");
  });

  it("rejects unknown pack measurements and inconsistent measured pack fields", async () => {
    for (const field of [
      "packManifestHash",
      "templateHash",
      "dependencyLockHash",
    ] as const) {
      const changed = structuredClone(actualEnvironment);
      changed.values[field] = await sha256(`ui_fixture:${field}:mismatch`);
      await expect(
        createRuntimeCatalogV2({ packs: [pack], actualEnvironment: changed }),
      ).rejects.toThrow(
        field === "packManifestHash"
          ? "RUNTIME_PACK_NOT_AVAILABLE"
          : "RUNTIME_PACK_MISMATCH",
      );
    }
    const changed = structuredClone(actualEnvironment);
    changed.values.initializationVersion = "different-init-v1";
    await expect(
      createRuntimeCatalogV2({ packs: [pack], actualEnvironment: changed }),
    ).rejects.toThrow("RUNTIME_PACK_MISMATCH");
  });

  it("requires every runtime field but refuses startup per-rule hashes", async () => {
    const incomplete = structuredClone(actualEnvironment);
    delete incomplete.values.chromiumVersion;
    incomplete.missingFields.push("chromiumVersion");
    await expect(
      createRuntimeCatalogV2({ packs: [pack], actualEnvironment: incomplete }),
    ).rejects.toThrow("RUNTIME_MEASUREMENT_INCOMPLETE");
    const prebound = structuredClone(actualEnvironment);
    prebound.values.ruleHash = await sha256("client-or-previous-rule");
    prebound.missingFields = ["parametersHash"];
    await expect(
      createRuntimeCatalogV2({ packs: [pack], actualEnvironment: prebound }),
    ).rejects.toThrow("RUNTIME_MEASUREMENT_INCOMPLETE");
  });

  it("does not approve another valid pack using the measured pack's environment", async () => {
    const other = structuredClone(pack);
    other.packVersion = "another-valid-version";
    other.contentHash = await hashTaskPack(other);
    const rule = await makeRule(other);
    const onlyMeasured = await createRuntimeCatalogV2({
      packs: [pack],
      actualEnvironment,
    });
    await expect(onlyMeasured.approvedFingerprint(rule)).rejects.toThrow(
      "RUNTIME_RULE_PACK_UNAVAILABLE",
    );
    const withOther = await createRuntimeCatalogV2({
      packs: [pack, other],
      actualEnvironment,
    });
    await expect(withOther.approvedFingerprint(rule)).rejects.toThrow(
      "RUNTIME_RULE_PACK_UNMEASURED",
    );
    const changedRule = await makeRule();
    changedRule.parametersHash = await sha256("forged parameters");
    await expect(onlyMeasured.approvedFingerprint(changedRule)).rejects.toThrow(
      "PARAMETERS_HASH_MISMATCH",
    );
  });
});

describe("server-owned run approval (ui_fixture)", () => {
  type App = Awaited<ReturnType<typeof createApp>>;
  type Session = { cookie: string; csrf: string; id: string };
  const origin = "http://localhost:5173";
  const password = "Runtime-catalog-ui-fixture-2037!";
  let db: DB;
  let app: App;
  let teacher: Session;
  let student: Session;
  let peer: Session;
  let outsider: Session;
  let taskId: string;
  let submissionId: string;
  let savedRule: RuleSnapshot;
  let runtime: Awaited<ReturnType<typeof createRuntimeCatalogV2>>;
  const resolve = vi.fn(async (rule: RuleSnapshot) =>
    runtime.approvedFingerprint(rule),
  );
  const apps: App[] = [];
  async function makeApp(overrides: Partial<Config> = {}) {
    const result = await createApp(db, {
      origin,
      secure: false,
      executionApproved: true,
      businessVersion: 2,
      model: "ui_fixture",
      image: "ui_fixture-not-an-image",
      packs: [pack],
      approvedFingerprint: resolve,
      ...overrides,
    });
    apps.push(result);
    return result;
  }
  const headers = (session: Session) => ({
    origin,
    cookie: session.cookie,
    "x-csrf-token": session.csrf,
    "idempotency-key": randomUUID(),
  });
  async function login(email: string): Promise<Session> {
    const result = await app.inject({
      method: "POST",
      url: "/api/v1/session/login",
      headers: { origin },
      payload: { email, password },
    });
    expect(result.statusCode, result.body).toBe(200);
    return {
      cookie: `sid=${result.cookies[0].value}`,
      csrf: result.json().csrf,
      id: result.json().user.id,
    };
  }
  const enqueue = (
    options: {
      target?: App;
      session?: Session;
      key?: string;
      body?: object;
    } = {},
  ) =>
    (options.target ?? app).inject({
      method: "POST",
      url: `/api/v2/submissions/${submissionId}/runs`,
      headers: {
        ...headers(options.session ?? student),
        ...(options.key ? { "idempotency-key": options.key } : {}),
      },
      payload: options.body ?? {},
    });
  async function publish() {
    const result = await app.inject({
      method: "POST",
      url: `/api/v2/tasks/${taskId}/rules`,
      headers: headers(teacher),
      payload: {
        packId: pack.packId,
        packVersion: pack.packVersion,
        packManifestHash: pack.contentHash,
        enabledCriterionIds: ["create"],
        parameterValues: {},
        confirmed: true,
      },
    });
    expect(result.statusCode, result.body).toBe(201);
    return result.json().rule as RuleSnapshot;
  }

  beforeAll(async () => {
    db = await testDB();
    await migrate(db);
    await seed(db, password);
    runtime = await createRuntimeCatalogV2({
      packs: [pack],
      actualEnvironment,
    });
    const task = (await db.query("SELECT id,class_id FROM tasks LIMIT 1"))
      .rows[0];
    taskId = task.id;
    for (const [email, role, member] of [
      ["runtime-peer@example.test", "student", true],
      ["runtime-outsider@example.test", "teacher", false],
    ] as const) {
      const id = randomUUID();
      await db.query(
        "INSERT INTO users(id,email,name,role,password_hash) VALUES($1,$2,'ui_fixture',$3,$4)",
        [id, email, role, hashPassword(password)],
      );
      if (member)
        await db.query(
          "INSERT INTO memberships(class_id,user_id) VALUES($1,$2)",
          [task.class_id, id],
        );
    }
    app = await makeApp();
    teacher = await login("teacher@codelab.local");
    student = await login("student@codelab.local");
    peer = await login("runtime-peer@example.test");
    outsider = await login("runtime-outsider@example.test");
    savedRule = await publish();
    const boundary = "runtime-ui-fixture-boundary";
    const upload = await app.inject({
      method: "POST",
      url: `/api/v2/tasks/${taskId}/submissions`,
      headers: {
        ...headers(student),
        "x-rule-id": savedRule.ruleId,
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      payload: Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="ui_fixture.zip"\r\nContent-Type: application/zip\r\n\r\n`,
        ),
        await readFile(path.join(root, "fixtures/correct.zip")),
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
    });
    expect(upload.statusCode, upload.body).toBe(201);
    submissionId = upload.json().submissionId;
    const newest = await publish();
    expect(newest.ruleId).not.toBe(savedRule.ruleId);
  }, 60000);

  afterAll(async () => {
    for (const value of apps) await value.close();
    await db?.close();
  });

  it("resolves the saved submission rule and stores its approved fingerprint", async () => {
    resolve.mockClear();
    const result = await enqueue();
    expect(result.statusCode, result.body).toBe(202);
    expect(resolve).toHaveBeenCalledOnce();
    expect(resolve.mock.calls[0][0]).toEqual(savedRule);
    const row = (
      await db.query("SELECT rule_id,execution_config FROM runs WHERE id=$1", [
        result.json().runId,
      ])
    ).rows[0];
    expect(row.rule_id).toBe(savedRule.ruleId);
    expect(row.execution_config.approvedFingerprint).toEqual(
      await runtime.approvedFingerprint(savedRule),
    );
  });

  it("rejects client fingerprints and unauthorized actors before resolving runtime state", async () => {
    resolve.mockClear();
    const forged = await enqueue({
      body: {
        approvedFingerprint: await runtime.approvedFingerprint(savedRule),
      },
    });
    expect(forged.statusCode).toBe(400);
    for (const session of [peer, outsider]) {
      const denied = await enqueue({ session });
      expect(denied.statusCode, denied.body).toBe(404);
    }
    expect(resolve).not.toHaveBeenCalled();
  });

  it("replays the saved approval after resolver changes and still verifies the request hash", async () => {
    const key = randomUUID();
    const first = await enqueue({ key });
    expect(first.statusCode, first.body).toBe(202);
    const unavailable = vi.fn(async (_rule: RuleSnapshot): Promise<never> => {
      throw new Error("runtime changed");
    });
    const changedApp = await makeApp({ approvedFingerprint: unavailable });
    const replay = await enqueue({ target: changedApp, key });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json().runId).toBe(first.json().runId);
    const conflict = await enqueue({
      target: changedApp,
      key,
      body: { retryOfRunId: randomUUID() },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(unavailable).not.toHaveBeenCalled();
  });

  it("does not enable execution from the runtime catalog or call a resolver when disabled", async () => {
    resolve.mockClear();
    const disabled = await makeApp({ executionApproved: false });
    const result = await enqueue({ target: disabled });
    expect(result.statusCode).toBe(503);
    expect(result.json().error.code).toBe("EXECUTION_DISABLED");
    expect(resolve).not.toHaveBeenCalled();
  });
});
