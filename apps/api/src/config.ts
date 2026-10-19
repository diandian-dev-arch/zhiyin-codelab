import { z } from "zod";

const boolean = (fallback: boolean) =>
  z
    .enum(["true", "false"])
    .default(String(fallback) as "true" | "false")
    .transform((value) => value === "true");
const port = (fallback: number) =>
  z.coerce.number().int().min(1).max(65535).default(fallback);
const httpUrl = z
  .string()
  .url()
  .refine((value) => /^https?:\/\//.test(value), "必须使用 HTTP(S)");
const databaseUrl = z
  .string()
  .url()
  .refine(
    (value) => /^postgres(ql)?:\/\//.test(value),
    "必须使用 PostgreSQL URL",
  );

// Report field names only. Environment values can contain credentials.
function parse<S extends z.ZodTypeAny>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new Error(
      "配置无效：" +
        result.error.issues.map((issue) => issue.path.join(".")).join(", "),
    );
  return result.data;
}

export function readApiConfig(env: NodeJS.ProcessEnv = process.env) {
  return parse(
    z.object({
      DATABASE_URL: databaseUrl,
      APP_ORIGIN: httpUrl.default("http://localhost:5173"),
      API_HOST: z.string().min(1).default("127.0.0.1"),
      API_PORT: port(3100),
      COOKIE_SECURE: boolean(false),
      EXECUTION_APPROVED: boolean(false),
      BUSINESS_API_VERSION: z.coerce
        .number()
        .pipe(z.union([z.literal(1), z.literal(2)]))
        .default(1),
      MODEL_NAME: z.string().default("unconfigured"),
      EXECUTION_IMAGE: z.string().min(1).default("codelab-build:vue-board-v1"),
    }),
    env,
  );
}

export function readWorkerConfig(env: NodeJS.ProcessEnv = process.env) {
  if (env.EXECUTION_APPROVED !== "true")
    throw Object.assign(new Error("执行入口未通过隔离验收，worker 拒绝启动"), {
      code: "EXECUTION_NOT_APPROVED",
    });
  return parse(
    z
      .object({
        DATABASE_URL: databaseUrl,
        RUNNER_URL: httpUrl,
        RUNNER_TOKEN: z
          .string()
          .min(32)
          .refine((value) => !value.startsWith("replace-"), "请使用独立令牌"),
        MODEL_BASE_URL: httpUrl.optional(),
        MODEL_NAME: z.string().min(1).optional(),
        MODEL_API_KEY: z.string().min(1).optional(),
      })
      .superRefine((value, ctx) => {
        if (value.MODEL_API_KEY && (!value.MODEL_NAME || !value.MODEL_BASE_URL))
          ctx.addIssue({
            code: "custom",
            path: ["MODEL_NAME/MODEL_BASE_URL"],
            message: "模型配置不完整",
          });
      }),
    Object.fromEntries(Object.entries(env).filter(([, value]) => value !== "")),
  );
}
