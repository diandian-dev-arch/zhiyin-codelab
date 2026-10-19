import { z } from "zod";
export const verdict = z.enum(["passed", "failed", "manual", "not_run"]);
export type Verdict = z.infer<typeof verdict>;
export const checkIds = [
  "create",
  "edit",
  "delete",
  "toggle",
  "filter",
  "validation",
  "persistence",
] as const;
export const criterionSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_-]{0,40}$/),
    title: z.string().min(1).max(160),
    mode: z.enum(["auto", "manual"]),
    check: z.enum(checkIds).optional(),
    note: z.string().max(1000).default(""),
  })
  .superRefine((v, c) => {
    if (v.mode === "auto" && !v.check)
      c.addIssue({ code: "custom", message: "自动条目需要选择检查定义" });
  });
export const taskSchema = z
  .object({
    title: z.string().min(1).max(120),
    description: z.string().max(5000),
    classId: z.string().uuid(),
    criteria: z.array(criterionSchema).min(1).max(15),
  })
  .superRefine((v, c) => {
    if (new Set(v.criteria.map((x) => x.id)).size !== v.criteria.length)
      c.addIssue({ code: "custom", message: "条目编号不能重复" });
  });
export type Criterion = z.infer<typeof criterionSchema>;
export const evidenceSchema = z.object({
  id: z.string(),
  kind: z.enum(["log", "screenshot", "dom", "source", "probe"]),
  title: z.string(),
  text: z.string().max(65536).optional(),
  file: z.string().optional(),
});
export type Evidence = z.infer<typeof evidenceSchema>;
export const resultSchema = z.object({
  criterionId: z.string(),
  status: verdict,
  observation: z.string().max(3000),
  steps: z.array(z.string()).max(20),
  evidenceIds: z.array(z.string()).max(20),
});
export type CheckResult = z.infer<typeof resultSchema>;
export const feedbackSchema = z.object({
  criterionId: z.string(),
  observation: z.string().max(3000),
  evidenceIds: z.array(z.string()).max(20),
  possibleCause: z.string().max(2000),
  support: z.enum(["observed", "hypothesis", "insufficient"]),
  nextStep: z.string().max(2000),
  needsReview: z.boolean(),
});
export type Feedback = z.infer<typeof feedbackSchema>;
export const runnerResponseSchema = z.object({
  outcome: z.enum(["complete", "build_error", "infra_error"]),
  results: z.array(resultSchema),
  evidence: z.array(evidenceSchema),
  screenshots: z.record(z.string()).default({}),
});
export type RunnerResponse = z.infer<typeof runnerResponseSchema>;
export const probeSchema = z.object({
  actions: z
    .array(
      z.discriminatedUnion("type", [
        z.object({
          type: z.literal("open"),
          path: z.string().regex(/^\/(?!\/)[a-zA-Z0-9/_?=&%-]*$/),
        }),
        z.object({
          type: z.literal("click"),
          testId: z.string().regex(/^[a-z0-9-]{1,80}$/),
        }),
        z.object({
          type: z.literal("fill"),
          testId: z.string().regex(/^[a-z0-9-]{1,80}$/),
          value: z.string().max(200),
        }),
        z.object({
          type: z.literal("select"),
          testId: z.string().regex(/^[a-z0-9-]{1,80}$/),
          value: z.string().max(80),
        }),
        z.object({
          type: z.literal("read"),
          testId: z.string().regex(/^[a-z0-9-]{1,80}$/),
        }),
      ]),
    )
    .min(1)
    .max(8),
});
export const statusLabels: Record<string, string> = {
  queued: "排队中",
  building: "构建与检查",
  analyzing: "分析证据",
  review: "待教师复核",
  published: "已发布",
  rejected: "提交不兼容",
  infra_error: "执行环境故障",
  cancelled: "已取消",
};
export const verdictLabels: Record<Verdict, string> = {
  passed: "已满足",
  failed: "未满足",
  manual: "待人工判断",
  not_run: "未执行",
};
export const defaultCriteria: Criterion[] = [
  ["create", "新增任务"],
  ["edit", "编辑任务"],
  ["delete", "删除任务"],
  ["toggle", "切换完成状态"],
  ["filter", "筛选任务"],
  ["validation", "拒绝空白任务"],
  ["persistence", "刷新后保留数据"],
].map(([id, title]) => ({
  id,
  title,
  mode: "auto",
  check: id as (typeof checkIds)[number],
  note: "",
}));
export function compareResults(before: CheckResult[], after: CheckResult[]) {
  return after.map((a) => {
    const b = before.find((b) => b.criterionId === a.criterionId);
    return {
      criterionId: a.criterionId,
      before: b?.status ?? null,
      after: a.status,
      change:
        !b ||
        a.status === "not_run" ||
        a.status === "manual" ||
        b.status === "not_run" ||
        b.status === "manual"
          ? "unknown"
          : b.status === "failed" && a.status === "passed"
            ? "resolved"
            : b.status === "passed" && a.status === "failed"
              ? "regression"
              : a.status === "failed"
                ? "remaining"
                : "unchanged",
    };
  });
}
