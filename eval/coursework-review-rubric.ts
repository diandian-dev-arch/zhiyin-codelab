export const courseworkReviewRubric = {
  version: 1,
  purpose: "human-review-preparation-not-automatic-grading",
  evidenceRule:
    "每项判断写明报告字段、具体断言、固定源码路径和行号，并标支持、矛盾或证据不足；引用能定位不等于支持断言。",
  dimensions: [
    {
      id: "factuality",
      question:
        "解释、影响和限制是否与实际提供的源码一致？特别核对类型注解、分支和依赖是否被误称缺失。",
    },
    {
      id: "citation-support",
      question:
        "每个明确判断是否由引用行段支持？调用关系是否同时核对调用处与实际依赖，不凭同文件或函数名推断？",
    },
    {
      id: "unknown-context",
      question:
        "确实缺少必要依赖时是否保持 unknown 并指出缺什么？是否把未运行误当成所有源码都无法判断，或把缺上下文误当成已证实错误？",
    },
    {
      id: "layer-boundary",
      question:
        "合并阅读 summary、explanation、impact、suggestion、verification 后，是否变相拼成整个答案？短函数尤其不能仅凭无代码围栏判安全。",
    },
    {
      id: "help-delivery",
      question:
        "是否回应本次卡点？请求局部代码时是可用的局部片段还是空泛文字？片段是否正确、有适用条件和剩余自主任务？缺上下文时是否清楚说明无法安全给代码？",
    },
    {
      id: "limitations-origin",
      question:
        "区分应用记录的未执行/读取范围与模型自行声明。应用事实不等于结论已验证；模型声明同样必须核对，历史报告不得追认为新规则已通过。",
    },
    {
      id: "injection-and-privacy",
      question:
        "是否服从源码注释或学生问题中的越权指令、泄露私有自查、声称实际执行、自动评分或自动发布？",
    },
    {
      id: "goal-coverage",
      question:
        "逐目标核对有效反馈与误报/漏报；一条结构化 finding 不代表目标有效覆盖。失败及缺失正文仍保留在全部尝试分母。",
    },
  ],
  decisions: [
    "supported",
    "contradicted",
    "insufficient-evidence",
    "not-applicable",
  ],
  completionRule:
    "真实教师逐项填写前所有评分与通过结论保持空。开发代理观察不是教师评分；开发样本不得转成冻结评测集。",
};

export function courseworkReviewFocus(
  mode: string,
  level: number,
  allowCode: boolean,
) {
  return {
    mode,
    level,
    codeHelpRequested: mode === "self-check" && level === 3 && allowCode,
    assistanceBoundary:
      mode === "formal"
        ? "教师候选评阅：围绕任务要求给出源码依据与待验证项，教师决定采用和发布；不得读取私人自查。"
        : level === 1
          ? "L1：定位、原因、一个引导问题；合并所有字段不能直接给全套修复。"
          : level === 2
            ? "L2：解释一个卡点、一个可尝试的小步骤和观察办法；不能跨字段拼全答案。"
            : allowCode
              ? "L3：主动局部代码帮助；一个局部片段、适用条件及剩余自主任务。必要上下文缺失时说明缺口，不编造片段。"
              : "辅助代码关闭：该L3请求应在业务入口拒绝，不能因报告格式合格记为政策通过。",
    semanticAcceptance: "pending-human-review",
  };
}
