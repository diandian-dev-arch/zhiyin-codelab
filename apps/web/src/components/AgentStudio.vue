<script setup lang="ts">
import StudioSelect from './StudioSelect.vue';
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { ArrowUpRight, ArrowRight, Check, Sparkles, FileSearch, Square, Clock3, RotateCcw } from 'lucide-vue-next';
import type { CaseResult, FeedbackItem } from '@codelab/contracts/v2';
import { analysisProgress, operationNames, operationStatusNames, type AnalysisRecord } from '../analysis-progress';
interface Candidate { candidateId: string; feedback: FeedbackItem[] }
const props = defineProps<{
  analyses: AnalysisRecord[]; candidates: Candidate[]; results: CaseResult[];
  criteria: { criterionId: string; title: string }[];
  available: boolean; busy: boolean; dirty: boolean; editable: boolean; stale: boolean;
}>();
const emit = defineEmits<{
  start: []; cancel: []; select: [criterionId: string];
  adopt: [candidateId: string, criterionId: string]; evidence: [criterionId: string, evidenceId: string];
}>();
const selectedId = ref('');
const active = computed(() => props.analyses.find(a => ['running', 'queued'].includes(a.status)));
const record = computed(() => props.analyses.find(a => a.id === selectedId.value) ?? props.analyses[0]);
watch(() => props.analyses[0]?.id, id => { selectedId.value = id ?? ''; }, { immediate: true });
const progress = computed(() => analysisProgress(record.value, props.stale));
const candidate = computed(() => props.candidates.find(c => c.candidateId === record.value?.id));
const focusedCriterion = ref('');
const concernIds = computed(() => [...new Set(props.results.filter(r => r.verdict !== 'passed').map(r => r.criterionId))]);
const findings = computed(() => [...(candidate.value?.feedback ?? [])].sort((a, b) =>
  Number(concernIds.value.includes(b.criterionId)) - Number(concernIds.value.includes(a.criterionId))));
const finding = computed(() => findings.value.find(f => f.criterionId === focusedCriterion.value) ?? findings.value[0]);
const titleFor = (id: string) => props.criteria.find(c => c.criterionId === id)?.title ?? id;
const supportLabels = { direct: '有直接依据', limited: '有限依据，需复核', insufficient: '依据不足，待核实' };
const statusLabels: Record<string,string> = { queued:'排队中', running:'调查中', succeeded:'已完成', degraded:'未形成建议', interrupted:'已中断', cancelled:'已取消' };
const refs = computed(() => finding.value ? [...new Map(
  [...finding.value.observationEvidenceRefs, ...finding.value.causeEvidenceRefs].map(r => [`${r.scope}:${r.evidenceId}`, r])
).values()] : []);
const now = ref(Date.now());
let timer: ReturnType<typeof setInterval>;
onMounted(() => { timer = setInterval(() => { if (!props.stale) now.value = Date.now(); }, 1000); });
onUnmounted(() => clearInterval(timer));
const elapsed = computed(() => {
  if (!record.value) return '—';
  const end = record.value.finished_at ? Date.parse(record.value.finished_at) : now.value;
  const total = Math.max(0, Math.floor((end - Date.parse(record.value.created_at)) / 1000));
  if (!Number.isFinite(total)) return '—';
  return total < 60 ? `${total}s` : `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, '0')}s`;
});
</script>

<template>
  <section class="agent-studio" aria-labelledby="agent-studio-title" data-testid="agent-studio" :class="{ 'is-working': progress.animating }">
    <header class="studio-masthead">
      <div class="studio-brand"><span class="studio-mark"><Sparkles aria-hidden="true" :size="18" /></span><span>知因 · Agent 调查台</span></div>
      <span class="studio-status"><i class="ms-dot" :class="progress.animating ? 'is-rust' : 'is-off'" />{{ stale ? '连接待恢复' : record ? statusLabels[record.status] ?? '状态待确认' : '准备就绪' }}</span>
    </header>
    <div class="studio-stage">
      <div class="studio-intro">
        <p class="studio-kicker">{{ record?.strategy === 'summary' ? '基于证据的一次性总结' : '从运行现象，到可解释的建议' }}</p>
        <h2 id="agent-studio-title">{{ progress.title }}</h2>
        <p class="studio-description" aria-live="polite">{{ progress.detail }}</p>
        <div class="studio-main-actions">
          <button class="studio-start" :disabled="busy || dirty || !!active || !available || stale" @click="emit('start')">
            <Sparkles aria-hidden="true" :size="16" />{{ active ? '调查进行中' : record ? '发起新的 Agent 调查' : '开始 Agent 调查' }}<ArrowUpRight aria-hidden="true" :size="16" />
          </button>
          <button v-if="active?.mode === 'reanalysis'" class="studio-cancel" :disabled="busy || stale" @click="emit('cancel')"><Square aria-hidden="true" :size="12" />取消分析</button>
          <a href="#review-evidence" class="studio-review-link">先看检查证据 <ArrowRight aria-hidden="true" :size="14" /></a>
        </div>
        <p v-if="!available || dirty || stale" class="studio-hint">{{ stale ? '连接恢复后可重新操作；不会自动重复调用模型。' : !available ? '尚未连接模型，仍可查看检查证据和编辑教师反馈。' : '有未保存的教师修改，请先保存再开始新的调查。' }}</p>
      </div>
    </div>
    <div class="studio-metrics" aria-label="真实分析进度">
      <span><Clock3 aria-hidden="true" :size="14" />含排队耗时 <strong>{{ elapsed }}</strong></span>
      <span>完成操作 <strong>{{ progress.completed }}<small> / {{ record?.operations?.length ?? 0 }}</small></strong></span>
      <span>模型调用 <strong>{{ progress.modelCalls }}</strong></span>
      <span>已归档补充材料 <strong>{{ progress.supplemental }}<small> 次</small></strong></span>
      <span class="metrics-note">依据真实事件更新 · 不预估完成百分比</span>
    </div>

    <div class="studio-workspace">
      <div class="studio-section-heading"><h3>调查轨迹</h3>
        <StudioSelect v-if="analyses.length" v-model="selectedId" aria-label="查看哪次调查">
          <option v-for="a in analyses" :key="a.id" :value="a.id">{{ a.strategy === 'summary' ? '总结' : 'Agent' }} · {{ statusLabels[a.status] ?? a.status }} · {{ a.id.slice(0,8) }}</option>
        </StudioSelect>
        <span v-else class="studio-caption">开始后呈现真实动作</span>
      </div>
      <ol v-if="record?.operations?.length" class="studio-trace" aria-label="Agent实际操作轨迹">
        <li v-for="(op, index) in record.operations" :key="op.operationId" :class="['trace-' + op.state, { 'trace-model': op.kind.startsWith('model_') }]">
          <span class="trace-point"><Check aria-hidden="true" v-if="op.state === 'completed'" :size="12" /><span v-else>{{ String(index + 1).padStart(2,'0') }}</span></span>
          <strong>{{ operationNames[op.kind] ?? '调查操作' }}</strong>
          <small>{{ operationStatusNames[op.state] ?? '状态待确认' }}{{ op.hasSupplementalEvidence ? ' · 材料已归档' : '' }}</small>
        </li>
      </ol>
      <div v-else class="studio-trace-empty"><span>01 研读检查材料</span><ArrowRight aria-hidden="true" :size="14" /><span>02 按需调查取证</span><ArrowRight aria-hidden="true" :size="14" /><span>03 形成修复建议</span><small>调查路径，尚未执行</small></div>

      <div v-if="candidate && finding" class="studio-findings">
        <div class="studio-section-heading"><h3>调查发现</h3><span class="studio-caption">候选建议 · 尚需教师复核</span></div>
        <div class="finding-tabs" aria-label="按要求查看AI建议">
          <button v-for="item in findings" :key="item.criterionId" :aria-pressed="finding.criterionId === item.criterionId" @click="focusedCriterion = item.criterionId">{{ titleFor(item.criterionId) }}<span v-if="concernIds.includes(item.criterionId)" class="concern-dot" /></button>
        </div>
        <div class="finding-body">
          <div><span class="finding-label">实际观察</span><p>{{ finding.observation }}</p>
            <div v-if="refs.length" class="finding-evidence"><template v-for="(reference, index) in refs" :key="reference.scope + reference.evidenceId">
              <button v-if="reference.scope === 'current'" @click="emit('evidence', finding.criterionId, reference.evidenceId)"><FileSearch aria-hidden="true" :size="13" />依据 {{ index + 1 }}<ArrowUpRight aria-hidden="true" :size="12" /></button>
              <span v-else class="studio-caption">依据 {{ index + 1 }} · 前后提交对照材料</span>
            </template></div>
          </div>
          <div><div class="cause-heading"><span class="finding-label">可能原因</span><span class="cause-support">{{ supportLabels[finding.causeSupport] }}</span></div><p>{{ finding.possibleCause || '当前材料不足以确认原因，需要进一步复核。' }}</p></div>
          <div class="finding-next"><span class="finding-label">建议下一步</span><p>{{ finding.nextStep || '保持已验证行为，并核对本次运行证据。' }}</p></div>
        </div>
        <div class="finding-actions"><button class="studio-adopt" :disabled="busy || dirty || !editable" @click="emit('adopt', candidate.candidateId, finding.criterionId)">采用到本条教师草稿<ArrowRight aria-hidden="true" :size="14" /></button><button class="studio-inspect" @click="emit('select', finding.criterionId)">对照原始检查</button><small>{{ dirty ? '请先保存现有修改' : !editable ? '报告已发布，创建更正草稿后可采用' : '采用后仍需确认，不会直接发布给学生' }}</small></div>
      </div>
      <div v-else class="studio-focus">
        <div><h3>{{ progress.active ? '等待期间，先看看这些线索' : '从值得关注的地方开始' }}</h3><p>{{ concernIds.length ? '以下来自基础检查，尚不是 Agent 的原因判断。' : '基础检查未发现失败项；Agent仍可核对材料并整理改进建议。' }}</p></div>
        <div class="focus-items"><button v-for="id in concernIds" :key="id" @click="emit('select', id)"><span class="concern-dot" />{{ titleFor(id) }}<ArrowUpRight aria-hidden="true" :size="14" /></button><a v-if="!concernIds.length" href="#review-evidence">查看全部检查证据 <ArrowRight aria-hidden="true" :size="14" /></a></div>
      </div>
    </div>
    <footer class="studio-footnote"><span><Check aria-hidden="true" :size="13" />基础事实保留</span><span><FileSearch aria-hidden="true" :size="13" />建议可追溯</span><span><RotateCcw aria-hidden="true" :size="13" />教师决定采用与发布</span><span>工具动作可见，不展示模型内部思维链</span></footer>
  </section>
</template>

<style scoped>
.agent-studio { background: var(--paper); border: 1px solid var(--line); border-radius: var(--radius); margin-bottom: var(--space-md); min-width: 0; overflow: hidden; }
.studio-masthead { display: flex; align-items: center; justify-content: space-between; gap: var(--space-sm); padding: var(--space-sm) var(--space-md); border-bottom: 1px solid var(--line); }
.studio-brand, .studio-status { display: flex; align-items: center; gap: var(--space-2xs); font-size: var(--text-sm); }
.studio-brand { font-weight: 600; }
.studio-mark { color: var(--accent); display: inline-flex; }
.studio-status { color: var(--muted); font-size: var(--text-xs); }
.studio-status i { width: 6px; height: 6px; border-radius: 50%; background: var(--muted); }
.studio-status i.lit { background: var(--accent); }
.studio-stage { padding: var(--space-md); }
.studio-kicker { color: var(--muted); font-size: var(--text-xs); margin-bottom: var(--space-2xs); }
.studio-intro h2 { font-size: 1.5rem; margin-bottom: var(--space-xs); }
.studio-description { color: var(--muted); max-width: 75ch; }
.studio-main-actions, .finding-actions { display: flex; align-items: center; gap: var(--space-2xs); flex-wrap: wrap; margin-top: var(--space-sm); }
.studio-start, .studio-adopt { background: var(--accent); color: var(--gl-on-c1); border-color: var(--accent); }
.studio-start:hover:not(:disabled), .studio-adopt:hover:not(:disabled) { background: var(--accent-hover); }
.studio-review-link { display: inline-flex; align-items: center; gap: var(--space-2xs); min-height: 44px; padding: var(--space-2xs); }
.studio-hint { color: var(--warning); font-size: var(--text-xs); margin: var(--space-sm) 0 0; }
.studio-metrics { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-md); padding: var(--space-sm) var(--space-md); background: var(--surface); border-block: 1px solid var(--line); }
.studio-metrics > span { display: flex; align-items: center; gap: var(--space-2xs); color: var(--muted); font-size: var(--text-xs); }
.studio-metrics strong { color: var(--ink); font-size: var(--text-sm); font-variant-numeric: tabular-nums; }
.studio-metrics strong small { display: inline; }
.studio-metrics .metrics-note { margin-left: auto; }
.studio-workspace { padding: var(--space-md); }
.studio-section-heading { display: flex; align-items: center; justify-content: space-between; gap: var(--space-sm); margin-bottom: var(--space-sm); }
.studio-section-heading h3 { margin: 0; }
.studio-section-heading select { width: auto; max-width: 100%; }
.studio-caption { font-size: var(--text-xs); color: var(--muted); }
.studio-trace { display: flex; list-style: none; overflow-x: auto; padding: 0 0 var(--space-sm); margin: var(--space-sm) 0; }
.studio-trace li { flex: 0 0 10rem; min-width: 0; display: flex; flex-direction: column; gap: var(--space-2xs); padding-right: var(--space-sm); }
.studio-trace strong { font-size: var(--text-xs); font-weight: 550; }
.trace-point { width: 28px; height: 28px; display: grid; place-items: center; border: 1px solid var(--line); border-radius: 50%; background: var(--surface); font: var(--text-xs) var(--font-outlier); color: var(--muted); }
.trace-completed .trace-point { color: var(--success); background: var(--success-soft); }
.trace-sent .trace-point { color: var(--accent-ink); background: var(--accent-soft); }
.trace-failed .trace-point, .trace-unknown .trace-point { color: var(--danger); background: var(--danger-soft); }
.studio-trace-empty { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-xs); color: var(--muted); font-size: var(--text-xs); margin-block: var(--space-md); }
.studio-trace-empty small { margin: 0; }
.studio-focus { border-top: 1px solid var(--line); padding-top: var(--space-sm); }
.studio-focus h3 { margin-bottom: var(--space-2xs); }
.studio-focus p { font-size: var(--text-xs); color: var(--muted); }
.focus-items, .finding-tabs, .finding-evidence { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-2xs); }
.focus-items button, .finding-tabs button, .finding-evidence button { font-size: var(--text-xs); }
.focus-items a { display: inline-flex; align-items: center; gap: var(--space-2xs); min-height: 44px; }
.concern-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); flex-shrink: 0; }
.studio-findings { border-top: 1px solid var(--line); padding-top: var(--space-md); }
.finding-tabs button[aria-pressed="true"] { background: var(--accent-soft); color: var(--accent-ink); border-color: var(--accent); }
.finding-body { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: var(--space-md); margin-top: var(--space-md); }
.finding-label { color: var(--muted); font-size: var(--text-xs); }
.finding-body p { margin: var(--space-2xs) 0; white-space: pre-wrap; }
.finding-next { grid-column: 1/-1; padding-top: var(--space-sm); border-top: 1px solid var(--line); }
.cause-heading { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2xs); }
.cause-support { font-size: var(--text-xs); color: var(--warning); }
.finding-actions small { flex-basis: 100%; }
.studio-footnote { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-sm); padding: var(--space-sm) var(--space-md); border-top: 1px solid var(--line); color: var(--muted); font-size: var(--text-xs); }
.studio-footnote span { display: inline-flex; align-items: center; gap: var(--space-2xs); }
@media (max-width: 760px) {
  .studio-masthead, .studio-stage, .studio-metrics, .studio-workspace, .studio-footnote { padding: var(--space-sm); }
  .studio-masthead, .studio-section-heading { flex-wrap: wrap; }
  .studio-section-heading select { width: 100%; }
  .finding-body { grid-template-columns: minmax(0,1fr); }
  .studio-metrics .metrics-note { margin-left: 0; }
}
/* 雾港手稿 (2026-10-04)：墨底刊头 + 宋体标题 + 编号航迹，AI 调查是这页的主角。 */
.agent-studio { border: 0; border-top: 1px solid var(--ink); border-radius: 0; background: transparent; overflow: visible; }
.agent-studio :focus-visible { outline: 2px dashed var(--accent); outline-offset: 3px; }
.studio-masthead { background: var(--gl-solid); color: var(--gl-text); border-bottom: 0; padding-block: var(--space-xs); }
.studio-brand { font-family: var(--font-display); letter-spacing: .08em; }
.studio-mark { color: var(--apricot); }
.studio-status { color: var(--on-ink-muted); font-family: var(--font-outlier); letter-spacing: .08em; }
.studio-status .ms-dot { width: 7px; height: 7px; }
.studio-stage { position: relative; padding-block: var(--space-lg) var(--space-md); padding-inline: 0; }
.studio-kicker { font-family: var(--font-outlier); letter-spacing: .18em; color: var(--accent); }
.studio-intro h2 { font-family: var(--font-display); font-size: clamp(1.5rem, 1.2rem + 1.2vw, 2.1rem); font-weight: 600; letter-spacing: .01em; line-height: 1.35; animation: studio-rise .8s var(--ease-out-expo) both; }
.studio-description { animation: studio-fade .8s var(--ease-out) .12s both; }
.studio-start, .studio-adopt { position: relative; isolation: isolate; overflow: hidden; border-radius: 0; transition: border-color 420ms var(--ease-out), color 420ms var(--ease-out); }
/* Ink wash: a layer of ink spreads from the left edge, like a brush across wet paper. */
.studio-start::before, .studio-adopt::before { content: ''; position: absolute; inset: 0; z-index: -1; background: var(--gl-solid); scale: 0 1; transform-origin: left; transition: scale 560ms var(--ease-emphasis); }
.studio-start:hover:not(:disabled), .studio-adopt:hover:not(:disabled) { background: var(--accent); border-color: var(--ink); }
.studio-start:hover:not(:disabled)::before, .studio-adopt:hover:not(:disabled)::before { scale: 1 1; }
.studio-start svg:last-child { transition: translate 260ms var(--ease-out); }
.studio-start:hover:not(:disabled) svg:last-child { translate: 2px -2px; }
.studio-cancel { border-radius: 0; }
.studio-review-link { color: var(--ink); text-decoration: underline; text-decoration-color: var(--ink-line); text-underline-offset: 5px; }
.studio-review-link:hover { color: var(--accent); text-decoration-color: currentColor; }
.studio-hint { border-left: 2px solid var(--warning); padding-left: var(--space-xs); }
.studio-metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)) auto; gap: 0; padding: 0; background: transparent; border-block: 1px solid var(--ink); }
.studio-metrics > span { flex-direction: column; align-items: flex-start; gap: .2rem; padding: var(--space-sm) var(--space-sm) var(--space-sm) 0; font-family: var(--font-outlier); letter-spacing: .06em; }
.studio-metrics > span + span { padding-left: var(--space-sm); border-left: 1px dashed var(--ink-line); }
.studio-metrics > span > svg { display: none; }
.studio-metrics strong { font-family: var(--font-display); font-size: 1.6rem; line-height: 1.1; font-weight: 600; letter-spacing: 0; }
.studio-metrics strong small { font-size: .75rem; color: var(--muted); font-family: var(--font-outlier); }
.studio-metrics .metrics-note { align-self: end; max-width: 13em; margin-left: 0; font-size: .65rem; }
.studio-workspace { padding-inline: 0; }
.studio-section-heading h3, .studio-focus h3 { font-family: var(--font-display); font-weight: 600; font-size: 1.15rem; }
.studio-caption { font-family: var(--font-outlier); letter-spacing: .06em; }
.studio-trace { position: relative; gap: 0; padding-top: .25rem; }
.studio-trace li { position: relative; flex-basis: 10.5rem; padding-top: .1rem; animation: studio-rise .7s var(--ease-out-expo) both; }
.studio-trace li:nth-child(2) { animation-delay: .07s; } .studio-trace li:nth-child(3) { animation-delay: .14s; } .studio-trace li:nth-child(4) { animation-delay: .21s; } .studio-trace li:nth-child(n+5) { animation-delay: .28s; }
.studio-trace li:not(:last-child)::after { content: ''; position: absolute; top: 15px; left: 36px; right: 8px; border-top: 1.5px dashed var(--ink-line); transform-origin: left; animation: studio-draw .9s var(--ease-draw) both; animation-delay: inherit; }
.studio-trace li.trace-completed:not(:last-child)::after { border-top-style: solid; border-color: var(--ink); }
.studio-trace strong { font-family: var(--font-display); font-size: .9rem; font-weight: 600; }
.studio-trace small { font-family: var(--font-outlier); letter-spacing: .04em; color: var(--muted); }
.trace-point { width: 30px; height: 30px; border-radius: 0; border: 1px solid var(--ink); background: var(--paper); color: var(--ink); font: 600 .8rem var(--font-display); }
.trace-completed .trace-point { color: var(--gl-text); background: var(--gl-solid); border-color: var(--ink); }
.trace-sent .trace-point { color: var(--gl-on-c1); background: var(--accent); border-color: var(--accent); animation: trace-pulse 2.4s var(--ease-out) infinite; }
@keyframes trace-pulse { 0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 45%, transparent); } 70%, 100% { box-shadow: 0 0 0 8px transparent; } }
.trace-failed .trace-point, .trace-unknown .trace-point { border-color: var(--danger); }
.studio-trace-empty { gap: var(--space-sm); padding-block: var(--space-sm); border-block: 1px dashed var(--ink-line); }
.studio-trace-empty > span { font-family: var(--font-display); font-size: .95rem; color: var(--ink); }
.studio-trace-empty > span::first-letter { color: var(--accent); }
.studio-trace-empty small { flex-basis: 100%; font-family: var(--font-outlier); letter-spacing: .06em; }
.studio-focus, .studio-findings { border-top: 1px solid var(--ink); }
.focus-items button, .finding-tabs button { border-radius: 0; }
.focus-items button .concern-dot, .finding-tabs .concern-dot { border-radius: 0; rotate: 45deg; }
.finding-tabs button[aria-pressed="true"] { background: var(--gl-solid); color: var(--gl-text); border-color: var(--ink); }
.finding-body > div { animation: studio-rise .6s var(--ease-out-expo) both; }
.finding-body > div:nth-child(2) { animation-delay: .08s; } .finding-body > div:nth-child(3) { animation-delay: .16s; }
.finding-label { font-family: var(--font-outlier); letter-spacing: .14em; color: var(--accent); }
.finding-next { border-top: 1px dashed var(--ink-line); border-left: 2px solid var(--ink); padding-left: var(--space-sm); }
.finding-evidence button { border-radius: 0; }
.studio-inspect { border-radius: 0; }
.studio-footnote { padding-inline: 0; border-top: 1px solid var(--ink); font-family: var(--font-outlier); letter-spacing: .04em; }
@media (max-width: 760px) {
  .studio-masthead { padding-inline: var(--space-sm); }
  .studio-stage, .studio-workspace, .studio-footnote { padding-inline: 0; }
  .studio-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); padding: 0; }
  .studio-metrics > span:nth-child(odd) { padding-left: 0; border-left: 0; }
  .studio-metrics > span:nth-child(n+3) { border-top: 1px dashed var(--ink-line); }
  .studio-metrics .metrics-note { grid-column: 1 / -1; max-width: none; }
  .studio-metrics strong { font-size: 1.35rem; }
}
.agent-studio { padding: var(--space-md); border: 1px solid var(--gl-line); border-radius: var(--gl-r-xl); background: linear-gradient(160deg,rgb(var(--gl-text-rgb) / .06),transparent 55%),var(--gl-glass); box-shadow: var(--gl-inner-hl),var(--gl-shadow-sm); backdrop-filter: blur(20px) saturate(150%); }
.studio-start, .studio-adopt, .studio-cancel, .focus-items button, .finding-tabs button, .finding-evidence button, .studio-inspect { border-radius: var(--gl-r-pill); }
.studio-start::before, .studio-adopt::before { content: none; }
.studio-metrics, .studio-focus, .studio-findings, .studio-footnote, .studio-trace-empty { border-color: var(--gl-line); }
.studio-metrics > span + span { border-left-style: solid; border-left-color: var(--gl-line); }
.finding-next { border-color: var(--gl-line); }
@media (prefers-reduced-transparency: reduce) { .agent-studio { background: var(--gl-solid); backdrop-filter: none; } }
@media (prefers-reduced-motion: reduce) {
  .agent-studio *, .agent-studio *::before, .agent-studio *::after { animation: none !important; transition: none !important; }
  .studio-start::before, .studio-adopt::before { transition: none; }
}
</style>
