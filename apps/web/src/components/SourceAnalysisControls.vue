<script setup lang="ts">
import { computed, ref } from "vue";
import type {
  SourceAnalysisMode,
  SourceModule,
} from "@codelab/contracts/source";
const props = defineProps<{
  mode: SourceAnalysisMode;
  modules: string[];
  catalog?: SourceModule[];
  disabled?: boolean;
  context: "upload" | "rerun";
}>();
const emit = defineEmits<{
  "update:mode": [value: SourceAnalysisMode];
  "update:modules": [value: string[]];
}>();
const query = ref("");
const limit = ref(30);
const filtered = computed(() =>
  (props.catalog ?? []).filter((m) =>
    m.label.toLowerCase().includes(query.value.toLowerCase()),
  ),
);
function choose(mode: SourceAnalysisMode) {
  emit("update:mode", mode);
  if (mode === "quick") emit("update:modules", []);
}
function toggle(id: string) {
  if (props.disabled) return;
  const next = props.modules.includes(id)
    ? props.modules.filter((m) => m !== id)
    : [...props.modules, id];
  if (next.length <= 6) emit("update:modules", next);
}
</script>

<template>
  <fieldset class="source-options" :disabled="disabled">
    <legend>
      {{ context === "upload" ? "这次想了解多深？" : "下一次分析" }}
    </legend>
    <div class="mode-choices">
      <label :class="{ chosen: mode === 'quick' }">
        <input
          type="radio"
          :name="`source-mode-${context}`"
          value="quick"
          :checked="mode === 'quick'"
          @change="choose('quick')"
        />
        <span
          ><strong>快速概览</strong
          ><small>找到入口，认识主要模块与业务</small></span
        >
      </label>
      <label :class="{ chosen: mode === 'deep' }">
        <input
          type="radio"
          :name="`source-mode-${context}`"
          value="deep"
          :checked="mode === 'deep'"
          @change="choose('deep')"
        />
        <span
          ><strong>深入分析</strong
          ><small>追加两轮调查，沿代码追踪调用与反证</small></span
        >
      </label>
    </div>
    <p class="mode-note">
      {{
        mode === "deep"
          ? "会读取更多关联代码，等待更久、模型调用费用也可能增加。两种模式都只做静态分析。"
          : "适合第一次了解项目；报告会标明实际读过的代码，未读部分不视为已审查。"
      }}
    </p>
    <template v-if="mode === 'deep' && catalog?.length">
      <div class="focus-heading">
        <strong>重点关注的目录 / 项目包</strong
        ><span>{{ modules.length }} / 6 已选</span>
      </div>
      <p class="mode-note">
        不选则从全局调查。选定后优先查阅这些目录，仍会跨目录追踪上下游。
      </p>
      <input
        v-model="query"
        class="module-filter"
        aria-label="筛选关注目录"
        placeholder="输入目录名筛选"
        @input="limit = 30"
      />
      <div v-if="modules.length" class="focus-selection">
        <button
          v-for="id in modules"
          :key="id"
          type="button"
          :aria-label="`取消关注 ${id}`"
          @click="toggle(id)"
        >
          {{ id }} <span aria-hidden="true">×</span>
        </button>
      </div>
      <div class="module-choices">
        <label
          v-for="m in filtered.slice(0, limit)"
          :key="m.id"
          :class="{ chosen: modules.includes(m.id) }"
        >
          <input
            type="checkbox"
            :checked="modules.includes(m.id)"
            :disabled="
              disabled || (modules.length >= 6 && !modules.includes(m.id))
            "
            @change="toggle(m.id)"
          />
          <span
            ><strong>{{ m.label }}</strong
            ><small
              >{{ m.fileCount }} 个文件 ·
              {{ m.lines.toLocaleString() }} 行</small
            ></span
          >
        </label>
      </div>
      <p v-if="!filtered.length" class="mode-note">没有匹配的目录。</p>
      <button
        v-if="filtered.length > limit"
        type="button"
        class="show-more"
        @click="limit += 30"
      >
        再显示 30 个目录
      </button>
    </template>
    <p v-else-if="mode === 'deep' && context === 'upload'" class="mode-note">
      导入后先从全局深入调查；以后重新分析时，可以选择重点目录。
    </p>
  </fieldset>
</template>

<style scoped>
.source-options {
  min-width: 0;
  padding: 0;
  margin: var(--space-md) 0 0;
  border: 0;
  color: var(--ink);
}
.source-options legend {
  font-size: 14px;
  font-weight: 650;
  margin-bottom: 12px;
}
.mode-choices {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}
.mode-choices label,
.module-choices label {
  display: flex;
  flex-direction: row;
  align-items: flex-start;
  gap: var(--space-xs);
  padding: var(--space-sm) var(--space-xs);
  margin: 0;
  border: 1px solid var(--line);
  border-radius: 8px;
  cursor: pointer;
  background: var(--paper);
}
.mode-choices .chosen,
.module-choices .chosen {
  border-color: var(--accent);
  background: var(--accent-soft);
}
input {
  accent-color: var(--accent);
}
.mode-choices input,
.module-choices input {
  flex: none;
  margin: 3px 0 0;
}
.source-options strong {
  display: block;
  font-size: 13px;
  font-weight: 650;
}
.source-options small {
  display: block;
  font-size: 12px;
  line-height: 1.7;
  color: var(--quiet);
  margin-top: 5px;
}
.mode-note {
  color: var(--quiet);
  font-size: 12px;
  line-height: 1.8;
  margin: 10px 0;
}
.focus-heading {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  justify-content: space-between;
  margin-top: 24px;
}
.focus-heading span {
  font-size: 12px;
  color: var(--accent);
}
.module-filter {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 10px;
  background: var(--paper);
  color: var(--ink);
  font: inherit;
  font-size: 13px;
}
.module-choices {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 190px), 1fr));
  gap: 8px;
  margin-top: 12px;
  max-height: 280px;
  overflow-y: auto;
}
.module-choices strong,
.focus-selection button {
  font-family: Consolas, "Microsoft YaHei", monospace;
  overflow-wrap: anywhere;
}
.focus-selection {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
}
.focus-selection button,
.show-more {
  border: 1px solid var(--line);
  background: var(--paper);
  color: var(--accent);
  padding: 6px 10px;
  border-radius: 4px;
  cursor: pointer;
}
.show-more {
  margin-top: 10px;
}
.source-options :focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 3px;
}
.source-options:disabled {
  opacity: 0.65;
}
@media (max-width: 500px) {
  .mode-choices {
    grid-template-columns: 1fr;
  }
}
</style>
