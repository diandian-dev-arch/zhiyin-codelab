<script setup lang="ts">
import { Search, X } from "lucide-vue-next";
import { nextTick, ref } from 'vue';
defineProps<{ modelValue: string; label: string }>();
const emit = defineEmits<{ "update:modelValue": [value: string] }>();
const input = ref<HTMLInputElement>();
async function clearSearch() {
  emit('update:modelValue', '');
  await nextTick();
  input.value?.focus({ preventScroll: true });
}
</script>
<template>
  <!-- From Uiverse.io by TimTrayler; adapted icon/input grouping. See THIRD_PARTY_NOTICES.md. -->
  <div class="studio-search">
    <Search :size="17" aria-hidden="true" />
    <input
      ref="input"
      type="search"
      :aria-label="label"
      :placeholder="label"
      :value="modelValue"
      @input="
        emit('update:modelValue', ($event.target as HTMLInputElement).value)
      "
    />
    <button
      v-if="modelValue"
      type="button"
      class="icon-button"
      aria-label="清空搜索"
      title="清空搜索"
      @click="clearSearch"
    >
      <X aria-hidden="true" :size="15" />
    </button>
  </div>
</template>
