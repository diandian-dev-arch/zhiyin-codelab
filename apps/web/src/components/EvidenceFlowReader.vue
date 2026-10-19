<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue';
import type { EvidenceFlow } from '@codelab/contracts/source';
import type { EvidenceContext } from '../lib/source-evidence';
const props = defineProps<{ flows: EvidenceFlow[] }>();
const emit = defineEmits<{ citation: [citation: { path: string; start: number; end: number }]; evidence: [context: EvidenceContext]; change: [] }>();
const sceneId = ref(props.flows[0]?.id ?? '');
const stepId = ref('');
const implementationOpen = ref(false);
const uid = useId();
const flow = computed(() => props.flows.find(item => item.id === sceneId.value) ?? props.flows[0]);
const step = computed(() => flow.value?.steps.find(item => item.id === stepId.value) ?? flow.value?.steps[0]);
const outgoing = computed(() => flow.value?.edges.filter(edge => edge.from === step.value?.id) ?? []);
const relationLabels = { call: '调用关系', data: '数据传递', inferred: '推断关系 · 待核实' };
watch(() => flow.value?.id, () => { stepId.value = ''; implementationOpen.value = false; emit('change'); });
watch(stepId, () => emit('change'));
function stepTitle(id: string) { return flow.value?.steps.find(item => item.id === id)?.title ?? id; }
</script>

<template>
  <section v-if="flow && step" class="evidence-flow" aria-label="有据可查的业务链路">
    <header><h2>沿着业务查看实现</h2><label v-if="flows.length > 1" :for="uid">选择链路<select :id="uid" v-model="sceneId"><option v-for="item in flows" :key="item.id" :value="item.id">{{ item.title }}</option></select></label></header>
    <h3>{{ flow.title }}</h3><p>{{ flow.summary }}</p>
    <button v-for="(citation, index) in flow.steps[0]?.citations ?? []" :key="index" type="button" class="citation" @click="emit('evidence', { owner: { kind: 'scene', key: flow.steps[0].id }, contextTitle: flow.steps[0].title, contextText: flow.steps[0].responsibility, citations: flow.steps[0].citations, selectedIndex: index })">起点源码：{{ citation.path }} · L{{ citation.start }}–{{ citation.end }}</button>
    <details :open="implementationOpen" @toggle="implementationOpen = ($event.target as HTMLDetailsElement).open">
    <summary>展开实现步骤与关系</summary>
    <p class="note">静态源码解读，未运行项目。步骤排列用于阅读；实际关联以下方关系说明为准。</p>
    <div class="flow-layout">
      <nav aria-label="业务步骤"><ul><li v-for="item in flow.steps" :key="item.id"><button type="button" :aria-pressed="item.id === step.id" :aria-controls="`${uid}-detail`" @click="stepId = item.id">{{ item.title }}</button></li></ul></nav>
      <section :id="`${uid}-detail`" aria-label="当前步骤详情">
        <h4>{{ step.title }}</h4><p>{{ step.responsibility }}</p>
        <dl><template v-if="step.symbol"><dt>方法或函数</dt><dd><code>{{ step.symbol }}</code></dd></template><template v-if="step.input"><dt>输入</dt><dd>{{ step.input }}</dd></template><template v-if="step.output"><dt>输出</dt><dd>{{ step.output }}</dd></template></dl>
        <h5>步骤源码依据</h5>
        <button v-for="(citation, index) in step.citations" :key="index" type="button" class="citation" @click="emit('evidence', { owner: { kind: 'scene', key: step.id }, contextTitle: step.title, contextText: step.responsibility, citations: step.citations, selectedIndex: index })">{{ citation.path }} · L{{ citation.start }}–{{ citation.end }}</button>
        <h5>从这一步到哪里</h5>
        <p v-if="!outgoing.length" class="note">未提供后续关系，不代表已确认流程结束。</p>
        <article v-for="(edge, index) in outgoing" :key="index" class="flow-relation" :class="{ inferred: edge.relation === 'inferred' }">
          <strong>{{ relationLabels[edge.relation] }}</strong><p>{{ step.title }} → {{ stepTitle(edge.to) }}</p><p>{{ edge.explanation }}</p>
          <button type="button" @click="stepId = edge.to">查看步骤：{{ stepTitle(edge.to) }}</button>
          <button v-for="(citation, i) in edge.evidence" :key="i" type="button" class="citation" @click="emit('evidence', { owner: { kind: 'scene', key: `${edge.from}:${edge.to}` }, contextTitle: `${step.title} → ${stepTitle(edge.to)}`, contextText: `${relationLabels[edge.relation]}：${edge.explanation}`, citations: edge.evidence, selectedIndex: i })">关系依据：{{ citation.path }} · L{{ citation.start }}–{{ citation.end }}</button>
        </article>
      </section>
    </div>
    </details>
    <aside v-if="flow.gaps.length" aria-label="链路待核实环节"><h4>尚未确认的环节</h4><ul><li v-for="gap in flow.gaps" :key="gap">{{ gap }}</li></ul></aside>
  </section>
</template>

<style scoped>
.evidence-flow { border-block: 1px solid var(--line); padding-block: 1.2rem; min-width: 0; overflow-wrap: anywhere; }
header { display: flex; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
h2 { font-size: 1.2rem; } h3,h4 { font-size: 1rem; } h5 { font-size: .85rem; margin: 1rem 0 .4rem; }
p,dd,li { line-height: 1.85; white-space: pre-wrap; }
.note { color: var(--muted); font-size: .8rem; }
.flow-layout { display: grid; grid-template-columns: minmax(10rem, 1fr) minmax(0, 2fr); gap: 1.5rem; }
nav ul { list-style: none; padding: 0; margin: 0; } nav li { margin-bottom: .4rem; }
button,select { min-height: 44px; max-width: 100%; white-space: normal; overflow-wrap: anywhere; }
nav button { width: 100%; text-align: left; }
nav button[aria-pressed="true"] { background: var(--gl-solid); color: var(--gl-text); }
.citation { display: block; text-align: left; color: var(--accent); background: transparent; border: 0; }
.flow-relation { border-left: 2px solid var(--line); padding: .8rem; margin-block: .5rem; }
.flow-relation.inferred { border-left-style: dashed; border-color: var(--warning); }
dt { color: var(--muted); font-size: .8rem; } dd { margin: .2rem 0 .7rem; }
aside { border-top: 1px solid var(--line); margin-top: 1rem; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
@media (max-width: 760px) { .flow-layout { grid-template-columns: minmax(0,1fr); gap: .75rem; } }
</style>
