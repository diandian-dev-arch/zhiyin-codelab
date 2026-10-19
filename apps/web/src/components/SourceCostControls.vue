<script setup lang="ts">
import { ref, watch, computed } from 'vue';
import { apiV2 } from '../api';
import type { SourceAnalysisOptions } from '@codelab/contracts/source';
type Price = NonNullable<SourceAnalysisOptions['cost']>;
const props = defineProps<{mode: 'quick'|'deep'; available: boolean; disabled?: boolean; revision?: number}>();
const emit = defineEmits<{change: [value: Price | undefined]; valid: [value: boolean]}>();
const quote = ref<{price: Price|null; allocationCny: number|null; maxCalls:number; historicalRange?:{min:number;max:number;samples:number}|null}>();
const loading = ref(false), error = ref(''), enabled = ref(false), manual = ref(false);
const limit = ref(1), input = ref<number>(), output = ref<number>();
let revision = 0;
watch(() => [props.mode, props.available, props.revision], async () => {
  const id = ++revision;
  if (!props.available) { quote.value = undefined; loading.value = false; emit('change', undefined); return; }
  loading.value = true; error.value = ''; quote.value=undefined; emit('valid', false);
  try {
    const value = await apiV2('/source-cost-preview', {method:'POST', body: JSON.stringify({mode:props.mode})});
    if (id !== revision) return;
    quote.value = value;
    if (value.price && input.value === undefined) { enabled.value = true; input.value=value.price.inputPerMillion; output.value=value.price.outputPerMillion; }
  } catch (e) { if(id===revision) error.value = (e as Error).message; }
  finally { if(id===revision) loading.value = false; }
}, {immediate:true});
const price = computed(() => manual.value ? (Number(input.value)>0 && Number(output.value)>0 ? {
  inputPerMillion:Number(input.value), outputPerMillion:Number(output.value),label:'用户确认单价 · 人民币 / 百万 token'
} : undefined) : quote.value?.price ?? undefined);
const valid = computed(() => !loading.value && (!enabled.value || (!!price.value && price.value.inputPerMillion<=100000 && price.value.outputPerMillion<=100000 && Number(limit.value)>=0.01 && Number(limit.value)<=1000)));
watch([price,enabled,limit,valid], () => {
  emit('valid',valid.value);
  emit('change',valid.value && enabled.value && price.value ? {...price.value,limitCny:Number(limit.value)} : undefined);
}, {immediate:true});
</script>

<template>
  <section class="cost-desk" aria-label="分析费用与预算">
    <header><div><h3>分析费用与预算</h3></div><span class="cost-unit">CNY / ¥</span></header>
    <p v-if="loading" role="status">正在核对模型价格…</p>
    <p v-if="error" role="alert">价格暂不可用：{{error}}。未启用费用控制时仍可分析。</p>
    <div class="cost-tariff" v-if="price">
      <div><span>输入 / 百万 token</span><strong>¥ {{price.inputPerMillion}}</strong></div>
      <div><span>输出 / 百万 token</span><strong>¥ {{price.outputPerMillion}}</strong></div>
    </div>
    <p class="cost-note" v-if="price">{{price.label}}。按未缓存输入保守计算；优惠与缓存可能降低实付。</p>
    <p class="cost-note" v-else>该模型暂无可信价格。可填写服务商单价开启预算；未知费用不会显示为免费。</p>
    <p v-if="quote?.historicalRange && !manual" class="cost-reference">你的历史参考 <strong>¥ {{quote.historicalRange.min.toFixed(2)}}<template v-if="quote.historicalRange.max!==quote.historicalRange.min"> – {{quote.historicalRange.max.toFixed(2)}}</template></strong><small>来自 {{quote.historicalRange.samples}} 次同模型、同模式的完整用量，按当前单价重算。项目大小与分析范围可能不同，不是本次报价。</small></p>
    <label class="cost-toggle"><input type="checkbox" v-model="enabled" :disabled="disabled"/>启用单次费用控制</label>
    <div v-if="enabled" class="cost-limit">
      <label>本次预算 <span>¥</span><input aria-label="本次预算（元）" type="number" min="0.01" max="1000" step="0.1" v-model.number="limit" :disabled="disabled"/></label>
      <div class="cost-presets"><button type="button" v-for="n in [0.5,1,3]" :key="n" :aria-pressed="limit===n" :disabled="disabled" @click="limit=n">¥ {{n}}</button></div>
      <p>每轮先预留输入与输出费用，输出上限按剩余预算调整。复核预算不足时停止后续调用；已有合格初稿保留为受限报告，未核实问题不会标为已确认。预算过低仍可能无法形成初稿。</p>
    </div>
    <details class="cost-details"><summary>价格依据与自定义单价</summary>
      <a href="https://api-docs.deepseek.com/zh-cn/quick_start/pricing" target="_blank" rel="noopener">查看 DeepSeek 官方价格 ↗</a>
      <label class="cost-toggle"><input type="checkbox" v-model="manual" :disabled="disabled"/>使用我确认的人民币单价</label>
      <div v-if="manual" class="cost-custom"><label>输入 / 百万 token<input type="number" min="0.000001" max="100000" step="any" v-model.number="input" :disabled="disabled"/></label><label>输出 / 百万 token<input type="number" min="0.000001" max="100000" step="any" v-model.number="output" :disabled="disabled"/></label></div>
      <p v-if="quote?.allocationCny!==null && quote?.allocationCny!==undefined && !manual">全流程容量预留上界 ¥{{quote.allocationCny.toFixed(2)}}（最多 {{quote.maxCalls}} 次，含格式修正）。这是各轮均用满上下文的保守上界，不是预计账单；不会一次性扣款。</p>
      <p>金额是按所选单价的估算，不是服务商账单。请求发出后停止也可能计费；严格扣费限额请同时在服务商设置。</p>
    </details>
  </section>
</template>
<style scoped>
.cost-desk { padding-block: var(--space-md); margin-top: var(--space-md); border-top: 1px solid var(--line); min-width: 0; }
header { display: flex; align-items: center; justify-content: space-between; gap: var(--space-sm); }
h3 { margin: 0; font-size: var(--text-sm); }
.cost-unit { font: var(--text-xs) var(--font-outlier); color: var(--muted); }
.cost-tariff { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: var(--space-sm); margin-top: var(--space-sm); }
.cost-tariff > div { display: grid; gap: var(--space-3xs); }
.cost-tariff span, .cost-note, .cost-limit p, .cost-details p { color: var(--muted); font-size: var(--text-xs); line-height: 1.8; }
.cost-tariff strong { font-size: var(--text-lg); font-variant-numeric: tabular-nums; }
.cost-reference { font-size: var(--text-xs); }
.cost-reference strong { display: block; font-size: var(--text-lg); }
.cost-toggle { flex-direction: row; align-items: center; gap: var(--space-2xs); font-weight: 400; min-height: 44px; margin: var(--space-2xs) 0; }
.cost-limit > label { flex-direction: row; align-items: center; gap: var(--space-xs); flex-wrap: wrap; }
.cost-limit input { width: 7rem; }
.cost-presets { display: flex; gap: var(--space-2xs); }
.cost-presets button[aria-pressed="true"] { background: var(--accent-soft); border-color: var(--accent); color: var(--accent-ink); }
.cost-details { border-top: 1px solid var(--line); font-size: var(--text-xs); }
.cost-details summary { font-weight: 500; }
.cost-details a { display: inline-flex; min-height: 44px; align-items: center; }
.cost-custom { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: var(--space-xs); }
.cost-custom label { font-size: var(--text-xs); }
@media (max-width: 420px) { .cost-custom { grid-template-columns: minmax(0,1fr); gap: 0; } }
</style>
