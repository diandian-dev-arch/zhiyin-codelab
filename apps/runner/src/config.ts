import { z } from "zod";

export function readRunnerConfig(env: NodeJS.ProcessEnv = process.env, platform = process.platform) {
  if (platform !== "linux" || env.RUNNER_APPROVED !== "true")
    throw new Error("Runner 仅在专用 Linux 测试环境启动，需要 RUNNER_APPROVED=true；该开关不代表隔离已验收");
  const parsed = z.object({
    RUNNER_TOKEN: z.string().min(32).refine((value) => !value.startsWith("replace-")),
    RUNNER_HOST: z.string().min(1).default("127.0.0.1"),
    RUNNER_PORT: z.coerce.number().int().min(1).max(65535).default(3200),
    RUNNER_DATA_DIR: z.string().regex(/^\/(?!$)/)
      .refine((value) => value.split("/").slice(1).every((part) => part !== "" && part !== "." && part !== ".."))
      .default("/var/lib/codelab-runner"),
  }).safeParse(env);
  if (!parsed.success) throw new Error("Runner 配置无效：" + parsed.error.issues.map((issue) => issue.path.join(".")).join(", "));
  return parsed.data;
}
