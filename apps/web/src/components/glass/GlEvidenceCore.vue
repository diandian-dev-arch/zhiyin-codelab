<!--
  GlEvidenceCore · 检查核心 + 代码粒子
  画布铺满最近的定位父元素；核心位置由 anchor 元素决定（通常是一个透明的方形 div）。
    <GlEvidenceCore :anchor="coreEl" :avoid="copyEl" :accent="0" @emit="onEmit" />
  emit 事件：能量充满爆发时触发，用于轮换证据卡、调用 GlLiquid.pulse()。
-->
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { createEvidenceCore, type EvidenceCoreHandle } from "../../glass/evidence-core";

const props = withDefaults(
  defineProps<{
    anchor?: HTMLElement | null;
    avoid?: HTMLElement | null;
    accent?: number;
    appearance?: 'radar' | 'glass';
    /** 首次挂载时预充能（0–1），让第一次爆发早点出现 */
    precharge?: number;
  }>(),
  { anchor: null, avoid: null, accent: 0, precharge: 0.55 }
);
const emit = defineEmits<{ emit: [] }>();

const canvas = ref<HTMLCanvasElement | null>(null);
let handle: EvidenceCoreHandle | null = null;

function mount() {
  if (!canvas.value) return;
  handle = createEvidenceCore(canvas.value, {
    anchor: props.anchor,
    avoid: props.avoid,
    appearance: props.appearance,
    onEmit: () => emit("emit"),
  });
  handle.setAccent(props.accent);
  handle.boost(props.precharge);
}

onMounted(mount);
watch(
  () => props.anchor,
  (el) => handle?.setAnchor(el)
);
watch(
  () => props.avoid,
  (el) => handle?.setAvoid(el)
);
watch(
  () => props.accent,
  (v) => handle?.setAccent(v)
);
onBeforeUnmount(() => {
  handle?.destroy();
  handle = null;
});

defineExpose({ burst: () => handle?.burst(), boost: (v: number) => handle?.boost(v) });
</script>

<template>
  <canvas ref="canvas" class="gl-evidence-core" aria-hidden="true" />
</template>

<style scoped>
.gl-evidence-core {
  position: absolute;
  inset: 0;
  z-index: 1;
  width: 100%;
  height: 100%;
  pointer-events: none;
}
</style>
