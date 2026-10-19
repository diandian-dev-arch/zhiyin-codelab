<script setup lang="ts">
const props = defineProps<{
  modelValue: {
    allowedSources: string[];
    requiredPaths: string[];
    scope: string[];
    starter: string;
  };
}>();
const emit = defineEmits<{ "update:modelValue": [value: any] }>();
const sources = {
  snippet: "代码片段",
  files: "文件 / 多文件",
  zip: "ZIP 压缩包",
  gitee: "Gitee 仓库",
  github: "GitHub 仓库",
};
function update(key: string, value: unknown) {
  emit("update:modelValue", { ...props.modelValue, [key]: value });
}
function paths(event: Event) {
  return (event.target as HTMLTextAreaElement).value
    .split("\n")
    .map((p) => p.trim())
    .filter(Boolean);
}
function source(key: string, event: Event) {
  const selected = new Set(props.modelValue.allowedSources);
  (event.target as HTMLInputElement).checked
    ? selected.add(key)
    : selected.delete(key);
  update("allowedSources", [...selected]);
}
</script>
<template>
  <details class="course-task-options">
    <summary>起始材料、来源与分析范围</summary>
    <div class="course-form course-options-body">
      <fieldset class="course-sources">
        <legend>允许的成果来源（至少一项）</legend>
        <label v-for="(label, key) in sources" :key="key" class="course-check"
          ><input
            type="checkbox"
            :checked="modelValue.allowedSources.includes(key)"
            @change="source(key, $event)"
          />{{ label }}</label
        >
      </fieldset>
      <label
        >必需文件（每行一个）<textarea
          :value="modelValue.requiredPaths.join('\n')"
          @change="update('requiredPaths', paths($event))"
          placeholder="src/search.ts"
        />
      </label>
      <label
        >分析重点范围（每行一个目录或文件）<textarea
          :value="modelValue.scope.join('\n')"
          @change="update('scope', paths($event))"
          placeholder="src"
        />
      </label>
      <label
        >起始材料<textarea
          :value="modelValue.starter"
          @input="
            update('starter', ($event.target as HTMLTextAreaElement).value)
          "
          placeholder="起始片段、材料说明或固定仓库提交链接"
        />
      </label>
    </div>
  </details>
</template>
