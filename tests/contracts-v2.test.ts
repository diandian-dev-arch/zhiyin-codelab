import { describe, expect, it } from "vitest";
import { runnerResponseSchema as legacyRunnerResponseSchema } from "../packages/contracts/src/index";
import {
  CORE_CASE_IDS,
  LIMITS_V1,
  MEASUREMENT_FIELDS,
  aggregateResults,
  artifactManifestSchema,
  canonicalJson,
  caseResultSchema,
  classifyCaseOutcome,
  compareCaseResults,
  compareMeasurements,
  createArtifactManifest,
  createCoursePack,
  createDevelopmentPack,
  createRuleSnapshot,
  createSourceManifest,
  encodeBase64,
  hashArtifactManifest,
  hashCleanupRequest,
  hashExecuteRequest,
  hashProbeRequest,
  hashRuleSnapshot,
  hashTaskPack,
  measuredEnvironmentSchema,
  ruleSnapshotSchema,
  runnerCapabilitiesSchema,
  runnerCleanupRequestSchema,
  runnerCleanupResponseSchema,
  runnerExecuteRequestSchema,
  runnerExecuteResponseSchema,
  runnerHeartbeatRequestSchema,
  runnerHeartbeatResponseSchema,
  runnerOperationQueryRequestSchema,
  runnerOperationQueryResponseSchema,
  runnerRemainingWorkMs,
  sha256,
  taskPackManifestSchema,
  unknownMeasuredEnvironment,
  validateArtifactManifest,
  validateArtifactPayloads,
  validateCaseEvidenceReferences,
  validateCaseResults,
  validateParameterValues,
  validateProbeRequest,
  validateReplayIdentity,
  validateRuleSnapshot,
  validateRunRequest,
  validateRunResponse,
  validateSourceFiles,
  validateSourceManifest,
  type ArtifactManifest,
  type ArtifactPayload,
  type CaseDefinition,
  type CaseResult,
  type ComparisonRun,
  type Evidence,
  type ExecutionContext,
  type MeasurementFingerprint,
  type RuleSnapshot,
  type RunnerCleanupRequest,
  type RunnerExecuteRequest,
  type RunnerExecuteResponse,
  type RunnerOperationRecord,
  type RunnerProbeRequest,
  type TaskPackBuildIdentity,
} from "../packages/contracts/src/v2/index";

// These are synthetic contract vectors, never measured runner output or checker certification.
const id = (number: number) =>
  `00000000-0000-4000-8000-${number.toString().padStart(12, "0")}`;
const now = "2026-09-27T00:00:00.000Z";
const later = (milliseconds: number) =>
  new Date(Date.parse(now) + milliseconds).toISOString();
const bytes64 = (text: string) => encodeBase64(new TextEncoder().encode(text));
const copy = <T>(value: T): T => structuredClone(value);
const hash = "1".repeat(64);
const otherHash = "2".repeat(64);
const buildIdentity: TaskPackBuildIdentity = {
  packVersion: "synthetic-contract-test-v1",
  templateVersion: "synthetic-template-v1",
  templateHash: hash,
  dependencyLockHash: hash,
  initializationVersion: "ui-setup-v1",
  caseImplementationHashes: Object.fromEntries(
    CORE_CASE_IDS.map((caseId) => [caseId, hash]),
  ),
  probeImplementationHashes: { FILTER_ORDER_CHECK: hash },
};

async function fixture(
  slice: "new-only" | "new-filter" | "course" = "new-only",
) {
  const pack =
    slice === "course"
      ? await createCoursePack(buildIdentity)
      : await createDevelopmentPack(slice, buildIdentity);
  const rule = await createRuleSnapshot({
    ruleId: id(1),
    taskId: id(2),
    version: 1,
    packManifest: pack,
    enabledCriterionIds: pack.criteria.map(
      (criterion) => criterion.criterionId,
    ),
    parameterValues:
      slice === "course" ? { requireValidationMessage: false } : {},
    confirmedBy: id(3),
    confirmedAt: now,
  });
  const files = {
    "src/App.vue": bytes64("<template>synthetic contract vector</template>\n"),
  };
  const source = await createSourceManifest(files);
  const context: ExecutionContext = {
    runId: id(4),
    executionAttemptId: id(5),
    submissionId: id(6),
    originalZipSha256: otherHash,
    sourceManifestSha256: source.sourceManifestSha256,
    ruleId: rule.ruleId,
    ruleHash: await hashRuleSnapshot(rule),
    packManifestHash: pack.contentHash,
    templateHash: pack.templateHash,
  };
  const fingerprint: MeasurementFingerprint = {
    ruleHash: context.ruleHash,
    packManifestHash: pack.contentHash,
    templateHash: pack.templateHash,
    dependencyLockHash: pack.dependencyLockHash,
    initializationVersion: pack.initializationVersion,
    parametersHash: rule.parametersHash,
    aggregationVersion: "aggregation-v1",
    buildImage: { identifierType: "digest", value: `sha256:${hash}` },
    webImage: { identifierType: "local_image_id", value: `sha256:${hash}` },
    browserImage: { identifierType: "digest", value: `sha256:${hash}` },
    playwrightVersion: "synthetic-1",
    chromiumVersion: "synthetic-1",
    viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
    locale: "zh-CN",
    timezone: "UTC",
    clockPolicy: "real-time-v1",
    randomPolicy: "uncontrolled-v1",
    pageServerPolicy: "static-v1",
    resourceTimeoutConfigVersion: "limits-v1",
  };
  const requestBody: Omit<RunnerExecuteRequest, "requestHash"> = {
    protocolVersion: 2,
    context,
    ownerToken: "synthetic-owner-token-only",
    operationId: id(7),
    requestId: id(8),
    files,
    ruleSnapshot: rule,
    approvedFingerprint: fingerprint,
    startedAt: now,
    leaseUntil: later(30_000),
    workDeadlineAt: later(270_000),
    hardDeadlineAt: later(300_000),
    remainingWorkMs: 270_000,
    budgetConfigVersion: "pipeline-budget-v1",
  };
  const request: RunnerExecuteRequest = {
    ...requestBody,
    requestHash: await hashExecuteRequest(requestBody),
  };
  return { pack, rule, files, source, context, fingerprint, request };
}

function resultFor(
  definition: CaseDefinition,
  verdict: CaseResult["verdict"] = "passed",
  evidenceId = id(101),
): CaseResult {
  const executed = verdict === "passed" || verdict === "failed";
  return {
    criterionId: definition.criterionId,
    caseId: definition.caseId,
    verdict,
    preconditionStatus: executed ? "satisfied" : "uncertain",
    reasonCode:
      verdict === "passed"
        ? "ASSERTION_SATISFIED"
        : verdict === "failed"
          ? "ASSERTION_MISMATCH"
          : verdict === "manual"
            ? "OBSERVATION_AMBIGUOUS"
            : "INFRA_ERROR",
    expected: definition.expected,
    observed: `Synthetic ${verdict} observation`,
    executedSteps: executed
      ? definition.plannedSteps.map((step, index) => ({
          stepId: step.stepId,
          phase: step.phase,
          startedAt: later(index * 100),
          finishedAt: later(index * 100 + 50),
          state:
            verdict === "failed" && index === definition.plannedSteps.length - 1
              ? "failed"
              : "completed",
          observation: `Synthetic observation of ${step.stepId}`,
          evidenceIds: [evidenceId],
        }))
      : [],
    unexecutedStepIds: executed
      ? []
      : definition.plannedSteps.map((step) => step.stepId),
    blockedBy: [],
    evidenceIds: executed ? [evidenceId] : [],
  };
}

async function responseFixture(
  slice: "new-only" | "new-filter" | "course" = "new-only",
) {
  const data = await fixture(slice);
  const manifestId = id(90);
  const artifacts: ArtifactPayload[] = [];
  const evidence: Evidence[] = [];
  const results = data.pack.cases.map((definition, index) =>
    resultFor(definition, "passed", id(101 + index)),
  );
  for (let index = 0; index < results.length; index++) {
    const result = results[index];
    const content = new TextEncoder().encode(
      JSON.stringify({
        synthetic: true,
        caseId: result.caseId,
        observed: result.observed,
      }),
    );
    const evidenceId = id(101 + index);
    evidence.push({
      evidenceId,
      manifestId,
      runId: data.context.runId,
      submissionId: data.context.submissionId,
      originalZipSha256: data.context.originalZipSha256,
      sourceManifestSha256: data.context.sourceManifestSha256,
      executionAttemptId: data.context.executionAttemptId,
      analysisAttemptId: null,
      operationId: null,
      scope: "case",
      criterionId: result.criterionId,
      caseId: result.caseId,
      phase: "base",
      collector: "runner",
      contentOrigin: "checker_observation",
      ruleHash: data.context.ruleHash,
      packManifestHash: data.context.packManifestHash,
      sha256: await sha256(content),
      byteSize: content.byteLength,
      mediaType: "application/json",
      storageKey: `runs/${data.context.runId}/${manifestId}/${evidenceId}.json`,
      capturedAt: now,
    });
    artifacts.push({
      evidenceId,
      encoding: "base64",
      data: encodeBase64(content),
    });
  }
  const baseManifest = await createArtifactManifest({
    manifestId,
    context: data.context,
    source: "base",
    analysisAttemptId: null,
    operationId: null,
    evidence,
    completeness: "complete",
  });
  const response: RunnerExecuteResponse = {
    protocolVersion: 2,
    context: {
      ...data.context,
      operationId: data.request.operationId,
      requestHash: data.request.requestHash,
      observedSourceManifestSha256: data.context.sourceManifestSha256,
      sourceVerificationReason: null,
    },
    actualFingerprint: {
      completeness: "complete",
      values: data.fingerprint,
      missingFields: [],
    },
    outcome: "complete",
    caseResults: results,
    baseManifest,
    artifacts,
    timings: [],
    resourceState: "retained_for_initial_analysis",
  };
  const options = {
    rule: data.rule,
    expectedContext: {
      ...data.context,
      operationId: data.request.operationId,
      requestHash: data.request.requestHash,
    },
    approvedFingerprint: data.fingerprint,
  };
  return { ...data, response, options };
}

describe("v2 source byte and hash contracts", () => {
  it("matches independent fixed SHA-256 and canonical source-manifest vectors", async () => {
    expect(await sha256("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    const source = await createSourceManifest({ "src/a.ts": "YWJj" });
    expect(source.sourceManifestSha256).toBe(
      "db0422161a35ae816f16ab16a953da5513caf393c368203e9f290e1b1517264c",
    );
    expect(source.files[0].byteSize).toBe(3);
  });

  it("normalizes object/set order but preserves source bytes and planned array order", async () => {
    expect(canonicalJson({ z: 1, a: { z: 2, a: 3 } })).toBe(
      '{"a":{"a":3,"z":2},"z":1}',
    );
    expect(canonicalJson(["z", "a"])).not.toBe(canonicalJson(["a", "z"]));
    const a = await createSourceManifest({
      "src/a.ts": bytes64("x\n"),
      "public/说明.txt": bytes64("说明"),
    });
    const b = await createSourceManifest({
      "public/说明.txt": bytes64("说明"),
      "src/a.ts": bytes64("x\n"),
    });
    const changed = await createSourceManifest({
      "src/a.ts": bytes64("x\r\n"),
      "public/说明.txt": bytes64("说明"),
    });
    expect(a.sourceManifestSha256).toBe(b.sourceManifestSha256);
    expect(a.sourceManifestSha256).not.toBe(changed.sourceManifestSha256);
    await expect(
      validateSourceManifest(a, { "src/a.ts": bytes64("changed") }),
    ).rejects.toThrow("SOURCE_HASH_MISMATCH");
  });

  it("never treats ZIP metadata or trusted template files as editable source bytes", async () => {
    const source = await createSourceManifest({ "src/a.ts": "YWJj" });
    const zipA = await sha256("synthetic ZIP bytes with timestamp A");
    const zipB = await sha256("synthetic ZIP bytes with timestamp B");
    expect(zipA).not.toBe(zipB);
    expect(
      (await createSourceManifest({ "src/a.ts": "YWJj" })).sourceManifestSha256,
    ).toBe(source.sourceManifestSha256);
    expect(() =>
      validateSourceFiles({ "package.json": bytes64("{}") }),
    ).toThrow("SOURCE_SCOPE_INVALID");
  });

  it.each([
    "../src/a.ts",
    "src/../a.ts",
    "/src/a.ts",
    "C:/src/a.ts",
    "src\\a.ts",
    "src//a.ts",
    "src/CON.ts",
    "src/a. ",
    "src/e\u0301.ts",
  ])("rejects unsafe or ambiguous path %s", (path) => {
    expect(() => validateSourceFiles({ [path]: "YWJj" })).toThrow(
      "INVALID_PATH",
    );
  });

  it("rejects case-fold and file-directory collisions plus noncanonical base64", () => {
    expect(() =>
      validateSourceFiles({ "src/A.ts": "", "src/a.ts": "" }),
    ).toThrow("PATH_COLLISION");
    expect(() => validateSourceFiles({ "src/a": "", "src/a/b": "" })).toThrow(
      "PATH_COLLISION",
    );
    for (const data of ["abc", "YR==", "YQ==\n", "!!!!"])
      expect(() => validateSourceFiles({ "src/a.ts": data })).toThrow(
        "INVALID_BASE64",
      );
  });

  it("checks decoded size, file counts and UTF-8 path byte limits", () => {
    expect(() =>
      validateSourceFiles({
        "src/a.ts": encodeBase64(
          new Uint8Array(LIMITS_V1.sourceFileMaxBytes + 1),
        ),
      }),
    ).toThrow("PAYLOAD_TOO_LARGE");
    expect(() =>
      validateSourceFiles(
        Object.fromEntries(
          Array.from({ length: 2001 }, (_, index) => [`src/${index}`, ""]),
        ),
      ),
    ).toThrow("FILE_COUNT_INVALID");
    expect(() =>
      validateSourceFiles({ [`src/${"字".repeat(80)}`]: "" }),
    ).toThrow("INVALID_PATH");
  });

  it("refuses unsupported JSON values and tampered manifests", async () => {
    for (const value of [
      undefined,
      NaN,
      { a: undefined },
      new Date(),
      Array(2),
    ])
      expect(() => canonicalJson(value)).toThrow("INVALID_CANONICAL_JSON");
    const source = await createSourceManifest({ "src/a.ts": "YWJj" });
    source.files[0].byteSize = 2;
    await expect(validateSourceManifest(source)).rejects.toThrow(
      "SOURCE_HASH_MISMATCH",
    );
  });
});

describe("v2 packs and immutable rule snapshots", () => {
  it("provides one-case/two-case development packs and all eight course cases without changing internal IDs", async () => {
    const one = await fixture();
    const two = await fixture("new-filter");
    const course = await fixture("course");
    expect(one.pack.cases.map((entry) => entry.caseId)).toEqual(["NEW-01"]);
    expect(two.pack.cases.map((entry) => entry.caseId)).toEqual([
      "NEW-01",
      "FILTER-03",
    ]);
    expect(course.pack.cases.map((entry) => entry.caseId)).toEqual([
      ...CORE_CASE_IDS,
    ]);
    expect(
      course.pack.criteria.map((entry) => [
        entry.criterionId,
        entry.displayCode,
      ]),
    ).toEqual([
      ["create", "CK-01"],
      ["validation", "CK-02"],
      ["toggle", "CK-03"],
      ["filter", "CK-04"],
      ["persistence", "CK-05"],
    ]);
    expect(
      course.pack.cases
        .find((entry) => entry.caseId === "FILTER-03")!
        .plannedSteps.some((step) => step.stepId === "action:select-active"),
    ).toBe(false);
  });

  it("does not invent implementation hashes or attest checker execution", async () => {
    await expect(
      createDevelopmentPack("new-only", {
        ...buildIdentity,
        caseImplementationHashes: {},
      }),
    ).rejects.toThrow("IMPLEMENTATION_HASH_REQUIRED");
  });

  it("rejects duplicate cases, missing groups, unknown requirements, and empty automatic criteria", async () => {
    const { pack, rule } = await fixture("course");
    expect(() =>
      taskPackManifestSchema.parse({
        ...pack,
        cases: [...pack.cases, pack.cases[0]],
      }),
    ).toThrow("DUPLICATE_ID");
    expect(() =>
      taskPackManifestSchema.parse({
        ...pack,
        cases: pack.cases.filter((entry) => entry.criterionId !== "create"),
      }),
    ).toThrow("EMPTY_AUTO_CRITERION");
    expect(() =>
      ruleSnapshotSchema.parse({
        ...rule,
        requiredCaseIds: rule.requiredCaseIds.filter(
          (id) => id !== "FILTER-02",
        ),
      }),
    ).toThrow("REQUIRED_CASE_SET_MISMATCH");
    expect(() =>
      ruleSnapshotSchema.parse({
        ...rule,
        requiredCaseIds: [...rule.requiredCaseIds, "UNKNOWN-01"],
      }),
    ).toThrow("REQUIRED_CASE_SET_MISMATCH");
    expect(() =>
      ruleSnapshotSchema.parse({ ...rule, enabledCriterionIds: ["unknown"] }),
    ).toThrow("UNKNOWN_CRITERION");
  });

  it("rejects unbounded/undeclared parameters and detects parameter/body hash changes", async () => {
    const { rule } = await fixture("course");
    expect(() =>
      validateParameterValues({}, { command: "echo untrusted" }),
    ).toThrow("PARAMETER_KEYS_MISMATCH");
    expect(() =>
      validateParameterValues(
        { count: { type: "integer", minimum: 1, maximum: 5, default: 2 } },
        { count: 6 },
      ),
    ).toThrow("INVALID_PARAMETER");
    await expect(
      validateRuleSnapshot({
        ...rule,
        parameterValues: { requireValidationMessage: true },
      }),
    ).rejects.toThrow("PARAMETERS_HASH_MISMATCH");
    const changed = copy(rule);
    changed.packManifest.cases[0].expected = "silently changed requirement";
    await expect(validateRuleSnapshot(changed)).rejects.toThrow(
      "PACK_HASH_MISMATCH",
    );
  });

  it("hashes declared sets independently of order, while changing actual planned order changes the pack", async () => {
    const { pack, rule } = await fixture("course");
    expect(
      await hashTaskPack({
        ...pack,
        cases: [...pack.cases].reverse(),
        criteria: [...pack.criteria].reverse(),
      }),
    ).toBe(pack.contentHash);
    const changed = copy(pack);
    changed.cases[0].plannedSteps.reverse();
    expect(await hashTaskPack(changed)).not.toBe(pack.contentHash);
    expect(
      await hashRuleSnapshot({
        ...rule,
        enabledCriterionIds: [...rule.enabledCriterionIds].reverse(),
        requiredCaseIds: [...rule.requiredCaseIds].reverse(),
      }),
    ).toBe(await hashRuleSnapshot(rule));
  });

  it("allows a manual criterion without fabricating an automatic case", async () => {
    const { pack, rule } = await fixture();
    const changed = copy(pack);
    changed.criteria.push({
      criterionId: "readability",
      displayCode: "CK-06",
      title: "可读性",
      mode: "manual",
      expectedBehavior: "教师阅读源码判断",
    });
    changed.contentHash = await hashTaskPack(changed);
    const manualRule = await createRuleSnapshot({
      ...rule,
      packManifest: changed,
      enabledCriterionIds: ["readability"],
    });
    expect(manualRule.requiredCaseIds).toEqual([]);
    expect(aggregateResults(manualRule, [])[0]).toMatchObject({
      criterionId: "readability",
      verdict: "manual",
      passedCaseIds: [],
    });
  });
});

describe("v2 actual steps and case aggregation", () => {
  it("classifies preparation faults and ambiguous observations without assigning student failures", () => {
    expect(
      classifyCaseOutcome({
        preconditionStatus: "blocked",
        observation: "violated",
      }).verdict,
    ).toBe("not_run");
    expect(
      classifyCaseOutcome({
        preconditionStatus: "uncertain",
        observation: "violated",
      }).verdict,
    ).toBe("manual");
    expect(
      classifyCaseOutcome({
        preconditionStatus: "satisfied",
        observation: "violated",
      }).verdict,
    ).toBe("failed");
    expect(
      classifyCaseOutcome({
        preconditionStatus: "satisfied",
        observation: "not_observed",
        interruption: "TIME_BUDGET",
      }),
    ).toMatchObject({ verdict: "not_run", reasonCode: "TIME_BUDGET" });
  });

  it("rejects missing, duplicate, unknown and wrongly attributed case results", async () => {
    const { pack, rule } = await fixture();
    const result = resultFor(pack.cases[0]);
    expect(() => validateCaseResults(rule, [])).toThrow(
      "RESULT_CASE_SET_MISMATCH",
    );
    expect(() => validateCaseResults(rule, [result, result])).toThrow(
      "DUPLICATE_ID",
    );
    expect(() =>
      validateCaseResults(rule, [{ ...result, caseId: "NOPE-01" }]),
    ).toThrow("RESULT_CASE_SET_MISMATCH");
    expect(() =>
      validateCaseResults(rule, [{ ...result, criterionId: "filter" }]),
    ).toThrow("CASE_IDENTITY_MISMATCH");
  });

  it("requires a real prefix of executed steps and explicitly records unexecuted suffixes", async () => {
    const { pack, rule } = await fixture("new-filter");
    const create = resultFor(pack.cases[0], "failed");
    const definition = pack.cases[1];
    const blocked = resultFor(definition, "not_run");
    blocked.preconditionStatus = "blocked";
    blocked.reasonCode = "SETUP_BLOCKED";
    blocked.executedSteps = resultFor(definition)
      .executedSteps.slice(0, 2)
      .map((step, index) => ({
        ...step,
        state: index ? "failed" : "completed",
        evidenceIds: [],
      }));
    blocked.unexecutedStepIds = definition.plannedSteps
      .slice(2)
      .map((step) => step.stepId);
    blocked.blockedBy = [
      {
        kind: "setup_step",
        id: "setup:create-mixed-tasks",
        reasonCode: "SETUP_BLOCKED",
      },
    ];
    expect(validateCaseResults(rule, [create, blocked])[1].verdict).toBe(
      "not_run",
    );
    const fakeDependency = copy(blocked);
    fakeDependency.blockedBy[0].id = "NEW-01";
    expect(() => validateCaseResults(rule, [create, fakeDependency])).toThrow(
      "UNOBSERVED_SETUP_BLOCKER",
    );
    const copiedPlan = copy(blocked);
    copiedPlan.executedSteps.push({
      ...resultFor(definition).executedSteps[2],
      evidenceIds: [],
    });
    copiedPlan.unexecutedStepIds.shift();
    expect(() => validateCaseResults(rule, [create, copiedPlan])).toThrow(
      "INVALID_STEP_SEQUENCE",
    );
    expect(() =>
      caseResultSchema.parse({ ...blocked, verdict: "failed" }),
    ).toThrow("PRECONDITION_NOT_SATISFIED");
  });

  it("keeps failed > not_run > manual > passed precedence and all contributing case groups", async () => {
    const { pack, rule } = await fixture("course");
    const results = pack.cases.map((definition) => resultFor(definition));
    for (const [caseId, verdict] of [
      ["FILTER-01", "failed"],
      ["FILTER-02", "not_run"],
      ["FILTER-03", "manual"],
    ] as const) {
      const index = results.findIndex((entry) => entry.caseId === caseId);
      results[index] = resultFor(pack.cases[index], verdict);
    }
    expect(
      aggregateResults(rule, results).find(
        (entry) => entry.criterionId === "filter",
      ),
    ).toEqual({
      criterionId: "filter",
      verdict: "failed",
      failedCaseIds: ["FILTER-01"],
      notRunCaseIds: ["FILTER-02"],
      manualCaseIds: ["FILTER-03"],
      passedCaseIds: [],
    });
    results[results.findIndex((entry) => entry.caseId === "FILTER-01")] =
      resultFor(pack.cases.find((entry) => entry.caseId === "FILTER-01")!);
    expect(
      aggregateResults(rule, results).find(
        (entry) => entry.criterionId === "filter",
      )!.verdict,
    ).toBe("not_run");
    results[results.findIndex((entry) => entry.caseId === "FILTER-02")] =
      resultFor(pack.cases.find((entry) => entry.caseId === "FILTER-02")!);
    expect(
      aggregateResults(rule, results).find(
        (entry) => entry.criterionId === "filter",
      )!.verdict,
    ).toBe("manual");
  });
});

describe("v2 evidence belongs to its run, manifest and exact case", () => {
  it("accepts a fully bound response with checked payload bytes", async () => {
    const { response, options } = await responseFixture("new-filter");
    await expect(validateRunResponse(response, options)).resolves.toEqual(
      response,
    );
  });

  it("rejects cross-case references even within the same run", async () => {
    const { response, options } = await responseFixture("new-filter");
    const crossed = copy(response);
    crossed.caseResults[0].evidenceIds.push(
      crossed.caseResults[1].evidenceIds[0],
    );
    await expect(validateRunResponse(crossed, options)).rejects.toThrow(
      "CROSS_CASE_EVIDENCE",
    );
  });

  it("rejects forged context, missing references, duplicate artifacts and changed bytes", async () => {
    const { response, options } = await responseFixture();
    const foreign = copy(response.baseManifest);
    foreign.evidence[0].submissionId = id(999);
    expect(() => artifactManifestSchema.parse(foreign)).toThrow(
      "EVIDENCE_CONTEXT_MISMATCH",
    );
    const missing = copy(response);
    missing.caseResults[0].evidenceIds.push(id(999));
    await expect(validateRunResponse(missing, options)).rejects.toThrow(
      "EVIDENCE_REFERENCE_MISSING",
    );
    await expect(
      validateArtifactPayloads(response.baseManifest, [
        ...response.artifacts,
        response.artifacts[0],
      ]),
    ).rejects.toThrow("DUPLICATE_ID");
    await expect(
      validateArtifactPayloads(response.baseManifest, [
        { ...response.artifacts[0], data: bytes64("changed") },
      ]),
    ).rejects.toThrow("ARTIFACT_HASH_MISMATCH");
    const altered = copy(response.baseManifest);
    altered.evidence[0].capturedAt = later(1);
    await expect(
      validateArtifactManifest(altered, {
        rule: options.rule,
        expectedContext: altered.context,
      }),
    ).rejects.toThrow("MANIFEST_HASH_MISMATCH");
  });

  it("includes base64 expansion in the 16 MiB response boundary", async () => {
    const { response } = await responseFixture();
    const boundedPngBytes = new Uint8Array(LIMITS_V1.pngMaxBytes);
    boundedPngBytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
    const data = encodeBase64(boundedPngBytes);
    // 13 decoded MiB fits 16 MiB, but the encoded JSON exceeds it.
    response.artifacts = Array.from({ length: 13 }, (_, index) => ({
      evidenceId: id(1000 + index),
      encoding: "base64" as const,
      data,
    }));
    expect(() => runnerExecuteResponseSchema.parse(response)).toThrow(
      "PAYLOAD_TOO_LARGE",
    );
  });

  it("permits run-level build-log references but does not use them as proof of functional success", async () => {
    const { response, pack } = await responseFixture();
    const evidence = {
      ...response.baseManifest.evidence[0],
      scope: "run" as const,
      criterionId: null,
      caseId: null,
      phase: "build" as const,
      contentOrigin: "student_console" as const,
    };
    const manifest: ArtifactManifest = {
      ...response.baseManifest,
      evidence: [evidence],
    };
    const notRun = resultFor(pack.cases[0], "not_run");
    notRun.reasonCode = "BUILD_ERROR";
    notRun.evidenceIds = [evidence.evidenceId];
    expect(() =>
      validateCaseEvidenceReferences([notRun], manifest),
    ).not.toThrow();
    expect(() =>
      validateCaseEvidenceReferences(response.caseResults, manifest),
    ).toThrow("CASE_OBSERVATION_EVIDENCE_REQUIRED");
  });

  it("requires supplemental analysis and operation identities and prevents blending into a base manifest", async () => {
    const { response } = await responseFixture();
    const base = copy(response.baseManifest);
    base.evidence[0].phase = "probe";
    expect(() => artifactManifestSchema.parse(base)).toThrow(
      "SUPPLEMENTAL_IDENTITY_REQUIRED",
    );
    base.evidence[0].analysisAttemptId = id(200);
    base.evidence[0].operationId = id(201);
    expect(() => artifactManifestSchema.parse(base)).toThrow(
      "EVIDENCE_MANIFEST_MISMATCH",
    );
    const supplemental = {
      ...base,
      source: "supplemental" as const,
      analysisAttemptId: id(200),
      operationId: id(201),
    };
    supplemental.contentHash = await hashArtifactManifest(supplemental);
    expect(artifactManifestSchema.parse(supplemental).source).toBe(
      "supplemental",
    );
  });
});

describe("v2 measurement completeness and comparison", () => {
  it("requires exact missing fields and does not upgrade partial/unknown environments", async () => {
    const { fingerprint } = await fixture();
    expect(
      measuredEnvironmentSchema.parse(unknownMeasuredEnvironment())
        .missingFields,
    ).toHaveLength(MEASUREMENT_FIELDS.length);
    expect(() =>
      measuredEnvironmentSchema.parse({
        completeness: "complete",
        values: {},
        missingFields: [],
      }),
    ).toThrow("MEASUREMENT_MISSING_FIELDS_MISMATCH");
    const partial = {
      completeness: "partial" as const,
      values: { templateHash: fingerprint.templateHash },
      missingFields: MEASUREMENT_FIELDS.filter(
        (field) => field !== "templateHash",
      ),
    };
    expect(
      compareMeasurements(partial, {
        completeness: "complete",
        values: fingerprint,
        missingFields: [],
      }).status,
    ).toBe("unknown");
    expect(() =>
      measuredEnvironmentSchema.parse({
        ...partial,
        values: { templateHash: undefined },
      }),
    ).toThrow("MEASUREMENT_VALUE_UNDEFINED");
  });

  it("requires exact actual image and browser conditions and reports differing fields", async () => {
    const { fingerprint } = await fixture();
    const before = {
      completeness: "complete" as const,
      values: fingerprint,
      missingFields: [],
    };
    const after = copy(before);
    after.values.browserImage.value = `sha256:${otherHash}`;
    after.values.chromiumVersion = "synthetic-2";
    const comparison = compareMeasurements(before, after);
    expect(comparison.status).toBe("incompatible");
    if (comparison.status === "incompatible")
      expect(comparison.items.map((item) => item.field)).toEqual([
        "browserImage",
        "chromiumVersion",
      ]);
  });

  it("allows changed student source under the same conditions but gates run-level identity and legacy records", async () => {
    const { response, rule } = await responseFixture();
    const before: ComparisonRun = {
      contractVersion: 2,
      studentId: id(400),
      taskId: rule.taskId,
      ruleId: rule.ruleId,
      actualFingerprint: response.actualFingerprint,
      caseResults: response.caseResults,
    };
    const after = copy(before);
    after.caseResults[0].verdict = "failed";
    expect(compareCaseResults(before, after)).toMatchObject({
      status: "compatible",
      caseDiffs: [{ caseId: "NEW-01", change: "regression" }],
    });
    expect(
      compareCaseResults(before, { ...after, taskId: id(401) }),
    ).toMatchObject({
      status: "incompatible",
      reasonCode: "COMPARISON_SCOPE_MISMATCH",
      caseDiffs: [],
    });
    expect(compareCaseResults({ contractVersion: 1 }, after)).toMatchObject({
      status: "unknown",
      reasonCode: "LEGACY_MEASUREMENT_UNKNOWN",
    });
    expect(
      compareCaseResults(
        { ...before, actualFingerprint: unknownMeasuredEnvironment() },
        after,
      ),
    ).toMatchObject({ status: "unknown", reasonCode: "MEASUREMENT_UNKNOWN" });
  });
});

describe("v2 runner request, failure and replay boundaries", () => {
  it("keeps v1 parsing intact and requires explicit v2 fields", async () => {
    expect(
      legacyRunnerResponseSchema.parse({
        outcome: "complete",
        results: [],
        evidence: [],
      }).screenshots,
    ).toEqual({});
    expect(() =>
      runnerExecuteResponseSchema.parse({
        outcome: "complete",
        results: [],
        evidence: [],
      }),
    ).toThrow();
    const { response } = await responseFixture();
    expect(() =>
      runnerExecuteResponseSchema.parse({
        ...response,
        arbitraryCommand: "sh",
      }),
    ).toThrow();
  });

  it("validates transmitted source and operation hashes before accepting a request", async () => {
    const { request } = await fixture();
    await expect(validateRunRequest(request)).resolves.toEqual(request);
    await expect(
      validateRunRequest({
        ...request,
        files: { "src/App.vue": bytes64("changed") },
      }),
    ).rejects.toThrow("SOURCE_HASH_MISMATCH");
    await expect(
      validateRunRequest({ ...request, requestHash: otherHash }),
    ).rejects.toThrow("REQUEST_HASH_MISMATCH");
    expect(
      await hashExecuteRequest({
        ...request,
        requestId: id(999),
        ownerToken: "refreshed-ownership-token",
        leaseUntil: later(40_000),
      }),
    ).toBe(request.requestHash);
  });

  it("requires bounded initial owner times without treating a replay as admission", async () => {
    const { request } = await fixture();
    const { startedAt: _started, ...withoutStart } = request;
    const { leaseUntil: _lease, ...withoutLease } = request;
    expect(() => runnerExecuteRequestSchema.parse(withoutStart)).toThrow();
    expect(() => runnerExecuteRequestSchema.parse(withoutLease)).toThrow();
    for (const invalid of [
      { startedAt: request.workDeadlineAt },
      { hardDeadlineAt: later(300_001) },
      { workDeadlineAt: later(269_999) },
      { leaseUntil: now },
      { leaseUntil: later(300_001) },
    ])
      expect(() =>
        runnerExecuteRequestSchema.parse({ ...request, ...invalid }),
      ).toThrow("OWNER_DEADLINES_INVALID");

    // Static decoding deliberately does not compare an old replay to Date.now().
    // New-owner freshness and any actual renewal are decided by the durable store.
    expect(runnerExecuteRequestSchema.parse(request)).toEqual(request);
    await expect(
      validateRunRequest({ ...request, leaseUntil: later(40_000) }),
    ).resolves.toMatchObject({ requestHash: request.requestHash });
  });

  it("binds execute hashes to fixed owner identity and absolute deadlines", async () => {
    const { request } = await fixture();
    for (const changed of [
      { startedAt: later(1) },
      { workDeadlineAt: later(269_999) },
      { hardDeadlineAt: later(299_999) },
      { context: { ...request.context, runId: id(998) } },
      { context: { ...request.context, executionAttemptId: id(999) } },
    ])
      expect(await hashExecuteRequest({ ...request, ...changed })).not.toBe(
        request.requestHash,
      );
  });

  it("uses a separate strict heartbeat transport with an exact lease acknowledgment", () => {
    const heartbeat = {
      protocolVersion: 2,
      owner: {
        runId: id(4),
        ownerKind: "execution",
        ownerId: id(5),
        ownerToken: "synthetic-owner-token-only",
      },
      leaseUntil: later(40_000),
    };
    expect(runnerHeartbeatRequestSchema.parse(heartbeat)).toEqual(heartbeat);
    for (const invalid of [
      { ...heartbeat, protocolVersion: 1 },
      { ...heartbeat, leaseUntil: "tomorrow" },
      { ...heartbeat, owner: { ...heartbeat.owner, ownerToken: "short" } },
      { ...heartbeat, startedAt: now },
      { ...heartbeat, workDeadlineAt: later(400_000) },
      { ...heartbeat, hardDeadlineAt: later(430_000) },
      { ...heartbeat, operationId: id(7) },
    ])
      expect(() => runnerHeartbeatRequestSchema.parse(invalid)).toThrow();
    const response = { protocolVersion: 2, leaseUntil: later(40_000) };
    expect(runnerHeartbeatResponseSchema.parse(response)).toEqual(response);
    expect(() =>
      runnerHeartbeatResponseSchema.parse({ leaseUntil: later(40_000) }),
    ).toThrow();
    expect(() =>
      runnerHeartbeatResponseSchema.parse({
        ...response,
        owner: heartbeat.owner,
      }),
    ).toThrow();
  });

  it("shares cleanup identity hashing without accepting trace IDs or tokens as action identity", async () => {
    const body: Omit<RunnerCleanupRequest, "requestHash"> = {
      protocolVersion: 2,
      owner: {
        runId: id(4),
        ownerKind: "execution",
        ownerId: id(5),
        ownerToken: "synthetic-owner-token-only",
      },
      operationId: id(7),
      requestId: id(8),
    };
    const requestHash = await hashCleanupRequest(body);
    const request = { ...body, requestHash };
    expect(runnerCleanupRequestSchema.parse(request)).toEqual(request);
    expect(requestHash).toBe(
      await sha256(
        canonicalJson({
          protocolVersion: 2,
          owner: { runId: id(4), ownerKind: "execution", ownerId: id(5) },
          operationId: id(7),
        }),
      ),
    );
    expect(
      await hashCleanupRequest({
        ...request,
        requestHash: otherHash,
        requestId: id(99),
        owner: { ...request.owner, ownerToken: "different-ownership-token" },
      }),
    ).toBe(requestHash);
    for (const changed of [
      { operationId: id(99) },
      { owner: { ...body.owner, runId: id(99) } },
      { owner: { ...body.owner, ownerId: id(99) } },
      { owner: { ...body.owner, ownerKind: "analysis" as const } },
    ])
      expect(await hashCleanupRequest({ ...request, ...changed })).not.toBe(
        requestHash,
      );
  });

  it("keeps operation queries read-only in shape and requires an explicit response or null", () => {
    const owner = {
      runId: id(4),
      ownerKind: "execution" as const,
      ownerId: id(5),
      ownerToken: "synthetic-owner-token-only",
    };
    const query = {
      protocolVersion: 2,
      owner,
      operationId: id(7),
      requestHash: hash,
    };
    expect(runnerOperationQueryRequestSchema.parse(query)).toEqual(query);
    const { requestHash: _hash, ...withoutHash } = query;
    expect(runnerOperationQueryRequestSchema.parse(withoutHash)).toEqual(
      withoutHash,
    );
    expect(() =>
      runnerOperationQueryRequestSchema.parse({
        ...query,
        leaseUntil: later(40_000),
      }),
    ).toThrow();
    const record: RunnerOperationRecord = {
      operationId: id(7),
      requestHash: hash,
      runId: owner.runId,
      ownerKind: owner.ownerKind,
      ownerId: owner.ownerId,
      kind: "execute",
      state: "unknown",
      responseHash: null,
    };
    expect(
      runnerOperationQueryResponseSchema.parse({ record, response: null }),
    ).toEqual({ record, response: null });
    expect(() =>
      runnerOperationQueryResponseSchema.parse({ record }),
    ).toThrow();
    expect(() =>
      runnerOperationQueryResponseSchema.parse({
        record,
        response: null,
        tokenHash: hash,
      }),
    ).toThrow();
    expect(
      runnerOperationQueryResponseSchema.parse({
        record,
        response: { saved: "result" },
      }),
    ).toEqual({ record, response: { saved: "result" } });
  });

  it("rejects a response from another operation, rule or approved runtime", async () => {
    const { response, options } = await responseFixture();
    await expect(
      validateRunResponse(
        { ...response, context: { ...response.context, operationId: id(999) } },
        options,
      ),
    ).rejects.toThrow("OPERATION_CONTEXT_MISMATCH");
    await expect(
      validateRunResponse(
        { ...response, context: { ...response.context, ruleHash: otherHash } },
        options,
      ),
    ).rejects.toThrow("CONTEXT_MISMATCH");
    const different = copy(response);
    different.actualFingerprint.values.chromiumVersion = "unapproved-browser";
    await expect(validateRunResponse(different, options)).rejects.toThrow(
      "ACTUAL_ENVIRONMENT_MISMATCH",
    );
  });

  it("preserves a real unknown-environment failure without inventing steps or source verification", async () => {
    const { response, pack, context, options } = await responseFixture();
    const fault = copy(response);
    fault.outcome = "infra_error";
    fault.context.observedSourceManifestSha256 = null;
    fault.context.sourceVerificationReason =
      "Runner failed before receiving verified editable source";
    fault.actualFingerprint = unknownMeasuredEnvironment();
    fault.caseResults = pack.cases.map((definition) =>
      resultFor(definition, "not_run"),
    );
    fault.baseManifest = await createArtifactManifest({
      manifestId: id(800),
      context,
      source: "base",
      analysisAttemptId: null,
      operationId: null,
      evidence: [],
      completeness: "partial",
    });
    fault.artifacts = [];
    fault.resourceState = "cleanup_pending";
    await expect(validateRunResponse(fault, options)).resolves.toEqual(fault);
    expect(() =>
      runnerExecuteResponseSchema.parse({ ...fault, outcome: "complete" }),
    ).toThrow("NORMAL_MEASUREMENT_INCOMPLETE");
    expect(() =>
      runnerExecuteResponseSchema.parse({
        ...fault,
        context: { ...fault.context, sourceVerificationReason: null },
      }),
    ).toThrow("SOURCE_VERIFICATION_REASON_REQUIRED");
  });

  it("does not accept functional results after a reported build failure", async () => {
    const { response, options } = await responseFixture();
    await expect(
      validateRunResponse({ ...response, outcome: "build_error" }, options),
    ).rejects.toThrow("BUILD_ERROR_RESULT_INVALID");
  });

  it("replays only the same owner, action and hash and keeps unknown results unknown", () => {
    const record: RunnerOperationRecord = {
      operationId: id(7),
      requestHash: hash,
      runId: id(4),
      ownerKind: "execution",
      ownerId: id(5),
      kind: "execute",
      state: "unknown",
      responseHash: null,
    };
    const { state: _state, responseHash: _response, ...incoming } = record;
    expect(validateReplayIdentity(record, incoming)).toEqual({
      decision: "return_existing",
      state: "unknown",
      operationId: id(7),
    });
    expect(() =>
      validateReplayIdentity(record, { ...incoming, requestHash: otherHash }),
    ).toThrow("OPERATION_PAYLOAD_CONFLICT");
    expect(() =>
      validateReplayIdentity(record, { ...incoming, ownerId: id(999) }),
    ).toThrow("OPERATION_SCOPE_MISMATCH");
  });

  it("enforces absolute work deadlines and cleanup reserve without renewing them on replay", () => {
    const deadline = {
      workDeadlineAt: later(270_000),
      hardDeadlineAt: later(300_000),
      remainingWorkMs: 270_000,
    };
    expect(
      runnerRemainingWorkMs(deadline, Date.parse(now) + 100_000, 270_000),
    ).toBe(170_000);
    expect(
      runnerRemainingWorkMs(deadline, Date.parse(now) + 280_000, 270_000),
    ).toBe(0);
    expect(() =>
      runnerRemainingWorkMs(
        { ...deadline, workDeadlineAt: later(280_000) },
        Date.parse(now),
        270_000,
      ),
    ).toThrow("CLEANUP_RESERVE_MISSING");
    expect(() =>
      runnerRemainingWorkMs(
        {
          ...deadline,
          workDeadlineAt: later(300_000),
          hardDeadlineAt: later(330_000),
        },
        Date.parse(now),
        270_000,
      ),
    ).toThrow("DEADLINE_EXCEEDS_BUDGET");
  });

  it("allows only registered probes and empty FILTER_ORDER_CHECK parameters", async () => {
    const { context, request, rule } = await fixture("new-filter");
    const probe: RunnerProbeRequest = {
      protocolVersion: 2,
      context,
      owner: {
        runId: context.runId,
        ownerKind: "execution",
        ownerId: context.executionAttemptId,
        ownerToken: request.ownerToken,
      },
      analysisAttemptId: id(500),
      operationId: id(501),
      requestHash: hash,
      requestId: id(502),
      probeId: "FILTER_ORDER_CHECK",
      parameters: {},
      workDeadlineAt: later(60_000),
      hardDeadlineAt: later(90_000),
      remainingWorkMs: 60_000,
      budgetConfigVersion: "analysis-budget-v1",
    };
    probe.requestHash = await hashProbeRequest(probe);
    expect((await validateProbeRequest(probe, rule)).probeId).toBe(
      "FILTER_ORDER_CHECK",
    );
    await expect(
      validateProbeRequest(
        { ...probe, parameters: { command: "do anything" } },
        rule,
      ),
    ).rejects.toThrow("PARAMETER_KEYS_MISMATCH");
    await expect(
      validateProbeRequest({ ...probe, probeId: "ARBITRARY_ACTION" }, rule),
    ).rejects.toThrow("PROBE_NOT_ENABLED");
    await expect(
      validateProbeRequest({ ...probe, requestHash: otherHash }, rule),
    ).rejects.toThrow("REQUEST_HASH_MISMATCH");
  });

  it("does not confuse run completion with clean resources", () => {
    expect(() =>
      runnerCapabilitiesSchema.parse({
        protocolVersion: 2,
        limitsVersion: "limits-v1",
        state: "ready",
        templateHashes: [],
        packManifestHashes: [],
        actualEnvironment: unknownMeasuredEnvironment(),
        activeOwner: { runId: id(4), ownerKind: "execution", ownerId: id(5) },
        residualResourceIds: [],
        admissionRecordVersion: "not-yet-admitted",
      }),
    ).toThrow("RUNNER_NOT_CLEAN");
    expect(() =>
      runnerCleanupResponseSchema.parse({
        protocolVersion: 2,
        runId: id(4),
        ownerKind: "execution",
        ownerId: id(5),
        operationId: id(7),
        requestHash: hash,
        state: "clean",
        residualResourceIds: ["synthetic-residue"],
        completedAt: now,
      }),
    ).toThrow("CLEANUP_RECEIPT_INVALID");
  });
});
