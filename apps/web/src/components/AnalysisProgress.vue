<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { analysisStage, analysisStages } from '../lib/analysis-progress';
import { ArrowUpRight, Square } from 'lucide-vue-next';
const props = defineProps<{
  analysisId: string; events: readonly { kind: string; label?: string; path?: string }[];
  elapsed: string; stale: boolean; queued: boolean;
  canCancel?: boolean; busy?: boolean; model?: string; mode?: string;
  cost?: { knownCny: number; reservedCny: number; unknownCalls: number; price: { limitCny?: number } } | null;
}>();
const emit = defineEmits<{ cancel: []; details: [] }>();
const highestStage = ref(0);
watch(() => [props.analysisId, analysisStage(props.events)] as const, ([id, stage], previous) => {
  highestStage.value = previous?.[0] === id ? Math.max(highestStage.value, stage) : stage;
}, { immediate: true, flush: 'sync' });
const status = computed(() => props.stale ? '暂时无法确认状态' : props.queued ? '已排队，等待开始' : analysisStages[highestStage.value]);
const latest = computed(() => props.events.at(-1));
const readFiles = computed(() => new Set(props.events.filter(event => ['read', 'read_verify'].includes(event.kind) && event.path).map(event => event.path)).size);
const searches = computed(() => props.events.filter(event => event.kind === 'search').length);
</script>

<template>
  <section class="analysis-progress" aria-label="解读进度">
    <header><div><h2>分析过程</h2><p class="progress-meta"><span>{{ mode || '静态源码分析' }}</span><span v-if="model">{{ model }}</span></p></div><span class="progress-elapsed">已用 <time>{{ elapsed }}</time></span></header>
    <p class="progress-status" role="status"><span class="progress-dot" aria-hidden="true" /><strong>{{ status }}</strong></p>
    <ol aria-label="解读阶段">
      <li v-for="(stage, index) in analysisStages" :key="stage" :aria-current="!queued && !stale && index === highestStage ? 'step' : undefined" :class="{ reached: !queued && index <= highestStage }">
        <span aria-hidden="true">{{ index + 1 }}</span>{{ stage }}
      </li>
    </ol>
    <div class="progress-activity"><p>{{ latest?.label || (queued ? '等待执行器开始处理，还没有源码阅读事件。' : '正在等待下一条分析事件。') }}</p><span v-if="latest?.path" class="progress-path">{{ latest.path }}</span></div>
    <div class="progress-footer"><p class="progress-counts"><span>已读 <strong>{{ readFiles }}</strong> 个文件片段</span><span>源码搜索 <strong>{{ searches }}</strong> 次</span><span v-if="cost">已知估算 <strong>¥{{ cost.knownCny.toFixed(4) }}</strong><template v-if="cost.price.limitCny"> / 预算 ¥{{ cost.price.limitCny.toFixed(2) }}</template><template v-if="cost.unknownCalls"> · {{ cost.unknownCalls }} 次用量待确认</template></span></p><div class="progress-actions"><button type="button" @click="emit('details')">完整分析轨迹<ArrowUpRight aria-hidden="true" :size="15" /></button><button v-if="canCancel" type="button" :disabled="busy || stale" @click="emit('cancel')"><Square aria-hidden="true" :size="14" />停止当前分析</button></div></div>
    <p v-if="stale" class="progress-note">正在重新查询后台状态。不会自动重发分析，已发出的请求仍可能产生费用。</p>
    <p v-else class="progress-note">离开页面不会取消解读。这里显示实际已用时间，不代表预计完成时间。</p>
  </section>
</template>

<style scoped>
.analysis-progress { padding: var(--space-md) 0; border-block: 1px solid var(--line); margin-block: var(--space-sm) var(--space-lg); min-width: 0; }
header { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-sm); }
h2 { font: 650 var(--text-lg)/1.5 var(--font-body); margin: 0 0 var(--space-2xs); letter-spacing: 0; }
.progress-meta, .progress-elapsed { color: var(--muted); font-size: var(--text-xs); }
.progress-meta { justify-content: flex-start; }
.progress-elapsed { flex: none; font-variant-numeric: tabular-nums; }
.progress-elapsed time { display: block; color: var(--ink); font-size: var(--text-lg); font-weight: 600; }
.progress-status { justify-content: flex-start; align-items: center; margin-top: var(--space-sm); }
.progress-dot { width: 8px; height: 8px; background: var(--accent); border-radius: 50%; flex: none; }
.progress-activity { display: grid; gap: var(--space-2xs); padding-block: var(--space-xs) var(--space-sm); min-width: 0; }
.progress-activity p { display: block; max-width: 75ch; font-size: var(--text-sm); overflow-wrap: anywhere; }
.progress-path { font: var(--text-xs)/1.7 var(--font-outlier); color: var(--muted); overflow-wrap: anywhere; }
.progress-footer { display: flex; align-items: center; justify-content: space-between; gap: var(--space-sm); flex-wrap: wrap; }
.progress-counts { justify-content: flex-start; font-size: var(--text-xs); }
.progress-counts strong { color: var(--ink); font-variant-numeric: tabular-nums; }
.progress-actions { display: flex; gap: var(--space-xs); flex-wrap: wrap; }
.progress-actions button { font-size: var(--text-xs); }
p { display: flex; justify-content: space-between; gap: .75rem; flex-wrap: wrap; margin: 0; line-height: 1.8; }
p > span { color: var(--muted); font-variant-numeric: tabular-nums; }
ol { display: flex; gap: 1rem; flex-wrap: wrap; padding: 0; margin: .9rem 0; list-style: none; }
li { display: flex; align-items: center; gap: .5rem; font-size: var(--text-sm); color: var(--muted); }
li > span { display: grid; place-items: center; border: 1px solid var(--line); border-radius: 50%; width: 1.6rem; height: 1.6rem; flex: none; }
li.reached { color: var(--ink); }
li[aria-current] { font-weight: 650; }
li[aria-current] > span { background: var(--gl-solid); color: var(--gl-text); }
.progress-note { font-size: var(--text-xs); color: var(--muted); margin-top: var(--space-sm); }
@media (max-width: 600px) { .analysis-progress { padding-block: var(--space-sm); margin-top: var(--space-xs); } ol { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--space-xs); } li { flex-direction: column; align-items: flex-start; font-size: var(--text-xs); } .progress-meta { display: block; overflow-wrap: anywhere; } .progress-meta span { display: block; } }
</style>
