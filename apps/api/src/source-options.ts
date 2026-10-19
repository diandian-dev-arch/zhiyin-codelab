import { z } from "zod";
export const sourceOptionsSchema = z
  .object({
    version: z.literal(1).default(1),
    mode: z.enum(["quick", "deep"]).default("quick"),
    modules: z.array(z.string().min(1).max(400)).max(6).default([]),
    cost: z.object({
      limitCny: z.number().finite().min(0.01).max(1000).optional(),
      inputPerMillion: z.number().finite().positive().max(100000),
      outputPerMillion: z.number().finite().positive().max(100000),
      label: z.string().min(1).max(120),
    }).strict().optional(),
    reuse: z.boolean().optional(),
    incrementalFrom: z.string().uuid().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      new Set(value.modules).size !== value.modules.length ||
      (value.mode === "quick" && value.modules.length)
    )
      context.addIssue({
        code: "custom",
        message: "关注目录仅用于深入分析且不能重复",
      });
  });
