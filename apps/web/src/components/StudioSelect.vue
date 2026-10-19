<script setup lang="ts">
import { computed } from 'vue';

// Keep the browser's form, keyboard and option semantics. Modern browsers
// expose the picker for styling; older browsers keep their native picker.
defineOptions({ inheritAttrs: false });
const props = defineProps<{ modelValue?: unknown; value?: unknown }>();
const emit = defineEmits<{
  'update:modelValue': [value: unknown];
  change: [event: Event];
}>();
const selected = computed({
  get: () => props.modelValue !== undefined ? props.modelValue : props.value,
  set: value => emit('update:modelValue', value),
});
</script>

<template>
  <select v-bind="$attrs" v-model="selected" class="studio-select" @change="emit('change', $event)">
    <slot />
  </select>
</template>

<style>
select.studio-select {
  min-height: 44px;
  padding: .7rem .85rem;
  border: 1px solid var(--control-line);
  border-radius: .7rem;
  background: var(--paper);
  color: var(--ink);
  font: inherit;
  font-size: .875rem;
  line-height: 1.55;
  cursor: pointer;
  transition: border-color 160ms, box-shadow 160ms;
}
select.studio-select:hover:not(:disabled) { border-color: var(--muted); }
select.studio-select:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
select.studio-select:disabled { cursor: not-allowed; }
@supports (appearance: base-select) {
  select.studio-select, select.studio-select::picker(select) { appearance: base-select; }
  select.studio-select { display: flex; align-items: center; gap: .75rem; text-align: start; }
  select.studio-select:open { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
  select.studio-select::picker-icon {
    width: 8px;
    height: 8px;
    margin-inline-start: auto;
    flex-shrink: 0;
    content: '';
    border-right: 1.5px solid var(--muted);
    border-bottom: 1.5px solid var(--muted);
    rotate: 45deg;
    translate: 0 -2px;
    transition: rotate 160ms, translate 160ms;
  }
  select.studio-select:open::picker-icon { rotate: 225deg; translate: 0 2px; border-color: var(--accent); }
  select.studio-select::picker(select) {
    margin-block: 6px;
    padding: 6px;
    max-block-size: min(320px, 55dvh);
    max-inline-size: calc(100vw - 24px);
    overflow: auto;
    overscroll-behavior: contain;
    scrollbar-width: thin;
    border: 1px solid var(--line);
    border-radius: .85rem;
    background: var(--paper);
    color: var(--ink);
    box-shadow: 0 12px 36px var(--gl-bg), 0 2px 6px var(--gl-bg);
  }
  select.studio-select option {
    display: flex;
    align-items: center;
    gap: .65rem;
    min-height: 44px;
    padding: .6rem .75rem;
    border-radius: .5rem;
    background: transparent;
    color: var(--ink);
    font-weight: 400;
    line-height: 1.6;
    white-space: normal;
    overflow-wrap: anywhere;
    cursor: pointer;
  }
  select.studio-select option:hover, select.studio-select option:focus { background: var(--surface); outline: none; }
  select.studio-select option:checked { color: var(--accent-ink); background: var(--accent-soft); font-weight: 600; }
  select.studio-select option::checkmark { order: 1; margin-inline-start: auto; color: var(--accent); }
  select.studio-select option:disabled { color: var(--muted); opacity: .55; cursor: not-allowed; }
  select.studio-select optgroup { padding: .4rem 0; color: var(--muted); font-size: .8rem; }
}
@media (prefers-reduced-motion: reduce) {
  select.studio-select, select.studio-select::picker-icon { transition: none; }
}
@media (forced-colors: active) {
  select.studio-select::picker(select) { border-color: CanvasText; }
  select.studio-select option:checked { outline: 1px solid Highlight; }
}
</style>
