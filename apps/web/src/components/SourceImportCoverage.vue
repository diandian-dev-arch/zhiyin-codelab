<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{ omitted: { path: string; reason: string }[]; importantOnly?: boolean }>();
const emit = defineEmits<{ details: [] }>();
// These are intentional exclusions, not failed source reads. Unknown reasons
// remain visible for review rather than being silently treated as harmless.
const routineReasons = new Set(['依赖或构建产物', '敏感配置', '非源码文件', '依赖锁文件']);
const important = computed(() => props.omitted.filter(file => !routineReasons.has(file.reason)));
const groups = computed(() => {
  const counts = new Map<string, number>();
  for (const file of important.value) counts.set(file.reason, (counts.get(file.reason) ?? 0) + 1);
  return [...counts].map(([reason, count]) => `${reason} ${count} 个`).join('；');
});
</script>

<template>
  <aside v-if="omitted.length && (!importantOnly || important.length)" class="import-coverage" :class="{ 'needs-review': important.length }" aria-label="导入范围提醒">
    <template v-if="important.length">
      <strong>{{ important.length }} 个文件未能纳入源码解读</strong>
      <p>{{ groups }}。报告不能覆盖这些文件中的实现；增加分析轮次不会补回未导入的内容。</p>
      <p>请核对跳过列表；如涉及核心实现，可调整源码体积或将文本转换为 UTF-8 后另行导入。保留原项目与报告，不会自动重新分析。</p>
    </template>
    <p v-else>导入时按规则跳过 {{ omitted.length }} 个文件（如依赖、构建产物、敏感配置或非源码文件）。这不表示分析失败；若缺少预期源码，请核对列表。</p>
    <button type="button" @click="emit('details')">查看跳过文件与原因</button>
  </aside>
</template>

<style scoped>
.import-coverage { padding: var(--space-md); border-inline-start: 3px solid var(--muted); margin-block: var(--space-md); font-size: var(--text-sm); overflow-wrap: anywhere; }
.import-coverage.needs-review { border-inline-start-color: var(--rust, var(--gl-control-line)); }
.import-coverage p { margin-block: var(--space-xs); }
.import-coverage button { min-height: 44px; white-space: normal; text-align: start; }
</style>
