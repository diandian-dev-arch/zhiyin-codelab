<template>
  <div class="analysis-sections">
    <section aria-label="范围"><h2>范围</h2><slot name="scope" /><slot name="directory" /><slot name="files" /></section>
    <section aria-label="模型与费用"><h2>模型与费用</h2><slot name="model" /><slot name="receipt" /><slot name="usage" /></section>
    <section aria-label="分析过程"><h2>分析过程</h2><slot name="process" /><slot name="events" /></section>
    <section aria-label="历史记录"><h2>历史记录</h2><slot name="history" /></section>
  </div>
</template>

<style scoped>
.analysis-sections > section { min-width: 0; border-top: 1px solid var(--line); padding-block: 1.25rem; }
h2 { font: 600 1.125rem/1.6 var(--font-body); margin: 0 0 .75rem; letter-spacing: 0; }
</style>
