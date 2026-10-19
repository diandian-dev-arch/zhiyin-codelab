<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue';
import type { SourceCitation, SourceReportSection, ReadingBrief } from '@codelab/contracts/source';
import type { EvidenceContext } from '../lib/source-evidence';

const props = defineProps<{ flows: SourceReportSection[]; briefScenes?: ReadingBrief['scenes'] }>();
const emit = defineEmits<{ citation: [citation: SourceCitation]; evidence: [context: EvidenceContext]; change: [] }>();
const selection = ref(0);
const controlId = useId();
const selected = computed(() => props.flows[selection.value]);
const brief = computed(() => props.briefScenes?.find(scene => scene.sourceRef.index === selection.value));
watch(selection, () => emit('change'));
// Polling may replace the report object. Preserve the selected scene when possible.
watch(() => props.flows.length, length => {
  if (selection.value >= length) selection.value = 0;
});
</script>

<template>
  <section class="core-scenario" aria-label="核心业务场景">
    <header>
      <div><h2>核心业务场景</h2></div>
      <div v-if="flows.length > 1" class="scene-choice">
        <label :for="controlId">切换场景</label>
        <select :id="controlId" v-model="selection">
          <option v-for="(flow, index) in flows" :key="index" :value="index">{{ flow.title }}</option>
        </select>
      </div>
    </header>
    <template v-if="selected">
      <h3>{{ selected.title }}</h3>
      <template v-if="brief"><p class="scene-body">{{ brief.businessSummary }}</p><ol v-if="brief.activities?.length"><li v-for="(activity, index) in brief.activities" :key="index">{{ activity.text }}<button v-for="(citation, i) in activity.citations" :key="i" type="button" @click="emit('evidence', { owner: { kind: 'scene', key: String(selection) }, contextTitle: activity.text, citations: activity.citations, selectedIndex: i })">{{ citation.path }} · L{{ citation.start }}–{{ citation.end }}</button></li></ol><details><summary>展开实现细节</summary><p class="scene-body">{{ selected.body }}</p></details></template>
      <p v-else class="scene-body">{{ selected.body }}</p>
      <div v-if="selected.citations.length" class="scene-evidence">
        <h4>查看源码依据</h4>
        <p class="note">以下引用用于核对场景说明，排列次序不代表真实调用顺序。</p>
        <ul>
          <li v-for="(citation, index) in selected.citations" :key="`${citation.path}:${citation.start}:${index}`">
            <button type="button" @click="emit('evidence', { owner: { kind: 'scene', key: String(selection) }, contextTitle: selected.title, contextText: brief?.businessSummary ?? selected.body, citations: selected.citations, selectedIndex: index })">
              <span>{{ citation.path }}</span><span class="lines">L{{ citation.start }}–{{ citation.end }}</span>
            </button>
          </li>
        </ul>
      </div>
      <p v-else class="unverified">待核实：这个场景尚无源码引用，不能作为已证实的实现。</p>
    </template>
    <p v-else class="note">当前已读源码不足以明确核心场景。可在“源码与模块”中查看已有依据。</p>
  </section>
</template>

<style scoped>
.core-scenario { min-width: 0; padding-block: 1.5rem; border-block: 1px solid var(--line); }
header { display: flex; justify-content: space-between; align-items: start; gap: 1.25rem; }
h2 { font-size: 1.2rem; margin: .4rem 0 1rem; }
h3 { font-size: 1.05rem; margin: .5rem 0; overflow-wrap: anywhere; }
h4 { font-size: .9rem; margin: 1rem 0 .3rem; }
.eyebrow, .note, label { color: var(--muted); font-size: .8rem; line-height: 1.8; }
.scene-body { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 1rem; line-height: 1.85; max-width: 46em; }
.scene-choice { display: grid; gap: .3rem; max-width: 22rem; min-width: 0; }
select { min-height: 44px; max-width: 100%; width: 100%; color: var(--ink); background: var(--paper); border: 1px solid var(--line); padding: .5rem; }
ul { list-style: none; padding: 0; margin: 0; }
button { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; min-height: 44px; max-width: 100%; padding: .5rem 0; border: 0; background: transparent; color: var(--accent); text-align: left; }
button span { overflow-wrap: anywhere; min-width: 0; }
.lines { white-space: nowrap; color: var(--muted); }
.unverified { border-left: 2px solid var(--warning); padding-left: .8rem; line-height: 1.8; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
@media (max-width: 760px) { header { display: block; } .scene-choice { max-width: none; margin-bottom: 1rem; } }
</style>
