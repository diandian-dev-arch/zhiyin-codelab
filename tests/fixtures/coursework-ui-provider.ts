import type { SummaryProviderV2 } from "../../apps/api/src/model-provider-v2";

// Test-only deterministic substitute. No environment credentials or network clients.
export const courseworkUIProvider: SummaryProviderV2 = {
  configuration: {
    provider: "test-only",
    model: "coursework_ui_fixture",
    endpoint: "http://127.0.0.1/unused-coursework-fixture",
  },
  async complete(input) {
    input.signal?.throwIfAborted();
    const request = JSON.parse(input.user);
    const file = Object.keys(request.files)[0];
    const line = Math.min(2, request.files[file].split("\n").length);
    return {
      raw: "coursework_ui_fixture",
      requestId: "synthetic-coursework-browser-receipt",
      usage: { inputTokens: 100, outputTokens: 80 },
      content: JSON.stringify({
        summary: "浏览器替身报告：只验证固定版本引用交互，不代表真实教学质量。",
        findings: request.task.requirements.map((r: { id: string }) => ({
          requirementId: r.id,
          verdict: "unknown",
          explanation: "尚需人工核对目标，未执行代码。",
          impact: "本报告只用于源码定位交互验证。",
          evidence: [{ path: file, start: line, end: line }],
          suggestion: "请核对引用行与当前固定版本。",
          verification: "在自己的环境中检查边界输入。",
        })),
        limitations: ["合成模型，不是实际评测结果"],
      }),
    };
  },
};
