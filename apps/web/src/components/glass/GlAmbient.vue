<!--
  GlAmbient · 全站环境光 + 颗粒
  放在 App 根部一次即可。工作台用 calm（更低存在感），首页/登录用默认。
  <GlAmbient :calm="isWorkspace" />
-->
<script setup lang="ts">
defineProps<{ calm?: boolean }>();
</script>

<template>
  <div class="gl-ambient" :class="{ 'gl-ambient--calm': calm }" aria-hidden="true"><i /><i /><i /></div>
  <div class="gl-grain" aria-hidden="true" />
</template>
