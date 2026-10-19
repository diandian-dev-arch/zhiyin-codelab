<script lang="ts">
import { defineComponent, type PropType } from 'vue';
import type { Task } from './domain';
export default defineComponent({
  props: { task: { type: Object as PropType<Task>, required: true } },
  emits: ['toggle', 'remove'],
});
</script>
<template>
  <li data-testid="task-row">
    <input data-testid="task-toggle" type="checkbox" :checked="task.done" :aria-label="'完成 '+task.title" @change="$emit('toggle', task.id)">
    <span data-testid="task-title">{{ task.title }}</span>
    <button @click="$emit('remove', task.id)">删除</button>
  </li>
</template>
