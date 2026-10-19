<script setup lang="ts">
import { ref, watch } from 'vue';
const props = defineProps<{ busy: boolean; checking: boolean; checked: boolean }>();
const emit = defineEmits<{ check: []; resume: [] }>();
const confirmed = ref(false);
watch(() => props.checked, () => { confirmed.value = false; });
</script>
<template>
  <section class="course-notice" role="status" aria-label="保存结果待核对">
    <h2>保存结果待核对</h2>
    <p>服务器可能已经处理原操作。本页暂停新的写入，没有自动重发；未离开页面的输入不会被清空。停止等待不代表服务端已取消，也不代表没有模型费用。</p>
    <button type="button" :disabled="busy || checking" @click="emit('check')">{{ checking ? '正在读取最新记录…' : '读取最新记录核对' }}</button>
    <template v-if="checked">
      <p>最新记录已读取。请核对下方列表、提交版本、授权或发布状态；列表尚未出现记录，不等于原操作失败。仍不确定时请继续等待或联系课程负责人。</p>
      <label class="course-check"><input v-model="confirmed" type="checkbox" />我已核对服务器记录，理解原操作仍可能完成，确认允许新的写入。</label>
      <button type="button" :disabled="busy || checking || !confirmed" @click="emit('resume')">确认核对，恢复写入</button>
    </template>
  </section>
</template>
