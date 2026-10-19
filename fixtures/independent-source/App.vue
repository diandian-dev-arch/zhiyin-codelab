<script lang="ts">
import { defineComponent } from 'vue';
import TaskRow from './TaskRow.vue';
import { transition, visible, type Task, type Action } from './domain';
const storageKey = 'independent-board-state-v1';
export default defineComponent({
  components: { TaskRow },
  data() {
    let tasks: Task[] = [];
    try { tasks = JSON.parse(localStorage.getItem(storageKey) ?? '[]'); } catch { /* clean initial state */ }
    return { tasks, title: '', mode: 'all', error: '' };
  },
  computed: { shown(): Task[] { return visible(this.tasks, this.mode); } },
  methods: {
    dispatch(action: Action) {
      this.tasks = transition(this.tasks, action);
      localStorage.setItem(storageKey, JSON.stringify(this.tasks));
    },
    add() {
      if (!this.title.trim()) { this.error = '请填写任务名称'; return; }
      this.dispatch({ type: 'add', title: this.title }); this.title = ''; this.error = '';
    },
    toggle(id: string) { this.dispatch({ type: 'toggle', id }); },
    remove(id: string) { this.dispatch({ type: 'remove', id }); },
  },
});
</script>
<template>
  <main>
    <h1>独立实现 · 任务清单</h1>
    <form @submit.prevent="add"><input data-testid="task-input" v-model="title" aria-label="任务名称"><button data-testid="add-task">添加</button></form>
    <p data-testid="validation-error" role="alert">{{ error }}</p>
    <select data-testid="filter" v-model="mode" aria-label="筛选任务"><option value="all">全部</option><option value="active">未完成</option><option value="done">已完成</option></select>
    <ul><TaskRow v-for="task in shown" :key="task.id" :task="task" @toggle="toggle" @remove="remove" /></ul>
  </main>
</template>
<style>body{font:16px system-ui;background:#f5f5f3;color:#273b32}main{max-width:720px;margin:48px auto;padding:28px;background:white}form,li{display:flex;gap:14px;align-items:center}li{padding:16px 0}span{flex:1}input,select,button{font:inherit;padding:8px}ul{padding:0}[role=alert]{color:#a52a2a;min-height:24px}</style>
