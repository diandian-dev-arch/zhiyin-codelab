<script setup lang="ts">
defineProps<{ report: any }>();
defineEmits<{ evidence: [path: string, start: number, end: number] }>();
const verdicts: Record<string, string> = {
  met: "符合",
  partial: "部分符合",
  unmet: "不符合",
  unknown: "无法判断",
};
</script>
<template>
  <div class="course-report">
    <p class="course-notice">仅静态分析 · 未运行测试 · 仅供教师或本人参考</p>
    <p>{{ report.summary }}</p>
    <p v-if="report.budget" class="muted">
      请求预算：输入 {{ report.budget.inputTokens }} Token（{{
        report.budget.counting === "utf8-conservative-estimate"
          ? "保守估算"
          : "配置的分词器计数"
      }}），输出上限
      {{ report.budget.outputTokens }} Token。实际用量以服务商返回为准。
    </p>
    <p class="muted">
      读取范围：{{ report.coveredPaths?.join("、")
      }}<span v-if="report.unreadPaths?.length"
        >；另有 {{ report.unreadPaths.length }} 个文件未读取</span
      >
    </p>
    <article v-for="f in report.findings" :key="f.requirementId">
      <h4>{{ f.requirementId }} · {{ verdicts[f.verdict] }}</h4>
      <p>{{ f.explanation }}</p>
      <p>影响：{{ f.impact || "此历史报告未提供影响说明，需人工确认。" }}</p>
      <button
        v-for="(e, i) in f.evidence"
        :key="i"
        @click="$emit('evidence', e.path, e.start, e.end)"
      >
        {{ e.path }}:{{ e.start }}–{{ e.end }}
      </button>
      <p class="course-code">{{ f.suggestion }}</p>
      <p>验证建议：{{ f.verification }}</p>
    </article>
    <ul v-if="report.limitations?.length">
      <li v-for="l in report.limitations" :key="l">{{ l }}</li>
    </ul>
    <details v-if="report.qualityReview?.status === 'not-reviewed'" class="course-quality-review">
      <summary>待复核的模型声明</summary>
      <p>引用可定位不代表结论已有语义复核。</p>
      <ul v-if="report.qualityReview.modelLimitations?.length">
        <li v-for="(statement, index) in report.qualityReview.modelLimitations" :key="index">{{ statement }}</li>
      </ul>
      <p v-if="report.qualityReview.codeDelivery?.status === 'snippet-provided'">已提供局部代码片段，正确性与辅导分寸仍待核对。</p>
      <p v-else-if="report.qualityReview.codeDelivery?.status === 'context-needed'">辅助代码未生成，缺失上下文仍需核对。</p>
    </details>
  </div>
</template>
