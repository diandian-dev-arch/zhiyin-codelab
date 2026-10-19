import type { z } from "zod";
import { courseworkReport } from "../../../packages/contracts/src/coursework.js";
import { courseFail } from "./coursework-common.js";

type CourseReport = z.infer<typeof courseworkReport>;

export function courseAnalysisContext(
  files: Record<string, string>,
  paths: string[],
  codeHelpRequested: boolean,
) {
  const coveredPaths = Object.keys(files);
  const unreadPaths = paths.filter((path) => !Object.hasOwn(files, path));
  return {
    coveredPaths,
    unreadPaths,
    codeHelpRequested,
    execution: { ran: false as const, reason: "仅静态分析，未运行测试" },
    limitations: [
      "仅依据本次实际提供的源码作静态分析，未运行代码或测试；引用可定位不代表结论已被人工确认。",
      ...(unreadPaths.length
        ? [
            `本次预算内有 ${unreadPaths.length} 个快照文件未提供给模型，不对其实现作判断。`,
          ]
        : []),
    ],
  };
}

// This checks delivery shape, not whether a snippet is correct or a complete answer.
export function courseCodeDelivery(
  report: CourseReport,
  codeHelpRequested: boolean,
) {
  if (!codeHelpRequested) return { status: "not-requested" as const };
  const snippets = report.findings.flatMap((finding) =>
    [...finding.suggestion.matchAll(/```[^\r\n`]*\r?\n([\s\S]*?)```/g)].map(
      (match) => ({
        requirementId: finding.requirementId,
        code: match[1].trim(),
      }),
    ),
  );
  const unknown = report.findings.filter(
    (finding) => finding.verdict === "unknown",
  );
  if (
    !snippets.length &&
    unknown.length &&
    unknown.every(
      (finding) => finding.explanation.trim() && finding.suggestion.trim(),
    ) &&
    report.findings.every((finding) => !/```/.test(finding.suggestion))
  )
    return {
      status: "context-needed" as const,
      requirementIds: unknown.map((finding) => finding.requirementId),
    };
  if (
    snippets.length !== 1 ||
    !snippets[0].code ||
    snippets[0].code.length > 800 ||
    snippets[0].code.split(/\r?\n/).length > 12
  )
    courseFail(
      "REPORT_HELP_NOT_DELIVERED",
      "辅助代码未按单个局部片段交付；缺少上下文时请明确未知原因",
    );
  return {
    status: "snippet-provided" as const,
    requirementId: snippets[0].requirementId,
  };
}
