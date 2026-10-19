<script setup>
import {ref,computed,watch} from 'vue';
const tasks=ref(JSON.parse(localStorage.getItem('codelab-tasks')||'[]'));
const title=ref(''),filter=ref('all'),error=ref(''),editing=ref(null),editTitle=ref('');
const visible=computed(()=>tasks.value.filter(t=>filter.value==='all'||(filter.value==='done'?t.done:!t.done)));
watch(tasks,v=>localStorage.setItem('codelab-tasks',JSON.stringify(v)),{deep:true});
function add(){if(!title.value.trim()){error.value='请输入任务名称';return;}tasks.value.push({id:crypto.randomUUID(),title:title.value.trim(),done:false});title.value='';error.value='';}
function edit(t){editing.value=t.id;editTitle.value=t.title;}
function save(t){if(!editTitle.value.trim())return;t.title=editTitle.value.trim();editing.value=null;}
</script>
<template><main><h1>任务管理看板</h1><p>记录任务，跟踪进展。</p><form @submit.prevent="add"><input data-testid="task-input" aria-label="任务名称" v-model="title" placeholder="添加一项任务"><button data-testid="add-task">新增任务</button></form><p data-testid="validation-error" role="alert">{{ error }}</p><label>显示 <select data-testid="filter" v-model="filter"><option value="all">全部任务</option><option value="active">未完成</option><option value="done">已完成</option></select></label><ul><li data-testid="task-row" v-for="t in visible" :key="t.id"><input data-testid="task-toggle" type="checkbox" v-model="t.done" :aria-label="'完成 '+t.title"><template v-if="editing===t.id"><input data-testid="edit-input" aria-label="编辑名称" v-model="editTitle"><button data-testid="save-task" @click="save(t)">保存</button></template><template v-else><span data-testid="task-title" :style="{textDecoration:t.done?'line-through':'none'}">{{t.title}}</span><button data-testid="edit-task" @click="edit(t)">编辑</button></template><button data-testid="delete-task" @click="tasks=tasks.filter(x=>x.id!==t.id)">删除</button></li></ul></main></template>
<style>body{margin:0;background:#f3f5f9;color:#263247;font:16px system-ui}main{max-width:760px;margin:60px auto;padding:32px;background:white;border-radius:12px}form,li{display:flex;gap:12px}li{padding:16px 0;align-items:center;border-bottom:1px solid #edf0f5}ul{padding:0}input,button,select{font:inherit;padding:8px;border:1px solid #ccd3df;border-radius:5px}button{cursor:pointer}span{flex:1}[role=alert]{color:#b42318;min-height:24px}</style>
