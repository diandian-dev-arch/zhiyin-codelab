export interface AnalysisOperation {
  operationId: string;
  kind: string;
  state: string;
  startedAt?: string;
  finishedAt?: string | null;
  hasSupplementalEvidence?: boolean;
}
export interface AnalysisRecord {
  id: string;
  status: string;
  strategy: string;
  mode: string;
  created_at: string;
  finished_at?: string | null;
  code?: string | null;
  operations?: AnalysisOperation[];
}
export const operationNames: Record<string, string> = {
  model_summary: "整理检查结论", model_agent: "研读材料与判断下一步", model_repair: "校验反馈格式",
  read_check_result: "核对检查结果", read_source_excerpt: "查阅源码线索", read_console_evidence: "核对运行日志",
  inspect_page_evidence: "查阅页面证据", compare_submission: "对比前次提交", run_probe: "执行筛选补查",
};
export const operationStatusNames: Record<string, string> = {
  reserved: "等待执行", sent: "进行中", completed: "已完成", failed: "未完成", unknown: "结果未确认",
};
export function analysisProgress(record?: AnalysisRecord, stale = false) {
  const operations = record?.operations ?? [];
  const active = !!record && ["queued", "running"].includes(record.status);
  const current = [...operations].reverse().find(o => ["sent", "reserved"].includes(o.state));
  const completed = operations.filter(o => o.state === "completed").length;
  const supplemental = operations.filter(o => o.state === "completed" && o.hasSupplementalEvidence).length;
  const modelCalls = operations.filter(o => o.kind.startsWith("model_")).length;
  let title = "让问题沿着证据，逐步清晰";
  let detail = "从检查结果出发，按需查阅源码、运行记录和补充检查，形成可供复核的修复建议。";
  if (record?.status === "queued") {
    title = "已进入调查队列";
    detail = "等待执行资源。领取任务后，这里会显示真实模型和工具动作。";
  } else if (record?.status === "running") {
    title = current ? operationNames[current.kind] ?? "执行调查操作" : "正在准备分析材料";
    detail = current?.kind.startsWith("model_")
      ? "正在等待模型返回。你可以继续查看证据；下一次工具调用或结果返回后，轨迹会更新。"
      : "根据实际执行记录更新。已取得的材料会保留，基础检查结果不会被改写。";
  } else if (record?.status === "succeeded") {
    title = "调查已完成，建议等待你复核";
    detail = "检查观察与原因假设分开展示。先核对依据，再把需要的建议采用到教师草稿。";
  } else if (record) {
    title = record.status === "cancelled" ? "调查已取消，已有材料保留" : "本次未形成可采用的建议";
    detail = record.code?.match(/TIME|DEADLINE|BUDGET/)
      ? "本次分析达到时间或调用预算。下方保留已经完成的调查，你可以重新发起或继续人工复核。"
      : "已完成的操作仍可查看；未确认的操作不算成功。基础报告仍可编辑和发布。";
  }
  if (stale) {
    title = "进度连接暂时中断";
    detail = "这里保留最后一次成功读取的记录。实际分析可能仍在运行，连接恢复前不会重复发起。";
  }
  return { title, detail, active, animating: active && !stale && record?.status === "running", current, completed, supplemental, modelCalls };
}
