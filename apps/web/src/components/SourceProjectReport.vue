
<script setup lang="ts">
import { computed, nextTick, ref, useId } from 'vue';
import { validatedReadingBrief, type SourceProjectReportData, type SourceCitation } from '@codelab/contracts/source';
import { ArrowUpRight, FileCode2, Info } from 'lucide-vue-next';
import SourceProjectMap from './SourceProjectMap.vue';
import CoreScenarioReader from './CoreScenarioReader.vue';
import EvidenceFlowReader from './EvidenceFlowReader.vue';
import { evidenceFlowSchema, sourceReportQuality } from '@codelab/contracts/source';
import { prioritizeFindings } from '../lib/finding-priority';
import type { EvidenceContext } from '../lib/source-evidence';

const props = defineProps<{ report: SourceProjectReportData; boundaryInMetadata?: boolean; indexedFiles?: number; readFiles?: number; projectName?: string; files?: readonly { path: string; lines?: number }[] }>();
const readingEnhancementsEnabled = import.meta.env.VITE_READING_BRIEF !== '0';
const brief = computed(() => readingEnhancementsEnabled ? validatedReadingBrief(props.report.readingBrief, props.report) : undefined);
const emit = defineEmits<{ citation: [citation: SourceCitation]; file: [path: string]; evidence: [context: EvidenceContext]; contextChange: [] }>();
const activeTab = ref('overview');
const expandedOverview = ref(false);
const showEvidenceFlow = ref(true);
const evidenceFlowEnabled = import.meta.env.VITE_EVIDENCE_FLOWS !== '0';
const evidenceFlows = computed(() => {
  if (!Array.isArray(props.report.evidenceFlows) || props.report.evidenceFlows.length > 5) return [];
  return props.report.evidenceFlows.flatMap(raw => {
    const result = evidenceFlowSchema.safeParse(raw);
    if (!result.success) return [];
    const flow = result.data;
    const ids = new Set(flow.steps.map(step => step.id));
    if (ids.size !== flow.steps.length || flow.edges.some(edge => !ids.has(edge.from) || !ids.has(edge.to) || edge.from === edge.to)) return [];
    return [flow];
  });
});
const tabId = useId();
const tabs = [
  { id: 'overview', title: '读懂项目' },
  { id: 'structure', title: '源码与模块' },
  { id: 'findings', title: '待核实问题' },
];
const showAllReading = ref(false);
const showAllFindings = ref(false);
const rankedFindings = computed(() => prioritizeFindings(props.report.findings).map(f => readingEnhancementsEnabled ? f : { ...f, condition: undefined, verificationSteps: undefined, remediation: undefined }));
const visibleFindings = computed(() => showAllFindings.value ? rankedFindings.value : rankedFindings.value.slice(0, 3));
const visibleReading = computed(() => showAllReading.value ? props.report.readingPath : props.report.readingPath.slice(0, 1));
const severityLabels: Record<string, string> = { high: '高优先级', medium: '中优先级', low: '低优先级' };
const verificationLabels: Record<string, string> = { retained: '保留线索', withdrawn: '已撤回', unresolved: '仍待核实' };
function cite(citation: SourceCitation, entry: { title?: string; body?: string; citations: SourceCitation[]; originalTitle?: string; reason?: string }, kind: EvidenceContext['owner']['kind']) {
  emit('evidence', { owner: { kind, key: entry.title ?? entry.originalTitle ?? '' }, contextTitle: entry.title ?? entry.originalTitle ?? '源码依据', contextText: entry.body ?? entry.reason, citations: entry.citations, selectedIndex: entry.citations.indexOf(citation) });
}
function citeBrief(entry: { text: string; citations: SourceCitation[] }, citation: SourceCitation, title: string) {
  cite(citation, { title, body: entry.text, citations: entry.citations }, 'reading');
}

async function chooseTab(id: string, focus = false) {
  if (activeTab.value !== id) emit('contextChange');
  activeTab.value = id;
  if (focus) {
    await nextTick();
    const target = document.getElementById(`${tabId}-${id}`);
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  }
}
function tabKeydown(event: KeyboardEvent, index: number) {
  let next = index;
  if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
  else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = tabs.length - 1;
  else return;
  event.preventDefault();
  void chooseTab(tabs[next].id, true);
}
</script>

<template>
  <section class="project-reader" aria-label="项目解读报告">
    <aside v-if="sourceReportQuality(report) === 'limited'" class="reader-warning" aria-label="报告范围受限">
      <strong>报告可读，部分内容受限</strong>
      <p v-for="warning in report.analysisWarnings" :key="warning">{{ warning }}</p>
      <p v-if="!report.analysisWarnings?.length">本次分析未完成全部预定核查，请结合源码核对结论。</p>
      <p>已有内容可继续阅读，相关判断仍需结合源码核实；不会自动重新付费分析。</p>
    </aside>
    <div v-if="!boundaryInMetadata" class="reader-boundary"><Info aria-hidden="true" :size="15" /><span>静态源码分析 · 未执行项目或测试 · 重要结论请结合引用核对</span></div>
    <div class="reader-tabs" role="tablist" aria-label="项目分析内容">
      <button v-for="(item, index) in tabs" :id="`${tabId}-${item.id}`" :key="item.id" type="button" role="tab"
        :aria-selected="activeTab === item.id" :aria-controls="`${tabId}-panel`" :tabindex="activeTab === item.id ? 0 : -1"
        @click="chooseTab(item.id)" @keydown="tabKeydown($event, index)">{{ item.title }}<span v-if="item.id === 'findings' && report.findings.length" class="finding-count"> {{ report.findings.length }}</span></button>
    </div>
    <div :id="`${tabId}-panel`" class="reader-panel" role="tabpanel" :aria-labelledby="`${tabId}-${activeTab}`" tabindex="0">
      <div v-show="activeTab === 'overview'">
        <section class="reader-overview">
          <h2>这个项目解决什么问题</h2>
          <template v-if="brief">
            <p class="purpose-text">{{ brief.purpose.text }}</p>
            <dl class="purpose-facts"><template v-if="brief.purpose.audience"><dt>使用者</dt><dd>{{ brief.purpose.audience }}</dd></template><template v-if="brief.purpose.input"><dt>输入</dt><dd>{{ brief.purpose.input }}</dd></template><template v-if="brief.purpose.output"><dt>输出</dt><dd>{{ brief.purpose.output }}</dd></template></dl>
            <div class="reader-citations"><button v-for="citation in brief.purpose.citations" :key="`${citation.path}:${citation.start}`" type="button" class="reader-source" @click="citeBrief(brief.purpose, citation, '项目用途')"><FileCode2 aria-hidden="true" :size="14" /><span>{{ citation.path }}</span><small>L{{ citation.start }}–{{ citation.end }}</small><ArrowUpRight aria-hidden="true" :size="14" /></button></div>
            <details><summary>完整项目概览</summary><p class="overview-text expanded">{{ report.overview }}</p></details>
          </template>
          <template v-else><p class="overview-text" :class="{ expanded: expandedOverview || report.overview.length <= 220 }">{{ report.overview || '当前报告尚未提供足够证据说明项目用途。' }}</p>
          <button v-if="report.overview.length > 220" type="button" class="reader-text-link" :aria-expanded="expandedOverview" @click="expandedOverview = !expandedOverview">{{ expandedOverview ? '收起完整概览' : '展开完整概览' }}</button></template>
        </section>
        <template v-if="evidenceFlowEnabled && evidenceFlows.length">
          <button type="button" class="reader-text-link" :aria-pressed="showEvidenceFlow" @click="showEvidenceFlow = !showEvidenceFlow">{{ showEvidenceFlow ? '切回场景说明' : '查看结构化链路' }}</button>
          <EvidenceFlowReader v-show="showEvidenceFlow" :flows="evidenceFlows" @citation="emit('citation', $event)" @evidence="emit('evidence', $event)" @change="emit('contextChange')" />
        </template>
        <CoreScenarioReader v-show="!evidenceFlowEnabled || !evidenceFlows.length || !showEvidenceFlow" :flows="report.flows" :brief-scenes="brief?.scenes" @evidence="emit('evidence', $event)" @change="emit('contextChange')" />
        <section class="reader-reading" aria-label="优先阅读入口">
          <div class="reader-section-heading"><h2>建议先读</h2></div>
          <p v-if="!report.readingPath.length" class="reader-empty">当前报告未提供足够证据形成阅读路线。</p>
          <ol class="reader-learning-list">
            <li v-for="(entry, index) in visibleReading" :key="`reading-${index}`">
              <span class="reader-step">{{ index + 1 }}</span>
              <article class="reader-article">
                <h3>{{ entry.title }}</h3><p>{{ entry.body }}</p>
                <div v-if="entry.nextStep" class="reader-next-step"><strong>后续建议</strong><p>{{ entry.nextStep }}</p></div>
                <div class="reader-citations">
                  <button v-for="citation in entry.citations" :key="`${citation.path}:${citation.start}`" class="reader-source" type="button" @click="cite(citation, entry, 'reading')">
                    <FileCode2 aria-hidden="true" :size="14" /><span>{{ citation.path }}</span><small>L{{ citation.start }}–{{ citation.end }}</small><ArrowUpRight aria-hidden="true" :size="14" />
                  </button>
                </div>
              </article>
            </li>
          </ol>
          <button v-if="report.readingPath.length > 1" class="reader-text-link" type="button" :aria-expanded="showAllReading" @click="showAllReading = !showAllReading">{{ showAllReading ? '收起更多阅读建议' : `查看全部 ${report.readingPath.length} 个阅读建议` }}</button>
          <button v-if="report.findings.length" class="reader-text-link reader-findings-link" type="button" @click="chooseTab('findings', true)">查看 {{ report.findings.length }} 条待核实问题</button>
        </section>
        <section v-if="brief?.takeaway" class="reader-takeaway"><h2>阅读重点</h2><p>{{ brief.takeaway.text }}</p><div class="reader-citations"><button v-for="citation in brief.takeaway.citations" :key="`${citation.path}:${citation.start}`" type="button" class="reader-source" @click="citeBrief(brief.takeaway, citation, '阅读重点')"><FileCode2 aria-hidden="true" :size="14" /><span>{{ citation.path }}</span><small>L{{ citation.start }}–{{ citation.end }}</small><ArrowUpRight aria-hidden="true" :size="14" /></button></div></section>
      </div>
      <div v-show="activeTab === 'structure'">
        <div v-if="report.stack.length" class="reader-stack" role="group" aria-label="报告识别的技术栈"><span v-for="stack in report.stack.slice(0, 5)" :key="stack">{{ stack }}</span><details v-if="report.stack.length > 5" class="reader-stack-more"><summary>另外 {{ report.stack.length - 5 }} 项</summary><div><span v-for="stack in report.stack.slice(5)" :key="stack">{{ stack }}</span></div></details></div>
        <details><summary>浏览项目地图与文件</summary><SourceProjectMap modules-only :report="report" :project-name="projectName" :files="files" @citation="emit('citation', $event)" @file="emit('file', $event)" /></details>
        <div class="reader-chapter-title"><h2>先分清职责，再沿业务追踪</h2><p>模块职责保留报告原有判断和引用，不把目录列表或共享文件当作真实调用关系。</p></div>
        <section v-for="group in [{ key: 'modules', title: '模块职责', sections: report.modules }]" :key="group.key" class="reader-section-group">
          <h2>{{ group.title }} <span class="reader-section-count">{{ group.sections.length }}</span></h2>
          <p v-if="!group.sections.length" class="reader-empty">当前已读片段没有足够证据形成这一部分的结论。</p>
          <details v-for="(entry, index) in group.sections" :key="`${group.key}-${index}`" class="reader-entry" :open="index === 0">
            <summary><span class="reader-entry-index">{{ String(index + 1).padStart(2, '0') }}</span><span class="reader-entry-label"><strong>{{ entry.title }}</strong><small>{{ entry.citations.length ? `${entry.citations.length} 处源码依据` : '暂无源码引用' }}</small></span></summary>
            <div class="reader-entry-body"><p>{{ entry.body }}</p><div class="reader-citations"><button v-for="citation in entry.citations" :key="`${citation.path}:${citation.start}`" class="reader-source" type="button" @click="cite(citation, entry, 'module')"><FileCode2 aria-hidden="true" :size="14" /><span>{{ citation.path }}</span><small>L{{ citation.start }}–{{ citation.end }}</small><ArrowUpRight aria-hidden="true" :size="14" /></button></div></div>
          </details>
        </section>
      </div>
      <div v-show="activeTab === 'findings'">
        <div class="reader-chapter-title"><h2>带着证据核对每一条判断</h2><p>静态分析提供问题线索与验证建议。没有发现问题不等于项目没有问题。</p></div>
        <p v-if="!report.findings.length" class="reader-empty">当前已读范围没有形成可发布的问题线索，可查看下方复核记录与分析边界。</p>
        <p v-if="report.findings.length" class="reader-note">优先展示有引用和验证建议的线索，再参考报告标注的优先级。排序仅辅助阅读，不代表结论已经证实。</p>
        <article v-for="(finding, index) in visibleFindings" :key="`finding-${index}`" class="reader-article reader-finding"><div class="reader-finding-title"><h3>{{ finding.title }}</h3><span v-if="finding.severity" class="reader-status">{{ severityLabels[finding.severity] ?? finding.severity }}</span><span class="reader-confidence">{{ !finding.citations.length ? '缺少源码引用 · 待核实' : finding.confidence === 'direct' ? '有源码引用 · 仍需验证' : '待验证假设' }}</span></div><p>{{ finding.body }}</p><section v-if="finding.condition"><h4>发生条件</h4><p>{{ finding.condition }}</p></section><section v-if="finding.verificationSteps?.length"><h4>验证动作</h4><ol><li v-for="(step, i) in finding.verificationSteps" :key="i"><p>{{ step.action }}</p><p>预期观察：{{ step.expectedObservation }}</p></li></ol></section><section v-if="finding.remediation"><h4>确认后的修复建议</h4><p>{{ finding.remediation }}</p></section><div v-if="finding.nextStep" class="reader-next-step"><strong>后续建议</strong><p>{{ finding.nextStep }}</p></div><div class="reader-citations"><button v-for="citation in finding.citations" :key="`${citation.path}:${citation.start}`" class="reader-source" type="button" @click="cite(citation, finding, 'finding')"><FileCode2 aria-hidden="true" :size="14" /><span>{{ citation.path }}</span><small>L{{ citation.start }}–{{ citation.end }}</small><ArrowUpRight aria-hidden="true" :size="14" /></button></div></article>
        <button v-if="report.findings.length > 3" class="reader-text-link" type="button" :aria-expanded="showAllFindings" @click="showAllFindings = !showAllFindings">{{ showAllFindings ? '收起更多问题线索' : `查看全部 ${report.findings.length} 条问题线索` }}</button>
        <details class="reader-verification"><summary>反证复核与撤回记录 <span v-if="report.verification">{{ report.verification.length }} 项</span></summary><p class="reader-note">{{ report.verification ? '逐条追查初步判断的相关实现。撤回的判断不会进入最终建议；保留的线索仍需运行验证。' : '这份历史报告没有记录反证复核。已有报告保持原样；重新分析可生成新版记录。' }}</p><p v-if="report.verification && !report.verification.length" class="reader-note">初步报告没有提出问题线索，因此没有逐项复核记录。这不代表项目没有问题。</p><article v-for="(item, index) in report.verification" :key="`verification-${index}`" class="reader-article"><div class="reader-finding-title"><h3>{{ item.originalTitle }}</h3><span class="reader-status" :class="{ withdrawn: item.decision === 'withdrawn' }">{{ verificationLabels[item.decision] ?? item.decision }}</span></div><p>{{ item.reason }}</p><div class="reader-citations"><button v-for="citation in item.citations" :key="`${citation.path}:${citation.start}`" class="reader-source" type="button" @click="cite(citation, item, 'verification')"><FileCode2 aria-hidden="true" :size="14" /><span>{{ citation.path }}</span><small>L{{ citation.start }}–{{ citation.end }}</small><ArrowUpRight aria-hidden="true" :size="14" /></button></div></article></details>
      </div>

    </div>
    <details class="reader-limits"><summary><span>本次分析的边界</span><small>{{ readFiles !== undefined ? `已阅读 ${readFiles} 个文件的部分源码` : '阅读范围与待验证内容' }}</small></summary><div class="reader-limits-body"><p v-if="indexedFiles !== undefined">索引 {{ indexedFiles }} 个文件<span v-if="readFiles !== undefined">，实际阅读 {{ readFiles }} 个文件的部分源码</span>。没有安装依赖或执行测试。</p><p>引用校验仅确认出处位于实际读过的行段，不等于已证明结论正确或完成全仓库审计。</p><p v-for="limit in report.limitations" :key="limit">{{ limit }}</p></div></details>
  </section>
</template>

<style scoped>
.purpose-text { font-size: 1.25rem; line-height: 1.8; max-width: 46em; }
.purpose-facts { font-size: 1rem; max-width: 46em; }
.purpose-facts dt { color: var(--muted); margin-top: .5rem; }
.purpose-facts dd { margin-left: 0; line-height: 1.8; }
.project-reader, .project-reader :deep(*) { letter-spacing: 0; }
.project-reader .reader-overview { padding: 0 0 1.5rem; border: 0; border-radius: 0; background: transparent; }
.project-reader .overview-text { max-width: 46em; font-size: 1rem; line-height: 1.8; }
.project-reader .reader-boundary { font-size: .875rem; margin-bottom: .35rem; }
.project-reader .reader-tabs { margin-bottom: .5rem; gap: 1.25rem; }
.project-reader .reader-tabs button { white-space: normal; font-size: 1rem; padding: .5rem 0; }
.project-reader .reader-article > p, .project-reader .reader-entry-body > p, .project-reader .reader-next-step p { max-width: 46em; font-size: 1rem; line-height: 1.85; }
.project-reader .reader-source { min-height: 44px; font-size: .875rem; white-space: normal; }
.project-reader .reader-text-link { font-size: .875rem; min-height: 44px; white-space: normal; }
.project-reader .reader-source small { font-size: .8125rem; }
.project-reader .reader-stack { margin-block: 0 1.25rem; }
.project-reader .reader-entry > summary { transform: none; padding-inline-start: .25rem; transition: none; }
.finding-count { color: var(--accent); font-variant-numeric: tabular-nums; }
.reader-reading { margin-top: 1.5rem; }
.reader-findings-link { display: flex; margin-top: .75rem; }
.reader-warning { border-left: 3px solid var(--warning); padding: .8rem 1rem; margin-bottom: 1.25rem; background: var(--warning-soft); overflow-wrap: anywhere; }
.reader-warning p { font-size: .85rem; line-height: 1.8; }

.project-reader { min-width: 0; color: var(--ink); }
.reader-boundary { display: flex; align-items: flex-start; gap: .5rem; color: var(--muted); font-size: .75rem; line-height: 1.8; margin-bottom: 1.15rem; }
.reader-boundary svg { flex: 0 0 auto; margin-top: .18rem; color: var(--accent); }
.reader-tabs { display: flex; gap: 1.75rem; border-bottom: 1px solid var(--line); margin-bottom: 1.5rem; }
.reader-tabs button { position: relative; min-height: 46px; padding: 0 0 .9rem; border: 0; border-radius: 0; box-shadow: none; background: transparent; color: var(--muted); font-size: .875rem; white-space: nowrap; }
.reader-tabs button[aria-selected="true"] { color: var(--ink); font-weight: 650; }
.reader-tabs button[aria-selected="true"]::after { content: ''; position: absolute; height: 3px; bottom: -1px; left: 0; right: 0; border-radius: 2px; background: var(--accent); }
.reader-tabs button:hover { background: transparent; color: var(--accent); }
.reader-panel { min-width: 0; }
.reader-overview { padding: 1.65rem 1.8rem 1.55rem; background: var(--paper); border: 1px solid var(--line); border-bottom: 0; border-radius: var(--radius) var(--radius) 0 0; }
.reader-kicker { display: flex; align-items: center; gap: .5rem; color: var(--muted); font-size: .75rem; font-weight: 550; line-height: 1.7; }
.reader-kicker svg { color: var(--accent); flex: 0 0 auto; }
.reader-overview h2 { font-size: 1.1rem; margin: .55rem 0 .75rem; }
.overview-text { font-size: 1.06rem; line-height: 1.95; color: var(--ink); white-space: pre-wrap; margin: 0; max-width: 88ch; display: -webkit-box; -webkit-line-clamp: 5; -webkit-box-orient: vertical; overflow: hidden; }
.overview-text.expanded { display: block; }
.reader-stack { display: flex; flex-wrap: wrap; gap: .4rem; margin-top: 1.05rem; align-items: center; }
.reader-stack > span, .reader-stack details span { display: inline-block; padding: .22rem .55rem; border: 1px solid var(--line); border-radius: 5px; color: var(--muted); background: var(--surface); font-size: .72rem; }
.reader-stack details { border: 0; padding: 0; }
.reader-stack summary { padding: .22rem 1.75rem .22rem .4rem; color: var(--muted); font-size: .75rem; }
.reader-stack details > div { display: flex; flex-wrap: wrap; gap: .4rem; padding-top: .5rem; }
.reader-stack .reader-stack-more { margin: 0; }
.reader-stack-more[open] { flex-basis: 100%; padding-bottom: .4rem; }
.reader-stack-more summary { min-height: 44px; }
.reader-takeaway { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: .6rem 1.5rem; padding: 1.25rem 1.8rem; border-inline: 1px solid var(--line); border-top: 1px solid var(--line); background: var(--paper); }
.takeaway-label { display: flex; align-items: center; gap: .5rem; grid-column: 1 / -1; color: var(--accent); font-size: .75rem; font-weight: 550; }
.takeaway-copy { min-width: 0; }
.takeaway-copy h3 { margin: 0; font-size: .9375rem; line-height: 1.7; }
.takeaway-copy p { margin: .5rem 0; color: var(--ink); font-size: .8125rem; line-height: 1.9; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; white-space: pre-wrap; }
.takeaway-heading { display: flex; align-items: baseline; flex-wrap: wrap; gap: .5rem; }
.takeaway-note { color: var(--muted); font-size: .75rem; line-height: 1.8; }
.reader-takeaway > button { align-self: start; }
.reader-flow-summary { border: 1px solid var(--line); border-radius: 0 0 var(--radius) var(--radius); background: var(--paper); padding: 1.4rem 1.8rem 1.65rem; }
.reader-section-heading { display: flex; align-items: center; justify-content: space-between; gap: 1rem; margin-bottom: 1rem; }
.reader-section-heading h2 { display: flex; align-items: center; gap: .5rem; font-size: .9375rem; line-height: 1.65; margin: 0; }
.reader-section-heading .reader-kicker { margin-bottom: .4rem; }
.reader-section-heading h2 svg { color: var(--accent); flex: 0 0 auto; }
.reader-text-link { display: inline-flex; gap: .4rem; align-items: center; min-height: 40px; border: 0; padding: .45rem 0; color: var(--accent); background: transparent; font-size: .75rem; white-space: nowrap; box-shadow: none; }
.reader-text-link:hover { background: transparent; text-decoration: underline; text-underline-offset: .2rem; }
.reader-flow-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr)); gap: .9rem; }
.reader-flow-grid article { min-width: 0; padding: 1rem; border: 1px solid var(--line); border-radius: .6rem; background: var(--surface); }
.reader-flow-grid article:first-child { border-color: color-mix(in oklch, var(--apricot) 60%, var(--line)); background: var(--accent-soft); }
.flow-index { color: var(--muted); font-family: var(--font-outlier); font-size: .6875rem; }
.reader-flow-grid h3 { font-size: .875rem; margin: .6rem 0; line-height: 1.7; }
.reader-flow-grid p { color: var(--muted); font-size: .8125rem; line-height: 1.9; margin: 0 0 .5rem; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.reader-overview-columns { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr); gap: 2.25rem; margin-top: 1.8rem; }
.reader-module-summary { display: flex; gap: .8rem; align-items: flex-start; padding: .9rem 0; border-bottom: 1px solid var(--line); }
.reader-module-summary > div { flex: 1; min-width: 0; }
.reader-module-summary h3, .reader-start-list h3 { font-size: .875rem; line-height: 1.8; margin: 0 0 .3rem; }
.reader-module-summary p, .reader-start-list p { color: var(--muted); font-size: .8125rem; line-height: 1.9; margin: 0; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.reader-module-source { display: grid; place-items: center; width: 40px; min-height: 40px; padding: .5rem; border: 0; color: var(--accent); background: transparent; flex: 0 0 auto; box-shadow: none; }
.reader-start-list { list-style: none; margin: 0; padding: .5rem 0 0; }
.reader-start-list li { display: grid; grid-template-columns: 25px minmax(0, 1fr); gap: .7rem; margin-bottom: 1.25rem; }
.reader-step { display: grid; place-items: center; width: 24px; height: 24px; border: 1px solid var(--control-line); border-radius: 50%; color: var(--accent); font: .75rem var(--font-outlier); }
.reader-source { display: inline-flex; align-items: center; gap: .4rem; max-width: 100%; min-height: 38px; padding: .45rem .1rem; border: 0; border-radius: .25rem; background: transparent; color: var(--accent); font-size: .72rem; line-height: 1.65; text-align: left; box-shadow: none; }
.reader-source > span { overflow-wrap: anywhere; font-family: var(--font-outlier); }
.reader-source svg { flex: 0 0 auto; }
.reader-source small { white-space: nowrap; font-size: .6875rem; color: var(--muted); }
.reader-source:hover { background: transparent; text-decoration: underline; text-underline-offset: .2rem; }
.reader-chapter-title { margin-bottom: 1.6rem; }
.reader-chapter-title h2 { margin: 0 0 .65rem; font-size: 1.15rem; }
.reader-chapter-title p { color: var(--muted); font-size: .875rem; line-height: 1.9; margin: 0; }
.reader-section-group + .reader-section-group { margin-top: 2rem; }
.reader-section-group > h2 { font-size: 1rem; margin-bottom: .45rem; color: var(--accent); }
.reader-section-count { margin-left: .5rem; font: .75rem var(--font-outlier); color: var(--muted); }
.reader-entry { margin: 0; padding: 0; border: 0; border-bottom: 1px solid var(--line); border-radius: 0; background: transparent; }
.reader-entry > summary { display: flex; align-items: center; gap: .9rem; padding: .9rem 2rem .9rem .25rem; min-height: 68px; }
.reader-entry-index { flex-shrink: 0; color: var(--muted); font: .75rem var(--font-outlier); }
.reader-entry-label { display: grid; gap: .2rem; min-width: 0; }
.reader-entry-label strong { font-size: .875rem; line-height: 1.8; font-weight: 550; overflow-wrap: anywhere; }
.reader-entry-label small { color: var(--muted); font-size: .6875rem; font-weight: 400; }
.reader-entry-body { padding: 0 .25rem 1.2rem 2.25rem; }
.reader-entry-body > p { margin: 0; font-size: .875rem; line-height: 1.95; white-space: pre-wrap; overflow-wrap: anywhere; }
.reader-entry[open] > summary { margin-bottom: .35rem; color: var(--ink); }
.reader-article { padding: 1.25rem 0; border-bottom: 1px solid var(--line); min-width: 0; }
.reader-article h3 { font-size: .9375rem; line-height: 1.8; margin: 0 0 .55rem; }
.reader-article > p, .reader-next-step p { font-size: .875rem; line-height: 1.95; white-space: pre-wrap; margin: 0; overflow-wrap: anywhere; }
.reader-citations { display: flex; flex-wrap: wrap; column-gap: 1rem; margin-top: .55rem; }
.reader-finding-title { display: flex; align-items: baseline; gap: .5rem; flex-wrap: wrap; margin-bottom: .6rem; }
.reader-finding-title h3 { margin: 0; }
.reader-status, .reader-confidence { padding: .2rem .5rem; border-radius: .3rem; background: var(--warning-soft); color: var(--warning); font-size: .6875rem; line-height: 1.8; }
.reader-confidence, .reader-status.withdrawn { background: var(--surface); color: var(--muted); }
.reader-next-step { padding: 1rem 1.15rem; background: var(--surface); border-radius: .5rem; margin-top: .9rem; }
.reader-next-step strong { display: block; font-size: .8125rem; margin-bottom: .3rem; }
.reader-note, .reader-empty { color: var(--muted); font-size: .8125rem; line-height: 1.95; }
.reader-verification { margin-top: 1.6rem; border-top: 1px solid var(--line); }
.reader-verification summary, .reader-limits summary { min-height: 44px; padding: .8rem 2rem .8rem 0; font-size: .8125rem; font-weight: 550; cursor: pointer; }
.reader-verification summary span { color: var(--muted); font-weight: 400; margin-left: .5rem; }
.reader-learning-list { list-style: none; padding: 0; margin: 0; }
.reader-learning-list li { display: grid; grid-template-columns: 26px minmax(0, 1fr); gap: .9rem; }
.reader-learning-list .reader-step { margin-top: 1.4rem; }
.reader-limits { border-top: 1px solid var(--line); margin-top: 1.75rem; }
.reader-limits p { color: var(--muted); font-size: .75rem; line-height: 1.95; margin: .25rem 0 .75rem; }
.reader-limits summary small { color: var(--muted); font-size: .75rem; font-weight: 400; margin-left: .75rem; }
.reader-limits-body { padding: .25rem 0 .6rem; }
.project-reader :focus-visible { outline: 3px solid var(--accent); outline-offset: 4px; }
@media (max-width: 760px) {
  .reader-boundary { font-size: .75rem; }
  .reader-tabs { gap: .6rem; justify-content: space-between; margin-bottom: 1.25rem; }
  .reader-tabs button { min-height: 46px; font-size: .78rem; }
  .reader-overview, .reader-flow-summary { padding: 1.15rem; }
  .reader-takeaway { grid-template-columns: minmax(0, 1fr); gap: .6rem; padding: 1.15rem; }
  .reader-takeaway > button { justify-self: start; }
  .overview-text { font-size: .9375rem; -webkit-line-clamp: 6; }
  .reader-overview-columns { grid-template-columns: 1fr; gap: 1.4rem; margin-top: 1.4rem; }
  .reader-flow-grid { grid-template-columns: 1fr; }
  .reader-flow-grid p, .reader-module-summary p, .reader-start-list p { font-size: .8125rem; }
  .reader-text-link, .reader-source, .reader-module-source { min-height: 44px; }
  .reader-text-link { font-size: .78rem; }
  .reader-module-source { width: 44px; }
  .reader-section-heading { gap: .5rem; }
  .reader-section-heading h2 { font-size: .875rem; }
  .reader-source { font-size: .75rem; flex-wrap: wrap; }
  .reader-source > span { min-width: 0; }
  .reader-article > p, .reader-next-step p { font-size: .8125rem; }
  .reader-entry-body { padding-left: .25rem; }
  .reader-entry-body > p { font-size: .8125rem; }
  .reader-limits summary small { margin-left: 0; }
}
/* ── 雾港手稿 (2026-10-04): the report reads as a ruled field notebook ── */
.reader-boundary { font-family: var(--font-outlier); letter-spacing: .08em; }
.reader-tabs { gap: 2rem; border-bottom: 1px solid var(--ink); }
.reader-tabs button { letter-spacing: .12em; }
.reader-tabs button[aria-selected="true"]::after { height: 3px; bottom: 2px; border-radius: 0; transform-origin: left; animation: studio-draw .7s var(--ease-out-expo) both; }
.reader-panel > * { animation: studio-rise .8s var(--ease-out-expo) both; }
.reader-panel > :nth-child(2) { animation-delay: .08s; }
.reader-panel > :nth-child(3) { animation-delay: .16s; }
.reader-panel > :nth-child(n + 4) { animation-delay: .24s; }
.reader-kicker { font-family: var(--font-outlier); font-weight: 400; letter-spacing: .16em; font-size: .6875rem; }
.reader-overview { padding: .25rem 0 1.75rem; background: transparent; border: 0; border-radius: 0; }
.reader-overview h2 { font-size: 1.125rem; line-height: 1.5; letter-spacing: 0; margin: 0 0 .5rem; }
.overview-text { font-size: 1.0625rem; line-height: 2; }
.reader-stack > span, .reader-stack details span { border-radius: 0; background: transparent; border-color: var(--ink-line); font-family: var(--font-outlier); letter-spacing: .04em; }
.reader-takeaway { padding: 1.25rem 1.5rem; border: 0; border-left: 2px solid var(--accent); background: color-mix(in srgb, var(--accent-soft) 70%, transparent); }
.takeaway-label { font-family: var(--font-outlier); letter-spacing: .14em; }
.takeaway-copy h3 { font-size: 1.125rem; letter-spacing: .03em; }
.reader-flow-summary { margin-top: 1.75rem; padding: 1.1rem 0 0; border: 0; border-top: 1px solid var(--ink); border-radius: 0; background: transparent; }
.reader-section-heading h2 { font-size: 1.125rem; letter-spacing: .04em; }
.reader-text-link { letter-spacing: .08em; }
.reader-flow-grid { gap: 1.5rem; }
.reader-flow-grid article { padding: .9rem 0 0; border: 0; border-top: 1px solid var(--ink-line); border-radius: 0; background: transparent; transition: border-color .6s var(--ease-out); }
.reader-flow-grid article:first-child { border-color: var(--accent); background: transparent; }
.reader-flow-grid article:hover { border-color: var(--ink); }
.flow-index { display: block; font: 600 1.5rem/1.1 var(--font-display); color: var(--ink); letter-spacing: .04em; }
.reader-flow-grid article:first-child .flow-index { color: var(--accent); }
.reader-flow-grid h3 { font-size: 1rem; letter-spacing: .03em; }
.reader-module-summary { border-bottom: 1px solid var(--line); }
.reader-module-summary h3, .reader-start-list h3, .reader-article h3 { letter-spacing: .03em; }
.reader-step { border-color: var(--ink-line); color: var(--ink); font: 600 .875rem var(--font-display); }
.reader-start-list li:first-child .reader-step { background: var(--gl-solid); border-color: var(--ink); color: var(--gl-text); }
.reader-source { border-radius: 0; }
.reader-chapter-title { padding-bottom: 1rem; border-bottom: 1px solid var(--ink); }
.reader-chapter-title h2 { font-size: clamp(1.45rem, 1.1rem + 1vw, 1.95rem); line-height: 1.45; letter-spacing: .04em; }
.reader-section-group > h2 { font-size: 1.25rem; color: var(--ink); letter-spacing: .04em; }
.reader-section-count { color: var(--accent); vertical-align: super; letter-spacing: .1em; }
.reader-entry { border-bottom: 1px solid var(--line); }
.reader-entry > summary { position: relative; isolation: isolate; gap: 1.1rem; }
.reader-entry > summary::before { content: ''; position: absolute; inset: 0; z-index: -1; background: var(--paper); opacity: 0; transition: opacity 180ms var(--ease-out); }
.reader-entry > summary:hover::before { opacity: 1; }
.reader-entry-index { min-width: 2.6rem; font: 600 1.75rem/1 var(--font-display); color: var(--ink); letter-spacing: 0; transition: color 180ms var(--ease-out); }
.reader-entry[open] .reader-entry-index, .reader-entry > summary:hover .reader-entry-index { color: var(--accent); }
.reader-entry-label strong { font-family: var(--font-display); font-size: 1rem; font-weight: 600; letter-spacing: .03em; }
.reader-entry-label small { font-family: var(--font-outlier); letter-spacing: .08em; }
.reader-entry-body { padding-left: 3.75rem; }
.reader-article { border-bottom: 1px solid var(--line); }
.reader-status, .reader-confidence { border-radius: 0; font-family: var(--font-outlier); letter-spacing: .06em; }
.reader-next-step { padding: .6rem 0 .6rem 1rem; background: transparent; border-left: 2px solid var(--ink); border-radius: 0; }
.reader-next-step strong { font-family: var(--font-display); letter-spacing: .04em; }
.reader-verification, .reader-limits { border-top: 1px solid var(--ink); }
.reader-verification summary, .reader-limits summary { font-family: var(--font-display); font-weight: 600; letter-spacing: .04em; }
.reader-entry[open] { border-bottom-color: var(--ink-line); }
.project-reader :focus-visible { outline: 2px dashed var(--accent); outline-offset: 4px; }
.reader-tabs button:focus-visible { box-shadow: 0 0 0 7px var(--paper); }
@media (max-width: 760px) {
  .reader-tabs { gap: .6rem; }
  .project-reader .reader-tabs { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1.25fr); gap: .5rem; }
  .project-reader .reader-tabs button { display: flex; align-items: center; justify-content: center; gap: .2rem; min-width: 0; font-size: .875rem; white-space: nowrap; }
  .project-reader .finding-count { flex: 0 0 auto; }
  .reader-overview { padding-inline: 0; }
  .reader-flow-summary { padding-inline: 0; }
  .reader-takeaway { padding: 1.1rem 1rem; }
  .reader-entry-index { min-width: 2rem; font-size: 1.35rem; }
  .reader-entry-body { padding-left: .25rem; }
}
@media (prefers-reduced-motion: reduce) {
  .project-reader *, .project-reader *::before, .project-reader *::after { transition: none !important; animation: none !important; scroll-behavior: auto !important; }
  .project-reader :deep(details::details-content) { transition: none !important; }
}
</style>
