import { z } from "zod";
import {
  aggregateResults,
  caseResultSchema,
  validateCaseResults,
  type CaseResult,
  type CriterionAggregate,
} from "./cases";
import {
  artifactManifestSchema,
  evidenceSchema,
  validateArtifactManifest,
  validateCaseEvidenceReferences,
  type ArtifactManifest,
  type Evidence,
} from "./evidence";
import { compareCaseResults, type ComparisonRun } from "./measurement";
import {
  businessIdSchema,
  canonicalJson,
  executionContextSchema,
  fail,
  lexicalCompare,
  refineWith,
  requireUnique,
  sha256,
  sha256Schema,
  utcDateTimeSchema,
  uuidSchema,
  verdictSchema,
} from "./primitives";
import {
  hashRuleSnapshot,
  ruleSnapshotSchema,
  validateRuleSnapshot,
  type RuleSnapshot,
} from "./task-packs";

export const evidenceRefSchema = z
  .object({
    scope: z.enum(["current", "comparison_before", "comparison_after"]),
    manifestId: uuidSchema,
    evidenceId: uuidSchema,
  })
  .strict();
export type EvidenceRef = z.infer<typeof evidenceRefSchema>;
export const reproductionStepSchema = z
  .object({
    caseId: businessIdSchema,
    stepId: businessIdSchema,
    description: z.string().trim().min(1).max(1000),
  })
  .strict();
export const feedbackItemSchema = z
  .object({
    criterionId: businessIdSchema,
    caseIds: z.array(businessIdSchema).max(64),
    observation: z.string().trim().min(1).max(5000),
    reproductionSteps: z.array(reproductionStepSchema).max(100),
    observationEvidenceRefs: z.array(evidenceRefSchema).max(200),
    possibleCause: z.string().trim().max(3000),
    causeSupport: z.enum(["direct", "limited", "insufficient"]),
    causeEvidenceRefs: z.array(evidenceRefSchema).max(200),
    nextStep: z.string().trim().max(3000),
    needsTeacherReview: z.boolean(),
  })
  .strict()
  .superRefine((feedback, ctx) =>
    refineWith(ctx, () => {
      requireUnique(feedback.caseIds, "feedback cases");
      requireUnique(
        feedback.reproductionSteps.map(
          (step) => `${step.caseId}:${step.stepId}`,
        ),
        "feedback reproduction steps",
      );
      requireUnique(
        feedback.observationEvidenceRefs.map(referenceKey),
        "observation references",
      );
      requireUnique(
        feedback.causeEvidenceRefs.map(referenceKey),
        "cause references",
      );
      if (
        !feedback.possibleCause &&
        (feedback.causeSupport !== "insufficient" ||
          feedback.causeEvidenceRefs.length)
      )
        fail("EMPTY_CAUSE_SUPPORT_INVALID", feedback.criterionId);
      if (
        feedback.causeSupport !== "insufficient" &&
        !feedback.causeEvidenceRefs.length
      )
        fail("CAUSE_EVIDENCE_REQUIRED", feedback.criterionId);
    }),
  );
export type FeedbackItem = z.infer<typeof feedbackItemSchema>;

/** This is the model's entire writable structure. IDs, decisions and authority are server-owned. */
export const modelFeedbackDraftSchema = z
  .object({ feedback: z.array(feedbackItemSchema).min(1).max(15) })
  .strict();

export const teacherJudgmentSchema = z
  .object({
    judgmentId: uuidSchema,
    targetType: z.enum(["case", "manualCriterion"]),
    targetId: businessIdSchema,
    verdict: verdictSchema,
    reason: z.string().trim().min(1).max(3000),
    verificationMethod: z.enum([
      "evidence_review",
      "manual_reproduction",
      "other_documented",
    ]),
    evidenceRefs: z.array(evidenceRefSchema).max(100),
    verificationNote: z.string().trim().max(3000),
    judgedBy: uuidSchema,
    judgedAt: utcDateTimeSchema,
  })
  .strict()
  .superRefine((judgment, ctx) =>
    refineWith(ctx, () => {
      requireUnique(
        judgment.evidenceRefs.map(referenceKey),
        "judgment evidence",
      );
      if (
        judgment.verificationMethod === "evidence_review" &&
        !judgment.evidenceRefs.length
      )
        fail("JUDGMENT_EVIDENCE_REQUIRED", judgment.targetId);
      if (
        (!judgment.evidenceRefs.length ||
          judgment.verificationMethod === "other_documented") &&
        !judgment.verificationNote
      )
        fail("JUDGMENT_VERIFICATION_NOTE_REQUIRED", judgment.targetId);
    }),
  );
export type TeacherJudgment = z.infer<typeof teacherJudgmentSchema>;
export const confirmationSchema = z
  .object({
    criterionId: businessIdSchema,
    contentHash: sha256Schema,
    confirmedBy: uuidSchema,
    confirmedAt: utcDateTimeSchema,
  })
  .strict();
export type Confirmation = z.infer<typeof confirmationSchema>;

export const reportRevisionSchema = z
  .object({
    contractVersion: z.literal(2),
    revisionId: uuidSchema,
    runId: uuidSchema,
    revisionNo: z.number().int().positive(),
    parentRevisionId: uuidSchema.nullable(),
    baseManifestId: uuidSchema,
    selectedSupplementalManifestIds: z.array(uuidSchema).max(50),
    feedback: z.array(feedbackItemSchema).min(1).max(15),
    teacherJudgments: z.array(teacherJudgmentSchema).max(80),
    confirmations: z.array(confirmationSchema).max(15),
    source: z.enum([
      "base",
      "model_adoption",
      "teacher_edit",
      "confirmation",
      "historical_correction",
    ]),
    originPublicationId: uuidSchema.nullable(),
    createdBy: uuidSchema.nullable(),
    createdAt: utcDateTimeSchema,
  })
  .strict()
  .superRefine((revision, ctx) =>
    refineWith(ctx, () => {
      requireUnique(
        revision.selectedSupplementalManifestIds,
        "selected supplemental manifests",
      );
      requireUnique(
        revision.feedback.map((item) => item.criterionId),
        "feedback criteria",
      );
      requireUnique(
        revision.teacherJudgments.map((judgment) => judgment.judgmentId),
        "teacher judgments",
      );
      requireUnique(
        revision.teacherJudgments.map(
          (judgment) => `${judgment.targetType}:${judgment.targetId}`,
        ),
        "teacher judgment targets",
      );
      requireUnique(
        revision.confirmations.map((item) => item.criterionId),
        "confirmations",
      );
      if (revision.revisionNo === 1 && revision.parentRevisionId !== null)
        fail("FIRST_REVISION_PARENT_INVALID", revision.revisionId);
      if (revision.revisionNo > 1 && revision.parentRevisionId === null)
        fail("REVISION_PARENT_REQUIRED", revision.revisionId);
      if (revision.parentRevisionId === revision.revisionId)
        fail("REVISION_SELF_PARENT", revision.revisionId);
      if (
        revision.source === "historical_correction" &&
        revision.originPublicationId === null
      )
        fail("CORRECTION_ORIGIN_REQUIRED", revision.revisionId);
      if (
        ["teacher_edit", "confirmation", "historical_correction"].includes(
          revision.source,
        ) &&
        revision.createdBy === null
      )
        fail("REVISION_AUTHOR_REQUIRED", revision.revisionId);
    }),
  );
export type ReportRevision = z.infer<typeof reportRevisionSchema>;

const aggregateSchema = z
  .object({
    criterionId: businessIdSchema,
    verdict: verdictSchema,
    failedCaseIds: z.array(businessIdSchema).max(64),
    notRunCaseIds: z.array(businessIdSchema).max(64),
    manualCaseIds: z.array(businessIdSchema).max(64),
    passedCaseIds: z.array(businessIdSchema).max(64),
  })
  .strict();
export const reviewedCriterionResultSchema = z
  .object({
    criterionId: businessIdSchema,
    automaticVerdict: verdictSchema,
    reviewedVerdict: verdictSchema,
    automatic: aggregateSchema,
    reviewed: aggregateSchema,
    cases: z
      .array(
        z
          .object({
            caseId: businessIdSchema,
            automaticVerdict: verdictSchema,
            reviewedVerdict: verdictSchema,
            judgmentId: uuidSchema.nullable(),
          })
          .strict(),
      )
      .max(64),
    manualJudgmentId: uuidSchema.nullable(),
  })
  .strict();
export type ReviewedCriterionResult = z.infer<
  typeof reviewedCriterionResultSchema
>;

function validateJudgmentTargets(
  rule: RuleSnapshot,
  judgmentsValue: unknown,
): TeacherJudgment[] {
  const judgments = z
    .array(teacherJudgmentSchema)
    .max(80)
    .parse(judgmentsValue);
  requireUnique(
    judgments.map((judgment) => judgment.judgmentId),
    "judgment IDs",
  );
  requireUnique(
    judgments.map((judgment) => `${judgment.targetType}:${judgment.targetId}`),
    "judgment targets",
  );
  for (const judgment of judgments) {
    if (
      judgment.targetType === "case" &&
      !rule.requiredCaseIds.includes(judgment.targetId)
    )
      fail("JUDGMENT_CASE_NOT_ENABLED", judgment.targetId);
    if (
      judgment.targetType === "manualCriterion" &&
      (!rule.enabledCriterionIds.includes(judgment.targetId) ||
        !rule.packManifest.criteria.some(
          (criterion) =>
            criterion.criterionId === judgment.targetId &&
            criterion.mode === "manual",
        ))
    )
      fail("JUDGMENT_MANUAL_CRITERION_INVALID", judgment.targetId);
  }
  return judgments;
}

function aggregateReviewed(
  criterionId: string,
  entries: { caseId: string; verdict: CaseResult["verdict"] }[],
): CriterionAggregate {
  const group = (verdict: CaseResult["verdict"]) =>
    entries
      .filter((entry) => entry.verdict === verdict)
      .map((entry) => entry.caseId)
      .sort(lexicalCompare);
  const groups = {
    failedCaseIds: group("failed"),
    notRunCaseIds: group("not_run"),
    manualCaseIds: group("manual"),
    passedCaseIds: group("passed"),
  };
  return {
    criterionId,
    verdict: groups.failedCaseIds.length
      ? "failed"
      : groups.notRunCaseIds.length
        ? "not_run"
        : groups.manualCaseIds.length
          ? "manual"
          : entries.length
            ? "passed"
            : "manual",
    ...groups,
  };
}

/** Review aggregates judgments; it never mutates facts or re-applies automatic setup preconditions to teacher findings. */
export function deriveReviewedResults(
  rule: RuleSnapshot,
  baseResults: CaseResult[],
  judgmentsValue: TeacherJudgment[],
): ReviewedCriterionResult[] {
  const automatic = aggregateResults(rule, baseResults);
  const judgments = validateJudgmentTargets(rule, judgmentsValue);
  return automatic.map((original) => {
    const criterion = rule.packManifest.criteria.find(
      (entry) => entry.criterionId === original.criterionId,
    )!;
    const cases = baseResults
      .filter((entry) => entry.criterionId === original.criterionId)
      .map((result) => {
        const judgment = judgments.find(
          (entry) =>
            entry.targetType === "case" && entry.targetId === result.caseId,
        );
        return {
          caseId: result.caseId,
          automaticVerdict: result.verdict,
          reviewedVerdict: judgment?.verdict ?? result.verdict,
          judgmentId: judgment?.judgmentId ?? null,
        };
      });
    const manualJudgment = judgments.find(
      (entry) =>
        entry.targetType === "manualCriterion" &&
        entry.targetId === original.criterionId,
    );
    const reviewed =
      criterion.mode === "manual"
        ? {
            ...original,
            verdict: manualJudgment?.verdict ?? ("manual" as const),
          }
        : aggregateReviewed(
            original.criterionId,
            cases.map((entry) => ({
              caseId: entry.caseId,
              verdict: entry.reviewedVerdict,
            })),
          );
    return {
      criterionId: original.criterionId,
      automaticVerdict: original.verdict,
      reviewedVerdict: reviewed.verdict,
      automatic: original,
      reviewed,
      cases,
      manualJudgmentId: manualJudgment?.judgmentId ?? null,
    };
  });
}

/** Bundles are selected and authorized by the business service, never supplied by the model. */
export interface ComparisonEvidenceBundle {
  studentId: string;
  taskId: string;
  baseManifest: ArtifactManifest;
  supplementalManifests: ArtifactManifest[];
  caseResults: CaseResult[];
  actualFingerprint: ComparisonRun["actualFingerprint"];
}
export interface ReportValidationContext {
  rule: RuleSnapshot;
  baseResults: CaseResult[];
  baseManifest: ArtifactManifest;
  supplementalManifests: ArtifactManifest[];
  comparison?: {
    before: ComparisonEvidenceBundle;
    after: ComparisonEvidenceBundle;
  };
}
type IndexedEvidence = {
  evidence: Evidence;
  manifest: ArtifactManifest;
  scope: EvidenceRef["scope"];
  caseResults: CaseResult[];
};
interface PreparedReport {
  revision: ReportRevision;
  context: ReportValidationContext;
  refs: Map<string, IndexedEvidence>;
  selectedCurrentManifests: ArtifactManifest[];
}
function referenceKey(ref: EvidenceRef): string {
  return `${ref.scope}:${ref.manifestId}:${ref.evidenceId}`;
}
function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return (
    canonicalJson([...a].sort(lexicalCompare)) ===
    canonicalJson([...b].sort(lexicalCompare))
  );
}

function findReference(
  ref: EvidenceRef,
  prepared: PreparedReport,
  criterionId: string,
  caseIds: string[],
  purpose: "observation" | "cause" | "judgment",
  judgmentVerdict?: CaseResult["verdict"],
): IndexedEvidence {
  const indexed = prepared.refs.get(referenceKey(ref));
  if (!indexed) fail("EVIDENCE_SCOPE_MISMATCH", referenceKey(ref));
  const evidence = indexed.evidence;
  if (
    evidence.scope === "case" &&
    (evidence.criterionId !== criterionId ||
      !caseIds.includes(evidence.caseId!))
  )
    fail("EVIDENCE_SCOPE_MISMATCH", evidence.evidenceId);
  if (evidence.scope === "run") {
    // A verified source excerpt belongs to the submission, not an invented executed case.
    // It may support a cause hypothesis; it is never proof of observed browser behavior.
    if (purpose === "cause" && evidence.phase === "source_excerpt" &&
        evidence.collector === "business_extractor" && evidence.contentOrigin === "student_source") return indexed;
    // A build log can explain an unexecuted case; it cannot establish a functional diagnosis.
    const targets = indexed.caseResults.filter((result) =>
      caseIds.includes(result.caseId),
    );
    if (
      purpose === "cause" ||
      (purpose === "judgment" && judgmentVerdict !== "not_run") ||
      !targets.length ||
      targets.some((result) => result.verdict !== "not_run") ||
      evidence.phase !== "build"
    )
      fail("RUN_EVIDENCE_PURPOSE_INVALID", evidence.evidenceId);
  }
  return indexed;
}

async function prepareReport(
  value: unknown,
  contextValue: ReportValidationContext,
): Promise<PreparedReport> {
  const revision = reportRevisionSchema.parse(value);
  const rule = await validateRuleSnapshot(contextValue.rule);
  const results = validateCaseResults(rule, contextValue.baseResults);
  const base = artifactManifestSchema.parse(contextValue.baseManifest);
  if (
    base.source !== "base" ||
    revision.baseManifestId !== base.manifestId ||
    revision.runId !== base.context.runId
  )
    fail("REVISION_BASE_MISMATCH", revision.revisionId);
  if (
    base.context.ruleId !== rule.ruleId ||
    base.context.ruleHash !== (await hashRuleSnapshot(rule)) ||
    base.context.packManifestHash !== rule.packManifestHash ||
    base.context.templateHash !== rule.packManifest.templateHash
  )
    fail("REVISION_RULE_MISMATCH", revision.revisionId);
  await validateArtifactManifest(base, { rule, expectedContext: base.context });
  validateCaseEvidenceReferences(results, base);
  requireUnique(
    contextValue.supplementalManifests.map((manifest) => manifest.manifestId),
    "available supplemental manifests",
  );
  const selected = revision.selectedSupplementalManifestIds.map(
    (manifestId) => {
      const manifest = contextValue.supplementalManifests.find(
        (item) => item.manifestId === manifestId,
      );
      if (!manifest || manifest.source !== "supplemental")
        fail("SUPPLEMENTAL_MANIFEST_NOT_SELECTED", manifestId);
      return manifest;
    },
  );
  for (const manifest of selected)
    await validateArtifactManifest(manifest, {
      rule,
      expectedContext: base.context,
    });
  const context = {
    ...contextValue,
    rule,
    baseResults: results,
    baseManifest: base,
  };
  const prepared: PreparedReport = {
    revision,
    context,
    refs: new Map(),
    selectedCurrentManifests: [base, ...selected],
  };
  const globalIds = new Map<string, { manifestId: string; evidence: string }>();
  const globalManifests = new Map<string, string>();
  const index = (
    scope: EvidenceRef["scope"],
    manifests: ArtifactManifest[],
    caseResults: CaseResult[],
  ) => {
    for (const manifest of manifests) {
      const priorHash = globalManifests.get(manifest.manifestId);
      if (priorHash && priorHash !== manifest.contentHash)
        fail("MANIFEST_ID_COLLISION", manifest.manifestId);
      globalManifests.set(manifest.manifestId, manifest.contentHash);
      for (const evidence of manifest.evidence) {
        const previous = globalIds.get(evidence.evidenceId);
        const encoded = canonicalJson(evidence);
        if (
          previous &&
          (previous.manifestId !== manifest.manifestId ||
            previous.evidence !== encoded)
        )
          fail("EVIDENCE_ID_COLLISION", evidence.evidenceId);
        globalIds.set(evidence.evidenceId, {
          manifestId: manifest.manifestId,
          evidence: encoded,
        });
        prepared.refs.set(
          referenceKey({
            scope,
            manifestId: manifest.manifestId,
            evidenceId: evidence.evidenceId,
          }),
          { scope, manifest, evidence, caseResults },
        );
      }
    }
  };
  index("current", prepared.selectedCurrentManifests, results);
  if (context.comparison) {
    const { before, after } = context.comparison;
    const asRun = (bundle: ComparisonEvidenceBundle): ComparisonRun => ({
      contractVersion: 2,
      studentId: bundle.studentId,
      taskId: bundle.taskId,
      ruleId: bundle.baseManifest.context.ruleId,
      actualFingerprint: bundle.actualFingerprint,
      caseResults: bundle.caseResults,
    });
    if (
      after.baseManifest.context.runId !== base.context.runId ||
      after.baseManifest.manifestId !== base.manifestId ||
      before.baseManifest.context.runId === after.baseManifest.context.runId ||
      after.taskId !== rule.taskId
    )
      fail("COMPARISON_SCOPE_MISMATCH", revision.runId);
    const comparison = compareCaseResults(asRun(before), asRun(after));
    if (comparison.status !== "compatible")
      fail("INCOMPATIBLE_MEASUREMENT", comparison.reasonCode);
    if (canonicalJson(after.caseResults) !== canonicalJson(results))
      fail("COMPARISON_CURRENT_RESULTS_MISMATCH", revision.runId);
    for (const [scope, bundle] of [
      ["comparison_before", before],
      ["comparison_after", after],
    ] as const) {
      validateCaseResults(rule, bundle.caseResults);
      if (
        bundle.baseManifest.source !== "base" ||
        bundle.baseManifest.context.ruleHash !== base.context.ruleHash ||
        bundle.baseManifest.context.packManifestHash !==
          base.context.packManifestHash
      )
        fail("COMPARISON_RULE_MISMATCH", scope);
      const manifests = [bundle.baseManifest, ...bundle.supplementalManifests];
      requireUnique(
        manifests.map((manifest) => manifest.manifestId),
        "comparison manifests",
      );
      for (const manifest of manifests) {
        if (
          scope === "comparison_after" &&
          !prepared.selectedCurrentManifests.some(
            (selectedManifest) =>
              selectedManifest.manifestId === manifest.manifestId,
          )
        )
          fail("SUPPLEMENTAL_MANIFEST_NOT_SELECTED", manifest.manifestId);
        await validateArtifactManifest(manifest, {
          rule,
          expectedContext: bundle.baseManifest.context,
        });
      }
      validateCaseEvidenceReferences(bundle.caseResults, bundle.baseManifest);
      index(scope, manifests, bundle.caseResults);
    }
  }
  if (
    !sameSet(
      rule.enabledCriterionIds,
      revision.feedback.map((item) => item.criterionId),
    )
  )
    fail("FEEDBACK_CRITERION_SET_MISMATCH", revision.revisionId);
  for (const feedback of revision.feedback) {
    const criterionCases = results.filter(
      (result) => result.criterionId === feedback.criterionId,
    );
    if (
      !sameSet(
        criterionCases.map((result) => result.caseId),
        feedback.caseIds,
      )
    )
      fail("FEEDBACK_CASE_SET_MISMATCH", feedback.criterionId);
    for (const step of feedback.reproductionSteps)
      if (
        !criterionCases.some(
          (result) =>
            result.caseId === step.caseId &&
            result.executedSteps.some(
              (actual) => actual.stepId === step.stepId,
            ),
        )
      )
        fail("REPRODUCTION_STEP_NOT_EXECUTED", `${step.caseId}:${step.stepId}`);
    for (const ref of feedback.observationEvidenceRefs)
      findReference(
        ref,
        prepared,
        feedback.criterionId,
        feedback.caseIds,
        "observation",
      );
    const causes = feedback.causeEvidenceRefs.map((ref) =>
      findReference(
        ref,
        prepared,
        feedback.criterionId,
        feedback.caseIds,
        "cause",
      ),
    );
    if (
      feedback.causeSupport === "direct" &&
      !causes.some(
        ({ evidence }) =>
          evidence.phase === "source_excerpt" &&
          evidence.contentOrigin === "student_source",
      )
    )
      fail("DIRECT_CAUSE_REQUIRES_SOURCE", feedback.criterionId);
  }
  const judgments = validateJudgmentTargets(rule, revision.teacherJudgments);
  for (const judgment of judgments) {
    const criterionId =
      judgment.targetType === "manualCriterion"
        ? judgment.targetId
        : results.find((result) => result.caseId === judgment.targetId)!
            .criterionId;
    for (const ref of judgment.evidenceRefs)
      findReference(
        ref,
        prepared,
        criterionId,
        judgment.targetType === "case" ? [judgment.targetId] : [],
        "judgment",
        judgment.verdict,
      );
  }
  for (const confirmation of revision.confirmations)
    if (!rule.enabledCriterionIds.includes(confirmation.criterionId))
      fail("CONFIRMATION_CRITERION_INVALID", confirmation.criterionId);
  return prepared;
}

export async function validateReportRevision(
  revision: unknown,
  context: ReportValidationContext,
): Promise<ReportRevision> {
  return (await prepareReport(revision, context)).revision;
}

function judgmentsForCriterion(
  prepared: PreparedReport,
  criterionId: string,
): TeacherJudgment[] {
  const cases = prepared.context.baseResults
    .filter((result) => result.criterionId === criterionId)
    .map((result) => result.caseId);
  return prepared.revision.teacherJudgments
    .filter((judgment) =>
      judgment.targetType === "manualCriterion"
        ? judgment.targetId === criterionId
        : cases.includes(judgment.targetId),
    )
    .sort((a, b) =>
      lexicalCompare(
        `${a.targetType}:${a.targetId}`,
        `${b.targetType}:${b.targetId}`,
      ),
    );
}

async function criterionHash(
  criterionId: string,
  prepared: PreparedReport,
): Promise<string> {
  const feedback = prepared.revision.feedback.find(
    (item) => item.criterionId === criterionId,
  );
  if (!feedback) fail("UNKNOWN_CRITERION", criterionId);
  const judgments = judgmentsForCriterion(prepared, criterionId);
  const selected = new Map<string, IndexedEvidence>();
  // Selecting new material for this criterion invalidates its confirmation, even if prose stays unchanged.
  for (const manifest of prepared.selectedCurrentManifests)
    for (const evidence of manifest.evidence)
      if (evidence.scope === "case" && evidence.criterionId === criterionId) {
        const ref: EvidenceRef = {
          scope: "current",
          manifestId: manifest.manifestId,
          evidenceId: evidence.evidenceId,
        };
        selected.set(referenceKey(ref), prepared.refs.get(referenceKey(ref))!);
      }
  const refs = [
    ...feedback.observationEvidenceRefs,
    ...feedback.causeEvidenceRefs,
    ...judgments.flatMap((judgment) => judgment.evidenceRefs),
  ];
  for (const ref of refs)
    selected.set(referenceKey(ref), prepared.refs.get(referenceKey(ref))!);
  const normalizeRefs = (values: EvidenceRef[]) =>
    [...values].sort((a, b) =>
      lexicalCompare(referenceKey(a), referenceKey(b)),
    );
  return sha256(
    canonicalJson({
      algorithmVersion: "criterion-content-v1",
      runId: prepared.revision.runId,
      baseManifestId: prepared.revision.baseManifestId,
      originPublicationId: prepared.revision.originPublicationId,
      ruleHash: prepared.context.baseManifest.context.ruleHash,
      criterionId,
      automaticCases: prepared.context.baseResults
        .filter((result) => result.criterionId === criterionId)
        .sort((a, b) => lexicalCompare(a.caseId, b.caseId)),
      feedback: {
        ...feedback,
        caseIds: [...feedback.caseIds].sort(lexicalCompare),
        observationEvidenceRefs: normalizeRefs(
          feedback.observationEvidenceRefs,
        ),
        causeEvidenceRefs: normalizeRefs(feedback.causeEvidenceRefs),
      },
      judgments: judgments.map((judgment) => ({
        ...judgment,
        evidenceRefs: normalizeRefs(judgment.evidenceRefs),
      })),
      selectedEvidence: [...selected.entries()]
        .sort(([a], [b]) => lexicalCompare(a, b))
        .map(([ref, indexed]) => ({
          ref,
          manifestContentHash: indexed.manifest.contentHash,
          evidence: indexed.evidence,
        })),
    }),
  );
}

export async function hashCriterionContent(
  criterionId: string,
  revision: ReportRevision,
  context: ReportValidationContext,
): Promise<string> {
  return criterionHash(criterionId, await prepareReport(revision, context));
}

export async function retainValidConfirmations(
  revision: ReportRevision,
  context: ReportValidationContext,
): Promise<Confirmation[]> {
  const prepared = await prepareReport(revision, context);
  const valid: Confirmation[] = [];
  for (const confirmation of prepared.revision.confirmations)
    if (
      confirmation.contentHash ===
      (await criterionHash(confirmation.criterionId, prepared))
    )
      valid.push(confirmation);
  return valid;
}

export async function confirmCriterion(
  revision: ReportRevision,
  criterionId: string,
  actor: { confirmedBy: string; confirmedAt: string },
  context: ReportValidationContext,
): Promise<Confirmation> {
  const prepared = await prepareReport(revision, context);
  return confirmationSchema.parse({
    criterionId,
    contentHash: await criterionHash(criterionId, prepared),
    ...actor,
  });
}

/** Fallback uses sealed observations only and makes no guess about internal causes. */
export function buildBaseFeedback(
  rule: RuleSnapshot,
  baseResults: CaseResult[],
  baseManifest?: ArtifactManifest,
): FeedbackItem[] {
  const results = validateCaseResults(rule, baseResults);
  const aggregates = aggregateResults(rule, results);
  const labels = {
    passed: "已满足",
    failed: "未满足",
    manual: "待人工判断",
    not_run: "未执行",
  };
  return aggregates.map((aggregate) => {
    const cases = results.filter(
      (result) => result.criterionId === aggregate.criterionId,
    );
    const references = new Map<string, EvidenceRef>();
    if (baseManifest)
      for (const result of cases)
        for (const evidenceId of result.evidenceIds) {
          const evidence = baseManifest.evidence.find(
            (entry) => entry.evidenceId === evidenceId,
          );
          if (
            evidence &&
            evidence.phase !== "diagnostic" &&
            (evidence.scope === "case" ||
              (cases.every((entry) => entry.verdict === "not_run") &&
                evidence.phase === "build"))
          ) {
            const ref: EvidenceRef = {
              scope: "current",
              manifestId: baseManifest.manifestId,
              evidenceId,
            };
            references.set(referenceKey(ref), ref);
          }
        }
    const perCaseBudget = Math.max(
      1,
      Math.floor(4000 / Math.max(1, cases.length)) - 160,
    );
    const abbreviated = cases.some(
      (result) => result.observed.length > perCaseBudget,
    );
    let observation = cases.length
      ? cases
          .map(
            (result) =>
              `${result.caseId}：原始检查${labels[result.verdict]}。${result.observed.slice(0, perCaseBudget)}${result.observed.length > perCaseBudget ? "…" : ""}`,
          )
          .join("\n")
      : "本条目由教师人工检查，不提供自动检查结论。教师判断与核实记录单独列出。";
    const allSteps = cases.flatMap((result) =>
      result.executedSteps.map((step) => ({
        caseId: result.caseId,
        stepId: step.stepId,
        description:
          step.observation.trim().slice(0, 1000) ||
          "该步骤已开始，原始记录没有可用的文字说明。",
      })),
    );
    const steps = allSteps.slice(0, 100);
    if (
      abbreviated ||
      allSteps.length > steps.length ||
      observation.length > 4500
    )
      observation =
        observation.slice(0, 4500) +
        "\n此处为有界摘要；完整观察与实际步骤保留在原始案例结果中。";
    return feedbackItemSchema.parse({
      criterionId: aggregate.criterionId,
      caseIds: cases.map((result) => result.caseId),
      observation,
      reproductionSteps: steps,
      observationEvidenceRefs: [...references.values()],
      possibleCause: "",
      causeSupport: "insufficient",
      causeEvidenceRefs: [],
      nextStep:
        aggregate.verdict === "passed"
          ? ""
          : aggregate.verdict === "failed"
            ? "对照本次实际观察与公开要求修改，再显式提交一次新检查。"
            : aggregate.verdict === "not_run"
              ? "先查明未执行原因；恢复检查条件后显式重试，或由教师独立复现并记录判断。"
              : "结合公开要求和本报告中的教师判断处理；依据不足时联系教师补充核实。",
      needsTeacherReview: aggregate.verdict !== "passed",
    });
  });
}

export async function assertPublishableRevision(
  revision: ReportRevision,
  context: ReportValidationContext,
): Promise<ReportRevision> {
  const prepared = await prepareReport(revision, context);
  for (const criterionId of context.rule.enabledCriterionIds) {
    const confirmation = prepared.revision.confirmations.find(
      (item) => item.criterionId === criterionId,
    );
    if (
      !confirmation ||
      confirmation.contentHash !== (await criterionHash(criterionId, prepared))
    )
      fail("CONFIRMATION_REQUIRED", criterionId);
  }
  for (const result of deriveReviewedResults(
    context.rule,
    context.baseResults,
    prepared.revision.teacherJudgments,
  ))
    if (
      result.reviewedVerdict === "manual" ||
      result.reviewedVerdict === "not_run"
    ) {
      const feedback = prepared.revision.feedback.find(
        (item) => item.criterionId === result.criterionId,
      )!;
      if (!feedback.observation.trim() || !feedback.nextStep.trim())
        fail("UNRESOLVED_FEEDBACK_REQUIRED", result.criterionId);
    }
  return prepared.revision;
}

export const publicationSnapshotSchema = z
  .object({
    contractVersion: z.literal(2),
    hashAlgorithm: z.literal("canonical-json-v1"),
    contentHash: sha256Schema,
    baseContext: executionContextSchema,
    ruleSnapshot: ruleSnapshotSchema,
    revision: reportRevisionSchema,
    baseResults: z.array(caseResultSchema).max(64),
    reviewedResults: z.array(reviewedCriterionResultSchema).min(1).max(15),
    publicEvidence: z.array(evidenceSchema).max(400),
  })
  .strict()
  .superRefine((snapshot, ctx) =>
    refineWith(ctx, () => {
      requireUnique(
        snapshot.publicEvidence.map((evidence) => evidence.evidenceId),
        "public evidence",
      );
      if (snapshot.revision.runId !== snapshot.baseContext.runId)
        fail("SNAPSHOT_RUN_MISMATCH", snapshot.revision.runId);
      if (
        snapshot.publicEvidence.some(
          (evidence) =>
            evidence.phase === "diagnostic" ||
            evidence.contentOrigin === "platform_diagnostic",
        )
      )
        fail("INTERNAL_EVIDENCE_NOT_PUBLIC", snapshot.revision.runId);
    }),
  );
export type PublicationSnapshot = z.infer<typeof publicationSnapshotSchema>;

export async function hashPublicationSnapshot(
  snapshot: Omit<PublicationSnapshot, "contentHash"> | PublicationSnapshot,
): Promise<string> {
  const { contentHash: _self, ...body } = snapshot as PublicationSnapshot;
  // Snapshot arrays are persisted in display order; only the evidence catalog is a set.
  return sha256(
    canonicalJson({
      ...body,
      publicEvidence: [...body.publicEvidence].sort((a, b) =>
        lexicalCompare(a.evidenceId, b.evidenceId),
      ),
    }),
  );
}

export async function referencedEvidenceIds(
  revision: ReportRevision,
  context: ReportValidationContext,
): Promise<string[]> {
  const prepared = await prepareReport(revision, context);
  return [
    ...new Set(
      [
        ...prepared.revision.feedback.flatMap((feedback) => [
          ...feedback.observationEvidenceRefs,
          ...feedback.causeEvidenceRefs,
        ]),
        ...prepared.revision.teacherJudgments.flatMap(
          (judgment) => judgment.evidenceRefs,
        ),
      ].map((ref) => ref.evidenceId),
    ),
  ].sort(lexicalCompare);
}

export async function createPublicationSnapshot(
  revisionValue: ReportRevision,
  context: ReportValidationContext,
  publicEvidenceIds: string[],
): Promise<PublicationSnapshot> {
  const revision = await assertPublishableRevision(revisionValue, context);
  const prepared = await prepareReport(revision, context);
  z.array(uuidSchema).max(400).parse(publicEvidenceIds);
  requireUnique(publicEvidenceIds, "public evidence IDs");
  const required = await referencedEvidenceIds(revision, context);
  for (const id of required)
    if (!publicEvidenceIds.includes(id))
      fail("REFERENCED_EVIDENCE_NOT_PUBLIC", id);
  const publicEvidence = publicEvidenceIds.map((id) => {
    const item = [...prepared.refs.values()].find(
      (entry) => entry.evidence.evidenceId === id,
    );
    if (!item) fail("PUBLIC_EVIDENCE_NOT_SELECTED", id);
    if (
      item.evidence.phase === "diagnostic" ||
      item.evidence.contentOrigin === "platform_diagnostic"
    )
      fail("INTERNAL_EVIDENCE_NOT_PUBLIC", id);
    return item.evidence;
  });
  const body: Omit<PublicationSnapshot, "contentHash"> = {
    contractVersion: 2,
    hashAlgorithm: "canonical-json-v1",
    baseContext: context.baseManifest.context,
    ruleSnapshot: context.rule,
    revision,
    baseResults: context.baseResults,
    reviewedResults: deriveReviewedResults(
      context.rule,
      context.baseResults,
      revision.teacherJudgments,
    ),
    publicEvidence,
  };
  return publicationSnapshotSchema.parse({
    ...body,
    contentHash: await hashPublicationSnapshot(body),
  });
}

export async function validatePublicationSnapshot(
  value: unknown,
  context: ReportValidationContext,
): Promise<PublicationSnapshot> {
  const snapshot = publicationSnapshotSchema.parse(value);
  if ((await hashPublicationSnapshot(snapshot)) !== snapshot.contentHash)
    fail("PUBLICATION_HASH_MISMATCH", snapshot.revision.revisionId);
  const expected = await createPublicationSnapshot(
    snapshot.revision,
    context,
    snapshot.publicEvidence.map((evidence) => evidence.evidenceId),
  );
  if (expected.contentHash !== snapshot.contentHash)
    fail("PUBLICATION_CONTEXT_MISMATCH", snapshot.revision.revisionId);
  return snapshot;
}

export const publicationSchema = z
  .object({
    contractVersion: z.literal(2),
    publicationId: uuidSchema,
    runId: uuidSchema,
    publicationNo: z.number().int().positive(),
    revisionId: uuidSchema,
    supersedesPublicationId: uuidSchema.nullable(),
    purpose: z.enum(["latest", "historical_correction"]),
    correctionReason: z.string().trim().min(1).max(3000).nullable(),
    snapshot: publicationSnapshotSchema,
    publicEvidenceIds: z.array(uuidSchema).max(400),
    publishedBy: uuidSchema,
    publishedAt: utcDateTimeSchema,
    idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/),
  })
  .strict()
  .superRefine((publication, ctx) =>
    refineWith(ctx, () => {
      requireUnique(publication.publicEvidenceIds, "publication evidence IDs");
      if (
        publication.runId !== publication.snapshot.revision.runId ||
        publication.revisionId !== publication.snapshot.revision.revisionId
      )
        fail("PUBLICATION_REVISION_MISMATCH", publication.publicationId);
      if (
        !sameSet(
          publication.publicEvidenceIds,
          publication.snapshot.publicEvidence.map(
            (evidence) => evidence.evidenceId,
          ),
        )
      )
        fail("PUBLIC_EVIDENCE_SET_MISMATCH", publication.publicationId);
      if (
        publication.purpose === "latest" &&
        (publication.publicationNo !== 1 ||
          publication.supersedesPublicationId !== null ||
          publication.correctionReason !== null ||
          publication.snapshot.revision.originPublicationId !== null)
      )
        fail("LATEST_PUBLICATION_CHAIN_INVALID", publication.publicationId);
      if (
        publication.purpose === "historical_correction" &&
        (publication.publicationNo < 2 ||
          publication.supersedesPublicationId === null ||
          publication.correctionReason === null ||
          publication.snapshot.revision.originPublicationId !==
            publication.supersedesPublicationId)
      )
        fail("CORRECTION_PUBLICATION_CHAIN_INVALID", publication.publicationId);
    }),
  );
export type Publication = z.infer<typeof publicationSchema>;

export function compareTeacherJudgments(
  before: ReportRevision,
  after: ReportRevision,
): {
  targetType: TeacherJudgment["targetType"];
  targetId: string;
  before: CaseResult["verdict"] | null;
  after: CaseResult["verdict"] | null;
  changed: boolean;
}[] {
  const a = reportRevisionSchema.parse(before);
  const b = reportRevisionSchema.parse(after);
  const keys = [
    ...new Set(
      [...a.teacherJudgments, ...b.teacherJudgments].map(
        (judgment) => `${judgment.targetType}:${judgment.targetId}`,
      ),
    ),
  ].sort(lexicalCompare);
  return keys.map((key) => {
    const prior = a.teacherJudgments.find(
      (judgment) => `${judgment.targetType}:${judgment.targetId}` === key,
    );
    const current = b.teacherJudgments.find(
      (judgment) => `${judgment.targetType}:${judgment.targetId}` === key,
    );
    const target = current ?? prior!;
    return {
      targetType: target.targetType,
      targetId: target.targetId,
      before: prior?.verdict ?? null,
      after: current?.verdict ?? null,
      changed: canonicalJson(prior ?? null) !== canonicalJson(current ?? null),
    };
  });
}
