<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { ArrowLeft, ArrowRight, ArrowUpRight, BookOpen, Plus, Upload, Users, Award, Sparkles, Check } from 'lucide-vue-next';
import { apiV2, useSession } from '../api';
import StudioSearch from '../components/StudioSearch.vue';
import StudioSelect from '../components/StudioSelect.vue';
import { accountDisplayName } from '../lib/account-display';
import ProjectSubmissionReview from '../components/ProjectSubmissionReview.vue';
import type { ProjectTaskData, ProjectSubmission } from '../project-task-types';

const route = useRoute();
const session = useSession();
const taskId = String(route.params.id);
const teacher = computed(() => session.user?.role === 'teacher');
const data = ref<ProjectTaskData>();
const loading = ref(true), error = ref(''), message = ref(''), busy = ref('');
const tab = ref<'overview' | 'submissions' | 'showcase'>('overview');
const selectedId = ref(typeof route.query.submission === 'string' ? route.query.submission : '');
const search = ref('');
const listFilter = ref('all');
const submitting = ref(false);
const importMode = ref<'upload' | 'existing'>('upload');
const chosenProject = ref(''), file = ref<File>(), savedProjectId = ref('');
const note = ref(''), revisionNote = ref(''), shareWithClass = ref(false), showcaseConsent = ref(false);
const fileInput = ref<HTMLInputElement>();
let submissionKey = crypto.randomUUID();
let pendingSubmissionBody = '';
let writeController: AbortController | undefined;
let disposed = false;
let readSequence = 0;
const mySubmissions = computed(() => data.value?.submissions.filter(item => item.userId === session.user?.id) ?? []);
const latestMine = computed(() => mySubmissions.value.reduce<ProjectSubmission | undefined>((latest, item) => !latest || item.version > latest.version ? item : latest, undefined));
const latestByStudent = computed(() => {
  const latest = new Map<string, ProjectSubmission>();
  for (const item of data.value?.submissions ?? []) {
    const prior = latest.get(item.userId);
    if (!prior || item.version > prior.version) latest.set(item.userId, item);
  }
  return [...latest.values()];
});
const pendingLatestIds = computed(() => new Set(latestByStudent.value
  .filter(item => !item.evaluation?.outcome || item.evaluation.outcome === 'pending')
  .map(item => item.id)));
const pendingCount = computed(() => pendingLatestIds.value.size);
const collection = computed(() => tab.value === 'showcase' ? data.value?.showcase ?? [] : data.value?.submissions ?? []);
const filtered = computed(() => collection.value.filter(item => {
  const matches = `${item.projectName} ${item.studentName}`.toLowerCase().includes(search.value.trim().toLowerCase());
  return matches && (listFilter.value === 'all'
    || (listFilter.value === 'mine' && item.userId === session.user?.id)
    || (listFilter.value === 'pending' && pendingLatestIds.value.has(item.id)));
}));
watch(filtered, items => {
  if (tab.value !== 'overview' && !items.some(item => item.id === selectedId.value)) selectedId.value = items[0]?.id ?? '';
});
const deadlinePassed = computed(() => !!data.value?.task.dueAt && Date.parse(data.value.task.dueAt) < Date.now());
const date = (value: string) => new Date(value).toLocaleString('zh-CN', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });

async function load() {
  const sequence = ++readSequence;
  loading.value = true;
  error.value = '';
  try {
    const result = await apiV2<ProjectTaskData>(`/project-tasks/${taskId}`);
    if (disposed || sequence !== readSequence) return;
    data.value = result;
    if (selectedId.value && !result.submissions.some(item => item.id === selectedId.value)) selectedId.value = '';
    if (!selectedId.value) selectedId.value = (teacher.value
      ? result.submissions.find(item => !item.evaluation?.outcome || item.evaluation.outcome === 'pending')
      : result.submissions.find(item => item.userId === session.user?.id))?.id ?? result.submissions[0]?.id ?? '';
    chosenProject.value ||= result.myProjects[0]?.id ?? '';
  } catch (failure) {
    if (!disposed && sequence === readSequence) error.value = (failure as Error).message;
  } finally {
    if (!disposed && sequence === readSequence) loading.value = false;
  }
}
async function mutate<T>(url: string, options: RequestInit, timeoutMs = 15000): Promise<T> {
  const controller = new AbortController();
  writeController = controller;
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const result = await apiV2<T>(url, { ...options, signal: controller.signal });
    controller.signal.throwIfAborted();
    return result;
  } catch (failure) {
    if (controller.signal.aborted || failure instanceof TypeError) throw new Error('尚未收到保存回执，服务器可能已经处理。请先刷新任务和已有项目核对，输入已保留；没有自动重发。');
    throw failure;
  } finally {
    window.clearTimeout(timer);
    if (writeController === controller) writeController = undefined;
  }
}
function chooseFile(event: Event) {
  file.value = (event.target as HTMLInputElement).files?.[0];
  savedProjectId.value = '';
  error.value = '';
  if (file.value && file.value.size > 100 * 1024 * 1024) {
    error.value = '压缩包超过 100 MB，请移除依赖或构建产物后再试。';
    file.value = undefined;
    if (fileInput.value) fileInput.value.value = '';
  }
}
async function submit() {
  if (busy.value || !shareWithClass.value) return;
  error.value = ''; message.value = '';
  try {
    let projectId = importMode.value === 'existing' ? chosenProject.value : savedProjectId.value;
    if (importMode.value === 'upload' && !projectId) {
      if (!file.value) throw new Error('请先选择项目 ZIP。');
      busy.value = '正在保存项目…';
      const body = new FormData();
      body.append('file', file.value);
      const name = file.value.name.replace(/\.zip$/i, '').slice(0, 120);
      const saved = await mutate<{projectId: string}>(`/projects?analyze=false&name=${encodeURIComponent(name)}`, { method: 'POST', body }, 135000);
      projectId = saved.projectId;
      savedProjectId.value = projectId;
    }
    if (!projectId) throw new Error('请选择要提交的项目。');
    busy.value = '正在提交作品…';
    const body = JSON.stringify({ projectId, shareWithClass: true, note: note.value.trim(), revisionNote: revisionNote.value.trim(), showcaseConsent: showcaseConsent.value });
    if (pendingSubmissionBody && pendingSubmissionBody !== body) submissionKey = crypto.randomUUID();
    pendingSubmissionBody = body;
    const result = await mutate<{submission: ProjectSubmission; replayed: boolean}>(`/project-tasks/${taskId}/submissions`, {
      method: 'POST', headers: { 'Idempotency-Key': submissionKey }, body,
    });
    if (disposed) return;
    selectedId.value = result.submission.id;
    tab.value = 'submissions';
    listFilter.value = 'all';
    search.value = '';
    submitting.value = false;
    message.value = result.replayed
      ? '这份项目已在本任务提交，已打开原提交记录；如需提交改进版本，请上传修改后的项目。本次保存未发起 AI 调用。'
      : '作品已提交，教师和同学现在可以阅读交流。本次保存未发起 AI 调用。';
    submissionKey = crypto.randomUUID(); pendingSubmissionBody = '';
    file.value = undefined; savedProjectId.value = ''; note.value = ''; revisionNote.value = ''; shareWithClass.value = false;
    if (fileInput.value) fileInput.value.value = '';
    await load();
  } catch (failure) {
    if (!disposed) error.value = (failure as Error).message;
  } finally { if (!disposed) busy.value = ''; }
}
function changeTab(value: typeof tab.value) {
  tab.value = value; search.value = ''; listFilter.value = 'all';
  if (value === 'showcase' && !data.value?.showcase.some(item => item.id === selectedId.value)) selectedId.value = data.value?.showcase[0]?.id ?? '';
  if (value === 'submissions' && !selectedId.value) selectedId.value = data.value?.submissions[0]?.id ?? '';
}
onMounted(async () => {
  await load();
  if (route.query.tab === 'showcase') changeTab('showcase');
  else if (route.query.submission || route.query.tab === 'submissions' || teacher.value) changeTab('submissions');
});
onUnmounted(() => { disposed = true; readSequence++; writeController?.abort(); });
</script>

<template>
  <div class="project-task">
    <RouterLink to="/tasks" class="back-link"><ArrowLeft aria-hidden="true" :size="16" />实训任务</RouterLink>
    <p v-if="error" class="error" role="alert">{{ error }} <button v-if="!busy" @click="load" :disabled="loading">重新读取</button></p>
    <p v-if="message" class="notice" role="status">{{ message }}</p>
    <template v-if="data">
      <header class="task-heading">
        <div><div class="task-heading-meta"><span class="eyebrow">开放项目实训</span><span class="deadline-label" :class="{ passed: deadlinePassed }">{{ data.task.dueAt ? `提交截止 ${date(data.task.dueAt)}` : '持续开放提交' }}</span></div><h1>{{ data.task.title }}</h1><p class="muted">{{ teacher ? '从项目导读进入评阅，结合具体实现与同伴建议给出反馈。' : '完成项目、交流实现，把本次反馈带进下一次修改。' }}</p></div>
        <div class="actions"><button :disabled="loading || !!busy" @click="load">{{ loading ? '正在刷新…' : '刷新' }}</button><button v-if="!teacher" class="primary" :disabled="!!busy" :aria-expanded="submitting" @click="submitting = !submitting"><Plus aria-hidden="true" :size="16" />{{ mySubmissions.length ? '提交改进版本' : '提交我的项目' }}</button></div>
      </header>
      <div v-if="!teacher && latestMine" class="my-submission-status"><span class="my-status-label"><Check aria-hidden="true" :size="15" />已提交第 {{ latestMine.version }} 版</span><span>{{ latestMine.evaluation?.outcome === 'needs_revision' ? '教师建议继续改进，查看反馈后再完善作品。' : latestMine.evaluation?.outcome === 'achieved' ? '教师已确认达到任务目标，可以继续学习同伴的实现。' : '作品已进入本班评阅，可随时查看导读和反馈。' }}</span><button type="button" @click="changeTab('submissions'); listFilter = 'mine'; selectedId = latestMine!.id">查看我的作品<ArrowRight aria-hidden="true" :size="14" /></button></div>
      <p v-else-if="teacher" class="my-submission-status">{{ latestByStudent.length }} 位同学已提交 · {{ pendingCount }} 份最新作品待反馈</p>
      <form v-if="submitting && !teacher" class="submission-form" @submit.prevent="submit">
        <div class="section-heading"><div><h2>{{ mySubmissions.length ? '让这一次改进有迹可循' : '提交你的项目' }}</h2><p class="muted small">保存作品无需 AI 密钥。AI 导读可在提交后由你或教师主动生成。</p></div></div>
        <div class="segmented" role="group" aria-label="项目来源"><button type="button" :aria-pressed="importMode === 'upload'" :disabled="!!busy" @click="importMode = 'upload'">上传项目 ZIP</button><button type="button" :aria-pressed="importMode === 'existing'" :disabled="!!busy" @click="importMode = 'existing'">关联已有项目</button></div>
        <label v-if="importMode === 'upload'" class="file-choice"><Upload aria-hidden="true" :size="22" /><span><strong>{{ file?.name ?? '选择项目 ZIP' }}</strong><small>常见语言均可 · 最大 100 MB</small></span><input ref="fileInput" type="file" accept=".zip,application/zip" :disabled="!!busy" :required="!savedProjectId" aria-label="选择实训项目 ZIP" @change="chooseFile" /></label>
        <label v-else>我的已有项目<StudioSelect aria-label="我的已有项目" v-model="chosenProject" required :disabled="!!busy"><option value="" disabled>选择项目</option><option v-for="project in data.myProjects" :key="project.id" :value="project.id">{{ project.name }}</option></StudioSelect><small v-if="!data.myProjects.length" class="muted">还没有已保存项目，可以切换到上传 ZIP。</small></label>
        <p v-if="savedProjectId" class="notice" role="status">项目已保存。继续提交会使用这份项目，无需重复上传。</p>
        <details class="upload-help"><summary>文件会如何处理？</summary><p>自动跳过依赖、构建产物和常见敏感配置。请在上传前移除私人数据与密钥。原项目结构可保留，无需套用课程模板。</p><p>展开最多 500 MB、20,000 个条目；用于分析的源码最多 16 MB，单文件最多 512 KB。当前导入保留 UTF-8 源码，图片等非源码内容会跳过；AI 仅做静态分析。</p></details>
        <label>项目说明（可选）<textarea v-model="note" rows="3" maxlength="1000" :disabled="!!busy" placeholder="我完成了什么？希望同学重点看看哪里？" /></label>
        <label v-if="mySubmissions.length">这次改进了什么（可选）<textarea v-model="revisionNote" rows="2" maxlength="1000" :disabled="!!busy" placeholder="说明相对上一版的主要变化。" /></label>
        <label class="check-line"><input type="checkbox" v-model="shareWithClass" required :disabled="!!busy" /><span>允许本班师生查看这份项目源码和导读，用于课程评价与学习。</span></label>
        <label class="check-line"><input type="checkbox" v-model="showcaseConsent" :disabled="!!busy" /><span>若被教师选为优秀作品，同意在本次任务的优秀作品区展示。</span></label>
        <p v-if="deadlinePassed" class="muted small">已超过提交截止时间，提交记录将标注为迟交。</p>
        <div class="actions"><button class="primary" :disabled="!!busy || !shareWithClass || (importMode === 'upload' ? !file && !savedProjectId : !chosenProject)">{{ busy || '保存并提交作品' }}</button><button type="button" :disabled="!!busy" @click="submitting = false">稍后再交</button></div>
      </form>
      <nav class="task-navigation" aria-label="实训任务内容"><button :aria-pressed="tab === 'overview'" @click="changeTab('overview')"><BookOpen aria-hidden="true" :size="17" />任务要求</button><button :aria-pressed="tab === 'submissions'" @click="changeTab('submissions')"><Users aria-hidden="true" :size="17" />作品与互评<span>{{ data.submissions.length }}</span></button><button :aria-pressed="tab === 'showcase'" @click="changeTab('showcase')"><Award aria-hidden="true" :size="17" />优秀作品<span>{{ data.showcase.length }}</span></button></nav>
      <section v-if="tab === 'overview'" class="task-brief">
        <div class="brief-copy"><span class="brief-kicker">任务说明</span><h2>这次要完成什么</h2><p class="task-requirements">{{ data.task.description || '教师尚未填写额外说明。' }}</p><div class="brief-submit"><div><strong>{{ teacher ? '要求明确后，就可以开始评阅' : '准备好作品，就从这里提交' }}</strong><p>支持上传项目 ZIP 或关联已有项目。提交不会发起 AI 调用。</p></div><button v-if="!teacher" class="primary" @click="submitting = true"><Upload aria-hidden="true" :size="16" />{{ mySubmissions.length ? '提交改进版本' : '提交我的项目' }}</button><button v-else @click="changeTab('submissions')">查看学生作品 <ArrowUpRight aria-hidden="true" :size="16" /></button></div><details class="participation-guide"><summary>提交之后，怎样参与学习与评价？</summary><ol><li>作者或教师可生成并确认 AI 导读，全班围绕同一份报告理解项目。</li><li>写下一个具体优点和一个改进建议，也可以推荐值得学习的作品。</li><li>教师结合实现与同伴意见发布反馈，在作者同意后确认优秀作品。</li><li>根据反馈提交改进版本，保留每次修改的说明。</li></ol></details></div>
        <aside class="rubric-list"><span class="brief-kicker">共同的评价依据</span><h3>评价参考</h3><p class="muted small">先理解实现，再给出有依据的建议。</p><article v-for="(criterion, index) in data.task.rubric" :key="criterion.id"><span>0{{ index + 1 }}</span><div><h4>{{ criterion.title }}</h4><p>{{ criterion.description }}</p></div></article><p class="rubric-note">AI 辅助理解项目，教师确认最终反馈。推荐与评价围绕本次提交版本展开。</p></aside>
      </section>
      <section v-else class="work-collection">
        <div class="section-heading"><div><h2>{{ tab === 'showcase' ? '把优秀做法，变成下一次灵感' : teacher ? '从理解作品，到给出反馈' : '看看同学如何完成这次任务' }}</h2><p class="muted small">{{ tab === 'showcase' ? '教师确认、作者同意展示的作品。阅读现有导读不会调用模型。' : teacher ? `${pendingCount} 份最新作品待反馈；同伴推荐供选优参考。` : '先理解项目，再写下一个具体优点和一个可行动的建议。' }}</p></div></div>
        <div class="collection-toolbar"><StudioSearch v-model="search" label="搜索项目或同学" /><div v-if="tab === 'submissions'" class="submission-filters" role="group" aria-label="按作品状态筛选"><button type="button" :aria-pressed="listFilter === 'all'" @click="listFilter = 'all'">全部提交版本</button><button v-if="teacher" type="button" :aria-pressed="listFilter === 'pending'" @click="listFilter = 'pending'">待教师反馈</button><button v-else type="button" :aria-pressed="listFilter === 'mine'" @click="listFilter = 'mine'">我的提交</button></div><span class="collection-count muted small" aria-live="polite">{{ filtered.length }} 份作品</span></div>
        <div v-if="!collection.length" class="empty"><Award aria-hidden="true" v-if="tab === 'showcase'" :size="30" /><BookOpen aria-hidden="true" v-else :size="30" /><h3>{{ tab === 'showcase' ? '优秀作品将在这里沉淀' : '第一份作品，等待提交' }}</h3><p>{{ tab === 'showcase' ? '作品获得作者展示授权，并由教师确认后会出现在这里。' : '提交后，AI 导读、同伴建议和教师反馈会围绕同一份作品展开。' }}</p></div>
        <div v-else class="work-layout">
          <aside class="submission-list" aria-label="选择作品">
            <p v-if="!filtered.length" class="muted">没有符合条件的作品。</p>
            <button v-for="item in filtered" :key="item.id" class="submission-row" :class="{ selected: selectedId === item.id }" :aria-pressed="selectedId === item.id" @click="selectedId = item.id"><span class="row-heading"><strong>{{ item.projectName }}</strong><Award v-if="item.evaluation?.featured" :size="16" aria-label="优秀作品" /></span><span>{{ accountDisplayName(item.studentName) }} · 第 {{ item.version }} 版<span v-if="item.userId === session.user?.id"> · 我</span></span><small>{{ date(item.createdAt) }}{{ item.late ? ' · 迟交' : '' }}</small><span class="row-meta">{{ item.reviewCount }} 条同伴评价 · {{ item.recommendations }} 人推荐</span><span class="row-badges"><span v-if="item.analysisId" class="row-state"><Sparkles aria-hidden="true" :size="12" />AI 导读</span><span v-if="item.evaluation?.outcome === 'needs_revision'" class="row-state revision">待改进</span><span v-else-if="item.evaluation?.outcome === 'achieved'" class="row-state achieved">已达标</span><span v-else class="row-state pending">待反馈</span></span></button>
          </aside>
          <ProjectSubmissionReview v-if="selectedId" :key="selectedId" :submission-id="selectedId" :rubric="data.task.rubric" @changed="load" />
          <p v-else class="muted">选择一份作品开始阅读。</p>
        </div>
      </section>
    </template>
    <p v-else-if="loading" role="status">正在读取实训任务…</p>
  </div>
</template>

<style scoped>
.project-task { min-width: 0; }
.back-link { display: inline-flex; align-items: center; gap: var(--space-2xs); min-height: 44px; color: var(--muted); font-size: var(--text-sm); }
.task-heading { display: flex; justify-content: space-between; align-items: center; gap: var(--space-md); padding-block: var(--space-sm) var(--space-md); }
.task-heading > div:first-child { min-width: 0; }
.task-heading h1 { margin: var(--space-xs) 0; }
.eyebrow { color: var(--accent-ink); font-size: var(--text-xs); letter-spacing: .08em; }
.task-heading p { margin: 0; font-size: var(--text-sm); line-height: 1.8; }
.task-heading-meta { display: flex; align-items: center; flex-wrap: wrap; gap: .65rem; }
.deadline-label { font-size: var(--text-xs); color: var(--muted); border-left: 1px solid var(--line); padding-left: .65rem; }
.deadline-label.passed { color: var(--warning); }
.my-submission-status { display: flex; align-items: center; flex-wrap: wrap; gap: .5rem .75rem; margin: -.25rem 0 var(--space-md); font-size: var(--text-xs); color: var(--muted); }
.my-status-label { display: inline-flex; align-items: center; gap: .35rem; color: var(--success); }
.my-submission-status button { display: inline-flex; align-items: center; gap: .35rem; margin-left: auto; min-height: 44px; padding: .25rem .5rem; font-size: var(--text-xs); background: transparent; border-color: transparent; color: var(--accent-ink); }
.task-navigation { display: flex; gap: var(--space-md); border-bottom: 1px solid var(--line); padding: 0; margin-bottom: var(--space-lg); }
.task-navigation button { position: relative; background: transparent; border-color: transparent; border-radius: 0; padding: var(--space-sm) .25rem; min-height: 52px; color: var(--muted); }
.task-navigation button[aria-pressed="true"] { background: transparent; border-color: transparent; color: var(--accent-ink); }
.task-navigation button[aria-pressed="true"]::after { content: ''; position: absolute; inset: auto 0 -1px; height: 2px; background: var(--accent); }
.task-navigation span { color: var(--muted); font-size: .6875rem; background: var(--surface); border-radius: .3rem; min-width: 1.35rem; padding: .1rem .3rem; }
.task-brief { display: grid; grid-template-columns: minmax(0,1.7fr) minmax(15rem,1fr); gap: var(--space-xl); align-items: start; }
.brief-copy { min-width: 0; }
.brief-kicker { font-size: .6875rem; color: var(--accent-ink); letter-spacing: .05em; }
.brief-copy h2 { margin: .5rem 0 var(--space-sm); }
.task-requirements { white-space: pre-wrap; max-width: 75ch; line-height: 1.95; font-size: var(--text-sm); margin-bottom: var(--space-lg); }
.brief-submit { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: var(--space-sm); padding-block: var(--space-md); border-top: 1px solid var(--line); }
.brief-submit strong { font-size: var(--text-sm); font-weight: 600; }
.brief-submit p { margin: .4rem 0 0; font-size: var(--text-xs); color: var(--muted); }
.participation-guide { color: var(--muted); font-size: var(--text-xs); }
.participation-guide summary { font-size: var(--text-xs); font-weight: 500; }
.brief-copy ol { padding-left: 1.3rem; line-height: 1.9; color: var(--muted); }
.brief-copy li { padding-block: var(--space-2xs); }
.rubric-list { background: var(--surface); padding: var(--space-md); border-radius: var(--radius); }
.rubric-list h3 { margin: .5rem 0; font-size: 1.0625rem; }
.rubric-list > p { line-height: 1.8; margin-bottom: var(--space-sm); }
.rubric-list article { display: flex; align-items: flex-start; gap: var(--space-sm); border-top: 1px solid var(--line); padding-block: var(--space-md); }
.rubric-list article > span { font-size: .6875rem; color: var(--accent-ink); margin-top: .15rem; font-family: var(--font-outlier); }
.rubric-list h4 { margin: 0 0 var(--space-2xs); font-size: var(--text-sm); }
.rubric-list article p { color: var(--muted); margin: 0; font-size: var(--text-xs); line-height: 1.8; }
.rubric-list .rubric-note { margin: 0; padding-top: var(--space-xs); border-top: 1px solid var(--line); font-size: .6875rem; color: var(--muted); }
.submission-form { background: var(--paper); border: 1px solid var(--line); border-radius: var(--radius); padding: var(--space-lg); margin-bottom: var(--space-lg); }
.submission-form > label, .submission-form > details { max-width: 55rem; }
.submission-form .segmented { margin-bottom: var(--space-md); }
.file-choice { position: relative; display: flex; flex-direction: row; align-items: center; gap: var(--space-sm); border: 1px dashed var(--control-line); padding: var(--space-lg); background: var(--surface); border-radius: var(--radius-input); overflow: hidden; }
.file-choice input { position: absolute; inset: 0; opacity: 0; cursor: pointer; width: 100%; }
.file-choice:focus-within { outline: 3px solid var(--accent); outline-offset: 2px; }
.file-choice span { min-width: 0; overflow-wrap: anywhere; }
.file-choice small { display: block; font-weight: 400; color: var(--muted); margin-top: var(--space-2xs); }
.check-line { flex-direction: row; align-items: flex-start; gap: var(--space-xs); font-size: var(--text-sm); font-weight: 400; }
.check-line input { margin-top: .2rem; flex: none; }
.upload-help { color: var(--muted); font-size: var(--text-xs); }
.submission-filters { display: flex; align-items: center; flex-wrap: wrap; gap: .35rem; }
.submission-filters button { min-height: 44px; padding: .4rem .7rem; background: transparent; border-color: transparent; color: var(--muted); font-size: var(--text-xs); }
.submission-filters button[aria-pressed="true"] { color: var(--accent-ink); background: var(--accent-soft); }
.collection-count { margin-left: auto; }
.work-layout { display: grid; grid-template-columns: minmax(13rem, .64fr) minmax(0, 2fr); gap: var(--space-lg); align-items: start; margin-top: var(--space-md); }
.submission-list { min-width: 0; display: grid; gap: .4rem; max-height: min(52rem, 90vh); overflow-y: auto; padding: 3px; margin: -3px; scrollbar-width: thin; }
.submission-row { display: flex; flex-direction: column; justify-content: flex-start; align-items: stretch; gap: .35rem; text-align: left; padding: var(--space-sm); width: 100%; background: transparent; border: 1px solid transparent; overflow-wrap: anywhere; border-radius: .75rem; }
.submission-row.selected { background: var(--paper); border-color: color-mix(in oklch, var(--accent) 35%, var(--line)); box-shadow: inset 3px 0 0 var(--accent); }
.row-heading { display: flex; justify-content: space-between; gap: var(--space-2xs); color: var(--ink); }
.row-heading strong { min-width: 0; overflow-wrap: anywhere; font-size: var(--text-sm); font-weight: 600; line-height: 1.6; }
.row-heading svg { color: var(--accent-ink); margin-top: .15rem; }
.submission-row > span:not(.row-heading), .submission-row small { font-size: var(--text-xs); color: var(--muted); }
.submission-row .row-meta { border-top: 1px solid var(--line); padding-top: .55rem; margin-top: .3rem; font-size: .6875rem; }
.row-badges { display: flex; flex-wrap: wrap; gap: .35rem; margin-top: .25rem; }
.submission-row .row-state { display: inline-flex; align-items: center; gap: .25rem; padding: .15rem .4rem; border-radius: .3rem; background: var(--accent-soft); color: var(--accent-ink); font-size: .625rem; line-height: 1.6; }
.submission-row .row-state.pending { background: var(--surface); color: var(--muted); }
.submission-row .row-state.revision { background: var(--warning-soft); color: var(--warning); }
.submission-row .row-state.achieved { background: var(--success-soft); color: var(--success); }
.work-collection { min-width: 0; }
@media (max-width: 1100px) { .task-brief { gap: var(--space-lg); } .work-layout { grid-template-columns: minmax(11rem,.6fr) minmax(0,1.6fr); gap: var(--space-md); } }
@media (max-width: 820px) { .task-heading { flex-direction: column; align-items: flex-start; } .task-heading > .actions { width: 100%; } .task-brief, .work-layout { grid-template-columns: minmax(0,1fr); } .submission-list { grid-template-columns: repeat(2,minmax(0,1fr)); max-height: 21rem; overflow-y: auto; } .submission-form { padding: var(--space-md); } .my-submission-status button { margin-left: 0; } }
@media (max-width: 480px) { .task-navigation { gap: .3rem; } .task-navigation button { flex: 1; font-size: var(--text-xs); padding-inline: var(--space-2xs); gap: .4rem; } .task-navigation svg { display: none; } .submission-list { grid-template-columns: minmax(0,1fr); max-height: 16rem; } .file-choice { padding: var(--space-md); } .submission-form { padding: var(--space-sm); } .my-submission-status { gap: .4rem; } .my-submission-status > span:nth-child(2) { flex-basis: 100%; line-height: 1.8; } .rubric-list { padding: var(--space-sm); } .brief-submit { align-items: stretch; } .brief-submit > button { width: 100%; } }
</style>
