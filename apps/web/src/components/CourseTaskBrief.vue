<script setup lang="ts">
import { courseTime } from "../coursework-time";
defineProps<{ task: any; heading?: boolean }>();
const sources: Record<string, string> = {
  snippet: "代码片段",
  files: "文件 / 文件夹",
  zip: "ZIP",
  gitee: "Gitee",
  github: "GitHub",
};
</script>
<template>
  <section class="course-panel course-task-brief">
    <template v-if="heading">
      <h2>{{ task.title || "未填写任务名称" }}</h2>
      <p>{{ task.description || "未填写目标与说明" }}</p>
      <p>截止 {{ courseTime(task.dueAt) }}（北京时间）</p>
      <p>{{ task.allowCode ? "允许主动请求辅助代码" : "辅助代码已关闭" }}</p>
    </template>
    <h3>任务要求</h3>
    <ol>
      <li v-for="r in task.requirements" :key="r.id">
        {{ r.id }} · {{ r.title }}
      </li>
    </ol>
    <p>
      允许来源：{{
        task.allowedSources.map((s: string) => sources[s]).join("、") ||
        "至少选择一种来源"
      }}
    </p>
    <p v-if="task.requiredPaths.length">
      必需文件：{{ task.requiredPaths.join("、") }}
    </p>
    <p v-if="task.scope.length">重点范围：{{ task.scope.join("、") }}</p>
    <details v-if="task.starter">
      <summary>起始材料</summary>
      <pre>{{ task.starter }}</pre>
    </details>
    <p class="muted">
      成功接受时间必须严格早于截止。导入完成后还需确认正式提交；模型失败不影响已交成果。
    </p>
  </section>
</template>
