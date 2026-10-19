import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  validateCandidateReport,
  type CandidateReport,
} from "../apps/api/src/candidate-report-v2.js";

const ids = {
  analysis: randomUUID(),
  revision: randomUUID(),
};
const context = {
  criterionIds: ["create", "filter"] as const,
  evidenceIds: new Set(["e-create", "e-filter"]),
  analysisAttemptId: ids.analysis,
  baseRevisionId: ids.revision,
};
const valid = (): CandidateReport => ({
  contractVersion: 2,
  analysisAttemptId: ids.analysis,
  baseRevisionId: ids.revision,
  feedback: [
    {
      criterionId: "create",
      observation: "点击后新增一项。",
      evidenceIds: ["e-create"],
      possibleCause: "",
      support: "observed",
      nextStep: "教师核对截图。",
      confidence: "high",
      needsReview: true,
    },
    {
      criterionId: "filter",
      observation: "筛选结果与预期不一致。",
      evidenceIds: ["e-filter"],
      possibleCause: "筛选条件可能未应用。",
      support: "hypothesis",
      nextStep: "检查筛选条件绑定。",
      confidence: "medium",
      needsReview: true,
    },
  ],
  unresolvedQuestions: [],
  newEvidenceIds: [],
  source: "agent",
  generatedAt: "2026-09-27T12:00:00.000Z",
});

describe("CandidateReport v2", () => {
  it("accepts a complete, scoped candidate", () => {
    expect(validateCandidateReport(valid(), context).contractVersion).toBe(2);
  });

  it.each([
    ["missing criterion", (r: CandidateReport) => { r.feedback.pop(); }],
    ["duplicate criterion", (r: CandidateReport) => { r.feedback[1] = { ...r.feedback[0]! }; }],
    ["foreign evidence", (r: CandidateReport) => { r.feedback[0]!.evidenceIds = ["other-run-evidence"]; }],
    ["foreign analysis", (r: CandidateReport) => { r.analysisAttemptId = randomUUID(); }],
  ])("rejects %s", (_label, mutate) => {
    const report = valid();
    mutate(report);
    expect(() => validateCandidateReport(report, context)).toThrow();
  });

  it("rejects an observed item that smuggles in a causal claim", () => {
    const report = valid();
    report.feedback[0]!.possibleCause = "因为状态管理错误";
    expect(() => validateCandidateReport(report, context)).toThrow(
      "CANDIDATE_OBSERVED_HAS_UNSUPPORTED_CAUSE",
    );
  });

  it("requires needsReview to stay true", () => {
    const report = valid() as any;
    report.feedback[0].needsReview = false;
    expect(() => validateCandidateReport(report, context)).toThrow();
  });
});
