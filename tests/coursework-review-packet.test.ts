import { describe, expect, it } from "vitest";
import { courseworkDevelopmentCorpus as corpus } from "../eval/coursework-development-corpus.js";
import { sha256 } from "../eval/coursework-live-guard.js";
import {
  buildCourseworkReviewPacket,
  emptyCourseworkReview,
} from "../eval/coursework-review-packet.js";

function fixture() {
  return {
    id: "receipt-one",
    mode: "live-synthetic-development",
    samplePartition: "development-not-held-out",
    agentSha256: "a".repeat(64),
    prompt: { templateSha256: "b".repeat(64) },
    modelConfiguration: { apiKey: "PRIVATE_KEY_NOT_FOR_EXPORT" },
    attempts: [
      {
        analysisId: "00000000-0000-0000-0000-000000000001",
        sampleId: corpus[0].id,
        sampleSha256: sha256(JSON.stringify(corpus[0])),
        mode: "self-check",
        level: 1,
        question: corpus[0].question,
        snapshotId: "snapshot-one",
        taskRevisionId: "revision-one",
        elapsedMs: 100,
        status: "succeeded",
        failureCode: null,
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          rawResponse: "PRIVATE_TRACE",
        },
        report: {
          snapshotId: "snapshot-one",
          taskRevisionId: "revision-one",
          coveredPaths: ["src/search.ts"],
          execution: { ran: false },
          summary: "仅静态阅读",
          findings: [
            {
              requirementId: "R1",
              verdict: "met",
              explanation: "可见分支",
              impact: "匹配给定目标",
              suggestion: "核对边界",
              verification: "请自行验证",
              evidence: [{ path: "src/search.ts", start: 1, end: 3 }],
            },
          ],
          limitations: ["未运行代码"],
        },
      },
    ],
  };
}
function build(value = fixture()) {
  return buildCourseworkReviewPacket([
    { path: "receipt.json", text: JSON.stringify(value) },
  ]);
}

describe("offline teacher-review preparation, not teacher acceptance", () => {
  it("binds real inputs and output while projecting only allowed fields", () => {
    const packet = build();
    expect(packet.mechanicalSummary).toMatchObject({
      attempts: 1,
      acceptedReports: 1,
      failedAttempts: 0,
      plannedRequirements: 1,
      structurallyRepresentedRequirements: 1,
      resolvableCitations: 1,
      totalCitations: 1,
      inputTokensKnown: 10,
      outputTokensKnown: 5,
      unknownUsageRequests: 0,
      semanticGoalCoverage: null,
      precision: null,
      recall: null,
    });
    expect(packet.cases[0].reportSha256).toBe(
      sha256(JSON.stringify(packet.cases[0].report)),
    );
    expect(JSON.stringify(packet)).not.toContain("PRIVATE_");
    expect(packet.qualityAcceptancePassed).toBe(false);
    expect(packet.teacherReviewsRecorded).toBe(0);
    expect(packet.rubric.dimensions).toHaveLength(8);
    expect(packet.cases[0].reviewFocus).toMatchObject({
      codeHelpRequested: false,
      semanticAcceptance: "pending-human-review",
    });
  });

  it("retains failure in denominators without manufacturing the missing response", () => {
    const receipt = fixture();
    const failed: any = structuredClone(receipt.attempts[0]);
    failed.analysisId = "00000000-0000-0000-0000-000000000002";
    failed.status = "failed";
    failed.failureCode = "REPORT_EXECUTION_CLAIM";
    failed.report = null;
    failed.usage = null;
    receipt.attempts.push(failed);
    const packet = build(receipt);
    expect(packet.mechanicalSummary).toMatchObject({
      attempts: 2,
      acceptedReports: 1,
      failedAttempts: 1,
      plannedRequirements: 2,
      structurallyRepresentedRequirements: 1,
      unavailableResponses: 1,
      unknownUsageRequests: 1,
    });
    expect(packet.cases[1].reviewability).toBe(
      "original-response-not-retained",
    );
    const review = emptyCourseworkReview(packet, "c".repeat(64));
    expect(review.entries[1].status).toBe("not-reviewable");
    expect(review.entries[1].unsupportedExecutionClaim).toBeNull();
  });

  it("does not prefill teacher identity, thresholds, scores or verdicts", () => {
    const review = emptyCourseworkReview(build(), "c".repeat(64));
    expect(review.status).toBe("not-reviewed");
    expect(review.reviewerAlias).toBeNull();
    expect(review.thresholdDecision).toBeNull();
    expect(review.entries[0]).toMatchObject({
      status: "pending",
      factuality: null,
      teachingDepthAppropriate: null,
      limitationClaimsSupported: null,
      unknownContextExplained: null,
      crossFieldAnswerLeak: null,
      localCodeDelivered: null,
      requirements: [
        {
          requirementId: "R1",
          truePositives: null,
          falsePositives: null,
          falseNegatives: null,
          claimSupport: [],
        },
      ],
    });
  });

  it("keeps new model limitation declarations separate and unreviewed without rewriting historical reports", () => {
    expect(build().cases[0].modelDeclarations).toBeNull();
    const receipt = fixture();
    (receipt.attempts[0].report as any).qualityReview = {
      modelLimitations: ["模型自行声称未提供类型"],
      privateConfig: "PRIVATE_NOT_FOR_EXPORT",
    };
    const packet = build(receipt);
    expect(packet.cases[0].modelDeclarations).toEqual({
      limitations: ["模型自行声称未提供类型"],
      reviewStatus: "not-reviewed",
    });
    expect(packet.cases[0].report?.limitations).toEqual(["未运行代码"]);
    expect(JSON.stringify(packet)).not.toContain("PRIVATE_NOT_FOR_EXPORT");
  });

  it.each(["mode", "samplePartition"] as const)(
    "rejects a changed provenance %s",
    (field) => {
      const receipt = fixture();
      receipt[field] = "held-out";
      expect(() => build(receipt)).toThrow();
    },
  );

  it("rejects duplicate analyses and modified sample hashes", () => {
    const receipt = fixture();
    receipt.attempts.push(receipt.attempts[0]);
    expect(() => build(receipt)).toThrow("DUPLICATE_ANALYSIS");
    receipt.attempts.pop();
    receipt.attempts[0].sampleSha256 = "c".repeat(64);
    expect(() => build(receipt)).toThrow();
  });

  it.each(["snapshotId", "taskRevisionId"] as const)(
    "rejects mismatched report binding %s",
    (field) => {
      const receipt = fixture();
      receipt.attempts[0].report[field] = "another-version";
      expect(() => build(receipt)).toThrow();
    },
  );

  it("rejects citations outside actual read paths and missing accepted reports", () => {
    const receipt = fixture();
    receipt.attempts[0].report.coveredPaths = [];
    expect(() => build(receipt)).toThrow("报告引用无法定位");
    (receipt.attempts[0] as any).report = null;
    expect(() => build(receipt)).toThrow("ACCEPTED_REPORT_MISSING");
  });

  it("never exports a body attached to a rejected attempt", () => {
    const receipt = fixture();
    receipt.attempts[0].status = "failed";
    expect(() => build(receipt)).toThrow("REJECTED_BODY_MUST_NOT_BE_EXPORTED");
  });
});
