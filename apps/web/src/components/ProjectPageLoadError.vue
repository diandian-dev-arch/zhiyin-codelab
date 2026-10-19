<script setup lang="ts">
function retry() {
  // Reload the current URL to obtain the latest asset manifest. This only
  // reloads the page; it must never resubmit an analysis or an upload.
  window.location.reload();
}
</script>

<template>
  <section aria-labelledby="project-page-load-error" class="project-load-error">
    <h1 id="project-page-load-error">项目页面暂时未能加载</h1>
    <p role="alert">页面资源可能因网络中断或版本更新而无法读取，这不代表后台分析失败。</p>
    <p>已保存的项目和报告不会因此删除。恢复连接后重新加载页面，只查询已有状态，不会自动重新分析。</p>
    <p>如果其他页面还有未保存的编辑，请先保存，再重新加载。</p>
    <button type="button" @click="retry">重新加载项目页面</button>
  </section>
</template>

<style scoped>
.project-load-error { max-width: 48rem; padding: var(--space-lg); overflow-wrap: anywhere; }
.project-load-error h1 { font-size: var(--text-lg); }
.project-load-error p { margin-block: var(--space-sm); }
.project-load-error button { min-height: 44px; }
</style>
