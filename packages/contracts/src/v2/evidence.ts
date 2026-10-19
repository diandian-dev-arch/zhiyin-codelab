import { z } from "zod";
import {
  LIMITS_V1,
  assertContextMatches,
  canonicalJson,
  decodeBase64,
  executionContextSchema,
  fail,
  lexicalCompare,
  refineWith,
  requireUnique,
  sha256,
  sha256Schema,
  utcDateTimeSchema,
  uuidSchema,
  validateRelativePath,
  type ExecutionContext,
} from "./primitives";
import { businessIdSchema } from "./primitives";
import type { CaseResult } from "./cases";
import type { RuleSnapshot } from "./task-packs";

export const evidenceSchema = z
  .object({
    evidenceId: uuidSchema,
    manifestId: uuidSchema,
    runId: uuidSchema,
    submissionId: uuidSchema,
    originalZipSha256: sha256Schema,
    sourceManifestSha256: sha256Schema,
    executionAttemptId: uuidSchema,
    analysisAttemptId: uuidSchema.nullable(),
    operationId: uuidSchema.nullable(),
    scope: z.enum(["run", "case"]),
    criterionId: businessIdSchema.nullable(),
    caseId: businessIdSchema.nullable(),
    phase: z.enum(["build", "base", "probe", "source_excerpt", "diagnostic"]),
    collector: z.enum(["runner", "business_extractor"]),
    contentOrigin: z.enum([
      "checker_observation",
      "student_console",
      "student_source",
      "rendered_page",
      "platform_diagnostic",
    ]),
    ruleHash: sha256Schema,
    packManifestHash: sha256Schema,
    sha256: sha256Schema,
    byteSize: z.number().int().nonnegative().max(LIMITS_V1.pngMaxBytes),
    mediaType: z.enum([
      "image/png",
      "text/plain; charset=utf-8",
      "application/json",
    ]),
    storageKey: z.string().min(1).max(240),
    capturedAt: utcDateTimeSchema,
  })
  .strict()
  .superRefine((evidence, ctx) =>
    refineWith(ctx, () => {
      if (
        evidence.scope === "case" &&
        (!evidence.criterionId || !evidence.caseId)
      )
        fail("CASE_SCOPE_REQUIRED", evidence.evidenceId);
      if (
        evidence.scope === "run" &&
        (evidence.criterionId !== null || evidence.caseId !== null)
      )
        fail("RUN_SCOPE_INVALID", evidence.evidenceId);
      if (
        evidence.scope === "run" &&
        !["build", "diagnostic", "source_excerpt"].includes(evidence.phase)
      )
        fail("RUN_EVIDENCE_PHASE_INVALID", evidence.evidenceId);
      if (evidence.phase === "source_excerpt" &&
        (evidence.collector !== "business_extractor" || evidence.contentOrigin !== "student_source" || evidence.mediaType === "image/png"))
        fail("SOURCE_EVIDENCE_ORIGIN_INVALID", evidence.evidenceId);
      if (
        (evidence.analysisAttemptId === null) !==
        (evidence.operationId === null)
      )
        fail("SUPPLEMENTAL_IDENTITY_INCOMPLETE", evidence.evidenceId);
      if (
        ["probe", "source_excerpt"].includes(evidence.phase) &&
        (!evidence.analysisAttemptId || !evidence.operationId)
      )
        fail("SUPPLEMENTAL_IDENTITY_REQUIRED", evidence.evidenceId);
      if (
        evidence.mediaType !== "image/png" &&
        evidence.byteSize > LIMITS_V1.textEvidenceMaxBytes
      )
        fail("PAYLOAD_TOO_LARGE", "text evidence bytes");
      validateRelativePath(evidence.storageKey);
      if (!evidence.storageKey.startsWith(`runs/${evidence.runId}/`))
        fail("STORAGE_SCOPE_MISMATCH", evidence.evidenceId);
    }),
  );
export type Evidence = z.infer<typeof evidenceSchema>;

export const artifactManifestSchema = z
  .object({
    contractVersion: z.literal(2),
    hashAlgorithm: z.literal("canonical-json-v1"),
    manifestId: uuidSchema,
    context: executionContextSchema,
    source: z.enum(["base", "supplemental"]),
    analysisAttemptId: uuidSchema.nullable(),
    operationId: uuidSchema.nullable(),
    contentHash: sha256Schema,
    evidence: z.array(evidenceSchema).max(LIMITS_V1.manifestMaxEvidence),
    completeness: z.enum(["complete", "partial"]),
  })
  .strict()
  .superRefine((manifest, ctx) =>
    refineWith(ctx, () => {
      requireUnique(
        manifest.evidence.map((entry) => entry.evidenceId),
        "manifest evidence IDs",
      );
      requireUnique(
        manifest.evidence.map((entry) => entry.storageKey.toLowerCase()),
        "manifest storage keys",
      );
      if (
        manifest.source === "base" &&
        (manifest.analysisAttemptId !== null || manifest.operationId !== null)
      )
        fail("BASE_MANIFEST_OWNER_INVALID", manifest.manifestId);
      if (
        manifest.source === "supplemental" &&
        (!manifest.analysisAttemptId || !manifest.operationId)
      )
        fail("SUPPLEMENTAL_IDENTITY_REQUIRED", manifest.manifestId);
      for (const entry of manifest.evidence) {
        if (
          entry.manifestId !== manifest.manifestId ||
          entry.analysisAttemptId !== manifest.analysisAttemptId ||
          entry.operationId !== manifest.operationId
        )
          fail("EVIDENCE_MANIFEST_MISMATCH", entry.evidenceId);
        for (const key of [
          "runId",
          "submissionId",
          "originalZipSha256",
          "sourceManifestSha256",
          "executionAttemptId",
          "ruleHash",
          "packManifestHash",
        ] as const)
          if (entry[key] !== manifest.context[key])
            fail("EVIDENCE_CONTEXT_MISMATCH", `${entry.evidenceId}.${key}`);
        if (
          manifest.source === "base" &&
          !["build", "base", "diagnostic"].includes(entry.phase)
        )
          fail("BASE_EVIDENCE_PHASE_INVALID", entry.evidenceId);
        if (
          manifest.source === "supplemental" &&
          !["probe", "source_excerpt", "diagnostic"].includes(entry.phase)
        )
          fail("SUPPLEMENTAL_EVIDENCE_PHASE_INVALID", entry.evidenceId);
      }
    }),
  );
export type ArtifactManifest = z.infer<typeof artifactManifestSchema>;

export async function hashArtifactManifest(
  manifest: Omit<ArtifactManifest, "contentHash"> | ArtifactManifest,
): Promise<string> {
  const { contentHash: _self, ...body } = manifest as ArtifactManifest;
  return sha256(
    canonicalJson({
      ...body,
      evidence: [...body.evidence].sort((a, b) =>
        lexicalCompare(a.evidenceId, b.evidenceId),
      ),
    }),
  );
}

export async function createArtifactManifest(
  input: Omit<
    ArtifactManifest,
    "contractVersion" | "hashAlgorithm" | "contentHash"
  >,
): Promise<ArtifactManifest> {
  const body = {
    ...input,
    contractVersion: 2 as const,
    hashAlgorithm: "canonical-json-v1" as const,
  };
  return artifactManifestSchema.parse({
    ...body,
    contentHash: await hashArtifactManifest(body),
  });
}

export async function validateArtifactManifest(
  value: unknown,
  options: { rule: RuleSnapshot; expectedContext: ExecutionContext },
): Promise<ArtifactManifest> {
  const manifest = artifactManifestSchema.parse(value);
  assertContextMatches(options.expectedContext, manifest.context);
  if ((await hashArtifactManifest(manifest)) !== manifest.contentHash)
    fail("MANIFEST_HASH_MISMATCH", manifest.manifestId);
  for (const evidence of manifest.evidence)
    if (evidence.scope === "case") {
      const definition = options.rule.packManifest.cases.find(
        (entry) =>
          entry.caseId === evidence.caseId &&
          entry.criterionId === evidence.criterionId,
      );
      if (
        !definition ||
        !options.rule.requiredCaseIds.includes(definition.caseId)
      )
        fail("EVIDENCE_CASE_NOT_ENABLED", evidence.evidenceId);
    }
  return manifest;
}

/** Every reference is checked again in the context of the referencing case. */
export function validateCaseEvidenceReferences(
  results: CaseResult[],
  manifest: ArtifactManifest,
): void {
  const byId = new Map(
    manifest.evidence.map((evidence) => [evidence.evidenceId, evidence]),
  );
  for (const result of results) {
    for (const id of [
      ...result.evidenceIds,
      ...result.executedSteps.flatMap((step) => step.evidenceIds),
    ]) {
      const evidence = byId.get(id);
      if (!evidence) fail("EVIDENCE_REFERENCE_MISSING", id);
      if (
        evidence.scope === "case" &&
        (evidence.caseId !== result.caseId ||
          evidence.criterionId !== result.criterionId)
      )
        fail("CROSS_CASE_EVIDENCE", id);
      if (
        evidence.scope === "run" &&
        !["build", "diagnostic"].includes(evidence.phase)
      )
        fail("RUN_EVIDENCE_REFERENCE_INVALID", id);
    }
    if (
      (result.verdict === "passed" || result.verdict === "failed") &&
      !result.evidenceIds.some((id) => {
        const evidence = byId.get(id)!;
        return (
          evidence.scope === "case" &&
          evidence.phase === "base" &&
          evidence.collector === "runner" &&
          ["checker_observation", "rendered_page"].includes(
            evidence.contentOrigin,
          )
        );
      })
    )
      fail("CASE_OBSERVATION_EVIDENCE_REQUIRED", result.caseId);
  }
}

export const artifactPayloadSchema = z
  .object({
    evidenceId: uuidSchema,
    encoding: z.literal("base64"),
    data: z.string().max(Math.ceil(LIMITS_V1.pngMaxBytes / 3) * 4),
  })
  .strict();
export type ArtifactPayload = z.infer<typeof artifactPayloadSchema>;

export async function validateArtifactPayloads(
  manifest: ArtifactManifest,
  payloadsValue: unknown,
): Promise<ArtifactPayload[]> {
  const payloads = z
    .array(artifactPayloadSchema)
    .max(LIMITS_V1.manifestMaxEvidence)
    .parse(payloadsValue);
  requireUnique(
    payloads.map((payload) => payload.evidenceId),
    "artifact payloads",
  );
  if (
    canonicalJson(
      payloads.map((payload) => payload.evidenceId).sort(lexicalCompare),
    ) !==
    canonicalJson(
      manifest.evidence
        .map((evidence) => evidence.evidenceId)
        .sort(lexicalCompare),
    )
  )
    fail(
      "ARTIFACT_SET_MISMATCH",
      "Every manifest entry needs exactly one bounded payload",
    );
  for (const payload of payloads) {
    const evidence = manifest.evidence.find(
      (entry) => entry.evidenceId === payload.evidenceId,
    )!;
    const bytes = decodeBase64(
      payload.data,
      evidence.mediaType === "image/png"
        ? LIMITS_V1.pngMaxBytes
        : LIMITS_V1.textEvidenceMaxBytes,
    );
    if (
      bytes.byteLength !== evidence.byteSize ||
      (await sha256(bytes)) !== evidence.sha256
    )
      fail("ARTIFACT_HASH_MISMATCH", evidence.evidenceId);
    if (evidence.mediaType === "image/png") {
      const signature = [137, 80, 78, 71, 13, 10, 26, 10];
      if (signature.some((byte, index) => bytes[index] !== byte))
        fail("ARTIFACT_MEDIA_MISMATCH", evidence.evidenceId);
      // Full image decoding and durable storage are collector responsibilities.
    } else {
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        fail("ARTIFACT_ENCODING_INVALID", evidence.evidenceId);
      }
      if (evidence.mediaType === "application/json") {
        try {
          JSON.parse(text);
        } catch {
          fail("ARTIFACT_JSON_INVALID", evidence.evidenceId);
        }
      }
    }
  }
  return payloads;
}
