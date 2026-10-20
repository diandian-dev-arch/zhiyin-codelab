<!--
  GlLiquid · 液体水波背景
  铺满最近的定位父元素（position: relative）。父元素上的点击会荡开涟漪。
    <section class="hero" style="position:relative">
      <GlLiquid ref="liquid" :anchor="coreEl" :accent="role === 'student' ? 1 : 0" />
      ...
    </section>
  父组件可调用 liquid.value?.pulse() 让水面从 anchor 处荡开一圈波。
  只在首页首屏和登录页使用；同一时刻页面上最多一个实例（WebGL 上下文开销大）。
-->
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { createLiquid, type LiquidHandle } from "../../glass/liquid";

const props = withDefaults(
  defineProps<{
    anchor?: HTMLElement | null;
    accent?: number;
    interactive?: boolean;
    ambientDrops?: boolean;
    /** 底部渐隐到背景色，便于和下一屏衔接 */
    fade?: boolean;
  }>(),
  { anchor: null, accent: 0, interactive: true, ambientDrops: true, fade: true }
);

const canvas = ref<HTMLCanvasElement | null>(null);
let handle: LiquidHandle | null = null;

function mount() {
  if (!canvas.value) return;
  handle = createLiquid(canvas.value, {
    anchor: props.anchor,
    interactive: props.interactive,
    ambientDrops: props.ambientDrops,
  });
  handle.setAccent(props.accent);
}

onMounted(mount);
// anchor 往往在父组件挂载后才拿到：只更新引用，不重建 WebGL 上下文
watch(
  () => props.anchor,
  (el) => handle?.setAnchor(el)
);
watch(
  () => props.accent,
  (v) => handle?.setAccent(v)
);
onBeforeUnmount(() => {
  handle?.destroy();
  handle = null;
});

defineExpose({
  pulse: () => handle?.pulse(),
  drop: (x: number, y: number, r: number, s: number) => handle?.drop(x, y, r, s),
});
</script>

<template>
  <canvas ref="canvas" class="gl-liquid" :class="{ 'gl-liquid--fade': fade }" aria-hidden="true" />
</template>

<style scoped>
.gl-liquid {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
  animation: gl-liquid-in 2.4s var(--gl-ease-out) both;
}
.gl-liquid--fade {
  -webkit-mask-image: linear-gradient(to bottom, #000 62%, transparent);
  mask-image: linear-gradient(to bottom, #000 62%, transparent);
}
@keyframes gl-liquid-in {
  from {
    opacity: 0;
    transform: scale(1.04);
  }
}
@media (prefers-reduced-motion: reduce) {
  .gl-liquid {
    animation: none;
  }
}
</style>
