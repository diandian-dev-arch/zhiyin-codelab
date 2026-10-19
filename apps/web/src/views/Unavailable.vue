<template>
  <section class="unavailable-page" aria-labelledby="unavailable-title">
    <p class="muted">页面不可用</p>
    <h1 id="unavailable-title">请从真实项目或任务继续</h1>
    <p>这个地址没有对应的已确认业务记录。可以回到项目列表，或选择实训任务查看提交与反馈。</p>
    <div class="actions"><RouterLink class="button primary" to="/tasks">实训任务</RouterLink><RouterLink class="button" to="/projects">AI 项目解读</RouterLink></div>
  </section>
</template>
<style scoped>
.unavailable-page { max-width: 44rem; padding-block: var(--space-xl); }
.unavailable-page > p { color: var(--muted); max-width: 60ch; }
.unavailable-page .actions { margin-top: var(--space-md); }
</style>
