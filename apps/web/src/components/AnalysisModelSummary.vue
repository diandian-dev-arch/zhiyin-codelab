<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { apiV2 } from '../api';
import { modelVendors, type PersonalModelState } from '@codelab/contracts/model-settings';
const props = defineProps<{ revision: number; available: boolean }>();
const emit = defineEmits<{ ready: [value: boolean] }>();
const state = ref<PersonalModelState>();
const loading = ref(false), error = ref('');
let controller: AbortController | undefined;
let requestId = 0;
const modelLabel = computed(() => {
  const settings = state.value?.settings;
  return settings ? `${modelVendors[settings.vendor]?.label ?? settings.vendor} · ${settings.model}` : '';
});
async function refresh() {
  const id = ++requestId;
  controller?.abort();
  controller = new AbortController();
  const current = controller;
  loading.value = true; error.value = ''; state.value = undefined; emit('ready', false);
  const timeout = window.setTimeout(() => current.abort(), 15000);
  try {
    const result = await apiV2<PersonalModelState>('/model-settings', { signal: current.signal });
    if (id !== requestId || current.signal.aborted) return;
    state.value = result;
    emit('ready', !!(props.available && result.enabled && result.configured && result.settings));
  } catch {
    if (id === requestId) error.value = '暂时无法核对本次模型，请重新读取；不会自动开始解读。';
  } finally {
    window.clearTimeout(timeout);
    if (id === requestId) loading.value = false;
  }
}
watch(() => [props.revision, props.available], refresh, { immediate: true });
onUnmounted(() => { requestId++; controller?.abort(); });
</script>

<template>
  <div class="model-summary" aria-label="本次模型与费用账户">
    <p v-if="loading" role="status">正在核对本次模型…</p>
    <p v-else-if="error" role="alert">{{ error }} <button type="button" @click="refresh">重新读取模型</button></p>
    <template v-else-if="state?.settings && state.configured">
      <p><strong>本次模型：{{ modelLabel }}</strong></p>
      <p>费用账户：当前登录用户保存的个人模型账户（API Key 所属账户）。这里不显示密钥。</p>
    </template>
    <p v-else>尚无可用个人模型。源码已保存，配置完成后回到此处确认费用。</p>
  </div>
</template>

<style scoped>
.model-summary { margin-block: .8rem; overflow-wrap: anywhere; }
p { margin: .3rem 0; font-size: .85rem; line-height: 1.8; }
button { min-height: 44px; }
</style>
