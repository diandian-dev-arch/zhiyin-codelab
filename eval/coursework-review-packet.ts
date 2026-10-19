import assert from "node:assert/strict";
import { courseworkDevelopmentCorpus as corpus } from "./coursework-development-corpus.js";
import { sha256 } from "./coursework-live-guard.js";
import { validateCourseReport } from "../apps/api/src/coursework-agent.js";
import {
  courseworkReviewFocus,
  courseworkReviewRubric,
} from "./coursework-review-rubric.js";

export function buildCourseworkReviewPacket(
  receipts: { path: string; text: string }[],
) {
  const ids = new Set<string>();
  const cases = receipts.flatMap(({ path, text }) => {
    const receipt = JSON.parse(text);
    assert.equal(receipt.mode, "live-synthetic-development");
    assert.equal(receipt.samplePartition, "development-not-held-out");
    assert.match(receipt.agentSha256, /^[a-f0-9]{64}$/);
    assert.match(receipt.prompt.templateSha256, /^[a-f0-9]{64}$/);
    const attempts: any[] = receipt.attempts;
    assert(Array.isArray(attempts));
    return attempts.map((attempt: any) => {
      assert.match(attempt.analysisId, /^[a-f0-9-]{36}$/);
      assert(!ids.has(attempt.analysisId), "DUPLICATE_ANALYSIS");
      ids.add(attempt.analysisId);
      assert(["self-check", "formal"].includes(attempt.mode));
      assert([1, 2, 3].includes(attempt.level));
      assert.equal(typeof attempt.question, "string");
      const sample = corpus.find((s) => s.id === attempt.sampleId);
      assert(sample, "UNKNOWN_DEVELOPMENT_SAMPLE");
      assert.equal(sha256(JSON.stringify(sample)), attempt.sampleSha256);
      let report = null;
      if (attempt.status === "succeeded") {
        assert(attempt.report, "ACCEPTED_REPORT_MISSING");
        assert.equal(attempt.report.execution.ran, false);
        assert.equal(attempt.report.snapshotId, attempt.snapshotId);
        assert.equal(attempt.report.taskRevisionId, attempt.taskRevisionId);
        assert(Array.isArray(attempt.report.coveredPaths));
        const files: Record<string, string> = {};
        for (const file of attempt.report.coveredPaths) {
          assert(Object.hasOwn(sample.files, file), "UNKNOWN_READ_PATH");
          files[file] = sample.files[file];
        }
        const { summary, findings, limitations } = attempt.report;
        report = validateCourseReport(
          { summary, findings, limitations },
          files,
          sample.task.requirements,
          sample.task.allowCode && attempt.level === 3,
        );
      } else {
        assert.equal(attempt.status, "failed");
        assert.equal(
          attempt.report,
          null,
          "REJECTED_BODY_MUST_NOT_BE_EXPORTED",
        );
        assert.match(attempt.failureCode, /^[A-Z][A-Z_0-9]{2,79}$/);
      }
      const usage = attempt.usage;
      const modelLimitations =
        attempt.report?.qualityReview?.modelLimitations ?? null;
      assert(
        modelLimitations === null ||
          (Array.isArray(modelLimitations) &&
            modelLimitations.length <= 20 &&
            modelLimitations.every(
              (text: unknown) =>
                typeof text === "string" && text.length <= 1000,
            )),
        "INVALID_MODEL_DECLARATIONS",
      );
      const usageKnown = [usage?.inputTokens, usage?.outputTokens].every(
        (n) => Number.isSafeInteger(n) && n >= 0,
      );
      assert(Number.isSafeInteger(attempt.elapsedMs) && attempt.elapsedMs >= 0);
      return {
        analysisId: attempt.analysisId,
        receipt: { path, sha256: sha256(text), id: receipt.id },
        applicationSha256: receipt.agentSha256,
        promptSha256: receipt.prompt.templateSha256,
        sampleId: sample.id,
        sampleSha256: attempt.sampleSha256,
        partition: "development-not-held-out",
        mode: attempt.mode,
        level: attempt.level,
        question: attempt.question,
        reviewFocus: courseworkReviewFocus(
          attempt.mode,
          attempt.level,
          sample.task.allowCode,
        ),
        task: sample.task,
        files: sample.files,
        binding: {
          taskId: attempt.taskId,
          taskRevisionId: attempt.taskRevisionId,
          snapshotId: attempt.snapshotId,
          submissionId: attempt.report?.submissionId ?? null,
        },
        status: attempt.status,
        failureCode: attempt.failureCode ?? null,
        report,
        modelDeclarations:
          modelLimitations === null
            ? null
            : { limitations: modelLimitations, reviewStatus: "not-reviewed" },
        reportSha256: report ? sha256(JSON.stringify(report)) : null,
        reviewability: report
          ? "saved-report"
          : "original-response-not-retained",
        elapsedMs: attempt.elapsedMs,
        usage: usageKnown
          ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }
          : null,
      };
    });
  });
  assert(cases.length > 0, "NO_RECORDED_ATTEMPTS");
  const accepted = cases.filter((c) => c.report !== null);
  const citations = accepted.flatMap((c) =>
    c.report!.findings.flatMap((f) => f.evidence),
  );
  return {
    version: 2,
    purpose: "offline-synthetic-development-teacher-review-preparation",
    rubric: courseworkReviewRubric,
    teacherReviewsRecorded: 0,
    heldOutSamples: 0,
    qualityAcceptancePassed: false,
    cases,
    mechanicalSummary: {
      attempts: cases.length,
      acceptedReports: accepted.length,
      failedAttempts: cases.length - accepted.length,
      unavailableResponses: cases.filter((c) => !c.report).length,
      plannedRequirements: cases.reduce(
        (n, c) => n + c.task.requirements.length,
        0,
      ),
      structurallyRepresentedRequirements: accepted.reduce(
        (n, c) => n + c.report!.findings.length,
        0,
      ),
      resolvableCitations: citations.length,
      totalCitations: citations.length,
      inputTokensKnown: cases.reduce(
        (n, c) => n + (c.usage?.inputTokens ?? 0),
        0,
      ),
      outputTokensKnown: cases.reduce(
        (n, c) => n + (c.usage?.outputTokens ?? 0),
        0,
      ),
      unknownUsageRequests: cases.filter((c) => c.usage === null).length,
      semanticGoalCoverage: null,
      precision: null,
      recall: null,
    },
  };
}

export function emptyCourseworkReview(
  packet: ReturnType<typeof buildCourseworkReviewPacket>,
  packetSha256: string,
) {
  return {
    packetSha256,
    status: "not-reviewed",
    reviewerAlias: null,
    reviewerRole: null,
    reviewedAt: null,
    thresholdDecision: null,
    entries: packet.cases.map((c) => ({
      analysisId: c.analysisId,
      reportSha256: c.reportSha256,
      status: c.report ? "pending" : "not-reviewable",
      factuality: null,
      citationsSupportClaims: null,
      teachingDepthAppropriate: null,
      assistanceUseful: null,
      limitationClaimsSupported: null,
      unknownContextExplained: null,
      crossFieldAnswerLeak: null,
      localCodeDelivered: null,
      unsupportedExecutionClaim: null,
      obeyedSourceInjection: null,
      privacyLeak: null,
      requirements: c.task.requirements.map((r) => ({
        requirementId: r.id,
        usefulFeedback: null,
        truePositives: null,
        falsePositives: null,
        falseNegatives: null,
        claimSupport: [] as {
          reportField: string;
          claim: string;
          source: { path: string; start: number; end: number }[];
          decision:
            | "supported"
            | "contradicted"
            | "insufficient-evidence"
            | "not-applicable";
          notes: string;
        }[],
        evidenceAndNotes: "",
      })),
      evidenceAndNotes: "",
    })),
  };
}
