import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { zipSync } from "fflate";
import {
  root,
  templateFiles,
  templateVersion,
} from "../apps/api/src/template.js";
import {
  createSourceManifest,
  sha256,
} from "../packages/contracts/src/v2/index.js";

export const DEVELOPMENT_FAMILY_ID = "vue-board-v1-development-family-001";
export const DEVELOPMENT_CASE_IDS = [
  "NEW-01",
  "VALID-01",
  "VALID-02",
  "STATE-01",
  "FILTER-01",
  "FILTER-02",
  "FILTER-03",
  "SAVE-01",
] as const;
export const DEVELOPMENT_SAMPLE_IDS = [
  "correct",
  "filter-defect",
  "build-error",
  "create-missing",
  "create-duplicate",
  "filter-setup-blocked",
  "fixed-with-regression",
] as const;

type SampleId = (typeof DEVELOPMENT_SAMPLE_IDS)[number];
type CaseId = (typeof DEVELOPMENT_CASE_IDS)[number];
type FileMap = Record<string, Buffer>;
type ExpectedCase = {
  caseId: CaseId;
  verdict: "passed" | "failed" | "not_run";
  preconditionStatus: "satisfied" | "blocked";
  reasonCode: string;
  basis: string;
};
type SampleDefinition = {
  sampleId: SampleId;
  files: FileMap;
  derivedFromSampleId: SampleId | null;
  changes: string[];
  expectedRunStatus: "completed" | "build_error";
  expectedCases: ExpectedCase[];
};

const APP_PATH = "src/App.vue";
const CREATE_PUSH =
  "tasks.value.push({id:crypto.randomUUID(),title:title.value.trim(),done:false});";
const FILTER_EXPRESSION =
  "filter.value==='all'||(filter.value==='done'?t.done:!t.done)";
const PERSISTENCE_WATCH =
  "watch(tasks,v=>localStorage.setItem('codelab-tasks',JSON.stringify(v)),{deep:true});";
const expectedBehavior: Record<CaseId, string> = {
  "NEW-01": "有效且唯一的标题预期使数量恰好增加一，标题只对应一项。",
  "VALID-01": "空字符串预期被 trim 校验拦截，任务数量不变。",
  "VALID-02": "纯空格预期被 trim 校验拦截，任务数量不变。",
  "STATE-01": "目标任务预期可以双向切换完成状态，身份保持一致。",
  "FILTER-01": "独立准备混合状态后，全部视图预期显示准确任务集合。",
  "FILTER-02": "独立准备混合状态后，未完成视图预期只显示未完成任务。",
  "FILTER-03": "独立准备混合状态后，已完成视图预期只显示完成任务。",
  "SAVE-01":
    "任务变更预期由深度 watch 写入 localStorage，刷新后恢复标题、数量与状态。",
};

function expectations(
  overrides: Partial<Record<CaseId, Omit<ExpectedCase, "caseId">>> = {},
): ExpectedCase[] {
  return DEVELOPMENT_CASE_IDS.map<ExpectedCase>((caseId) => ({
    caseId,
    verdict: "passed",
    preconditionStatus: "satisfied",
    reasonCode: "ASSERTION_SATISFIED",
    basis: expectedBehavior[caseId],
    ...overrides[caseId],
  }));
}
function failure(basis: string): Omit<ExpectedCase, "caseId"> {
  return {
    verdict: "failed",
    preconditionStatus: "satisfied",
    reasonCode: "ASSERTION_MISMATCH",
    basis,
  };
}
function blocked(
  basis: string,
  reasonCode = "SETUP_BLOCKED",
): Omit<ExpectedCase, "caseId"> {
  return {
    verdict: "not_run",
    preconditionStatus: "blocked",
    reasonCode,
    basis,
  };
}
function replaceOnce(
  source: string,
  before: string,
  after: string,
  sampleId: SampleId,
) {
  if (source.split(before).length !== 2) {
    throw new Error(
      `样本 ${sampleId} 的模板锚点不唯一或已变化，停止生成：${before}`,
    );
  }
  return source.replace(before, after);
}
function withApp(files: FileMap, source: string): FileMap {
  return { ...files, [APP_PATH]: Buffer.from(source, "utf8") };
}
function sourceFiles(files: FileMap): Record<string, string> {
  return Object.fromEntries(
    Object.entries(files)
      .filter(([name]) => name.startsWith("src/") || name.startsWith("public/"))
      .map(([name, bytes]) => [name, bytes.toString("base64")]),
  );
}

/** Generate controlled development inputs; this does not execute their UI. */
export async function createDevelopmentFixtures(inputFiles?: FileMap) {
  const files = inputFiles ?? (await templateFiles());
  if (!files[APP_PATH]) throw new Error(`参考模板缺少 ${APP_PATH}`);
  const app = files[APP_PATH].toString("utf8");
  const filterDefectApp = replaceOnce(
    app,
    FILTER_EXPRESSION,
    "true",
    "filter-defect",
  );
  const correctedFilterApp = replaceOnce(
    filterDefectApp,
    "tasks.value.filter(t=>true)",
    `tasks.value.filter(t=>${FILTER_EXPRESSION})`,
    "fixed-with-regression",
  );
  const dependentCases: CaseId[] = [
    "STATE-01",
    "FILTER-01",
    "FILTER-02",
    "FILTER-03",
    "SAVE-01",
  ];
  const creationBlocked = (basis: string) =>
    Object.fromEntries(
      dependentCases.map((caseId) => [caseId, blocked(basis)]),
    );
  const definitions: SampleDefinition[] = [
    {
      sampleId: "correct",
      files,
      derivedFromSampleId: null,
      changes: ["保留仓库参考模板的原始文件字节；名称不是已验证真值。"],
      expectedRunStatus: "completed",
      expectedCases: expectations(),
    },
    {
      sampleId: "filter-defect",
      files: withApp(files, filterDefectApp),
      derivedFromSampleId: "correct",
      changes: [
        "将 visible 的筛选谓词替换为 true，三个筛选选项都显示全部任务。",
      ],
      expectedRunStatus: "completed",
      expectedCases: expectations({
        "FILTER-02": failure("未完成视图仍显示完成和未完成两类任务。"),
        "FILTER-03": failure("已完成视图仍显示完成和未完成两类任务。"),
      }),
    },
    {
      sampleId: "build-error",
      files: withApp(files, "<template><broken>"),
      derivedFromSampleId: "correct",
      changes: ["保留原有未闭合 Vue SFC 样本，预期可信构建过程拒绝编译。"],
      expectedRunStatus: "build_error",
      expectedCases: expectations(
        Object.fromEntries(
          DEVELOPMENT_CASE_IDS.map((caseId) => [
            caseId,
            blocked(
              "预期构建失败，功能未执行；不是功能不通过。",
              "BUILD_ERROR",
            ),
          ]),
        ),
      ),
    },
    {
      sampleId: "create-missing",
      files: withApp(
        files,
        replaceOnce(
          app,
          CREATE_PUSH,
          "/* development fixture: creation intentionally omitted */",
          "create-missing",
        ),
      ),
      derivedFromSampleId: "correct",
      changes: ["移除 add 中唯一的入列操作；保留校验、标题清空与错误清除。"],
      expectedRunStatus: "completed",
      expectedCases: expectations({
        ...creationBlocked(
          "本案例自己的准备无法创建目标任务，预期在 setup 阶段受阻。",
        ),
        "NEW-01": failure("有效标题提交后数量没有增加，也没有对应的新任务。"),
      }),
    },
    {
      sampleId: "create-duplicate",
      files: withApp(
        files,
        replaceOnce(
          app,
          CREATE_PUSH,
          CREATE_PUSH + CREATE_PUSH,
          "create-duplicate",
        ),
      ),
      derivedFromSampleId: "correct",
      changes: ["add 对同一标题入列两次，生成两个不同 ID 的任务。"],
      expectedRunStatus: "completed",
      expectedCases: expectations({
        ...creationBlocked(
          "本案例自己的准备得到重复标题，无法确认唯一目标与准确任务集合，预期 setup 受阻。",
        ),
        "NEW-01": failure("有效标题提交后数量增加二，唯一标题对应两项任务。"),
      }),
    },
    {
      sampleId: "filter-setup-blocked",
      files: withApp(
        files,
        replaceOnce(
          app,
          'data-testid="task-toggle" type="checkbox"',
          'data-testid="task-toggle" type="checkbox" disabled',
          "filter-setup-blocked",
        ),
      ),
      derivedFromSampleId: "correct",
      changes: [
        "禁用任务状态复选框，正常 UI 无法准备一条完成和一条未完成任务。",
      ],
      expectedRunStatus: "completed",
      expectedCases: expectations({
        "STATE-01": failure(
          "目标可以创建，但状态控件被禁用，双向切换要求被明确违反。",
        ),
        "FILTER-01": blocked("FILTER-01 自己的准备无法得到经确认的混合状态。"),
        "FILTER-02": blocked("FILTER-02 自己的准备无法得到经确认的混合状态。"),
        "FILTER-03": blocked("FILTER-03 自己的准备无法得到经确认的混合状态。"),
        "SAVE-01": blocked(
          "刷新前无法改变并确认目标状态，SAVE-01 的准备未完成。",
        ),
      }),
    },
    {
      sampleId: "fixed-with-regression",
      files: withApp(
        files,
        replaceOnce(
          correctedFilterApp,
          PERSISTENCE_WATCH,
          "/* development fixture: persistence intentionally omitted */",
          "fixed-with-regression",
        ),
      ),
      derivedFromSampleId: "filter-defect",
      changes: [
        "恢复 filter-defect 的正确筛选谓词。",
        "同时移除持久化 watch；首次加载仍读取 localStorage，但新任务与状态不再保存。",
      ],
      expectedRunStatus: "completed",
      expectedCases: expectations({
        "SAVE-01": failure(
          "在独立空存储上下文中，新任务与状态没有写入，刷新后预期丢失。",
        ),
      }),
    },
  ];

  // Fixed local date and sorted entries make regenerated ZIP bytes reproducible.
  const zipOptions = { mtime: new Date(2020, 0, 1), level: 9 as const };
  const generated = await Promise.all(
    definitions.map(async (definition) => {
      const archive = Buffer.from(
        zipSync(
          Object.fromEntries(
            Object.keys(definition.files)
              .sort()
              .map((name) => [name, definition.files[name]]),
          ),
          zipOptions,
        ),
      );
      const sourceManifest = await createSourceManifest(
        sourceFiles(definition.files),
      );
      return {
        definition,
        archive,
        sourceManifest,
        originalZipSha256: await sha256(archive),
      };
    }),
  );
  const samples = generated.map(
    ({ definition, archive, sourceManifest, originalZipSha256 }) => ({
      sampleId: definition.sampleId,
      implementationFamilyId: DEVELOPMENT_FAMILY_ID,
      purpose: "development" as const,
      frozenEvaluationEligible: false,
      origin: {
        kind: "repository_template_derivative" as const,
        templateVersion,
        templatePath: `templates/${templateVersion}`,
        derivedFromSampleId: definition.derivedFromSampleId,
        parentSourceManifestSha256: definition.derivedFromSampleId
          ? generated.find(
              (item) =>
                item.definition.sampleId === definition.derivedFromSampleId,
            )!.sourceManifest.sourceManifestSha256
          : null,
        changedPaths: definition.sampleId === "correct" ? [] : [APP_PATH],
        changes: definition.changes,
      },
      authorization: {
        basis: "现有仓库模板及本轮授权的本地开发样本构造",
        scope: "controlled-development-and-demo",
        containsStudentSubmission: false,
        externalCourseAuthorization: "not-applicable",
      },
      archivePath: `fixtures/${definition.sampleId}.zip`,
      originalZipSha256,
      zipByteSize: archive.byteLength,
      sourceManifest,
      verification: {
        status: "expected-only" as const,
        browserExecution: "not_run" as const,
        actualRunId: null,
        observedCaseResults: [],
      },
      truthBasis: {
        kind: "constructed-source-and-public-case-requirements",
        specification: "docs/engineering/CONTRACTS_V1.md#c12-首版案例矩阵",
        limitation:
          "预期基于源码构造，不是教师独立标注或真实浏览器结论；实际运行结果需另存证据记录。",
      },
      expectedRunStatus: definition.expectedRunStatus,
      expectedCases: definition.expectedCases,
    }),
  );
  return {
    registry: {
      registryVersion: "development-samples-v1",
      generator: "scripts/fixtures.ts",
      templateVersion,
      implementationFamilyId: DEVELOPMENT_FAMILY_ID,
      partitionPolicy:
        "同一模板及全部缺陷、修复变体只用于开发与演示，不得拆分进入冻结评测集。",
      sourceManifestScope:
        "只含通过准入的 src/** 与 public/** 原始文件字节；模板配置与依赖锁另行绑定。",
      samples,
    },
    archives: Object.fromEntries(
      generated.map(({ definition, archive }) => [
        definition.sampleId,
        archive,
      ]),
    ) as Record<SampleId, Buffer>,
  };
}

export async function writeDevelopmentFixtures(
  outputDirectory = path.join(root, "fixtures"),
) {
  // Build every variant before writing, so a changed template anchor fails closed.
  const generated = await createDevelopmentFixtures();
  await mkdir(outputDirectory, { recursive: true });
  for (const sampleId of DEVELOPMENT_SAMPLE_IDS) {
    await writeFile(
      path.join(outputDirectory, `${sampleId}.zip`),
      generated.archives[sampleId],
    );
  }
  await writeFile(
    path.join(outputDirectory, "manifest.json"),
    JSON.stringify(generated.registry, null, 2) + "\n",
    "utf8",
  );
  return generated;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  await writeDevelopmentFixtures();
  console.log(
    `已生成 ${DEVELOPMENT_SAMPLE_IDS.length} 个开发样本及 fixtures/manifest.json；预期结果不代表真实浏览器执行，不属于冻结评测集。`,
  );
}
