import { z } from "zod";
import {
  businessIdSchema,
  canonicalJson,
  fail,
  lexicalCompare,
  refineWith,
  requireUnique,
  sha256,
  sha256Schema,
  utcDateTimeSchema,
  uuidSchema,
  versionSchema,
} from "./primitives";

export const CORE_CASE_IDS = [
  "NEW-01",
  "VALID-01",
  "VALID-02",
  "STATE-01",
  "FILTER-01",
  "FILTER-02",
  "FILTER-03",
  "SAVE-01",
] as const;
export type CoreCaseId = (typeof CORE_CASE_IDS)[number];
export const AGGREGATION_VERSION = "aggregation-v1" as const;

export const parameterDefinitionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("boolean"), default: z.boolean() }).strict(),
  z
    .object({
      type: z.literal("integer"),
      minimum: z.number().int().safe(),
      maximum: z.number().int().safe(),
      default: z.number().int().safe(),
    })
    .strict(),
  z
    .object({
      type: z.literal("enum"),
      values: z.array(z.string().min(1).max(120)).min(1).max(32),
      default: z.string().min(1).max(120),
    })
    .strict(),
]);
export const boundedParameterSchema = z
  .record(
    z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,59}$/),
    parameterDefinitionSchema,
  )
  .superRefine((parameters, ctx) =>
    refineWith(ctx, () => {
      if (Object.keys(parameters).length > 20)
        fail("PARAMETER_LIMIT", "At most 20 bounded parameters");
      for (const [name, parameter] of Object.entries(parameters)) {
        if (
          parameter.type === "integer" &&
          (parameter.minimum > parameter.maximum ||
            parameter.default < parameter.minimum ||
            parameter.default > parameter.maximum)
        )
          fail("INVALID_PARAMETER", name);
        if (parameter.type === "enum") {
          requireUnique(parameter.values, `parameter ${name}`);
          if (!parameter.values.includes(parameter.default))
            fail("INVALID_PARAMETER", name);
        }
      }
    }),
  );
export type BoundedParameterSchema = z.infer<typeof boundedParameterSchema>;
export type ParameterValues = Record<string, boolean | number | string>;

export function validateParameterValues(
  definitions: BoundedParameterSchema,
  values: unknown,
): ParameterValues {
  const definition = boundedParameterSchema.parse(definitions);
  const parsed = z
    .record(z.union([z.boolean(), z.number().finite(), z.string()]))
    .parse(values);
  if (
    canonicalJson(Object.keys(definition).sort(lexicalCompare)) !==
    canonicalJson(Object.keys(parsed).sort(lexicalCompare))
  )
    fail(
      "PARAMETER_KEYS_MISMATCH",
      "All and only declared parameters are required",
    );
  for (const [name, parameter] of Object.entries(definition)) {
    const value = parsed[name];
    if (parameter.type === "boolean" && typeof value !== "boolean")
      fail("INVALID_PARAMETER", name);
    if (
      parameter.type === "integer" &&
      (typeof value !== "number" ||
        !Number.isSafeInteger(value) ||
        value < parameter.minimum ||
        value > parameter.maximum)
    )
      fail("INVALID_PARAMETER", name);
    if (
      parameter.type === "enum" &&
      (typeof value !== "string" || !parameter.values.includes(value))
    )
      fail("INVALID_PARAMETER", name);
  }
  return parsed;
}

export const plannedStepSchema = z
  .object({
    stepId: businessIdSchema,
    phase: z.enum(["setup", "action", "assert"]),
    description: z.string().min(1).max(1000),
  })
  .strict();
export const criterionDefinitionSchema = z
  .object({
    criterionId: businessIdSchema,
    displayCode: z.string().regex(/^CK-\d{2}$/),
    title: z.string().min(1).max(160),
    mode: z.enum(["auto", "manual"]),
    expectedBehavior: z.string().min(1).max(3000),
  })
  .strict();
export const caseDefinitionSchema = z
  .object({
    caseId: businessIdSchema,
    criterionId: businessIdSchema,
    setupPlanId: businessIdSchema,
    expected: z.string().min(1).max(3000),
    plannedSteps: z.array(plannedStepSchema).min(3).max(32),
    timeoutMs: z.number().int().positive().max(75_000),
    implementationHash: sha256Schema,
  })
  .strict()
  .superRefine((definition, ctx) =>
    refineWith(ctx, () => {
      requireUnique(
        definition.plannedSteps.map((step) => step.stepId),
        `steps of ${definition.caseId}`,
      );
      for (const phase of ["setup", "action", "assert"])
        if (!definition.plannedSteps.some((step) => step.phase === phase))
          fail("MISSING_PLAN_PHASE", `${definition.caseId}: ${phase}`);
      const firstNonSetup = definition.plannedSteps.findIndex(
        (step) => step.phase !== "setup",
      );
      if (
        definition.plannedSteps
          .slice(firstNonSetup)
          .some((step) => step.phase === "setup")
      )
        fail("INVALID_SETUP_ORDER", definition.caseId);
    }),
  );
export const probeDefinitionSchema = z
  .object({
    probeId: businessIdSchema,
    applicableCriterionIds: z.array(businessIdSchema).min(1).max(15),
    parameterSchema: boundedParameterSchema,
    setupPlanId: businessIdSchema,
    plannedPaths: z
      .array(
        z
          .object({
            pathId: businessIdSchema,
            plannedSteps: z.array(plannedStepSchema).min(1).max(32),
          })
          .strict(),
      )
      .min(1)
      .max(4),
    maxDurationMs: z.number().int().positive().max(30_000),
    implementationHash: sha256Schema,
  })
  .strict()
  .superRefine((probe, ctx) =>
    refineWith(ctx, () => {
      requireUnique(probe.applicableCriterionIds, "probe criteria");
      requireUnique(
        probe.plannedPaths.map((path) => path.pathId),
        "probe paths",
      );
      for (const path of probe.plannedPaths)
        requireUnique(
          path.plannedSteps.map((step) => step.stepId),
          "probe steps",
        );
      if (
        probe.probeId === "FILTER_ORDER_CHECK" &&
        Object.keys(probe.parameterSchema).length
      )
        fail(
          "INVALID_PROBE_PARAMETERS",
          "FILTER_ORDER_CHECK v1 has no parameters",
        );
    }),
  );

export const taskPackManifestSchema = z
  .object({
    contractVersion: z.literal(2),
    hashAlgorithm: z.literal("canonical-json-v1"),
    packId: businessIdSchema,
    packVersion: versionSchema,
    contentHash: sha256Schema,
    templateVersion: versionSchema,
    templateHash: sha256Schema,
    dependencyLockHash: sha256Schema,
    initializationVersion: versionSchema,
    aggregationVersion: z.literal(AGGREGATION_VERSION),
    criteria: z.array(criterionDefinitionSchema).min(1).max(15),
    cases: z.array(caseDefinitionSchema).max(64),
    probes: z.array(probeDefinitionSchema).max(10),
    parameterSchema: boundedParameterSchema,
  })
  .strict()
  .superRefine((pack, ctx) =>
    refineWith(ctx, () => {
      requireUnique(
        pack.criteria.map((criterion) => criterion.criterionId),
        "criteria",
      );
      requireUnique(
        pack.criteria.map((criterion) => criterion.displayCode),
        "display codes",
      );
      requireUnique(
        pack.cases.map((entry) => entry.caseId),
        "cases",
      );
      requireUnique(
        pack.probes.map((probe) => probe.probeId),
        "probes",
      );
      const criteria = new Map(
        pack.criteria.map((criterion) => [criterion.criterionId, criterion]),
      );
      for (const entry of pack.cases)
        if (criteria.get(entry.criterionId)?.mode !== "auto")
          fail("CASE_CRITERION_INVALID", entry.caseId);
      for (const criterion of pack.criteria)
        if (
          criterion.mode === "auto" &&
          !pack.cases.some(
            (entry) => entry.criterionId === criterion.criterionId,
          )
        )
          fail("EMPTY_AUTO_CRITERION", criterion.criterionId);
      for (const probe of pack.probes)
        for (const id of probe.applicableCriterionIds)
          if (criteria.get(id)?.mode !== "auto")
            fail("PROBE_CRITERION_INVALID", id);
    }),
  );
export type TaskPackManifest = z.infer<typeof taskPackManifestSchema>;
export type CriterionDefinition = z.infer<typeof criterionDefinitionSchema>;
export type CaseDefinition = z.infer<typeof caseDefinitionSchema>;

function normalizeParameterSchema(
  parameters: BoundedParameterSchema,
): BoundedParameterSchema {
  return Object.fromEntries(
    Object.entries(parameters).map(([name, parameter]) => [
      name,
      parameter.type === "enum"
        ? { ...parameter, values: [...parameter.values].sort(lexicalCompare) }
        : parameter,
    ]),
  );
}

export async function hashTaskPack(
  pack: Omit<TaskPackManifest, "contentHash"> | TaskPackManifest,
): Promise<string> {
  const { contentHash: _self, ...body } = pack as TaskPackManifest;
  return sha256(
    canonicalJson({
      ...body,
      criteria: [...body.criteria].sort((a, b) =>
        lexicalCompare(a.criterionId, b.criterionId),
      ),
      cases: [...body.cases].sort((a, b) => lexicalCompare(a.caseId, b.caseId)),
      probes: [...body.probes]
        .sort((a, b) => lexicalCompare(a.probeId, b.probeId))
        .map((probe) => ({
          ...probe,
          applicableCriterionIds: [...probe.applicableCriterionIds].sort(
            lexicalCompare,
          ),
          parameterSchema: normalizeParameterSchema(probe.parameterSchema),
          plannedPaths: [...probe.plannedPaths].sort((a, b) =>
            lexicalCompare(a.pathId, b.pathId),
          ),
        })),
      parameterSchema: normalizeParameterSchema(body.parameterSchema),
    }),
  );
}

export async function validateTaskPack(
  pack: unknown,
): Promise<TaskPackManifest> {
  const parsed = taskPackManifestSchema.parse(pack);
  if ((await hashTaskPack(parsed)) !== parsed.contentHash)
    fail("PACK_HASH_MISMATCH", parsed.packId);
  return parsed;
}

export const ruleSnapshotSchema = z
  .object({
    contractVersion: z.literal(2),
    ruleId: uuidSchema,
    taskId: uuidSchema,
    version: z.number().int().positive(),
    packManifest: taskPackManifestSchema,
    packManifestHash: sha256Schema,
    enabledCriterionIds: z.array(businessIdSchema).min(1).max(15),
    requiredCaseIds: z.array(businessIdSchema).max(64),
    parameterValues: z.record(
      z.union([z.string(), z.number().finite(), z.boolean()]),
    ),
    parametersHash: sha256Schema,
    confirmedBy: uuidSchema,
    confirmedAt: utcDateTimeSchema,
  })
  .strict()
  .superRefine((rule, ctx) =>
    refineWith(ctx, () => {
      requireUnique(rule.enabledCriterionIds, "enabled criteria");
      requireUnique(rule.requiredCaseIds, "required cases");
      if (rule.packManifestHash !== rule.packManifest.contentHash)
        fail("PACK_HASH_MISMATCH", "rule snapshot");
      for (const id of rule.enabledCriterionIds)
        if (
          !rule.packManifest.criteria.some(
            (criterion) => criterion.criterionId === id,
          )
        )
          fail("UNKNOWN_CRITERION", id);
      const expected = rule.packManifest.cases
        .filter((entry) => rule.enabledCriterionIds.includes(entry.criterionId))
        .map((entry) => entry.caseId)
        .sort(lexicalCompare);
      if (
        canonicalJson(expected) !==
        canonicalJson([...rule.requiredCaseIds].sort(lexicalCompare))
      )
        fail(
          "REQUIRED_CASE_SET_MISMATCH",
          "An enabled criterion requires its whole published case group",
        );
      validateParameterValues(
        rule.packManifest.parameterSchema,
        rule.parameterValues,
      );
    }),
  );
export type RuleSnapshot = z.infer<typeof ruleSnapshotSchema>;

export async function validateRuleSnapshot(
  rule: unknown,
): Promise<RuleSnapshot> {
  const parsed = ruleSnapshotSchema.parse(rule);
  await validateTaskPack(parsed.packManifest);
  if (
    (await sha256(canonicalJson(parsed.parameterValues))) !==
    parsed.parametersHash
  )
    fail("PARAMETERS_HASH_MISMATCH", "rule snapshot");
  return parsed;
}

export async function hashRuleSnapshot(rule: RuleSnapshot): Promise<string> {
  const parsed = await validateRuleSnapshot(rule);
  // The validated pack content hash already covers its complete immutable body.
  const { packManifest: _pack, ...body } = parsed;
  return sha256(
    canonicalJson({
      ...body,
      enabledCriterionIds: [...body.enabledCriterionIds].sort(lexicalCompare),
      requiredCaseIds: [...body.requiredCaseIds].sort(lexicalCompare),
    }),
  );
}

export async function createRuleSnapshot(
  input: Omit<
    RuleSnapshot,
    | "contractVersion"
    | "packManifestHash"
    | "parametersHash"
    | "requiredCaseIds"
  >,
): Promise<RuleSnapshot> {
  const pack = await validateTaskPack(input.packManifest);
  return validateRuleSnapshot({
    ...input,
    contractVersion: 2,
    packManifestHash: pack.contentHash,
    parametersHash: await sha256(canonicalJson(input.parameterValues)),
    requiredCaseIds: pack.cases
      .filter((entry) => input.enabledCriterionIds.includes(entry.criterionId))
      .map((entry) => entry.caseId),
  });
}

export interface TaskPackBuildIdentity {
  packVersion: string;
  templateVersion: string;
  templateHash: string;
  dependencyLockHash: string;
  initializationVersion: string;
  caseImplementationHashes: Partial<Record<CoreCaseId, string>>;
  probeImplementationHashes?: { FILTER_ORDER_CHECK?: string };
}

const step = (
  stepId: string,
  phase: "setup" | "action" | "assert",
  description: string,
) => ({ stepId, phase, description });
const openStep = step(
  "setup:open-clean-context",
  "setup",
  "打开独立浏览器上下文并确认页面可交互",
);
const mixedSteps = [
  openStep,
  step(
    "setup:create-mixed-tasks",
    "setup",
    "通过公开交互创建两个未完成任务和一个已完成任务，确认身份及混合状态",
  ),
];
const descriptors: Record<
  CoreCaseId,
  Omit<CaseDefinition, "implementationHash">
> = {
  "NEW-01": {
    caseId: "NEW-01",
    criterionId: "create",
    setupPlanId: "clean-ui-v1",
    expected: "新增唯一有效标题后数量恰好加一且该标题只对应一项",
    timeoutMs: 10_000,
    plannedSteps: [
      openStep,
      step(
        "setup:record-initial-tasks",
        "setup",
        "记录初始数量和任务身份并选择唯一标题",
      ),
      step("action:create-unique-task", "action", "输入唯一有效标题并新增"),
      step(
        "assert:exactly-one-created",
        "assert",
        "确认总数加一且唯一标题只匹配一项",
      ),
    ],
  },
  "VALID-01": {
    caseId: "VALID-01",
    criterionId: "validation",
    setupPlanId: "clean-ui-v1",
    expected: "空字符串不能新增；按规则检查提示",
    timeoutMs: 7_000,
    plannedSteps: [
      openStep,
      step("setup:record-initial-tasks", "setup", "记录任务集合与数量"),
      step("action:submit-empty", "action", "提交空字符串"),
      step("assert:empty-rejected", "assert", "数量和集合不变，按参数观察提示"),
    ],
  },
  "VALID-02": {
    caseId: "VALID-02",
    criterionId: "validation",
    setupPlanId: "clean-ui-v1",
    expected: "纯空格不能新增；按规则检查提示",
    timeoutMs: 7_000,
    plannedSteps: [
      openStep,
      step("setup:record-initial-tasks", "setup", "记录任务集合与数量"),
      step("action:submit-whitespace", "action", "提交三个空格"),
      step(
        "assert:whitespace-rejected",
        "assert",
        "数量和集合不变，按参数观察提示",
      ),
    ],
  },
  "STATE-01": {
    caseId: "STATE-01",
    criterionId: "toggle",
    setupPlanId: "target-ui-v1",
    expected: "同一任务可以未完成→完成→未完成",
    timeoutMs: 10_000,
    plannedSteps: [
      openStep,
      step("setup:create-target", "setup", "独立新增并确认唯一未完成目标"),
      step("action:mark-done", "action", "标记目标为已完成"),
      step("assert:done-same-target", "assert", "同一目标状态已完成"),
      step("action:mark-active", "action", "标记同一目标为未完成"),
      step("assert:active-same-target", "assert", "同一目标恢复未完成"),
    ],
  },
  "FILTER-01": {
    caseId: "FILTER-01",
    criterionId: "filter",
    setupPlanId: "mixed-ui-v1",
    expected: "全部选项呈现准确完整任务集合",
    timeoutMs: 10_000,
    plannedSteps: [
      ...mixedSteps,
      step("action:select-all", "action", "选择全部"),
      step("assert:all-exact-set", "assert", "核对准确任务身份集合与数量"),
    ],
  },
  "FILTER-02": {
    caseId: "FILTER-02",
    criterionId: "filter",
    setupPlanId: "mixed-ui-v1",
    expected: "从初始全部切至未完成只显示未完成任务",
    timeoutMs: 10_000,
    plannedSteps: [
      ...mixedSteps,
      step("action:select-active", "action", "从初始全部直接选择未完成"),
      step("assert:active-exact-set", "assert", "只包含预期未完成任务身份"),
    ],
  },
  "FILTER-03": {
    caseId: "FILTER-03",
    criterionId: "filter",
    setupPlanId: "mixed-ui-v1",
    expected: "从初始全部直接切至已完成只显示已完成任务",
    timeoutMs: 10_000,
    plannedSteps: [
      ...mixedSteps,
      step("action:select-done", "action", "从初始全部直接选择已完成"),
      step("assert:done-exact-set", "assert", "只包含预期已完成任务身份"),
    ],
  },
  "SAVE-01": {
    caseId: "SAVE-01",
    criterionId: "persistence",
    setupPlanId: "persist-ui-v1",
    expected: "同一上下文刷新后标题、数量与完成状态保留",
    timeoutMs: 10_000,
    plannedSteps: [
      openStep,
      step(
        "setup:create-and-confirm-state",
        "setup",
        "独立新增目标、改变完成状态并保存已确认的任务快照",
      ),
      step("action:reload", "action", "在当前上下文刷新页面"),
      step(
        "assert:persisted-snapshot",
        "assert",
        "核对标题、任务数量和状态快照",
      ),
    ],
  },
};
const criteria: CriterionDefinition[] = [
  {
    criterionId: "create",
    displayCode: "CK-01",
    title: "新增任务",
    mode: "auto",
    expectedBehavior: "一次有效操作准确新增一个任务",
  },
  {
    criterionId: "validation",
    displayCode: "CK-02",
    title: "拒绝空白任务",
    mode: "auto",
    expectedBehavior: "空字符串和纯空格均不能新增任务",
  },
  {
    criterionId: "toggle",
    displayCode: "CK-03",
    title: "切换完成状态",
    mode: "auto",
    expectedBehavior: "同一任务支持双向状态切换",
  },
  {
    criterionId: "filter",
    displayCode: "CK-04",
    title: "筛选任务",
    mode: "auto",
    expectedBehavior: "每个启用案例按准确任务集合核对筛选结果",
  },
  {
    criterionId: "persistence",
    displayCode: "CK-05",
    title: "刷新后保留数据",
    mode: "auto",
    expectedBehavior: "同一上下文刷新保留标题、数量和状态",
  },
];

async function createPack(
  packId: string,
  caseIds: readonly CoreCaseId[],
  identity: TaskPackBuildIdentity,
): Promise<TaskPackManifest> {
  const selectedCases = caseIds.map((id) => {
    const implementationHash = identity.caseImplementationHashes[id];
    if (!implementationHash)
      fail(
        "IMPLEMENTATION_HASH_REQUIRED",
        `${id}: supply a hash of the real trusted checker; descriptors are not an implemented checker`,
      );
    return { ...descriptors[id], implementationHash };
  });
  const selectedCriteria = criteria.filter((criterion) =>
    selectedCases.some((entry) => entry.criterionId === criterion.criterionId),
  );
  const probeHash = identity.probeImplementationHashes?.FILTER_ORDER_CHECK;
  const body: Omit<TaskPackManifest, "contentHash"> = {
    contractVersion: 2,
    hashAlgorithm: "canonical-json-v1",
    packId,
    packVersion: identity.packVersion,
    templateVersion: identity.templateVersion,
    templateHash: identity.templateHash,
    dependencyLockHash: identity.dependencyLockHash,
    initializationVersion: identity.initializationVersion,
    aggregationVersion: AGGREGATION_VERSION,
    criteria: selectedCriteria,
    cases: selectedCases,
    probes:
      probeHash &&
      selectedCriteria.some((criterion) => criterion.criterionId === "filter")
        ? [
            {
              probeId: "FILTER_ORDER_CHECK",
              applicableCriterionIds: ["filter"],
              parameterSchema: {},
              setupPlanId: "mixed-ui-v1",
              maxDurationMs: 20_000,
              implementationHash: probeHash,
              plannedPaths: [
                {
                  pathId: "A",
                  plannedSteps: [
                    ...mixedSteps,
                    step("action:select-done", "action", "初始全部→已完成"),
                    step(
                      "assert:observe-done-set",
                      "assert",
                      "记录控件值、任务身份与可见集合",
                    ),
                  ],
                },
                {
                  pathId: "B",
                  plannedSteps: [
                    ...mixedSteps,
                    step("action:select-active", "action", "初始全部→未完成"),
                    step(
                      "assert:observe-active-set",
                      "assert",
                      "记录控件值、任务身份与可见集合",
                    ),
                    step("action:select-done", "action", "未完成→已完成"),
                    step(
                      "assert:observe-done-set",
                      "assert",
                      "记录控件值、任务身份与可见集合",
                    ),
                  ],
                },
              ],
            },
          ]
        : [],
    parameterSchema: selectedCriteria.some(
      (criterion) => criterion.criterionId === "validation",
    )
      ? { requireValidationMessage: { type: "boolean", default: false } }
      : {},
  };
  // Validation proves descriptor integrity, not that a checker was executed or certified.
  return taskPackManifestSchema.parse({
    ...body,
    contentHash: await hashTaskPack(body),
  });
}

export function createDevelopmentPack(
  slice: "new-only" | "new-filter",
  identity: TaskPackBuildIdentity,
): Promise<TaskPackManifest> {
  if (slice !== "new-only" && slice !== "new-filter")
    fail("UNKNOWN_DEVELOPMENT_SLICE", String(slice));
  return createPack(
    slice === "new-only" ? "vue-board-dev-new" : "vue-board-dev-new-filter",
    slice === "new-only" ? ["NEW-01"] : ["NEW-01", "FILTER-03"],
    identity,
  );
}

export function createCoursePack(
  identity: TaskPackBuildIdentity,
): Promise<TaskPackManifest> {
  return createPack("vue-board-core", CORE_CASE_IDS, identity);
}
