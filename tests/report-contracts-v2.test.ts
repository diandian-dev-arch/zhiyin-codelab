import { describe, expect, it } from "vitest";
import {
  assertPublishableRevision,
  buildBaseFeedback,
  canonicalJson,
  compareTeacherJudgments,
  confirmCriterion,
  createArtifactManifest,
  createDevelopmentPack,
  createPublicationSnapshot,
  createRuleSnapshot,
  deriveReviewedResults,
  hashCriterionContent,
  hashRuleSnapshot,
  hashTaskPack,
  modelFeedbackDraftSchema,
  publicationSchema,
  referencedEvidenceIds,
  retainValidConfirmations,
  sha256,
  teacherJudgmentSchema,
  validatePublicationSnapshot,
  validateReportRevision,
  type ArtifactManifest,
  type CaseResult,
  type ComparisonEvidenceBundle,
  type Evidence,
  type EvidenceRef,
  type MeasurementFingerprint,
  type ReportRevision,
  type ReportValidationContext,
  type TeacherJudgment,
} from "../packages/contracts/src/v2/index";

// Synthetic contract examples only. These do not attest execution, publication or teacher activity.
const id = (number: number) =>
  `00000000-0000-4000-8000-${number.toString().padStart(12, "0")}`;
const timestamp = "2026-09-27T00:00:00.000Z";
const hash = "a".repeat(64);
const clone = <T>(value: T): T => structuredClone(value);

async function reportFixture(
  status: CaseResult["verdict"] = "passed",
  includeManual = false,
) {
  const pack = await createDevelopmentPack("new-filter", {
    packVersion: "synthetic-report-v1",
    templateVersion: "synthetic-template-v1",
    templateHash: hash,
    dependencyLockHash: hash,
    initializationVersion: "ui-setup-v1",
    caseImplementationHashes: { "NEW-01": hash, "FILTER-03": hash },
  });
  if (includeManual) {
    pack.criteria.push({
      criterionId: "readability",
      displayCode: "CK-06",
      title: "可读性",
      mode: "manual",
      expectedBehavior: "教师检查可读性",
    });
    pack.contentHash = await hashTaskPack(pack);
  }
  const rule = await createRuleSnapshot({
    ruleId: id(1),
    taskId: id(2),
    version: 1,
    packManifest: pack,
    enabledCriterionIds: pack.criteria.map(
      (criterion) => criterion.criterionId,
    ),
    parameterValues: {},
    confirmedBy: id(3),
    confirmedAt: timestamp,
  });
  const execution = {
    runId: id(4),
    executionAttemptId: id(5),
    submissionId: id(6),
    originalZipSha256: hash,
    sourceManifestSha256: hash,
    ruleId: rule.ruleId,
    ruleHash: await hashRuleSnapshot(rule),
    packManifestHash: rule.packManifestHash,
    templateHash: pack.templateHash,
  };
  const results: CaseResult[] = pack.cases.map((definition, index) => {
    const executed = status === "passed" || status === "failed";
    return {
      criterionId: definition.criterionId,
      caseId: definition.caseId,
      verdict: status,
      preconditionStatus: executed ? "satisfied" : "uncertain",
      reasonCode:
        status === "passed"
          ? "ASSERTION_SATISFIED"
          : status === "failed"
            ? "ASSERTION_MISMATCH"
            : status === "manual"
              ? "OBSERVATION_AMBIGUOUS"
              : "INFRA_ERROR",
      expected: definition.expected,
      observed: `Synthetic ${status} result for ${definition.caseId}`,
      executedSteps: executed
        ? definition.plannedSteps.map((step, stepIndex) => ({
            stepId: step.stepId,
            phase: step.phase,
            startedAt: new Date(
              Date.parse(timestamp) + stepIndex * 100,
            ).toISOString(),
            finishedAt: new Date(
              Date.parse(timestamp) + stepIndex * 100 + 50,
            ).toISOString(),
            state:
              status === "failed" &&
              stepIndex === definition.plannedSteps.length - 1
                ? ("failed" as const)
                : ("completed" as const),
            observation: `Actual synthetic step ${step.stepId}`,
            evidenceIds: [id(100 + index)],
          }))
        : [],
      unexecutedStepIds: executed
        ? []
        : definition.plannedSteps.map((step) => step.stepId),
      blockedBy: [],
      evidenceIds: [id(100 + index)],
    };
  });
  const evidence: Evidence[] = [];
  for (const [index, result] of results.entries())
    evidence.push({
      evidenceId: id(100 + index),
      manifestId: id(90),
      runId: execution.runId,
      submissionId: execution.submissionId,
      originalZipSha256: hash,
      sourceManifestSha256: hash,
      executionAttemptId: execution.executionAttemptId,
      analysisAttemptId: null,
      operationId: null,
      scope: "case",
      criterionId: result.criterionId,
      caseId: result.caseId,
      phase: "base",
      collector: "runner",
      contentOrigin: "checker_observation",
      ruleHash: execution.ruleHash,
      packManifestHash: execution.packManifestHash,
      sha256: await sha256(result.observed),
      byteSize: new TextEncoder().encode(result.observed).length,
      mediaType: "text/plain; charset=utf-8",
      storageKey: `runs/${execution.runId}/${id(90)}/${id(100 + index)}.txt`,
      capturedAt: timestamp,
    });
  const baseManifest = await createArtifactManifest({
    manifestId: id(90),
    context: execution,
    source: "base",
    analysisAttemptId: null,
    operationId: null,
    evidence,
    completeness: "complete",
  });
  const context: ReportValidationContext = {
    rule,
    baseResults: results,
    baseManifest,
    supplementalManifests: [],
  };
  const revision: ReportRevision = {
    contractVersion: 2,
    revisionId: id(200),
    runId: execution.runId,
    revisionNo: 1,
    parentRevisionId: null,
    baseManifestId: baseManifest.manifestId,
    selectedSupplementalManifestIds: [],
    feedback: buildBaseFeedback(rule, results, baseManifest),
    teacherJudgments: [],
    confirmations: [],
    source: "base",
    originPublicationId: null,
    createdBy: null,
    createdAt: timestamp,
  };
  return { rule, context, revision };
}

function teacherJudgment(
  targetId: string,
  verdict: TeacherJudgment["verdict"],
  targetType: TeacherJudgment["targetType"] = "case",
  suffix = 0,
): TeacherJudgment {
  return {
    judgmentId: id(300 + suffix),
    targetType,
    targetId,
    verdict,
    reason: "Synthetic teacher independently verified the behavior",
    verificationMethod: "manual_reproduction",
    evidenceRefs: [],
    verificationNote:
      "Synthetic record: independent browser reproduction at a documented time",
    judgedBy: id(3),
    judgedAt: timestamp,
  };
}

async function confirmAll(
  revision: ReportRevision,
  context: ReportValidationContext,
) {
  const result = clone(revision);
  for (const criterionId of context.rule.enabledCriterionIds)
    result.confirmations.push(
      await confirmCriterion(
        result,
        criterionId,
        { confirmedBy: id(3), confirmedAt: timestamp },
        context,
      ),
    );
  return result;
}

async function supplemental(
  context: ReportValidationContext,
  criterionId = "create",
  suffix = 0,
  phase: "source_excerpt" | "probe" | "diagnostic" = "source_excerpt",
): Promise<ArtifactManifest> {
  const original = context.baseManifest.evidence.find(
    (evidence) => evidence.criterionId === criterionId,
  )!;
  const manifestId = id(500 + suffix);
  const evidence: Evidence = {
    ...original,
    evidenceId: id(600 + suffix),
    manifestId,
    analysisAttemptId: id(400),
    operationId: id(450 + suffix),
    phase,
    collector: phase === "source_excerpt" ? "business_extractor" : "runner",
    contentOrigin:
      phase === "source_excerpt"
        ? "student_source"
        : phase === "diagnostic"
          ? "platform_diagnostic"
          : "checker_observation",
    storageKey: `runs/${context.baseManifest.context.runId}/${manifestId}/${id(600 + suffix)}.txt`,
  };
  return createArtifactManifest({
    manifestId,
    context: context.baseManifest.context,
    source: "supplemental",
    analysisAttemptId: evidence.analysisAttemptId,
    operationId: evidence.operationId,
    evidence: [evidence],
    completeness: "complete",
  });
}

const ref = (
  manifest: ArtifactManifest,
  scope: EvidenceRef["scope"] = "current",
): EvidenceRef => ({
  scope,
  manifestId: manifest.manifestId,
  evidenceId: manifest.evidence[0].evidenceId,
});

function fingerprint(context: ReportValidationContext): MeasurementFingerprint {
  return {
    ruleHash: context.baseManifest.context.ruleHash,
    packManifestHash: context.rule.packManifestHash,
    templateHash: context.rule.packManifest.templateHash,
    dependencyLockHash: hash,
    initializationVersion: context.rule.packManifest.initializationVersion,
    parametersHash: context.rule.parametersHash,
    aggregationVersion: "aggregation-v1",
    buildImage: { identifierType: "digest", value: `sha256:${hash}` },
    webImage: { identifierType: "digest", value: `sha256:${hash}` },
    browserImage: { identifierType: "digest", value: `sha256:${hash}` },
    playwrightVersion: "synthetic",
    chromiumVersion: "synthetic",
    viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
    locale: "zh-CN",
    timezone: "UTC",
    clockPolicy: "real-v1",
    randomPolicy: "uncontrolled-v1",
    pageServerPolicy: "static-v1",
    resourceTimeoutConfigVersion: "limits-v1",
  };
}

async function addComparison(
  context: ReportValidationContext,
): Promise<ReportValidationContext> {
  const beforeExecution = {
    ...context.baseManifest.context,
    runId: id(704),
    executionAttemptId: id(705),
    submissionId: id(706),
    sourceManifestSha256: "b".repeat(64),
  };
  const beforeEvidence = context.baseManifest.evidence.map(
    (evidence, index) => ({
      ...evidence,
      runId: beforeExecution.runId,
      executionAttemptId: beforeExecution.executionAttemptId,
      submissionId: beforeExecution.submissionId,
      sourceManifestSha256: beforeExecution.sourceManifestSha256,
      evidenceId: id(710 + index),
      manifestId: id(790),
      storageKey: `runs/${beforeExecution.runId}/${id(790)}/${id(710 + index)}.txt`,
    }),
  );
  const beforeManifest = await createArtifactManifest({
    manifestId: id(790),
    context: beforeExecution,
    source: "base",
    analysisAttemptId: null,
    operationId: null,
    evidence: beforeEvidence,
    completeness: "complete",
  });
  const beforeResults = context.baseResults.map((result, index) => ({
    ...result,
    evidenceIds: [id(710 + index)],
    executedSteps: result.executedSteps.map((step) => ({
      ...step,
      evidenceIds: [id(710 + index)],
    })),
  }));
  const actualFingerprint = {
    completeness: "complete" as const,
    values: fingerprint(context),
    missingFields: [],
  };
  const before: ComparisonEvidenceBundle = {
    studentId: id(800),
    taskId: context.rule.taskId,
    baseManifest: beforeManifest,
    supplementalManifests: [],
    caseResults: beforeResults,
    actualFingerprint,
  };
  const after: ComparisonEvidenceBundle = {
    studentId: id(800),
    taskId: context.rule.taskId,
    baseManifest: context.baseManifest,
    supplementalManifests: [],
    caseResults: context.baseResults,
    actualFingerprint: clone(actualFingerprint),
  };
  return { ...context, comparison: { before, after } };
}

describe("C3 feedback schema and deterministic fallback", () => {
  it("keeps model output unable to supply verdicts, run identities or publication authority", async () => {
    const { revision } = await reportFixture();
    expect(
      modelFeedbackDraftSchema.parse({ feedback: revision.feedback }).feedback,
    ).toHaveLength(2);
    for (const forbidden of [
      { verdict: "passed" },
      { ownerToken: "secret" },
      { runId: id(1) },
      { published: true },
    ]) {
      expect(() =>
        modelFeedbackDraftSchema.parse({
          feedback: revision.feedback,
          ...forbidden,
        }),
      ).toThrow();
      expect(() =>
        modelFeedbackDraftSchema.parse({
          feedback: [{ ...revision.feedback[0], ...forbidden }],
        }),
      ).toThrow();
    }
  });

  it("creates no-model feedback from actual observations and preserves unknown causes", async () => {
    const { context, revision } = await reportFixture("not_run");
    expect(
      revision.feedback.every(
        (item) =>
          item.reproductionSteps.length === 0 &&
          item.possibleCause === "" &&
          item.causeSupport === "insufficient",
      ),
    ).toBe(true);
    await expect(validateReportRevision(revision, context)).resolves.toEqual(
      revision,
    );
    const invented = clone(revision);
    invented.feedback[0].reproductionSteps = [
      {
        caseId: "NEW-01",
        stepId: "action:create-unique-task",
        description: "Pretend this planned operation happened",
      },
    ];
    await expect(validateReportRevision(invented, context)).rejects.toThrow(
      "REPRODUCTION_STEP_NOT_EXECUTED",
    );
  });

  it("marks fallback excerpts as bounded while preserving full base observations", async () => {
    const { context } = await reportFixture("not_run");
    context.baseResults[0].observed = "长".repeat(5000);
    const feedback = buildBaseFeedback(context.rule, context.baseResults);
    expect(feedback[0].observation).toContain("完整观察与实际步骤保留");
    expect(feedback[0].observation.length).toBeLessThanOrEqual(5000);
    expect(context.baseResults[0].observed).toHaveLength(5000);
  });
});

describe("C3 teacher judgments stay separate from automatic facts", () => {
  it("permits an independently documented not_run → failed override without rechecking original setup", async () => {
    const { context } = await reportFixture("not_run");
    const original = canonicalJson(context.baseResults);
    const results = deriveReviewedResults(context.rule, context.baseResults, [
      teacherJudgment("FILTER-03", "failed"),
    ]);
    expect(results.find((item) => item.criterionId === "filter")).toMatchObject(
      {
        automaticVerdict: "not_run",
        reviewedVerdict: "failed",
        cases: [
          {
            caseId: "FILTER-03",
            automaticVerdict: "not_run",
            reviewedVerdict: "failed",
          },
        ],
      },
    );
    expect(canonicalJson(context.baseResults)).toBe(original);
  });

  it("handles manual criteria and preserves automatic manual alongside teacher decisions", async () => {
    const { context } = await reportFixture("passed", true);
    const without = deriveReviewedResults(
      context.rule,
      context.baseResults,
      [],
    );
    expect(
      without.find((item) => item.criterionId === "readability")!
        .reviewedVerdict,
    ).toBe("manual");
    const judged = deriveReviewedResults(context.rule, context.baseResults, [
      teacherJudgment("readability", "passed", "manualCriterion"),
    ]);
    expect(
      judged.find((item) => item.criterionId === "readability"),
    ).toMatchObject({
      automaticVerdict: "manual",
      reviewedVerdict: "passed",
      cases: [],
      manualJudgmentId: id(300),
    });
    expect(() =>
      deriveReviewedResults(context.rule, context.baseResults, [
        teacherJudgment("create", "passed", "manualCriterion"),
      ]),
    ).toThrow("JUDGMENT_MANUAL_CRITERION_INVALID");
  });

  it("requires reasons, documented verification and unique enabled targets", async () => {
    const { context } = await reportFixture();
    const judgment = teacherJudgment("NEW-01", "failed");
    expect(() =>
      teacherJudgmentSchema.parse({ ...judgment, reason: "  " }),
    ).toThrow();
    expect(() =>
      teacherJudgmentSchema.parse({ ...judgment, verificationNote: "" }),
    ).toThrow("JUDGMENT_VERIFICATION_NOTE_REQUIRED");
    expect(() =>
      teacherJudgmentSchema.parse({
        ...judgment,
        verificationMethod: "evidence_review",
      }),
    ).toThrow("JUDGMENT_EVIDENCE_REQUIRED");
    expect(() =>
      deriveReviewedResults(context.rule, context.baseResults, [
        judgment,
        { ...judgment, judgmentId: id(301) },
      ]),
    ).toThrow("DUPLICATE_ID");
    expect(() =>
      deriveReviewedResults(context.rule, context.baseResults, [
        teacherJudgment("NEW-99", "failed"),
      ]),
    ).toThrow("JUDGMENT_CASE_NOT_ENABLED");
  });

  it("reports teacher changes separately, including changed reasoning with an unchanged verdict", async () => {
    const { revision } = await reportFixture();
    revision.teacherJudgments = [teacherJudgment("NEW-01", "failed")];
    const after = clone(revision);
    after.teacherJudgments[0].reason = "A different documented reason";
    expect(compareTeacherJudgments(revision, after)).toEqual([
      {
        targetType: "case",
        targetId: "NEW-01",
        before: "failed",
        after: "failed",
        changed: true,
      },
    ]);
    expect(revision.feedback).toEqual(after.feedback);
  });
});

describe("C3 feedback evidence provenance", () => {
  it("allows submission source as cause evidence without treating it as an executed observation",async()=>{
    const {context,revision}=await reportFixture();
    const source=await supplemental(context);
    source.evidence[0].scope="run";source.evidence[0].caseId=null;source.evidence[0].criterionId=null;
    const manifest=await createArtifactManifest(source);
    context.supplementalManifests=[manifest];
    revision.selectedSupplementalManifestIds=[manifest.manifestId];
    revision.feedback[0].possibleCause="根据实际源码片段提出原因假设";
    revision.feedback[0].causeSupport="direct";
    revision.feedback[0].causeEvidenceRefs=[ref(manifest)];
    await expect(validateReportRevision(revision,context)).resolves.toBeDefined();
    revision.feedback[0].observationEvidenceRefs=[ref(manifest)];
    await expect(validateReportRevision(revision,context)).rejects.toThrow("RUN_EVIDENCE_PURPOSE_INVALID");
  });
  it("rejects cross-case and unselected supplemental evidence even in the same run", async () => {
    const { context, revision } = await reportFixture();
    const crossCase = clone(revision);
    crossCase.feedback[0].observationEvidenceRefs.push(
      crossCase.feedback[1].observationEvidenceRefs[0],
    );
    await expect(validateReportRevision(crossCase, context)).rejects.toThrow(
      "EVIDENCE_SCOPE_MISMATCH",
    );
    const extra = await supplemental(context);
    context.supplementalManifests.push(extra);
    revision.feedback[0].observationEvidenceRefs.push(ref(extra));
    await expect(validateReportRevision(revision, context)).rejects.toThrow(
      "EVIDENCE_SCOPE_MISMATCH",
    );
    revision.selectedSupplementalManifestIds.push(extra.manifestId);
    await expect(validateReportRevision(revision, context)).resolves.toEqual(
      revision,
    );
  });

  it("does not promote browser observations into direct claims about source causes", async () => {
    const { context, revision } = await reportFixture("failed");
    revision.feedback[0].possibleCause =
      "Synthetic proposed internal condition";
    revision.feedback[0].causeSupport = "direct";
    revision.feedback[0].causeEvidenceRefs = [
      ...revision.feedback[0].observationEvidenceRefs,
    ];
    await expect(validateReportRevision(revision, context)).rejects.toThrow(
      "DIRECT_CAUSE_REQUIRES_SOURCE",
    );
    revision.feedback[0].causeSupport = "limited";
    await expect(validateReportRevision(revision, context)).resolves.toEqual(
      revision,
    );
    const source = await supplemental(context);
    context.supplementalManifests.push(source);
    revision.selectedSupplementalManifestIds.push(source.manifestId);
    revision.feedback[0].causeEvidenceRefs = [ref(source)];
    revision.feedback[0].causeSupport = "direct";
    await expect(validateReportRevision(revision, context)).resolves.toEqual(
      revision,
    );
  });

  it("allows build logs to explain unexecuted cases but not establish a functional teacher override", async () => {
    const { context, revision } = await reportFixture("not_run");
    const log = {
      ...context.baseManifest.evidence[0],
      scope: "run" as const,
      criterionId: null,
      caseId: null,
      phase: "build" as const,
      contentOrigin: "student_console" as const,
    };
    context.baseManifest = await createArtifactManifest({
      ...context.baseManifest,
      evidence: [log],
    });
    context.baseResults.forEach((result) => {
      result.evidenceIds = [log.evidenceId];
    });
    revision.feedback = buildBaseFeedback(
      context.rule,
      context.baseResults,
      context.baseManifest,
    );
    await expect(validateReportRevision(revision, context)).resolves.toEqual(
      revision,
    );
    revision.teacherJudgments = [
      {
        ...teacherJudgment("NEW-01", "failed"),
        verificationMethod: "evidence_review",
        evidenceRefs: [ref(context.baseManifest)],
      },
    ];
    await expect(validateReportRevision(revision, context)).rejects.toThrow(
      "RUN_EVIDENCE_PURPOSE_INVALID",
    );
    revision.teacherJudgments[0].verdict = "not_run";
    await expect(validateReportRevision(revision, context)).resolves.toEqual(
      revision,
    );
  });

  it("requires explicitly authorized and compatible before/after bundles for historical references", async () => {
    const { context, revision } = await reportFixture();
    const compared = await addComparison(context);
    revision.feedback[0].observationEvidenceRefs.push(
      ref(compared.comparison!.before.baseManifest, "comparison_before"),
    );
    await expect(validateReportRevision(revision, context)).rejects.toThrow(
      "EVIDENCE_SCOPE_MISMATCH",
    );
    await expect(validateReportRevision(revision, compared)).resolves.toEqual(
      revision,
    );
    const wrongStudent = clone(compared);
    wrongStudent.comparison!.before.studentId = id(899);
    await expect(
      validateReportRevision(revision, wrongStudent),
    ).rejects.toThrow("INCOMPATIBLE_MEASUREMENT");
    const changedEnvironment = clone(compared);
    changedEnvironment.comparison!.before.actualFingerprint.values.chromiumVersion =
      "different";
    await expect(
      validateReportRevision(revision, changedEnvironment),
    ).rejects.toThrow("INCOMPATIBLE_MEASUREMENT");
  });
});

describe("C3 content-bound confirmations", () => {
  it("confirmation accepts feedback content and does not turn an unresolved case into passed", async () => {
    const { context, revision } = await reportFixture("not_run");
    const confirmed = await confirmAll(revision, context);
    expect(await retainValidConfirmations(confirmed, context)).toHaveLength(2);
    expect(
      deriveReviewedResults(
        context.rule,
        context.baseResults,
        confirmed.teacherJudgments,
      ).every((item) => item.reviewedVerdict === "not_run"),
    ).toBe(true);
    await expect(
      assertPublishableRevision(confirmed, context),
    ).resolves.toEqual(confirmed);
  });

  it("invalidates only edited criterion confirmations and allows unrelated revision metadata to change", async () => {
    const { context, revision } = await reportFixture();
    const confirmed = await confirmAll(revision, context);
    const next = clone(confirmed);
    next.revisionId = id(201);
    next.revisionNo = 2;
    next.parentRevisionId = revision.revisionId;
    next.source = "teacher_edit";
    next.createdBy = id(3);
    expect(await retainValidConfirmations(next, context)).toHaveLength(2);
    next.feedback[0].nextStep = "New explicit advice changes this criterion";
    expect(
      (await retainValidConfirmations(next, context)).map(
        (confirmation) => confirmation.criterionId,
      ),
    ).toEqual(["filter"]);
    await expect(assertPublishableRevision(next, context)).rejects.toThrow(
      "CONFIRMATION_REQUIRED",
    );
  });

  it("covers teacher judgment content and newly selected evidence, including selections not yet cited in prose", async () => {
    const { context, revision } = await reportFixture("not_run");
    const confirmed = await confirmAll(revision, context);
    const changed = clone(confirmed);
    changed.teacherJudgments = [teacherJudgment("NEW-01", "passed")];
    expect(
      (await retainValidConfirmations(changed, context)).map(
        (entry) => entry.criterionId,
      ),
    ).toEqual(["filter"]);
    const extra = await supplemental(context);
    context.supplementalManifests.push(extra);
    confirmed.selectedSupplementalManifestIds.push(extra.manifestId);
    expect(
      (await retainValidConfirmations(confirmed, context)).map(
        (entry) => entry.criterionId,
      ),
    ).toEqual(["filter"]);
    expect(await hashCriterionContent("create", confirmed, context)).not.toBe(
      confirmed.confirmations[0].contentHash,
    );
  });

  it("binds original facts and requires new confirmation when entering a historical correction chain", async () => {
    const { context, revision } = await reportFixture();
    const confirmed = await confirmAll(revision, context);
    const changedFacts = clone(context);
    changedFacts.baseResults[0].verdict = "failed";
    changedFacts.baseResults[0].reasonCode = "ASSERTION_MISMATCH";
    expect(
      (await retainValidConfirmations(confirmed, changedFacts)).map(
        (entry) => entry.criterionId,
      ),
    ).toEqual(["filter"]);
    const correction = {
      ...confirmed,
      revisionId: id(201),
      revisionNo: 2,
      parentRevisionId: revision.revisionId,
      source: "historical_correction" as const,
      originPublicationId: id(900),
      createdBy: id(3),
    };
    expect(await retainValidConfirmations(correction, context)).toEqual([]);
  });

  it("publishes manual or not_run only with a reason and next step after fresh confirmation", async () => {
    const { context, revision } = await reportFixture("manual");
    revision.feedback[0].nextStep = "";
    const confirmed = await confirmAll(revision, context);
    await expect(assertPublishableRevision(confirmed, context)).rejects.toThrow(
      "UNRESOLVED_FEEDBACK_REQUIRED",
    );
    const untouched = await reportFixture();
    await expect(
      assertPublishableRevision(untouched.revision, untouched.context),
    ).rejects.toThrow("CONFIRMATION_REQUIRED");
  });
});

describe("C3 immutable publication snapshots and safe public catalogs", () => {
  it("freezes base facts, reviewed decisions and only explicitly selected evidence", async () => {
    const { context, revision } = await reportFixture("not_run");
    revision.teacherJudgments = [teacherJudgment("NEW-01", "failed")];
    const confirmed = await confirmAll(revision, context);
    const ids = await referencedEvidenceIds(confirmed, context);
    const snapshot = await createPublicationSnapshot(confirmed, context, ids);
    expect(snapshot.baseResults[0].verdict).toBe("not_run");
    expect(snapshot.reviewedResults[0]).toMatchObject({
      automaticVerdict: "not_run",
      reviewedVerdict: "failed",
    });
    await expect(
      validatePublicationSnapshot(snapshot, context),
    ).resolves.toEqual(snapshot);
    confirmed.feedback[0].observation = "A later unsaved mutation";
    expect(snapshot.revision.feedback[0].observation).not.toBe(
      confirmed.feedback[0].observation,
    );
    const changed = clone(snapshot);
    changed.baseResults[0].observed = "tampered";
    await expect(validatePublicationSnapshot(changed, context)).rejects.toThrow(
      "PUBLICATION_HASH_MISMATCH",
    );
  });

  it("refuses omitted cited evidence, unselected evidence, and internal diagnostics", async () => {
    const { context, revision } = await reportFixture();
    const diagnostic = await supplemental(context, "create", 1, "diagnostic");
    const unselected = await supplemental(context, "create", 2);
    context.supplementalManifests.push(diagnostic, unselected);
    revision.selectedSupplementalManifestIds.push(diagnostic.manifestId);
    const confirmed = await confirmAll(revision, context);
    const ids = await referencedEvidenceIds(confirmed, context);
    await expect(
      createPublicationSnapshot(confirmed, context, []),
    ).rejects.toThrow("REFERENCED_EVIDENCE_NOT_PUBLIC");
    await expect(
      createPublicationSnapshot(confirmed, context, [
        ...ids,
        unselected.evidence[0].evidenceId,
      ]),
    ).rejects.toThrow("PUBLIC_EVIDENCE_NOT_SELECTED");
    await expect(
      createPublicationSnapshot(confirmed, context, [
        ...ids,
        diagnostic.evidence[0].evidenceId,
      ]),
    ).rejects.toThrow("INTERNAL_EVIDENCE_NOT_PUBLIC");
  });

  it("rejects evidence ID collisions across manifests instead of ambiguously granting public access", async () => {
    const { context, revision } = await reportFixture();
    const extra = await supplemental(context);
    extra.evidence[0].evidenceId = context.baseManifest.evidence[0].evidenceId;
    const colliding = await createArtifactManifest(extra);
    context.supplementalManifests.push(colliding);
    revision.selectedSupplementalManifestIds.push(colliding.manifestId);
    await expect(validateReportRevision(revision, context)).rejects.toThrow(
      "EVIDENCE_ID_COLLISION",
    );
  });

  it("requires historical publication origin and a correction chain while keeping old snapshots unchanged", async () => {
    const { context, revision } = await reportFixture();
    const confirmed = await confirmAll(revision, context);
    const ids = await referencedEvidenceIds(confirmed, context);
    const snapshot = await createPublicationSnapshot(confirmed, context, ids);
    const initial = {
      contractVersion: 2 as const,
      publicationId: id(900),
      runId: revision.runId,
      publicationNo: 1,
      revisionId: revision.revisionId,
      supersedesPublicationId: null,
      purpose: "latest" as const,
      correctionReason: null,
      snapshot,
      publicEvidenceIds: ids,
      publishedBy: id(3),
      publishedAt: timestamp,
      idempotencyKey: "publish_synthetic_1",
    };
    expect(publicationSchema.parse(initial).publicationNo).toBe(1);
    expect(() =>
      publicationSchema.parse({ ...initial, publicationNo: 2 }),
    ).toThrow("LATEST_PUBLICATION_CHAIN_INVALID");
    const correction = await confirmAll(
      {
        ...confirmed,
        confirmations: [],
        revisionId: id(201),
        revisionNo: 2,
        parentRevisionId: revision.revisionId,
        source: "historical_correction" as const,
        originPublicationId: initial.publicationId,
        createdBy: id(3),
      },
      context,
    );
    const correctedSnapshot = await createPublicationSnapshot(
      correction,
      context,
      ids,
    );
    const second = {
      ...initial,
      publicationId: id(901),
      publicationNo: 2,
      revisionId: correction.revisionId,
      supersedesPublicationId: initial.publicationId,
      purpose: "historical_correction" as const,
      correctionReason: "Documented correction",
      snapshot: correctedSnapshot,
      idempotencyKey: "publish_synthetic_2",
    };
    expect(publicationSchema.parse(second).supersedesPublicationId).toBe(
      initial.publicationId,
    );
    expect(() =>
      publicationSchema.parse({ ...second, supersedesPublicationId: id(999) }),
    ).toThrow("CORRECTION_PUBLICATION_CHAIN_INVALID");
    expect(initial.snapshot.revision.originPublicationId).toBeNull();
  });
});
