import { z } from "zod";
import {
  businessIdSchema,
  canonicalJson,
  fail,
  lexicalCompare,
  reasonCodeSchema,
  refineWith,
  requireUnique,
  utcDateTimeSchema,
  uuidSchema,
  verdictSchema,
} from "./primitives";
import {
  ruleSnapshotSchema,
  type CaseDefinition,
  type RuleSnapshot,
} from "./task-packs";

export const EXECUTION_STAGES = [
  "prepare",
  "build",
  "page_service",
  "browser",
  "base_checks",
  "deadline",
  "cancellation",
  "connection",
] as const;
export const executedStepSchema = z
  .object({
    stepId: businessIdSchema,
    phase: z.enum(["setup", "action", "assert"]),
    startedAt: utcDateTimeSchema,
    finishedAt: utcDateTimeSchema.optional(),
    state: z.enum(["completed", "failed", "interrupted"]),
    observation: z.string().min(1).max(3000),
    evidenceIds: z.array(uuidSchema).max(20),
  })
  .strict()
  .superRefine((step, ctx) =>
    refineWith(ctx, () => {
      requireUnique(step.evidenceIds, "step evidence");
      if (step.state !== "interrupted" && !step.finishedAt)
        fail("STEP_FINISH_REQUIRED", step.stepId);
      if (
        step.finishedAt &&
        Date.parse(step.finishedAt) < Date.parse(step.startedAt)
      )
        fail("INVALID_STEP_TIME", step.stepId);
    }),
  );
export const caseResultSchema = z
  .object({
    criterionId: businessIdSchema,
    caseId: businessIdSchema,
    verdict: verdictSchema,
    preconditionStatus: z.enum(["satisfied", "blocked", "uncertain"]),
    reasonCode: reasonCodeSchema,
    expected: z.string().min(1).max(3000),
    observed: z.string().min(1).max(5000),
    executedSteps: z.array(executedStepSchema).max(32),
    unexecutedStepIds: z.array(businessIdSchema).max(32),
    blockedBy: z
      .array(
        z
          .object({
            kind: z.enum(["setup_step", "execution_stage"]),
            id: businessIdSchema,
            reasonCode: reasonCodeSchema,
          })
          .strict(),
      )
      .max(10),
    evidenceIds: z.array(uuidSchema).max(200),
  })
  .strict()
  .superRefine((result, ctx) =>
    refineWith(ctx, () => {
      requireUnique(
        result.executedSteps.map((step) => step.stepId),
        "executed steps",
      );
      requireUnique(result.unexecutedStepIds, "unexecuted steps");
      requireUnique(result.evidenceIds, "case evidence");
      requireUnique(
        result.blockedBy.map((item) => `${item.kind}:${item.id}`),
        "blockers",
      );
      if (
        result.executedSteps.some((step) =>
          result.unexecutedStepIds.includes(step.stepId),
        )
      )
        fail("STEP_EXECUTION_CONFLICT", result.caseId);
      if (
        (result.verdict === "passed" || result.verdict === "failed") &&
        result.preconditionStatus !== "satisfied"
      )
        fail("PRECONDITION_NOT_SATISFIED", result.caseId);
      if (
        result.preconditionStatus === "blocked" &&
        (result.verdict !== "not_run" || !result.blockedBy.length)
      )
        fail("BLOCKED_CASE_INVALID", result.caseId);
      if (
        result.reasonCode === "SETUP_BLOCKED" &&
        (result.preconditionStatus !== "blocked" ||
          !result.blockedBy.some((item) => item.kind === "setup_step"))
      )
        fail("SETUP_BLOCKER_REQUIRED", result.caseId);
      if (
        result.verdict === "passed" &&
        (result.unexecutedStepIds.length ||
          result.blockedBy.length ||
          result.executedSteps.some((step) => step.state !== "completed"))
      )
        fail("INCOMPLETE_PASS", result.caseId);
      for (const step of result.executedSteps)
        for (const id of step.evidenceIds)
          if (!result.evidenceIds.includes(id))
            fail("STEP_EVIDENCE_NOT_DECLARED", id);
    }),
  );
export type CaseResult = z.infer<typeof caseResultSchema>;
export type ExecutedStep = z.infer<typeof executedStepSchema>;

export function validateCaseResult(
  definition: CaseDefinition,
  value: unknown,
): CaseResult {
  const result = caseResultSchema.parse(value);
  if (
    result.caseId !== definition.caseId ||
    result.criterionId !== definition.criterionId
  )
    fail("CASE_IDENTITY_MISMATCH", result.caseId);
  if (result.expected !== definition.expected)
    fail("CASE_EXPECTATION_MISMATCH", result.caseId);
  const plans = definition.plannedSteps;
  if (
    result.executedSteps.length + result.unexecutedStepIds.length !==
    plans.length
  )
    fail("STEP_COVERAGE_MISMATCH", result.caseId);
  for (let index = 0; index < result.executedSteps.length; index++) {
    const executed = result.executedSteps[index];
    const planned = plans[index];
    if (
      !planned ||
      executed.stepId !== planned.stepId ||
      executed.phase !== planned.phase
    )
      fail("EXECUTED_STEP_PLAN_MISMATCH", executed.stepId);
    const previous = result.executedSteps[index - 1];
    if (
      previous &&
      (!previous.finishedAt ||
        previous.state !== "completed" ||
        Date.parse(previous.finishedAt) > Date.parse(executed.startedAt))
    )
      fail("INVALID_STEP_SEQUENCE", executed.stepId);
  }
  const remaining = plans
    .slice(result.executedSteps.length)
    .map((step) => step.stepId);
  if (canonicalJson(remaining) !== canonicalJson(result.unexecutedStepIds))
    fail("UNEXECUTED_STEP_PLAN_MISMATCH", result.caseId);
  if (
    result.preconditionStatus === "satisfied" &&
    plans
      .filter((step) => step.phase === "setup")
      .some(
        (step) =>
          !result.executedSteps.some(
            (executed) =>
              executed.stepId === step.stepId && executed.state === "completed",
          ),
      )
  )
    fail("SETUP_NOT_CONFIRMED", result.caseId);
  if (
    (result.verdict === "passed" || result.verdict === "failed") &&
    (!result.evidenceIds.length ||
      !result.executedSteps.some((step) => step.phase !== "setup"))
  )
    fail("ASSERTION_EVIDENCE_REQUIRED", result.caseId);
  for (const blocker of result.blockedBy) {
    if (
      blocker.kind === "execution_stage" &&
      !(EXECUTION_STAGES as readonly string[]).includes(blocker.id)
    )
      fail("UNKNOWN_EXECUTION_STAGE", blocker.id);
    if (blocker.kind === "setup_step") {
      const actual = result.executedSteps.find(
        (step) => step.stepId === blocker.id && step.phase === "setup",
      );
      if (!actual || actual.state === "completed")
        fail("UNOBSERVED_SETUP_BLOCKER", blocker.id);
    }
  }
  return result;
}

export function validateCaseResults(
  ruleValue: RuleSnapshot,
  values: unknown,
): CaseResult[] {
  const rule = ruleSnapshotSchema.parse(ruleValue);
  const results = z.array(caseResultSchema).max(64).parse(values);
  requireUnique(
    results.map((result) => result.caseId),
    "case results",
  );
  if (
    canonicalJson([...rule.requiredCaseIds].sort(lexicalCompare)) !==
    canonicalJson(results.map((result) => result.caseId).sort(lexicalCompare))
  )
    fail(
      "RESULT_CASE_SET_MISMATCH",
      "Exactly one result per enabled automatic case is required",
    );
  return results.map((result) =>
    validateCaseResult(
      rule.packManifest.cases.find((entry) => entry.caseId === result.caseId)!,
      result,
    ),
  );
}

export const caseClassificationInputSchema = z
  .object({
    preconditionStatus: z.enum(["satisfied", "blocked", "uncertain"]),
    observation: z.enum(["satisfied", "violated", "ambiguous", "not_observed"]),
    interruption: z
      .enum([
        "BUILD_ERROR",
        "INFRA_ERROR",
        "RESOURCE_LIMIT",
        "TIME_BUDGET",
        "CANCELLED",
        "INTERRUPTED",
      ])
      .optional(),
  })
  .strict();

/** A timeout alone never establishes a functional violation. */
export function classifyCaseOutcome(
  input: z.infer<typeof caseClassificationInputSchema>,
): Pick<CaseResult, "verdict" | "preconditionStatus" | "reasonCode"> {
  const value = caseClassificationInputSchema.parse(input);
  if (value.interruption)
    return {
      verdict: "not_run",
      preconditionStatus: value.preconditionStatus,
      reasonCode: value.interruption,
    };
  if (value.preconditionStatus === "blocked")
    return {
      verdict: "not_run",
      preconditionStatus: "blocked",
      reasonCode: "SETUP_BLOCKED",
    };
  if (
    value.preconditionStatus === "uncertain" ||
    value.observation === "ambiguous"
  )
    return {
      verdict: "manual",
      preconditionStatus: value.preconditionStatus,
      reasonCode: "OBSERVATION_AMBIGUOUS",
    };
  if (value.observation === "not_observed")
    return {
      verdict: "not_run",
      preconditionStatus: "satisfied",
      reasonCode: "INTERRUPTED",
    };
  return {
    verdict: value.observation === "satisfied" ? "passed" : "failed",
    preconditionStatus: "satisfied",
    reasonCode:
      value.observation === "satisfied"
        ? "ASSERTION_SATISFIED"
        : "ASSERTION_MISMATCH",
  };
}

export interface CriterionAggregate {
  criterionId: string;
  verdict: CaseResult["verdict"];
  failedCaseIds: string[];
  notRunCaseIds: string[];
  manualCaseIds: string[];
  passedCaseIds: string[];
}

export function aggregateResults(
  rule: RuleSnapshot,
  results: CaseResult[],
): CriterionAggregate[] {
  const validated = validateCaseResults(rule, results);
  return rule.enabledCriterionIds.map((criterionId) => {
    const criterion = rule.packManifest.criteria.find(
      (entry) => entry.criterionId === criterionId,
    )!;
    const entries = validated.filter(
      (entry) => entry.criterionId === criterionId,
    );
    const ids = (verdict: CaseResult["verdict"]) =>
      entries
        .filter((entry) => entry.verdict === verdict)
        .map((entry) => entry.caseId)
        .sort(lexicalCompare);
    const groups = {
      failedCaseIds: ids("failed"),
      notRunCaseIds: ids("not_run"),
      manualCaseIds: ids("manual"),
      passedCaseIds: ids("passed"),
    };
    const verdict: CaseResult["verdict"] =
      criterion.mode === "manual"
        ? "manual"
        : groups.failedCaseIds.length
          ? "failed"
          : groups.notRunCaseIds.length
            ? "not_run"
            : groups.manualCaseIds.length
              ? "manual"
              : "passed";
    return { criterionId, verdict, ...groups };
  });
}

export function aggregateCriterion(
  rule: RuleSnapshot,
  criterionId: string,
  allCaseResults: CaseResult[],
): CriterionAggregate {
  const result = aggregateResults(rule, allCaseResults).find(
    (entry) => entry.criterionId === criterionId,
  );
  if (!result) fail("UNKNOWN_CRITERION", criterionId);
  return result;
}
