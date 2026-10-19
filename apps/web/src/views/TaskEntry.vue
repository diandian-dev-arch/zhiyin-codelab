<script setup lang="ts">
import { onUnmounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { apiV2 } from '../api';
import TaskV2 from './TaskV2.vue';
import ProjectTask from './ProjectTask.vue';

const route = useRoute();
const kind = ref<'template' | 'project'>();
const error = ref('');
let request = 0;
let controller: AbortController | undefined;
async function load() {
  const sequence = ++request;
  controller?.abort();
  const current = new AbortController();
  controller = current;
  const timeout = window.setTimeout(() => current.abort(), 15000);
  kind.value = undefined;
  error.value = '';
  try {
    const task = await apiV2(`/tasks/${String(route.params.id)}`, { signal: current.signal });
    current.signal.throwIfAborted();
    if (sequence === request) kind.value = task.kind === 'project' ? 'project' : 'template';
  } catch (failure) {
    if (sequence === request) error.value = current.signal.aborted
      ? '任务读取超时，请检查连接后重试。'
      : (failure as Error).message;
  } finally {
    window.clearTimeout(timeout);
  }
}
watch(() => route.params.id, load, { immediate: true });
onUnmounted(() => { request++; controller?.abort(); });
</script>

<template>
  <ProjectTask v-if="kind === 'project'" :key="`project-${route.params.id}`" />
  <TaskV2 v-else-if="kind === 'template'" :key="`template-${route.params.id}`" />
  <section v-else-if="error" class="panel">
    <p class="error" role="alert">{{ error }}</p>
    <button @click="load">重新读取任务</button>
    <RouterLink class="button" to="/tasks">返回实训任务</RouterLink>
  </section>
  <p v-else role="status">正在读取任务…</p>
</template>
