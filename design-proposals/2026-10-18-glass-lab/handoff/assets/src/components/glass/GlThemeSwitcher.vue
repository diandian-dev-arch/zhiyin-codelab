<!--
  GlThemeSwitcher · 配色切换
  两种形态：
    <GlThemeSwitcher />                 色板一排（设置页「外观」区块、首页角落）
    <GlThemeSwitcher variant="list" />  带名称的单选列表（设置页、用户菜单）
  切换时新配色从点击处圆形展开；选择保存在 localStorage。
-->
<script setup lang="ts">
import { ref } from "vue";
import { THEMES, applyTheme, getTheme, type ThemeId } from "../../glass/theme";

withDefaults(defineProps<{ variant?: "swatches" | "list" }>(), { variant: "swatches" });

const current = ref<ThemeId>(getTheme());

function pick(id: ThemeId, e: MouseEvent) {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  applyTheme(id, { x: r.left + r.width / 2, y: r.top + r.height / 2 });
  current.value = id;
}
</script>

<template>
  <div v-if="variant === 'swatches'" class="gl-theme-swatches" role="radiogroup" aria-label="配色方案">
    <button
      v-for="t in THEMES"
      :key="t.id"
      type="button"
      role="radio"
      class="gl-theme-swatch"
      :aria-checked="current === t.id"
      :aria-label="t.name"
      :title="t.name"
      :style="{
        '--sb': t.swatch[0],
        '--s1': t.swatch[1],
        '--s2': t.swatch[3],
        '--s3': t.swatch[2],
        '--s4': t.swatch[4],
      }"
      @click="pick(t.id, $event)"
    />
  </div>
  <div v-else class="gl-theme-list" role="radiogroup" aria-label="配色方案">
    <button
      v-for="t in THEMES"
      :key="t.id"
      type="button"
      role="radio"
      class="gl-theme-option"
      :aria-checked="current === t.id"
      @click="pick(t.id, $event)"
    >
      <span
        class="gl-theme-swatch"
        aria-hidden="true"
        :style="{
          '--sb': t.swatch[0],
          '--s1': t.swatch[1],
          '--s2': t.swatch[3],
          '--s3': t.swatch[2],
          '--s4': t.swatch[4],
        }"
      />
      <span>{{ t.name }}</span>
    </button>
  </div>
</template>

<style scoped>
.gl-theme-swatches {
  display: inline-flex;
  gap: 8px;
}
.gl-theme-swatch {
  position: relative;
  width: 44px;
  height: 44px;
  flex: none;
  padding: 0;
  border: 0;
  border-radius: 50%;
  cursor: pointer;
  background: conic-gradient(from 210deg, var(--s1) 0 40%, var(--s2) 40% 60%, var(--s3) 60% 80%, var(--s4) 80%);
  box-shadow: inset 0 0 0 4px var(--sb);
  transition: box-shadow var(--gl-dur);
}
.gl-theme-swatch::after {
  content: "";
  position: absolute;
  inset: -4px;
  border-radius: 50%;
  border: 1.5px solid var(--gl-text);
  opacity: 0;
  transform: scale(0.85);
  transition: 0.45s var(--gl-ease-spring);
}
.gl-theme-swatch[aria-checked="true"]::after,
.gl-theme-option[aria-checked="true"] .gl-theme-swatch::after {
  opacity: 0.9;
  transform: none;
}
.gl-theme-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 10px;
}
.gl-theme-option {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 60px;
  padding: 8px 14px 8px 8px;
  border-radius: var(--gl-r-lg);
  border: 1px solid var(--gl-line);
  background: rgb(var(--gl-text-rgb) / 0.03);
  color: var(--gl-text-2);
  font: inherit;
  font-weight: 600;
  text-align: left;
  cursor: pointer;
  transition:
    border-color var(--gl-dur),
    background-color var(--gl-dur);
}
.gl-theme-option:hover {
  background: rgb(var(--gl-text-rgb) / 0.06);
}
.gl-theme-option[aria-checked="true"] {
  color: var(--gl-text);
  border-color: rgb(var(--gl-c1-rgb) / 0.55);
  background: rgb(var(--gl-c1-rgb) / 0.08);
}
.gl-theme-option .gl-theme-swatch {
  width: 40px;
  height: 40px;
  pointer-events: none;
}
</style>
