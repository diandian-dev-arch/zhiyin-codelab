import { z } from "zod";
const uuid = z.string().uuid();
export const courseworkPath = z
  .string()
  .min(1)
  .max(300)
  .refine(
    (p) =>
      !/[\\:\x00-\x1f]/.test(p) &&
      !p.startsWith("/") &&
      p.split("/").every((s) => s && s !== "." && s !== "..") &&
      p.split("/").length <= 16,
    "文件路径无效",
  );
export const courseworkSources = z.enum([
  "snippet",
  "files",
  "zip",
  "github",
  "gitee",
]);
export const courseworkTask = z
  .object({
    title: z.string().trim().min(1).max(160),
    description: z.string().trim().min(1).max(8000),
    requirements: z
      .array(
        z
          .object({
            id: z.string().regex(/^[\w-]{1,60}$/),
            title: z.string().trim().min(1).max(500),
          })
          .strict(),
      )
      .min(1)
      .max(20)
      .refine(
        (rs) => new Set(rs.map((r) => r.id)).size === rs.length,
        "目标编号不能重复",
      ),
    dueAt: z.string().datetime().nullable().default(null),
    allowCode: z.boolean().default(true),
    allowedSources: z
      .array(courseworkSources)
      .min(1)
      .default(["snippet", "files", "zip", "gitee", "github"]),
    requiredPaths: z.array(courseworkPath).max(30).default([]),
    scope: z.array(courseworkPath).max(30).default([]),
    predecessorTaskId: uuid.nullable().default(null),
    starter: z.string().max(16000).default(""),
  })
  .strict();
export const courseworkAssignment = z
  .object({
    classId: uuid,
    title: z.string().trim().min(1).max(160),
    subjectMode: z.enum(["individual", "team"]).default("individual"),
    tasks: z.array(courseworkTask).min(1).max(30),
    status: z.enum(["draft", "published"]).default("published"),
  })
  .strict();
export const courseworkFiles = z
  .array(
    z
      .object({ path: courseworkPath, content: z.string().max(524288) })
      .strict(),
  )
  .min(1)
  .max(200);
export const courseworkImport = z
  .object({
    taskId: uuid,
    type: courseworkSources,
    files: courseworkFiles.optional(),
    zipBase64: z.string().max(13000000).optional(),
    repository: z
      .object({
        provider: z.enum(["github", "gitee"]),
        owner: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/),
        name: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/),
        ref: z.string().min(1).max(200),
        connectionId: uuid.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export const courseworkSubmit = z
  .object({
    subjectId: uuid.optional(),
    snapshotId: uuid,
    taskRevisionId: uuid,
    baseSubmissionId: uuid.nullable().default(null),
    note: z.string().trim().max(2000).default(""),
  })
  .strict();
export const courseworkReport = z
  .object({
    summary: z.string().min(1).max(3000),
    findings: z
      .array(
        z
          .object({
            requirementId: z.string().max(60),
            verdict: z.enum(["met", "partial", "unmet", "unknown"]),
            explanation: z.string().min(1).max(2000),
            impact: z.string().max(2000).default("未提供影响说明，需人工确认"),
            evidence: z
              .array(
                z
                  .object({
                    path: courseworkPath,
                    start: z.number().int().positive(),
                    end: z.number().int().positive(),
                  })
                  .strict(),
              )
              .max(10),
            suggestion: z.string().max(3000),
            verification: z.string().max(2000),
          })
          .strict(),
      )
      .max(20),
    limitations: z.array(z.string().max(1000)).max(20),
  })
  .strict();
export type CourseworkTask = z.infer<typeof courseworkTask>;
