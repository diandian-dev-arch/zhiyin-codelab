<script setup lang="ts">
import { citationRange } from '../lib/source-evidence';
import { accountDisplayName } from '../lib/account-display';
import StudioSelect from './StudioSelect.vue';
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import { Award, BookOpen, Check, MessageSquare, Sparkles, X } from 'lucide-vue-next';
import { apiV2, useSession } from '../api';
import PersonalModelDialog from './PersonalModelDialog.vue';
import SourceCostControls from './SourceCostControls.vue';
import SourceProjectReport from './SourceProjectReport.vue';
import type { SourceCitation, SourceProjectReportData } from '@codelab/contracts/source';
import SourceEvidenceReader from './SourceEvidenceReader.vue';
import type { PersonalModelState } from '@codelab/contracts/model-settings';
import type { SourceAnalysisOptions } from '@codelab/contracts/source';
import type { ProjectRubric, ProjectSubmissionDetail, ProjectReportEnvelope } from '../project-task-types';

const props = defineProps<{ submissionId: string; rubric: ProjectRubric[] }>();
const emit = defineEmits<{ changed: [] }>();
const session = useSession();
const detail = ref<ProjectSubmissionDetail>();
const loading = ref(true), error = ref(''), notice = ref(''), busy = ref(''), connectionError = ref('');
const selectedTab = ref<'report' | 'reviews'>('report');
const strength = ref(''), improvement = ref(''), recommend = ref(false);
const feedback = ref(''), outcome = ref<'achieved' | 'needs_revision' | 'pending'>('pending');
const featured = ref(false), featureReason = ref('');
const modelDialog = ref<InstanceType<typeof PersonalModelDialog>>();
const personalModel = ref<PersonalModelState>();
const modelError = ref('');
const analysisPanel = ref(false), previewPending = ref(false);
const costPolicy = ref<SourceAnalysisOptions['cost']>();
const costValid = ref(false);
const teacher = computed(() => session.user?.role === 'teacher');
const mine = computed(() => detail.value?.submission.userId === session.user?.id);
const mayAnalyze = computed(() => teacher.value || mine.value);
const mayReview = computed(() => session.user?.role === 'student' && !mine.value);
const modelConfigured = computed(() => !!personalModel.value?.configured);
const activeAnalysis = computed(() => ['queued', 'running'].includes(detail.value?.pendingAnalysis?.status ?? ''));
const myReview = computed(() => detail.value?.myReview ?? detail.value?.peerReviews.find(item => item.reviewerId === session.user?.id));
const canSeeReviews = computed(() => teacher.value || mine.value || !!myReview.value);
const pendingReady = computed(() => detail.value?.pendingAnalysis?.status === 'succeeded' && detail.value.pendingAnalysis.id !== detail.value.analysis?.id);
const report = computed<SourceProjectReportData | undefined>(() => {
  if (previewPending.value && mayAnalyze.value && detail.value?.pendingAnalysis?.report) return detail.value.pendingAnalysis.report;
  const value = detail.value?.analysis?.report;
  if (!value) return;
  return 'report' in value ? (value as ProjectReportEnvelope).report : value;
});
const coverage = computed(() => {
  const value = detail.value?.analysis?.report;
  return value && 'report' in value ? (value as ProjectReportEnvelope).coverage : undefined;
});
const outcomeLabel = (value?: string) => value === 'achieved' ? '已达到任务目标' : value === 'needs_revision' ? '建议继续改进' : '等待教师反馈';
const formatDate = (value: string) => new Date(value).toLocaleString('zh-CN', {month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit'});
let disposed = false, readSequence = 0;
let writeController: AbortController | undefined;
let pollTimer: ReturnType<typeof setTimeout> | undefined;

function updateDrafts() {
  const review = myReview.value;
  strength.value = review?.strength ?? '';
  improvement.value = review?.improvement ?? '';
  recommend.value = review?.recommend ?? false;
  feedback.value = detail.value?.submission.evaluation?.feedback ?? '';
  outcome.value = detail.value?.submission.evaluation?.outcome ?? 'pending';
  featured.value = detail.value?.submission.evaluation?.featured ?? false;
  featureReason.value = detail.value?.submission.evaluation?.featureReason ?? '';
}
function schedulePoll() {
  if (pollTimer) clearTimeout(pollTimer);
  if (!disposed && activeAnalysis.value) pollTimer = setTimeout(() => { void load(false, true); }, 4500);
}
async function load(resetDrafts = false, polling = false) {
  const sequence = ++readSequence;
  if (!polling) loading.value = true;
  try {
    const result = await apiV2<ProjectSubmissionDetail>(`/project-submissions/${props.submissionId}`);
    if (disposed || sequence !== readSequence) return;
    detail.value = result;
    connectionError.value = '';
    if (resetDrafts) updateDrafts();
    schedulePoll();
  } catch (failure) {
    if (disposed || sequence !== readSequence) return;
    if (polling) connectionError.value = '导读进度暂时无法刷新。已有内容和填写中的评价已保留，可手动重试。';
    else error.value = (failure as Error).message;
  } finally { if (!disposed && sequence === readSequence) loading.value = false; }
}
async function refreshModel() {
  modelError.value = '';
  try { personalModel.value = await apiV2<PersonalModelState>('/model-settings'); }
  catch { modelError.value = '暂时无法读取模型设置，可以重新读取或打开设置核对。'; }
}
async function mutate(url: string, options: RequestInit) {
  const controller = new AbortController();
  writeController = controller;
  const timer = window.setTimeout(() => controller.abort(), 20000);
  try {
    const result = await apiV2(url, {...options, signal: controller.signal});
    controller.signal.throwIfAborted();
    return result;
  } catch (failure) {
    if (controller.signal.aborted || failure instanceof TypeError) throw new Error('尚未收到操作回执，结果未确认。请先刷新核对，填写内容仍在；没有自动重发，已发起的 AI 请求可能产生费用。');
    throw failure;
  } finally {
    window.clearTimeout(timer);
    if (writeController === controller) writeController = undefined;
  }
}
async function act(label: string, action: () => Promise<void>) {
  if (busy.value) return;
  busy.value = label; error.value = ''; notice.value = '';
  try { await action(); }
  catch (failure) { if (!disposed) error.value = (failure as Error).message; }
  finally { if (!disposed) busy.value = ''; }
}
async function saveReview() {
  await act('正在保存评价…', async () => {
    await mutate(`/project-submissions/${props.submissionId}/peer-review`, {method: 'PUT', body: JSON.stringify({strength: strength.value.trim(), improvement: improvement.value.trim(), recommend: recommend.value})});
    await load(true);
    notice.value = '评价已保存。你的具体建议会帮助同学继续改进。';
    emit('changed');
  });
}
async function saveEvaluation() {
  await act('正在发布反馈…', async () => {
    const selectFeatured = featured.value && outcome.value === 'achieved' && detail.value?.submission.showcaseConsent;
    await mutate(`/project-submissions/${props.submissionId}/evaluation`, {method: 'PUT', body: JSON.stringify({feedback: feedback.value.trim(), outcome: outcome.value, featured: !!selectFeatured, featureReason: selectFeatured ? featureReason.value.trim() : ''})});
    await load(true);
    notice.value = '教师反馈已发布，学生现在可以查看。';
    emit('changed');
  });
}
async function analyze() {
  if (!modelConfigured.value || !costValid.value || activeAnalysis.value) return;
  await act('正在发起导读…', async () => {
    await mutate(`/project-submissions/${props.submissionId}/analyze`, {method: 'POST', body: JSON.stringify({consent: true, options: {mode: 'quick', ...(costPolicy.value ? {cost: costPolicy.value} : {})}})});
    await load();
    analysisPanel.value = false;
    notice.value = '导读已发起，使用你的模型账户。完成后请查看并选择是否采用到这份提交。';
  });
}
async function adoptAnalysis() {
  const id = detail.value?.pendingAnalysis?.id;
  if (!id || !pendingReady.value) return;
  await act('正在采用导读…', async () => {
    await mutate(`/project-submissions/${props.submissionId}/analysis`, {method: 'PUT', body: JSON.stringify({analysisId: id})});
    previewPending.value = false;
    await load();
    notice.value = '这份提交的 AI 导读已更新，同班师生可阅读同一份报告。';
    emit('changed');
  });
}
async function cancelAnalysis() {
  const pending = detail.value?.pendingAnalysis;
  if (!pending?.canCancel || !activeAnalysis.value) return;
  await act('正在停止导读…', async () => {
    await mutate(`/project-submissions/${props.submissionId}/cancel`, {method: 'POST', body: JSON.stringify({analysisId: pending.id})});
    await load();
    notice.value = '已请求停止本次导读，提交与现有报告仍保留。已发生的模型调用费用按服务商规则结算。';
    emit('changed');
  });
}
const evidenceReader = ref<InstanceType<typeof SourceEvidenceReader>>();
function loadEvidence(citation: SourceCitation, full: boolean, signal: AbortSignal) {
  const analysisId = previewPending.value ? detail.value?.pendingAnalysis?.id : detail.value?.analysis?.id;
  return apiV2<{ path: string; content: string; startLine: number; totalLines: number }>(`/project-submissions/${props.submissionId}/source?path=${encodeURIComponent(citation.path)}${analysisId ? `&analysisId=${encodeURIComponent(analysisId)}` : ''}${citationRange(citation, full)}`, { signal });
}
function openSource(citation: SourceCitation) { return evidenceReader.value?.openCitation(citation); }
function openFile(path: string) { return evidenceReader.value?.openFile(path); }
onMounted(async () => {
  await load(true);
  if (!disposed && mayAnalyze.value) await refreshModel();
});
onUnmounted(() => { disposed = true; readSequence++; writeController?.abort(); if (pollTimer) clearTimeout(pollTimer); });
</script>

<template>
  <article class="submission-detail" aria-label="作品详情">
    <p v-if="error" class="error" role="alert">{{ error }} <button :disabled="!!busy || loading" @click="error = ''; load()">刷新核对</button></p>
    <p v-if="notice" class="notice" role="status">{{ notice }}</p>
    <p v-if="!detail && loading" role="status">正在读取作品与评价…</p>
    <template v-if="detail">
      <header class="submission-header"><div><span class="submission-author">{{ accountDisplayName(detail.submission.studentName) }} · 第 {{ detail.submission.version }} 版</span><h2>{{ detail.submission.projectName }}</h2><p class="muted small">{{ formatDate(detail.submission.createdAt) }} 提交{{ detail.submission.late ? ' · 迟交' : '' }}</p></div><span v-if="detail.submission.evaluation?.featured" class="featured-label"><Award aria-hidden="true" :size="16" />优秀作品</span></header>
      <p v-if="detail.submission.note" class="author-note">{{ detail.submission.note }}</p>
      <p v-if="detail.submission.revisionNote" class="revision-note"><strong>本次改进</strong> {{ detail.submission.revisionNote }}</p>
      <p v-if="detail.submission.evaluation?.featured && detail.submission.evaluation.featureReason" class="feature-reason"><Award aria-hidden="true" :size="16" /><span><strong>值得学习</strong>{{ detail.submission.evaluation.featureReason }}</span></p>
      <nav class="detail-tabs" aria-label="作品阅读与评价"><button :aria-pressed="selectedTab === 'report'" @click="selectedTab = 'report'"><BookOpen aria-hidden="true" :size="16" />AI 导读</button><button :aria-pressed="selectedTab === 'reviews'" @click="selectedTab = 'reviews'"><MessageSquare aria-hidden="true" :size="16" />评价与反馈 <span>{{ detail.peerReviews.length }}</span></button></nav>
      <section v-if="selectedTab === 'report'" class="report-area">
        <div v-if="connectionError" class="notice" role="status">{{ connectionError }} <button @click="load()" :disabled="loading">重新读取进度</button></div>
        <div v-if="activeAnalysis" class="analysis-status" role="status"><Sparkles aria-hidden="true" :size="18" /><span>{{ detail.pendingAnalysis?.status === 'queued' ? '新的导读已排队' : '正在整理新的 AI 导读' }}。现有报告仍可阅读，完成后由教师或作者确认采用。</span><button v-if="detail.pendingAnalysis?.canCancel" :disabled="!!busy" @click="cancelAnalysis">停止本次分析</button></div>
        <div v-else-if="pendingReady && mayAnalyze" class="analysis-ready"><div><Check aria-hidden="true" :size="18" /><strong>新的 AI 导读已生成</strong><p class="muted small">确认采用后，同学看到的导读才会更新。</p></div><div class="actions"><button v-if="detail.pendingAnalysis?.report" @click="previewPending = !previewPending">{{ previewPending ? '返回当前导读' : '预览新导读' }}</button><button class="primary" :disabled="!!busy" @click="adoptAnalysis">采用到本次提交</button></div></div>
        <p v-else-if="mayAnalyze && detail.pendingAnalysis?.status === 'failed'" class="notice">上一次导读未完成{{ detail.pendingAnalysis.code ? `（${detail.pendingAnalysis.code}）` : '' }}。提交与已有评价仍保留，可以重新发起。</p>
        <p v-else-if="mayAnalyze && detail.pendingAnalysis?.status === 'cancelled'" class="notice">上一次导读已停止，提交与现有报告仍保留。</p>
        <p v-if="previewPending && pendingReady" class="preview-label">正在预览新导读 · 尚未向同学共享</p>
        <SourceEvidenceReader v-if="report" ref="evidenceReader" :identity="`${submissionId}:${previewPending ? detail.pendingAnalysis?.id : detail.analysis?.id}`" :version-label="`提交 ${submissionId} · 报告 ${previewPending ? detail.pendingAnalysis?.id : detail.analysis?.id}`" :load-source="loadEvidence">
        <SourceProjectReport v-if="report" :key="previewPending ? detail.pendingAnalysis?.id : detail.analysis?.id" :report="report" :project-name="detail.submission.projectName" :indexed-files="coverage?.indexedFiles" :read-files="coverage?.readFiles" @citation="openSource" @file="openFile" @evidence="evidenceReader?.openEvidence($event)" @context-change="evidenceReader?.close(false)" />
        </SourceEvidenceReader>
        <div v-else class="report-empty"><BookOpen aria-hidden="true" :size="28" /><h3>这份作品还没有共享 AI 导读</h3><p>作品已经提交，可以先阅读项目说明并参与交流。作者或教师生成并确认导读后，可在这里了解核心模块、业务链路和代码依据。</p><button @click="selectedTab = 'reviews'">前往评价与反馈</button></div>
        <div v-if="mayAnalyze" class="analysis-control"><button :aria-expanded="analysisPanel" :disabled="!!busy || activeAnalysis" @click="analysisPanel = !analysisPanel"><Sparkles aria-hidden="true" :size="16" />{{ report ? '生成新的导读' : '生成 AI 导读' }}</button><p class="muted small">阅读现有报告免费且不会调用模型。生成导读使用发起人的个人模型。</p>
          <form v-if="analysisPanel" class="analysis-settings" @submit.prevent="analyze"><div class="section-heading"><div><h3>使用我的模型生成导读</h3><p class="muted small">{{ accountDisplayName(session.user?.name) }} · 调用费用由你的 API Key 所属服务商账户承担。仅静态阅读源码，不运行项目。</p></div><button type="button" @click="modelDialog?.open()" :disabled="!!busy">模型设置</button></div><p v-if="modelError" role="alert">{{ modelError }} <button type="button" @click="refreshModel">重新读取</button></p><p v-else class="muted small">{{ modelConfigured ? `当前模型：${personalModel?.settings?.model} · 快速概览` : '尚未配置个人模型。配置后可生成导读，不影响提交和参与评价。' }}</p><SourceCostControls mode="quick" :available="modelConfigured" :disabled="!!busy" @change="costPolicy = $event" @valid="costValid = $event" /><button class="primary" :disabled="!!busy || !modelConfigured || !costValid">{{ busy || '使用我的模型生成导读' }}</button></form>
        </div>
      </section>
      <section v-else class="feedback-area">
        <details class="review-rubric"><summary>本次评价参考</summary><p v-for="item in rubric" :key="item.id"><strong>{{ item.title }}</strong> · {{ item.description }}</p></details>
        <section v-if="detail.submission.evaluation?.feedback && !teacher" class="teacher-feedback"><span class="section-kicker">教师反馈</span><h3>{{ outcomeLabel(detail.submission.evaluation.outcome) }}</h3><p>{{ detail.submission.evaluation.feedback }}</p></section>
        <p v-else-if="mine && !teacher" class="muted">教师尚未发布反馈，你可以先阅读同伴建议。</p>
        <form v-if="teacher" class="evaluation-form" @submit.prevent="saveEvaluation"><h3>教师反馈与选优</h3><label>给学生的反馈<textarea v-model="feedback" required maxlength="1000" rows="4" :disabled="!!busy" placeholder="说明完成情况，并给出一个最值得优先改进的建议。" /></label><label>任务完成情况<StudioSelect v-model="outcome" :disabled="!!busy" @change="outcome !== 'achieved' && (featured = false)"><option value="pending">待进一步确认</option><option value="achieved">已达到任务目标</option><option value="needs_revision">建议继续改进</option></StudioSelect></label><label class="check-line"><input type="checkbox" v-model="featured" :disabled="!!busy || outcome !== 'achieved' || !detail.submission.showcaseConsent" /><span>选为本次任务的优秀作品</span></label><p v-if="!detail.submission.showcaseConsent" class="muted small">作者未同意优秀作品展示，本次仍可发布教学反馈。</p><p v-else-if="outcome !== 'achieved'" class="muted small">确认达到任务目标后可选优；同伴推荐作为参考。</p><label v-if="featured">入选理由<textarea v-model="featureReason" required maxlength="1000" rows="2" :disabled="!!busy" placeholder="同学最值得学习这个项目的哪一点？" /></label><button class="primary" :disabled="!!busy || !feedback.trim() || (featured && !featureReason.trim())">{{ busy || '发布教师反馈' }}</button></form>
        <form v-if="mayReview" class="peer-form" @submit.prevent="saveReview"><h3>{{ myReview ? '完善我的评价' : '写下你的观察' }}</h3><p class="muted small">围绕具体功能或代码给建议。先形成自己的观察，再查看同学的评价。</p><label>一个值得学习的优点<textarea v-model="strength" required minlength="2" maxlength="1000" rows="3" :disabled="!!busy" placeholder="例如：哪个交互或模块实现得好？为什么？" /></label><label>一个可以改进的地方<textarea v-model="improvement" required minlength="2" maxlength="1000" rows="3" :disabled="!!busy" placeholder="指出具体位置，并说明你建议怎样改进或验证。" /></label><label class="check-line"><input type="checkbox" v-model="recommend" :disabled="!!busy" /><span>推荐为优秀作品，理由见上方具体评价</span></label><button class="primary" :disabled="!!busy || strength.trim().length < 2 || improvement.trim().length < 2">{{ busy || (myReview ? '更新我的评价' : '提交评价') }}</button></form>
        <div v-if="mine" class="muted small">这是你的作品，可以阅读反馈并提交改进版本；不能给自己互评。</div>
        <section class="peer-reviews"><h3>同伴的观察 <span>{{ detail.peerReviews.length }}</span></h3><p v-if="!canSeeReviews" class="muted small">提交自己的观察后，即可展开同学的评价。</p><template v-else><p v-if="!detail.peerReviews.length" class="muted">还没有同伴评价。</p><article v-for="item in detail.peerReviews" :key="item.id"><header><strong>{{ accountDisplayName(item.reviewerName) }}{{ item.reviewerId === session.user?.id ? ' · 我' : '' }}</strong><span v-if="item.recommend" class="recommendation"><Award aria-hidden="true" :size="14" />推荐作品</span></header><p><span class="observation-label">值得学习</span>{{ item.strength }}</p><p><span class="observation-label">改进建议</span>{{ item.improvement }}</p><small>{{ formatDate(item.updatedAt) }}</small></article></template></section>
      </section>
    </template>
    <PersonalModelDialog ref="modelDialog" @changed="refreshModel" />

  </article>
</template>

<style scoped>
.submission-detail { min-width: 0; border-left: 1px solid var(--line); padding-left: var(--space-lg); }
.submission-header { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-md); }
.submission-header > div { min-width: 0; }
.submission-header h2 { margin-block: var(--space-xs); }
.submission-author, .submission-header .small { color: var(--muted); font-size: var(--text-xs); }
.featured-label, .recommendation { display: inline-flex; align-items: center; gap: var(--space-2xs); color: var(--accent-ink); font-size: var(--text-xs); white-space: nowrap; }
.author-note { white-space: pre-wrap; line-height: 1.8; }
.revision-note { color: var(--muted); font-size: var(--text-sm); white-space: pre-wrap; }
.feature-reason { display: flex; align-items: flex-start; gap: var(--space-xs); padding-block: var(--space-sm); color: var(--accent-ink); }
.feature-reason strong { display: block; margin-bottom: var(--space-2xs); }
.feature-reason > span { white-space: pre-wrap; }
.detail-tabs { display: flex; gap: var(--space-sm); border-bottom: 1px solid var(--line); margin-block: var(--space-md); }
.detail-tabs button { background: transparent; border-color: transparent; border-radius: 0; }
.detail-tabs button[aria-pressed="true"] { color: var(--accent-ink); border-bottom-color: var(--accent); }
.detail-tabs span { color: var(--muted); font-size: var(--text-xs); }
.analysis-status { display: flex; align-items: flex-start; flex-wrap: wrap; gap: var(--space-xs); padding-block: var(--space-sm); color: var(--muted); font-size: var(--text-sm); }
.analysis-status > span { flex: 1; min-width: min(100%, 12rem); }
.analysis-status > svg { flex-shrink: 0; }
.analysis-ready { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: var(--space-sm); padding: var(--space-sm); background: var(--success-soft); border-radius: var(--radius-input); margin-bottom: var(--space-md); }
.analysis-ready > div:first-child > svg { display: inline; vertical-align: middle; margin-right: var(--space-2xs); }
.analysis-ready p { margin-bottom: 0; }
.preview-label { color: var(--accent-ink); font-size: var(--text-xs); }
.report-empty { padding: var(--space-lg) 0; }
.report-empty > svg { color: var(--muted); }
.report-empty h3 { margin-top: var(--space-sm); }
.report-empty p { color: var(--muted); max-width: 65ch; line-height: 1.8; }
.analysis-control { margin-top: var(--space-lg); padding-top: var(--space-md); border-top: 1px solid var(--line); }
.analysis-settings { margin-top: var(--space-sm); padding: var(--space-md); background: var(--paper); border: 1px solid var(--line); border-radius: var(--radius); }
.analysis-settings .section-heading { align-items: flex-start; }
.analysis-settings .section-heading > div { min-width: 0; }
.analysis-settings .section-heading > button { flex-shrink: 0; }
.review-rubric { font-size: var(--text-xs); color: var(--muted); margin-bottom: var(--space-md); }
.teacher-feedback { padding-block: var(--space-sm); border-bottom: 1px solid var(--line); margin-bottom: var(--space-md); }
.section-kicker { font-size: var(--text-xs); color: var(--accent-ink); }
.teacher-feedback h3 { margin-top: var(--space-xs); }
.teacher-feedback p { white-space: pre-wrap; line-height: 1.8; }
.evaluation-form, .peer-form { margin-bottom: var(--space-lg); padding-bottom: var(--space-md); border-bottom: 1px solid var(--line); }
.check-line { flex-direction: row; align-items: flex-start; gap: var(--space-xs); font-weight: 400; }
.check-line input { margin-top: .2rem; flex: none; }
.peer-reviews { margin-top: var(--space-lg); }
.peer-reviews h3 > span { color: var(--muted); font-size: var(--text-xs); margin-left: var(--space-xs); }
.peer-reviews article { padding-block: var(--space-md); border-bottom: 1px solid var(--line); }
.peer-reviews article header { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: var(--space-xs); }
.peer-reviews article p { font-size: var(--text-sm); line-height: 1.8; white-space: pre-wrap; }
.peer-reviews article small { color: var(--muted); }
.observation-label { display: block; color: var(--muted); font-size: var(--text-xs); margin-bottom: var(--space-2xs); }
.project-source-dialog { width: min(68rem, calc(100vw - 2rem)); max-height: 86dvh; padding: 0; }
.project-source-dialog[open] { display: flex; flex-direction: column; }
.project-source-dialog header { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-md); padding: var(--space-md); border-bottom: 1px solid var(--line); }
.project-source-dialog header > div { min-width: 0; }
.project-source-dialog h3 { font-size: var(--text-sm); margin-bottom: 0; overflow-wrap: anywhere; }
.project-source-dialog > p, .project-source-dialog > div { padding: var(--space-md); }
.project-source-dialog > .source-view-tools { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: var(--space-sm); padding: var(--space-xs) var(--space-md); border-bottom: 1px solid var(--line); color: var(--muted); font-size: var(--text-xs); }
.source-view-tools > button { min-height: 44px; flex-shrink: 0; }
.project-source-dialog pre { padding-block: var(--space-sm); margin: 0; overflow: auto; background: var(--surface); font-size: var(--text-xs); line-height: 1.8; }
.project-source-dialog code { display: block; min-width: 100%; width: max-content; padding-inline: var(--space-sm); }
.project-source-dialog code > span { display: inline-block; color: var(--muted); min-width: 3.5rem; text-align: right; padding-right: 1rem; user-select: none; }
.project-source-dialog .highlighted { background: var(--accent-soft); }
@media (max-width: 820px) { .submission-detail { border-left: 0; padding-left: 0; border-top: 1px solid var(--line); padding-top: var(--space-lg); } }
@media (max-width: 480px) { .submission-header { flex-direction: column; gap: var(--space-xs); } .analysis-settings { padding: var(--space-sm); } .project-source-dialog { width: calc(100vw - 1rem); } }
</style>
