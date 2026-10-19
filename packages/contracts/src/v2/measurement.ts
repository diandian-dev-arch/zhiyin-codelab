import { z } from "zod";
import {
  canonicalJson,
  fail,
  lexicalCompare,
  refineWith,
  requireUnique,
  sha256Schema,
  uuidSchema,
  versionSchema,
} from "./primitives";
import { AGGREGATION_VERSION } from "./task-packs";
import { caseResultSchema, type CaseResult } from "./cases";

export const imageIdentitySchema = z
  .object({
    identifierType: z.enum(["digest", "local_image_id"]),
    value: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  })
  .strict();
export const measurementFingerprintSchema = z
  .object({
    ruleHash: sha256Schema,
    packManifestHash: sha256Schema,
    templateHash: sha256Schema,
    dependencyLockHash: sha256Schema,
    initializationVersion: versionSchema,
    parametersHash: sha256Schema,
    aggregationVersion: z.literal(AGGREGATION_VERSION),
    buildImage: imageIdentitySchema,
    webImage: imageIdentitySchema,
    browserImage: imageIdentitySchema,
    playwrightVersion: versionSchema,
    chromiumVersion: versionSchema,
    viewport: z
      .object({
        width: z.number().int().positive().max(7680),
        height: z.number().int().positive().max(4320),
        deviceScaleFactor: z.number().positive().max(4),
      })
      .strict(),
    locale: z.string().min(2).max(80),
    timezone: z.string().min(1).max(80),
    clockPolicy: versionSchema,
    randomPolicy: versionSchema,
    pageServerPolicy: versionSchema,
    resourceTimeoutConfigVersion: versionSchema,
  })
  .strict();
export type MeasurementFingerprint = z.infer<
  typeof measurementFingerprintSchema
>;
export const MEASUREMENT_FIELDS = Object.keys(
  measurementFingerprintSchema.shape,
) as (keyof MeasurementFingerprint)[];
export const measuredEnvironmentSchema = z
  .object({
    completeness: z.enum(["complete", "partial", "unknown"]),
    values: measurementFingerprintSchema.partial().strict(),
    missingFields: z
      .array(
        z.enum(
          MEASUREMENT_FIELDS as [
            keyof MeasurementFingerprint,
            ...(keyof MeasurementFingerprint)[],
          ],
        ),
      )
      .max(MEASUREMENT_FIELDS.length),
  })
  .strict()
  .superRefine((measurement, ctx) =>
    refineWith(ctx, () => {
      requireUnique(measurement.missingFields, "missing measurement fields");
      if (
        Object.values(measurement.values).some((value) => value === undefined)
      )
        fail(
          "MEASUREMENT_VALUE_UNDEFINED",
          "Unknown fields must be absent and listed in missingFields",
        );
      const measured = Object.keys(measurement.values);
      const missing = MEASUREMENT_FIELDS.filter(
        (field) => !measured.includes(field),
      ).sort(lexicalCompare);
      if (
        canonicalJson(missing) !==
        canonicalJson([...measurement.missingFields].sort(lexicalCompare))
      )
        fail(
          "MEASUREMENT_MISSING_FIELDS_MISMATCH",
          "missingFields must exactly name unknown top-level values",
        );
      if (measurement.completeness === "complete" && missing.length)
        fail(
          "MEASUREMENT_INCOMPLETE",
          "Complete measurements require every field",
        );
      if (
        measurement.completeness === "partial" &&
        (!missing.length || !measured.length)
      )
        fail(
          "MEASUREMENT_PARTIAL_INVALID",
          "Partial measurements need known and unknown values",
        );
      if (measurement.completeness === "unknown" && measured.length)
        fail(
          "MEASUREMENT_UNKNOWN_INVALID",
          "Unknown measurements have no observed values",
        );
    }),
  );
export type MeasuredEnvironment = z.infer<typeof measuredEnvironmentSchema>;

export function unknownMeasuredEnvironment(): MeasuredEnvironment {
  return {
    completeness: "unknown",
    values: {},
    missingFields: [...MEASUREMENT_FIELDS].sort(lexicalCompare),
  };
}

export type MeasurementComparison =
  | { status: "compatible"; items: [] }
  | { status: "unknown"; reasonCode: "MEASUREMENT_UNKNOWN"; items: string[] }
  | {
      status: "incompatible";
      reasonCode: "MEASUREMENT_DIFFERENT";
      items: {
        field: keyof MeasurementFingerprint;
        before: unknown;
        after: unknown;
      }[];
    };

export function compareMeasurements(
  beforeValue: MeasuredEnvironment,
  afterValue: MeasuredEnvironment,
): MeasurementComparison {
  const before = measuredEnvironmentSchema.parse(beforeValue);
  const after = measuredEnvironmentSchema.parse(afterValue);
  if (before.completeness !== "complete" || after.completeness !== "complete")
    return {
      status: "unknown",
      reasonCode: "MEASUREMENT_UNKNOWN",
      items: [
        ...new Set([...before.missingFields, ...after.missingFields]),
      ].sort(lexicalCompare),
    };
  const items = MEASUREMENT_FIELDS.filter(
    (field) =>
      canonicalJson(before.values[field]) !==
      canonicalJson(after.values[field]),
  ).map((field) => ({
    field,
    before: before.values[field],
    after: after.values[field],
  }));
  return items.length
    ? { status: "incompatible", reasonCode: "MEASUREMENT_DIFFERENT", items }
    : { status: "compatible", items: [] };
}

export const comparisonRunSchema = z
  .object({
    contractVersion: z.literal(2),
    studentId: uuidSchema,
    taskId: uuidSchema,
    ruleId: uuidSchema,
    actualFingerprint: measuredEnvironmentSchema,
    caseResults: z.array(caseResultSchema).max(64),
  })
  .strict()
  .superRefine((run, ctx) =>
    refineWith(ctx, () =>
      requireUnique(
        run.caseResults.map((entry) => entry.caseId),
        "comparison cases",
      ),
    ),
  );
export type ComparisonRun = z.infer<typeof comparisonRunSchema>;
export interface CaseDiff {
  criterionId: string;
  caseId: string;
  before: CaseResult["verdict"];
  after: CaseResult["verdict"];
  change: "resolved" | "regression" | "remaining" | "unchanged" | "unknown";
}

/** Call with archived, validated case results. No rule conversion is done for legacy records. */
export function compareCaseResults(
  beforeValue: ComparisonRun | { contractVersion: 1 },
  afterValue: ComparisonRun | { contractVersion: 1 },
):
  | { status: "compatible"; caseDiffs: CaseDiff[] }
  | {
      status: "unknown" | "incompatible";
      reasonCode: string;
      items: unknown[];
      caseDiffs: [];
    } {
  if (beforeValue.contractVersion !== 2 || afterValue.contractVersion !== 2)
    return {
      status: "unknown",
      reasonCode: "LEGACY_MEASUREMENT_UNKNOWN",
      items: [],
      caseDiffs: [],
    };
  const before = comparisonRunSchema.parse(beforeValue);
  const after = comparisonRunSchema.parse(afterValue);
  const identityDifferences = (
    ["studentId", "taskId", "ruleId"] as const
  ).filter((key) => before[key] !== after[key]);
  if (identityDifferences.length)
    return {
      status: "incompatible",
      reasonCode: "COMPARISON_SCOPE_MISMATCH",
      items: identityDifferences,
      caseDiffs: [],
    };
  const measurement = compareMeasurements(
    before.actualFingerprint,
    after.actualFingerprint,
  );
  if (measurement.status !== "compatible")
    return { ...measurement, caseDiffs: [] };
  const keys = (run: ComparisonRun) =>
    run.caseResults
      .map((entry) => `${entry.criterionId}:${entry.caseId}`)
      .sort(lexicalCompare);
  if (
    !before.caseResults.length ||
    canonicalJson(keys(before)) !== canonicalJson(keys(after))
  )
    return {
      status: "incompatible",
      reasonCode: "COMPARISON_CASE_SET_MISMATCH",
      items: [],
      caseDiffs: [],
    };
  const caseDiffs = after.caseResults.map((current): CaseDiff => {
    const previous = before.caseResults.find(
      (entry) => entry.caseId === current.caseId,
    )!;
    const unknown = [previous.verdict, current.verdict].some(
      (verdict) => verdict === "not_run" || verdict === "manual",
    );
    return {
      criterionId: current.criterionId,
      caseId: current.caseId,
      before: previous.verdict,
      after: current.verdict,
      change: unknown
        ? "unknown"
        : previous.verdict === "failed" && current.verdict === "passed"
          ? "resolved"
          : previous.verdict === "passed" && current.verdict === "failed"
            ? "regression"
            : current.verdict === "failed"
              ? "remaining"
              : "unchanged",
    };
  });
  return { status: "compatible", caseDiffs };
}
