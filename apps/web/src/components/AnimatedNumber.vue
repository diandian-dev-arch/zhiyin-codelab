<script setup lang="ts">
// Tweens a real count toward its current value. The final rendered text always equals
// `value`; non-numeric placeholders (for example '—') render unchanged.
import { onBeforeUnmount, ref, watch } from 'vue';

const props = withDefaults(defineProps<{ value: number | string; duration?: number }>(), { duration: 700 });
const shown = ref<number | string>(typeof props.value === 'number' ? 0 : props.value);
let frame = 0;

const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

function run(to: number | string, from: number | string) {
  cancelAnimationFrame(frame);
  if (typeof to !== 'number' || !Number.isFinite(to) || typeof from !== 'number' || reduced() || from === to) {
    shown.value = to;
    return;
  }
  const start = performance.now();
  const step = (now: number) => {
    const t = Math.min(1, (now - start) / props.duration);
    const eased = 1 - Math.pow(1 - t, 4);
    shown.value = t === 1 ? to : Math.round(from + (to - from) * eased);
    if (t < 1) frame = requestAnimationFrame(step);
  };
  frame = requestAnimationFrame(step);
}

watch(() => props.value, (to) => run(to, typeof shown.value === 'number' ? shown.value : 0), { immediate: true });
onBeforeUnmount(() => cancelAnimationFrame(frame));
</script>
<template><data class="animated-number" :value="value">{{ shown }}</data></template>
