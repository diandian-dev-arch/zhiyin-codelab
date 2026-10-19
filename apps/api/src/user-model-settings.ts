import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { readFile, writeFile, mkdir, lstat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { DB } from "./db.js";
import { root } from "./template.js";
import {
  createSummaryProviderV2,
  isOpenAIReasoningModel,
  ModelRequestError,
  type SummaryProviderV2,
} from "./model-provider-v2.js";
import {
  modelVendors,
  type PersonalModelState,
} from "../../../packages/contracts/src/model-settings.js";

const settingsSchema = z
  .object({
    vendor: z.enum(["deepseek", "openai", "qwen"]),
    model: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z0-9_.:/-]+$/),
    contextWindowTokens: z
      .number()
      .int()
      .min(16384)
      .max(2000000)
      .nullable()
      .default(null),
    maxOutputTokens: z.number().int().min(1024).max(32768).default(12000),
  })
  .strict();
const inputSchema = settingsSchema
  .extend({ apiKey: z.string().trim().max(1024).optional() })
  .strict();
const failure = (statusCode: number, code: string, message: string): never => {
  throw Object.assign(new Error(message), { statusCode, code });
};
export type SourceProviderResolver = (
  owner: string,
  connection?: DB,
) => Promise<SummaryProviderV2 | undefined>;

/** Separate encryption key must accompany a database restore. Never regenerate over stored profiles. */
export async function loadModelVaultKey(
  db: DB,
  directory = path.join(root, ".data"),
  env: NodeJS.ProcessEnv = process.env,
) {
  if (env.MODEL_CREDENTIAL_KEY) {
    if (!/^[a-f0-9]{64}$/i.test(env.MODEL_CREDENTIAL_KEY))
      throw new Error("MODEL_VAULT_KEY_INVALID");
    return Buffer.from(env.MODEL_CREDENTIAL_KEY, "hex");
  }
  const filename = path.join(directory, "model-credentials.key");
  await mkdir(directory, { recursive: true });
  try {
    const stat = await lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== 32)
      throw new Error("MODEL_VAULT_KEY_INVALID");
    return await readFile(filename);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (
    Number(
      (await db.query("SELECT count(*) AS n FROM user_model_settings")).rows[0]
        .n,
    )
  )
    throw new Error("MODEL_VAULT_KEY_MISSING");
  if ((await db.query("SELECT to_regclass('course_repository_connections') AS relation")).rows[0].relation && Number((await db.query("SELECT count(*) AS n FROM course_repository_connections WHERE credential<>''")).rows[0].n)) throw new Error('MODEL_VAULT_KEY_MISSING');
  const key = randomBytes(32);
  try {
    await writeFile(filename, key, { flag: "wx", mode: 0o600 });
    return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return loadModelVaultKey(db, directory, env);
  }
}
export function createUserModelService(
  db: DB,
  key: Buffer | undefined,
  makeProvider: (env: NodeJS.ProcessEnv) => SummaryProviderV2 | undefined = createSummaryProviderV2,
) {
  if (key && key.length !== 32) throw new Error("MODEL_VAULT_KEY_INVALID");
  const ready = () => {
    if (!key)
      failure(
        503,
        "MODEL_VAULT_UNAVAILABLE",
        "个人模型配置暂不可用，请联系管理员完成安全存储配置",
      );
  };
  const encrypt = (user: string, secret: string) => {
    ready();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key!, iv);
    cipher.setAAD(Buffer.from(user));
    const body = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
    return [iv, cipher.getAuthTag(), body]
      .map((b) => b.toString("base64url"))
      .join(".");
  };
  const decrypt = (user: string, encrypted: string) => {
    ready();
    try {
      const [iv, tag, body] = encrypted
        .split(".")
        .map((s) => Buffer.from(s, "base64url"));
      const decipher = createDecipheriv("aes-256-gcm", key!, iv);
      decipher.setAAD(Buffer.from(user));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(body), decipher.final()]).toString(
        "utf8",
      );
    } catch {
      failure(
        503,
        "MODEL_KEY_UNAVAILABLE",
        "无法读取已保存的密钥，请重新填写并保存",
      );
    }
  };
  const read = async (user: string, connection = db) =>
    (
      await connection.query(
        "SELECT * FROM user_model_settings WHERE user_id=$1",
        [user],
      )
    ).rows[0];
  const active = async (user: string, connection = db) =>
    !!(
      await connection.query(
        `SELECT 1 WHERE
          EXISTS(SELECT 1 FROM course_analyses WHERE billing_user_id=$1 AND status IN ('queued','running')) OR
          EXISTS(SELECT 1 FROM source_analyses a JOIN source_projects p ON p.id=a.project_id WHERE COALESCE(a.billing_user_id,p.owner_id)=$1 AND a.status IN ('queued','running'))
          OR EXISTS(SELECT 1 FROM analysis_attempts WHERE requested_by=$1 AND configuration->>'billingUserId'=$1::text AND status IN ('queued','running'))
          OR EXISTS(SELECT 1 FROM runs r WHERE r.execution_config->'initialModel'->>'billingUserId'=$1::text AND
            (r.status IN ('queued','preparing','building','checking','analyzing') OR EXISTS(
              SELECT 1 FROM execution_attempts e WHERE e.run_id=r.id AND e.owner_phase<>'closed')))`,
        [user],
      )
    ).rows.length;
  const provider = (
    settings: z.infer<typeof settingsSchema>,
    secret: string,
    revision?: string,
  ) => {
    const p = makeProvider({
      MODEL_BASE_URL: modelVendors[settings.vendor].baseUrl,
      MODEL_NAME: settings.model,
      MODEL_API_KEY: secret,
      SOURCE_MODEL_CONTEXT_TOKENS:
        settings.contextWindowTokens === null
          ? ""
          : String(settings.contextWindowTokens),
      SOURCE_MODEL_MAX_OUTPUT_TOKENS: String(settings.maxOutputTokens),
      SOURCE_MODEL_TOKENIZER: "utf8-conservative",
    })!;
    if (revision)
      p.configuration = { ...p.configuration, credentialRevision: revision };
    return p;
  };
  async function candidate(user: string, raw: unknown, connection = db) {
    ready();
    const parsed = inputSchema.safeParse(raw);
    if (!parsed.success)
      failure(
        400,
        "MODEL_SETTINGS_INVALID",
        "模型配置格式无效，请检查服务商、模型名称和高级设置",
      );
    const { apiKey, ...settings } = parsed.data!;
    const old = await read(user, connection);
    let secret = apiKey;
    if (!secret) {
      if (!old || old.settings.vendor !== settings.vendor)
        failure(400, "MODEL_KEY_REQUIRED", "请填写此服务商的 API Key");
      secret = decrypt(user, old.encrypted_key);
    }
    if (!secret || secret.length < 8 || /[\s\x00-\x1f\x7f]/.test(secret))
      failure(
        400,
        "MODEL_KEY_INVALID",
        "API Key 格式无效，请检查是否有空格或换行",
      );
    let client: SummaryProviderV2;
    try {
      client = provider(settings, secret!);
    } catch {
      failure(
        400,
        "MODEL_SETTINGS_INVALID",
        "上下文容量与输出预算不匹配，请检查高级设置",
      );
    }
    return { settings, secret, client: client! };
  }
  const service = {
    async state(user: string): Promise<PersonalModelState> {
      const row = await read(user);
      return {
        enabled: !!key,
        configured: !!key && !!row,
        settings: row ? settingsSchema.parse(row.settings) : null,
        revision: row?.revision ?? null,
        updatedAt: row?.updated_at
          ? new Date(row.updated_at).toISOString()
          : null,
        active: await active(user),
      };
    },
    sealRepository(user: string, secret: string) { return encrypt(`repository:${user}`, secret); },
    openRepository(user: string, secret: string) { return decrypt(`repository:${user}`, secret)!; },
    async resolve(user: string, connection = db) {
      if (!key) return;
      const row = await read(user, connection);
      if (!row) return;
      return provider(
        settingsSchema.parse(row.settings),
        decrypt(user, row.encrypted_key)!,
        row.revision,
      );
    },
    async save(user: string, raw: unknown) {
      await db.transaction(async (tx) => {
        await tx.query("SELECT pg_advisory_xact_lock(41724)");
        if (await active(user, tx))
          failure(
            409,
            "MODEL_ANALYSIS_ACTIVE",
            "请等待当前分析完成，或先停止分析，再修改模型配置",
          );
        const value = await candidate(user, raw, tx);
        await tx.query(
          "INSERT INTO user_model_settings(user_id,revision,settings,encrypted_key) VALUES($1,$2,$3,$4) ON CONFLICT(user_id) DO UPDATE SET revision=EXCLUDED.revision,settings=EXCLUDED.settings,encrypted_key=EXCLUDED.encrypted_key,updated_at=now()",
          [
            user,
            randomUUID(),
            JSON.stringify(value.settings),
            encrypt(user, value.secret!),
          ],
        );
      });
      return service.state(user);
    },
    async remove(user: string) {
      await db.transaction(async (tx) => {
        await tx.query("SELECT pg_advisory_xact_lock(41724)");
        if (await active(user, tx))
          failure(409, "MODEL_ANALYSIS_ACTIVE", "请先结束当前分析，再移除密钥");
        await tx.query("DELETE FROM user_model_settings WHERE user_id=$1", [
          user,
        ]);
      });
      return service.state(user);
    },
    async test(user: string, raw: unknown) {
      const value = await candidate(user, raw);
      const started = Date.now();
      try {
        const response = await value.client.complete({
          system:
            'Return exactly this JSON object: {"status":"ok"}. No other keys or text.',
          user: '{"purpose":"personal model connectivity test; no project source"}',
          // The limit includes reasoning; 64 tokens can end before any JSON.
          maxOutputTokens: isOpenAIReasoningModel(value.settings.model) ? 1024 : 64,
          signal: AbortSignal.timeout(30000),
        });
        let valid = false;
        try {
          const parsed = JSON.parse(response.content);
          valid = parsed?.status === "ok" && Object.keys(parsed).length === 1;
        } catch {}
        if (!valid)
          failure(
            422,
            "MODEL_TEST_FORMAT",
            "接口已响应，但未返回所需的 JSON；请检查模型是否支持 JSON 输出",
          );
        return {
          ok: true,
          elapsedMs: Date.now() - started,
          usage: response.usage,
          model: value.settings.model,
        };
      } catch (error) {
        if ((error as any).statusCode) throw error;
        const code =
          error instanceof ModelRequestError ? error.code : "MODEL_TEST_FAILED";
        const messages: Record<string, string> = {
          MODEL_HTTP_401: "密钥无效或已过期，请检查 API Key",
          MODEL_HTTP_402: "服务商账户余额不足，请前往服务商充值",
          MODEL_HTTP_403: "服务商拒绝访问，请检查密钥权限和模型权限",
          MODEL_HTTP_404: "模型或接口不存在，请检查模型名称",
          MODEL_HTTP_429: "服务商限流，请稍后手动重试",
          MODEL_TRANSPORT_UNKNOWN: "连接超时或中断，结果未确认；未自动重试",
        };
        return failure(
          422,
          code,
          messages[code] ?? "连接未通过，请核对服务商、模型和密钥；未自动重试",
        );
      }
    },
  };
  return service;
}
export type UserModelService = ReturnType<typeof createUserModelService>;
export function registerUserModelRoutes(
  app: FastifyInstance,
  service: UserModelService,
) {
  const owner = (req: any) => req.user.id as string;
  app.get("/api/v2/model-settings", (req) => service.state(owner(req)));
  app.put("/api/v2/model-settings", { bodyLimit: 8192 }, (req) =>
    service.save(owner(req), req.body),
  );
  app.delete("/api/v2/model-settings", (req) => service.remove(owner(req)));
  app.post(
    "/api/v2/model-settings/test",
    {
      bodyLimit: 8192,
      config: {
        rateLimit: {
          hook: "preHandler",
          max: 3,
          timeWindow: "1 minute",
          keyGenerator: owner,
        },
      },
    },
    (req) => service.test(owner(req), req.body),
  );
}
