<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { api, apiV2, useSession } from "../api";
import AnimatedNumber from "../components/AnimatedNumber.vue";
import StudioSearch from "../components/StudioSearch.vue";
import StudioSelect from "../components/StudioSelect.vue";
import { accountDisplayName } from "../lib/account-display";
import { defaultCriteria } from "@codelab/contracts";
import { ArrowUpRight, ArrowRight, Plus, BookOpen, Users, ClipboardCheck, MessageSquareText, Award, RefreshCw } from "lucide-vue-next";
const s = useSession(),
  tasks = ref<any[]>([]),
  classes = ref<any[]>([]),
  error = ref(""),
  loading = ref(true),
  show = ref(false),
  busy = ref(false),
  classForm = ref(false);
const router = useRouter();
const taskKind = ref<'project' | 'template'>('project');
const dueAt = ref('');
const rubric = ref([
  { id: 'completion', title: '目标完成', description: '项目是否完成任务要求，能否清楚展示主要功能。' },
  { id: 'implementation', title: '实现质量', description: '核心实现是否清晰合理，有哪些值得学习和改进的地方。' },
  { id: 'communication', title: '表达与复用', description: '能否说明设计思路，让同学理解并借鉴。' },
]);
const title = ref(""),
  description = ref(""),
  classId = ref(""),
  className = ref(""),
  student = ref({ classId: "", email: "", name: "", password: "" }),
  message = ref("");
const query = ref("");
const ruleFilter = ref("all");
const workFilter = ref("all");
const progressLabels: Record<string,string> = {saved:'提交已保存，尚未创建检查',queued:'等待检查',preparing:'准备环境',building:'正在构建',checking:'正在检查',analyzing:'正在分析',completed:'检查结束，等待教师反馈',build_error:'构建未通过，等待教师反馈',infra_error:'执行环境异常',interrupted:'检查中断',cancelled:'检查已取消'};
const pendingReviewCount = computed(() => tasks.value.reduce((count, task) => count + (task.overview?.pendingReviewCount ?? 0), 0));
const overviewAvailable = computed(() => tasks.value.every(task => task.overview));
const readyCount = computed(
  () => tasks.value.filter((t) => t.kind === 'project' || t.rule_version).length,
);
const feedbackCount = computed(() => tasks.value.filter(task => task.overview?.latestPublication || task.overview?.latestEvaluation).length);
const unsubmittedCount = computed(() => tasks.value.filter(task => task.overview && !task.overview.latestSubmission).length);
const pendingTaskCount = computed(() => tasks.value.filter(task => (task.overview?.pendingReviewCount ?? 0) > 0).length);
const workOptions = computed(() => s.user?.role === 'teacher'
  ? [{ value: 'all', label: '全部任务', count: tasks.value.length }, { value: 'review', label: '待我复核', count: pendingTaskCount.value }]
  : [{ value: 'all', label: '全部任务', count: tasks.value.length }, { value: 'unsubmitted', label: '尚未提交', count: unsubmittedCount.value }, { value: 'feedback', label: '有已发布反馈', count: feedbackCount.value }]);
function selectQueue(value: string, rule = 'all') {
  workFilter.value = value;
  ruleFilter.value = rule;
  query.value = '';
}
function hasCurrentFeedback(task: any) {
  const overview = task.overview;
  return !!(overview?.latestEvaluation || overview?.latestSubmission?.publicationId ||
    (overview?.latestSubmission?.submissionId && overview.latestPublication?.submissionId === overview.latestSubmission.submissionId));
}
function taskStatus(task: any) {
  if (task.kind !== 'project' && !task.rule_version) return { label: '等待发布要求', tone: 'quiet' };
  if (!task.overview) return { label: '已开放', tone: 'quiet' };
  if (s.user?.role === 'teacher') return task.overview.pendingReviewCount
    ? { label: `${task.overview.pendingReviewCount} 份待${task.kind === 'project' ? '反馈' : '复核'}`, tone: 'attention' }
    : { label: task.overview.submittedStudents ? '暂无待复核' : '等待学生提交', tone: 'quiet' };
  if (hasCurrentFeedback(task)) return { label: '本次反馈已发布', tone: 'complete' };
  if (task.overview.latestPublication) return { label: '有历史反馈', tone: 'quiet' };
  return task.overview.latestSubmission
    ? { label: '已提交', tone: 'quiet' }
    : { label: '尚未提交', tone: 'attention' };
}
const filteredTasks = computed(() =>
  tasks.value.filter(
    (t) =>
      (ruleFilter.value === "all" ||
        (ruleFilter.value === "ready" ? t.kind === 'project' || !!t.rule_version : t.kind !== 'project' && !t.rule_version)) &&
      (workFilter.value === "all" ||
        (workFilter.value === "review" ? (t.overview?.pendingReviewCount ?? 0) > 0 :
          workFilter.value === "feedback" ? !!(t.overview?.latestPublication || t.overview?.latestEvaluation) :
            !!t.overview && !t.overview.latestSubmission)) &&
      [t.title, t.description, t.class_name].some((v) =>
        String(v ?? "")
          .toLowerCase()
          .includes(query.value.trim().toLowerCase()),
      ),
  ),
);
let createKey = crypto.randomUUID();
let classKey = crypto.randomUUID();
watch(className, () => { classKey = crypto.randomUUID(); }, {flush:'sync'});
const members=ref<Array<{id:string;name:string;email:string}>>([]),memberCursor=ref<string|null>(null),memberLoading=ref(false),memberError=ref(''),memberLoaded=ref(false),memberEmail=ref('');
let memberRequest=0;
watch(()=>[student.value.classId,memberEmail.value],()=>{
  memberRequest++;members.value=[];memberCursor.value=null;memberLoaded.value=false;memberLoading.value=false;memberError.value='';
},{flush:'sync'});
async function loadMembers(more=false){
  if(memberLoading.value||!student.value.classId)return;
  const sequence=++memberRequest;memberLoading.value=true;memberError.value='';
  const query=new URLSearchParams();
  if(more&&memberCursor.value)query.set('after',memberCursor.value);
  if(memberEmail.value.trim())query.set('email',memberEmail.value.trim());
  try{
    const result=await api(`/classes/${student.value.classId}/students?${query}`);
    if(sequence!==memberRequest)return;
    members.value=more?[...members.value,...result.items]:result.items;
    memberCursor.value=result.nextCursor;memberLoaded.value=true;
  }catch(e){if(sequence===memberRequest)memberError.value=(e as Error).message;}
  finally{if(sequence===memberRequest)memberLoading.value=false;}
}
watch(() => JSON.stringify([title.value, description.value, classId.value, taskKind.value, dueAt.value, rubric.value]), () => { createKey = crypto.randomUUID(); }, {flush:'sync'});
let writeController: AbortController | undefined;
onUnmounted(() => { writeController?.abort(); memberRequest++; });
async function mutate(url: string, options: RequestInit, version: 1 | 2 = 1) {
  const controller = new AbortController();
  writeController = controller;
  const timeout = window.setTimeout(() => controller.abort(), 15000);
  try {
    const result = await api(url, {...options, signal: controller.signal}, version);
    controller.signal.throwIfAborted();
    return result;
  } catch (failure) {
    if (controller.signal.aborted || failure instanceof TypeError)
      throw new Error('尚未收到创建回执，结果未知；服务器可能已经创建。没有自动重试，请先刷新核对任务和班级；学生账号可在班级成员中按邮箱核对。输入仍保留。');
    throw failure;
  } finally {
    window.clearTimeout(timeout);
    if (writeController === controller) writeController = undefined;
  }
}
const taskTotal=ref(0),nextCursor=ref<string|null>(null),loadingMore=ref(false);
let refreshAfterPage=false;
const decorate=(task:any,items:any[])=>({...task,id:task.taskId,rule_version:task.ruleVersion,class_name:items.find(item=>item.id===task.classId)?.name});
async function loadMore(){
  if(loading.value||loadingMore.value||!nextCursor.value)return;
  loadingMore.value=true;
  try{
    const result=await apiV2(`/tasks?after=${encodeURIComponent(nextCursor.value)}`);
    const seen=new Set(tasks.value.map(task=>task.id));
    tasks.value.push(...result.items.filter((task:any)=>!seen.has(task.taskId)).map((task:any)=>decorate(task,classes.value)));
    nextCursor.value=result.nextCursor;taskTotal.value=result.total;
  }catch(e){error.value=(e as Error).message;}
  finally{loadingMore.value=false;if(refreshAfterPage){refreshAfterPage=false;await load();}}
}
async function load() {
  if(loadingMore.value){refreshAfterPage=true;return;}
  loading.value = true;
  error.value = "";
  const version = s.businessVersion;
  try {
    const [t, c] = await Promise.all([
      version === 2 ? apiV2("/tasks") : api("/tasks"),
      api("/classes"),
    ]);
    if(version===2){
      let cursor=t.nextCursor;
      while(cursor&&t.items.length<tasks.value.length){
        const older=await apiV2(`/tasks?after=${encodeURIComponent(cursor)}`);
        t.items.push(...older.items);cursor=older.nextCursor;
      }
      nextCursor.value=cursor;taskTotal.value=t.total;
    }else{nextCursor.value=null;taskTotal.value=t.items.length;}
    tasks.value =
      version === 2
        ? t.items.map((task: any) => ({
            ...task,
            id: task.taskId,
            rule_version: task.ruleVersion,
            class_name: c.items.find((item: any) => item.id === task.classId)
              ?.name,
          }))
        : t.items;
    classes.value = c.items;
    classId.value ||= c.items[0]?.id ?? "";
    student.value.classId ||= classId.value;
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}
onMounted(load);
async function create() {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    const created = await mutate("/tasks", {
      method: "POST",
      headers: { "Idempotency-Key": createKey },
      body: JSON.stringify({
        title: title.value,
        description: description.value,
        classId: classId.value,
        ...(s.businessVersion === 1 ? { criteria: defaultCriteria } : {}),
        ...(s.businessVersion === 2 ? {
          kind: taskKind.value,
          ...(taskKind.value === 'project' ? {
            dueAt: dueAt.value ? new Date(dueAt.value).toISOString() : null,
            rubric: rubric.value.map(item => ({ ...item, title: item.title.trim(), description: item.description.trim() })),
          } : {}),
        } : {}),
      }),
    }, s.businessVersion);
    show.value = false;
    createKey = crypto.randomUUID();
    title.value = "";
    description.value = '';
    dueAt.value = '';
    message.value = taskKind.value === 'project' ? '任务已发布，学生现在可以提交项目。' : '任务已创建，请继续发布模板验收要求。';
    await load();
    if (s.businessVersion === 2 && created.taskId) await router.push(`/tasks/${created.taskId}`);
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
async function createClass() {
  if (busy.value) return;
  busy.value = true; error.value = ''; message.value = '';
  try {
    await mutate("/classes", {
      method: "POST",
      headers: { 'Idempotency-Key': classKey },
      body: JSON.stringify({ name: className.value }),
    });
    className.value = "";
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  } finally { busy.value = false; }
}
async function createStudent() {
  if (busy.value) return;
  busy.value = true; error.value = ''; message.value = '';
  try {
    await mutate(`/classes/${student.value.classId}/students`, {
      method: "POST",
      body: JSON.stringify(student.value),
    });
    message.value = "学生账号已创建，请通过课程约定方式告知学生。";
    student.value.password = "";
    memberEmail.value = student.value.email;
    await loadMembers();
  } catch (e) {
    error.value = (e as Error).message;
  } finally { busy.value = false; }
}
</script>
<template>
  <div class="page-heading" :class="{ 'student-task-heading': s.user?.role !== 'teacher' }">
    <div>
      <h1>实训任务</h1>
      <p class="muted">
        {{
          s.businessVersion === 1
            ? "固定模板验收，按提交时的规则检查与反馈。"
            : s.user?.role === "teacher"
              ? "发布开放项目或固定模板验收，按提交版本给出反馈。"
              : "开放项目与固定模板验收，提交作品后查看反馈。"
        }}
      </p>
    </div>
    <div class="actions">
      <button class="refresh-tasks" aria-label="刷新任务列表" :title="loading ? '正在读取任务' : '刷新任务列表'" :aria-busy="loading" :disabled="loading" @click="load"><RefreshCw :size="18" aria-hidden="true" /></button>
      <button v-if="s.user?.role === 'teacher'" :aria-expanded="classForm" @click="classForm = !classForm">
        <Users aria-hidden="true" :size="16" />班级与账号</button
      ><button v-if="s.user?.role === 'teacher'" class="primary" :aria-expanded="show" @click="show = !show">
        <Plus aria-hidden="true" :size="17" />创建任务
      </button>
    </div>
  </div>
  <p v-if="error" class="error" role="alert">{{ error }}</p>
  <p v-if="message && !classForm" class="notice" role="status">{{ message }}</p>
  <section v-if="classForm" class="panel">
    <h2>班级与学生账号</h2>
    <form class="inline-form" @submit.prevent="createClass">
      <label
        >新班级名称<input :disabled="busy" required v-model="className" maxlength="120" /></label
      ><button :disabled="busy">创建班级</button>
    </form>
    <form class="form-grid" @submit.prevent="createStudent">
      <label
      >所属班级<StudioSelect aria-label="所属班级" :disabled="busy" required v-model="student.classId">
          <option v-for="c in classes" :value="c.id">{{ c.name }}</option>
        </StudioSelect></label
      ><label>姓名<input :disabled="busy" required v-model="student.name" /></label
      ><label>邮箱<input :disabled="busy" required type="email" v-model="student.email" /></label
      ><label
        >初始密码<input
          :disabled="busy"
          required
          type="password"
          minlength="12"
          v-model="student.password"
          autocomplete="new-password" /></label
      ><button class="primary" :disabled="busy">创建学生账号</button>
    </form>
    <p role="status">{{ message }}</p>
    <section aria-label="班级成员核对">
      <h3>核对班级成员</h3>
      <p class="muted">按上方所选班级查询。创建结果未确认时，可输入完整邮箱核对；不会显示或重置学生密码。</p>
      <label>核对邮箱（留空查看成员）<input v-model="memberEmail" type="email" /></label>
      <button type="button" :disabled="memberLoading || !student.classId" @click="loadMembers()">{{ memberLoading ? '读取成员中…' : '查询班级成员' }}</button>
      <p v-if="memberError" role="alert" class="error">{{ memberError }}</p>
      <p v-if="memberLoaded && !members.length">当前班级未找到符合条件的学生。尚未完成的创建请求可能稍后生效，可再次查询。</p>
      <ul v-if="members.length"><li v-for="member in members" :key="member.id">{{ accountDisplayName(member.name) }} · {{ member.email }}</li></ul>
      <button v-if="memberCursor" type="button" :disabled="memberLoading" @click="loadMembers(true)">加载更多成员</button>
    </section>
  </section>
  <form v-if="show" class="panel form-grid" @submit.prevent="create">
    <h2 class="full">
      {{ s.businessVersion === 2 ? "发布一份实训任务" : "创建并发布首版规则" }}
    </h2>
    <label>任务名称<input :disabled="busy" v-model="title" required maxlength="120" /></label
    ><label
      >班级<StudioSelect aria-label="班级" :disabled="busy" v-model="classId" required>
        <option v-for="c in classes" :value="c.id">{{ c.name }}</option>
      </StudioSelect></label
    ><label class="full"
      >任务说明<textarea
        :disabled="busy"
        v-model="description"
        :required="s.businessVersion === 2 && taskKind === 'project'"
        rows="3"
        maxlength="5000"
        placeholder="学生要完成什么？请写明主要功能和需要展示的成果。"
      ></textarea>
    </label>
    <label v-if="s.businessVersion === 2 && taskKind === 'project'">提交截止时间（可选）<input type="datetime-local" v-model="dueAt" :disabled="busy" /><small class="muted">按本地时间；未设置时可持续提交。</small></label>
    <details v-if="s.businessVersion === 2" class="full task-creation-options">
      <summary>评价标准与任务方式 <span class="muted small">{{ taskKind === 'project' ? '开放项目 · 3 项参考标准' : '固定模板验收' }}</span></summary>
      <label>任务方式<StudioSelect aria-label="任务方式" v-model="taskKind" :disabled="busy"><option value="project">开放项目 · 接收常见语言的项目</option><option value="template">模板验收 · 使用课程模板运行检查</option></StudioSelect></label>
      <template v-if="taskKind === 'project'">
        <p class="muted small">教师和同学将参考这些标准交流。AI 帮助理解代码，教师确认最终反馈。</p>
        <div v-for="(item, index) in rubric" :key="item.id" class="rubric-editor">
          <label>标准 {{ index + 1 }}<input v-model="item.title" :disabled="busy" required maxlength="80" /></label>
          <label>说明<textarea v-model="item.description" :disabled="busy" rows="2" maxlength="500" /></label>
        </div>
      </template>
    </details>
    <p class="hint full">
      {{
        s.businessVersion === 2
          ? taskKind === 'project' ? "发布后即可收项目。学生无需配置 AI 模型也能提交；同班同学可交流学习，教师确认优秀作品。" : "创建后选择验收包并发布规则，学生使用固定模板提交。"
          : "首版采用模板的七项行为检查。创建后可在任务页调整条目并发布新规则版本。"
      }}
    </p>
    <div class="actions">
      <button class="primary" :disabled="busy">
        {{ busy ? '正在保存…' : s.businessVersion === 2 && taskKind === 'template' ? "创建任务并设置验收" : "发布任务" }}</button
      ><button type="button" :disabled="busy" @click="show = false">取消</button>
    </div>
  </form>
  <section v-if="!loading && tasks.length" class="task-overview" :class="{ 'student-task-overview': s.user?.role !== 'teacher' }" aria-label="任务概览">
    <div class="overview-heading">
      <span>{{ s.user?.role === 'teacher' ? '教学进展' : '我的实训进展' }}</span>
      <span class="muted small">基于已加载的 {{ tasks.length }} 项任务</span>
    </div>
    <div class="overview-counts">
      <button v-if="s.businessVersion === 2" v-spotlight class="overview-item overview-priority" :disabled="!overviewAvailable" @click="selectQueue(s.user?.role === 'teacher' ? 'review' : 'unsubmitted')">
        <span class="overview-metric"><ClipboardCheck aria-hidden="true" :size="18" /><span>{{ s.user?.role === 'teacher' ? '待复核的最新提交' : '尚未提交的任务' }}</span></span>
        <strong><AnimatedNumber :value="overviewAvailable ? s.user?.role === 'teacher' ? pendingReviewCount : unsubmittedCount : '—'" /><small>{{ s.user?.role === 'teacher' ? '份' : '项' }}</small></strong>
        <span class="overview-action">{{ s.user?.role === 'teacher' ? '开始评阅' : '去完成任务' }}<ArrowRight aria-hidden="true" :size="15" /></span>
      </button>
      <button v-if="s.user?.role !== 'teacher' && s.businessVersion === 2" v-spotlight class="overview-item" :disabled="!overviewAvailable" @click="selectQueue('feedback')">
        <span class="overview-metric"><MessageSquareText aria-hidden="true" :size="18" /><span>有已发布反馈</span></span>
        <strong><AnimatedNumber :value="overviewAvailable ? feedbackCount : '—'" /><small>项</small></strong>
        <span class="overview-action">阅读反馈与改进<ArrowRight aria-hidden="true" :size="15" /></span>
      </button>
      <button v-else v-spotlight class="overview-item" @click="selectQueue('all', 'draft')">
        <span class="overview-metric"><BookOpen aria-hidden="true" :size="18" /><span>待发布的验收要求</span></span>
        <strong><AnimatedNumber :value="tasks.length - readyCount" /><small>项</small></strong>
        <span class="overview-action">完善任务要求<ArrowRight aria-hidden="true" :size="15" /></span>
      </button>
      <button v-spotlight class="overview-item" @click="selectQueue('all', 'ready')">
        <span class="overview-metric"><Users aria-hidden="true" :size="18" /><span>已开放任务</span></span>
        <strong><AnimatedNumber :value="readyCount" /><small>/ {{ tasks.length }} 项</small></strong>
        <span class="overview-action">查看课程任务<ArrowRight aria-hidden="true" :size="15" /></span>
      </button>
    </div>
    <p v-if="s.businessVersion === 2 && !overviewAvailable" class="overview-notice">提交摘要暂不可用，请进入任务查看记录。</p>
  </section>
  <section class="task-collection" aria-label="课程任务列表">
    <div class="section-heading">
      <div>
        <h2>
          课程任务 <span class="count-label">{{ taskTotal }}</span>
        </h2>
      </div>
    </div>
    <div v-if="s.businessVersion === 2" class="work-filter">
      <div class="queue-filters" role="group" aria-label="按待办筛选">
        <span class="queue-label">我的待办</span>
        <button v-for="option in workOptions" :key="option.value" type="button" :aria-pressed="workFilter === option.value" :disabled="loading || !overviewAvailable" @click="workFilter = option.value">{{ option.label }}<span>{{ option.count }}</span></button>
      </div>
      <span class="filter-result muted small" aria-live="polite">显示 {{ filteredTasks.length }} / {{ tasks.length }} 项</span>
    </div>
    <div class="collection-toolbar">
      <div class="segmented" role="group" aria-label="按规则状态筛选">
        <button
          :aria-pressed="ruleFilter === 'all'"
          @click="ruleFilter = 'all'"
        >
          全部 {{ tasks.length }}
        </button>
        <button
          :aria-pressed="ruleFilter === 'ready'"
          @click="ruleFilter = 'ready'"
        >
          已发布 {{ readyCount }}
        </button>
        <button
          :aria-pressed="ruleFilter === 'draft'"
          @click="ruleFilter = 'draft'"
        >
          待发布 {{ tasks.length - readyCount }}
        </button>
      </div>
      <StudioSearch v-model="query" label="搜索任务或班级" />
    </div>
    <p class="loaded-note muted small">已加载 {{ tasks.length }} / {{ taskTotal }} 项；搜索、筛选与统计仅针对已加载任务。<span v-if="s.businessVersion === 2 && s.user?.role === 'teacher'">待复核按每位学生的最新提交统计。</span></p>
    <div v-if="loading" class="empty" role="status">正在读取任务…</div>
    <div v-else-if="!tasks.length" class="empty">
      <BookOpen aria-hidden="true" :size="34" />
      <h2>还没有实训任务</h2>
      <p>
        {{
          s.user?.role === "teacher"
            ? "先创建班级，再发布一份任务。"
            : "教师将你加入班级后，课程任务会显示在这里。"
        }}
      </p>
    </div>
    <div v-else class="task-list">
      <article
        v-for="t in filteredTasks"
        :key="t.id"
        class="task-card"
        ><div class="task-icon"><BookOpen aria-hidden="true" :size="21" /></div>
        <div class="task-description">
          <div class="task-meta">
            <span class="task-class">{{ t.class_name || '课程任务' }}</span>
            <span class="task-kind">{{
              t.kind === 'project' ? '开放项目' : t.rule_version ? "模板验收 · v" + t.rule_version : "模板规则待发布"
            }}</span>
            <span class="task-state" :class="taskStatus(t).tone">{{ taskStatus(t).label }}</span>
          </div>
          <h2><RouterLink :to="'/tasks/' + t.id">{{ t.title }}</RouterLink></h2>
          <p v-if="t.description" class="task-excerpt">{{ t.description }}</p>
          <div v-if="t.kind === 'project' && t.overview" class="task-progress">
            <span v-if="s.user?.role === 'teacher'">{{ t.overview.submittedStudents ?? 0 }} 位学生已提交</span>
            <span v-else>{{ t.overview.latestEvaluation ? '教师反馈可阅读' : t.overview.latestSubmission ? '教师和同学可以阅读交流' : '上传 ZIP 或关联已有项目' }}</span>
            <span>{{ t.dueAt ? `截止 ${new Date(t.dueAt).toLocaleString('zh-CN', {month:'long', day:'numeric', hour:'2-digit', minute:'2-digit'})}` : '可持续提交' }}</span>
            <RouterLink :to="{ path: '/tasks/' + t.id, query: { tab: 'showcase' } }" class="featured-link"><Award aria-hidden="true" :size="14" />优秀作品</RouterLink>
          </div>
          <div v-else-if="t.overview" class="task-progress">
            <template v-if="s.user?.role === 'teacher'">
              <span>{{ t.overview.submittedStudents ? `${t.overview.submittedStudents} 位学生已提交` : '尚无学生提交' }}</span>
            </template>
            <template v-else>
              <span v-if="!t.overview.latestSubmission">{{ t.rule_version ? '查看要求后提交项目' : '教师发布要求后即可提交' }}</span>
              <template v-else>
                <span>最近提交 <code>{{ t.overview.latestSubmission.submissionId.slice(0,8) }}</code></span>
                <span>{{ hasCurrentFeedback(t) ? '本次反馈已发布' : progressLabels[t.overview.latestSubmission.status] ?? '请进入任务查看状态' }}</span>
              </template>
            </template>
          </div>
          <div v-if="s.user?.role !== 'teacher' && t.kind !== 'project' && (t.overview?.latestSubmission?.runId || t.overview?.latestPublication)" class="task-links">
            <RouterLink v-if="t.overview.latestPublication" :to="'/publications/' + t.overview.latestPublication.publicationId"><MessageSquareText aria-hidden="true" :size="14" />阅读已发布反馈 · 版本 {{ t.overview.latestPublication.publicationNo }}<span v-if="t.overview.latestPublication.submissionId !== t.overview.latestSubmission?.submissionId" class="muted">（前次提交）</span></RouterLink>
            <RouterLink v-if="t.overview.latestSubmission?.runId" :to="'/runs/' + t.overview.latestSubmission.runId">查看本次进度<ArrowUpRight aria-hidden="true" :size="14" /></RouterLink>
          </div>
          <div v-if="s.businessVersion === 2 && t.kind !== 'project'" class="task-disclosures">
            <details class="task-scope" aria-label="当前验收范围">
              <summary><span>验收范围</span><span v-if="t.ruleScope" class="scope-count">{{ t.ruleScope.caseCount }} 个自动检查案例</span></summary>
              <div class="scope-content">
                <template v-if="t.ruleScope">
                  <div class="scope-groups">
                    <section v-for="mode in ['auto','manual']" :key="mode" class="scope-group">
                      <h3>{{ mode === 'auto' ? '自动检查' : '人工判断' }}<span>{{ t.ruleScope.criteria.filter((c: any) => c.mode === mode).length }}</span></h3>
                      <ul v-if="t.ruleScope.criteria.some((c: any) => c.mode === mode)"><li v-for="criterion in t.ruleScope.criteria.filter((c: any) => c.mode === mode)" :key="criterion.id || criterion.title">{{ criterion.title }}</li></ul>
                      <p v-else class="muted">未启用</p>
                    </section>
                  </div>
                  <p class="scope-note">当前规则适用于新提交；既有提交保留当时规则。</p>
                </template>
                <p v-else class="muted">{{ t.rule_version ? '验收范围暂不可用，请进入任务查看。' : '尚未发布要求，暂不能提交。' }}</p>
              </div>
            </details>
            <details v-if="s.user?.role === 'teacher' && t.overview?.pendingReviews?.length" class="task-scope review-queue">
              <summary><span>待复核提交</span><span class="scope-count">{{ t.overview.pendingReviewCount }} 份</span></summary>
              <div class="scope-content">
                <ul aria-label="待复核提交"><li v-for="item in t.overview.pendingReviews" :key="item.submissionId"><span>{{ accountDisplayName(item.studentName) }} <code>{{ item.submissionId.slice(0,8) }}</code></span><RouterLink :to="'/runs/' + item.runId">复核此提交<ArrowUpRight aria-hidden="true" :size="14" /></RouterLink></li></ul>
                <p v-if="t.overview.pendingReviewCount > 5" class="scope-note">显示最近 5 份；进入任务可查看其余提交。</p>
              </div>
            </details>
          </div>
        </div>
        <RouterLink :to="'/tasks/' + t.id" class="task-arrow" :aria-label="'进入任务：' + t.title"><span>{{ t.kind === 'project' && s.user?.role === 'teacher' ? '评阅作品' : '查看任务' }}</span><ArrowUpRight aria-hidden="true" :size="17" /></RouterLink>
      </article>
    </div>
    <div
      v-if="!loading && tasks.length && !filteredTasks.length"
      class="empty compact"
    >
      <h3>没有匹配的任务</h3>
      <p>{{ workFilter === 'review' ? '当前条件下没有待复核的最新提交。可清除筛选查看全部任务。' : workFilter === 'feedback' ? '当前条件下没有已发布反馈。可进入任务查看检查进度。' : '换一个关键词，或清除规则与待办筛选。' }}</p>
      <button
        @click="
          query = '';
          ruleFilter = 'all';
          workFilter = 'all';
        "
      >
        清除筛选
      </button>
    </div>
    <button v-if="nextCursor" type="button" :disabled="loading || loadingMore || busy" @click="loadMore">{{ loadingMore ? '读取中…' : '加载更早任务' }}</button>
  </section>
  <details class="task-type-guide">
    <summary>任务类型与学习方式</summary>
    <dl>
      <div v-if="s.businessVersion === 2"><dt>开放项目</dt><dd>上传项目或关联已有项目，围绕同一提交版本阅读 AI 导读、交流评价；教师确认最终反馈与优秀作品。提交项目不会自动调用付费模型。</dd></div>
      <div><dt>固定模板验收</dt><dd>使用课程模板，按已发布规则执行检查；既有提交保留提交时的规则和教师反馈。</dd></div>
      <div v-if="s.businessVersion === 2"><dt>课程作业</dt><dd>函数、文件或一组连续子任务，各自保留提交与评价。<RouterLink to="/assignments">前往课程作业<ArrowUpRight :size="15" aria-hidden="true" /></RouterLink></dd></div>
    </dl>
    <p>从任务要求开始，提交作品、核对依据，再把反馈带进下一次修改。</p>
  </details>
</template>

<style scoped>
.task-overview { margin-bottom: var(--space-lg); }
.overview-heading { display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-sm); margin-bottom: var(--space-xs); font-size: var(--text-sm); font-weight: 600; }
.overview-heading .muted { font-weight: 400; }
.overview-counts { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--space-xs); }
.overview-item { display: grid; grid-template-columns: minmax(0,1fr) auto; align-items: center; column-gap: var(--space-sm); row-gap: var(--space-xs); padding: var(--space-md); background: var(--paper); border: 1px solid var(--line); border-radius: var(--radius); text-align: left; }
.overview-item:hover:not(:disabled) { background: var(--paper); border-color: var(--control-line); }
.overview-priority { background: var(--accent-soft); border-color: color-mix(in oklch, var(--accent) 18%, var(--paper)); }
.overview-priority:hover:not(:disabled) { background: var(--accent-soft); border-color: var(--accent); }
.overview-metric { display: flex; align-items: center; gap: var(--space-2xs); color: var(--muted); font-weight: 500; font-size: var(--text-xs); }
.overview-priority .overview-metric, .overview-priority strong { color: var(--accent-ink); }
.overview-item strong { grid-column: 2; grid-row: 1 / 3; font-size: 2rem; font-weight: 600; letter-spacing: -.05em; line-height: 1; font-variant-numeric: tabular-nums; color: var(--ink); white-space: nowrap; }
.overview-item strong small { display: inline; margin-left: .3rem; font-size: var(--text-xs); font-weight: 400; color: var(--muted); letter-spacing: 0; }
.overview-action { display: flex; align-items: center; gap: var(--space-2xs); color: var(--ink); font-size: var(--text-xs); font-weight: 400; }
.overview-notice { font-size: var(--text-xs); color: var(--muted); margin: var(--space-xs) 0 0; }
.task-collection > .section-heading { flex-wrap: wrap; gap: var(--space-sm); margin-bottom: var(--space-md); }
.work-filter { display: flex; align-items: center; justify-content: space-between; gap: var(--space-xs); padding-block: var(--space-xs); border-top: 1px solid var(--line); }
.queue-filters { display: flex; flex-wrap: wrap; align-items: center; gap: .3rem; }
.queue-label { color: var(--muted); font-size: var(--text-xs); margin-right: var(--space-2xs); }
.queue-filters button { display: inline-flex; align-items: center; gap: .4rem; background: transparent; border-color: transparent; font-size: var(--text-xs); font-weight: 500; min-height: 44px; padding: .35rem .65rem; border-radius: .5rem; color: var(--muted); }
.queue-filters button[aria-pressed="true"] { color: var(--accent-ink); background: var(--accent-soft); }
.queue-filters button span { font-family: var(--font-outlier); font-size: .7rem; opacity: .85; }
.filter-result { flex-shrink: 0; }
.loaded-note { margin: 0; padding-bottom: var(--space-xs); line-height: 1.7; }
.task-card { display: grid; grid-template-columns: 40px minmax(0,1fr) auto; gap: var(--space-sm); align-items: start; padding-block: var(--space-md); }
.task-card .task-icon { width: 40px; height: 40px; margin-top: .15rem; }
.task-meta { display: flex; align-items: center; flex-wrap: wrap; gap: .4rem .65rem; font-size: var(--text-xs); }
.task-class { color: var(--muted); }
.task-kind { color: var(--muted); padding-left: .65rem; border-left: 1px solid var(--line); }
.task-state { display: inline-flex; align-items: center; gap: .35rem; padding: .15rem .5rem; border-radius: .375rem; font-size: .6875rem; font-weight: 500; line-height: 1.6; }
.task-state::before { content: ''; width: 4px; height: 4px; border-radius: 50%; background: currentColor; }
.task-state.quiet { background: var(--surface); color: var(--muted); }
.task-state.attention { background: var(--warning-soft); color: var(--warning); }
.task-state.complete { background: var(--success-soft); color: var(--success); }
.task-description h2 { font-size: 1.0625rem; margin: .45rem 0 .3rem; line-height: 1.6; }
.task-description .task-excerpt { margin: 0; font-size: var(--text-xs); line-height: 1.8; max-width: 95ch; }
.task-progress { display: flex; flex-wrap: wrap; align-items: center; gap: .25rem .65rem; margin-top: .5rem; color: var(--muted); font-size: var(--text-xs); line-height: 1.7; }
.task-progress > span + span { padding-left: .65rem; border-left: 1px solid var(--line); }
.task-progress code { background: var(--surface); padding: .1rem .2rem; font-size: .6875rem; }
.task-progress .featured-link { display: inline-flex; align-items: center; gap: .3rem; min-height: 32px; color: var(--accent-ink); }
.task-links { display: flex; align-items: center; flex-wrap: wrap; gap: .25rem var(--space-md); margin-top: .15rem; }
.task-links a { display: inline-flex; align-items: center; flex-wrap: wrap; gap: .35rem; min-height: 44px; font-size: var(--text-xs); color: var(--accent-ink); text-decoration: none; }
.task-links a:hover, .task-progress a:hover { text-decoration: underline; text-underline-offset: 4px; }
.task-arrow { display: inline-flex; align-items: center; justify-content: center; gap: .4rem; margin: 0; min-height: 44px; padding: .45rem .7rem; font-size: var(--text-xs); background: var(--paper); white-space: nowrap; }
.task-disclosures { margin-top: var(--space-2xs); display: grid; gap: .4rem; max-width: 54rem; }
.task-scope { margin: 0; padding: 0; border: 1px solid var(--line); border-radius: .625rem; color: var(--muted); font-size: var(--text-xs); overflow: clip; background: var(--surface); }
.task-scope summary { display: flex; align-items: center; flex-wrap: wrap; gap: .5rem; padding: .55rem .75rem; min-height: 44px; font-size: var(--text-xs); color: var(--ink); font-weight: 500; margin: 0; }
.task-scope[open] > summary { border-bottom: 1px solid var(--line); margin-bottom: 0; }
.scope-count { font-weight: 400; color: var(--muted); }
.task-scope > .scope-content { margin-bottom: 0; padding: var(--space-sm); background: var(--paper); }
.scope-groups { display: grid; grid-template-columns: minmax(0,1fr) minmax(0,1fr); gap: var(--space-md); }
.scope-group + .scope-group { border-left: 1px solid var(--line); padding-left: var(--space-md); }
.scope-group h3 { display: flex; align-items: center; gap: .5rem; margin: 0 0 .6rem; color: var(--ink); font-size: var(--text-xs); }
.scope-group h3 span { color: var(--muted); font-size: .6875rem; font-weight: 400; }
.scope-group ul { padding: 0; margin: 0; list-style: none; display: grid; gap: .5rem; }
.scope-group li { display: flex; align-items: baseline; gap: .5rem; line-height: 1.7; }
.scope-group li::before { content: ''; flex-shrink: 0; width: 4px; height: 4px; border-radius: 50%; background: var(--control-line); transform: translateY(-2px); }
.task-description .task-scope p { display: block; overflow: visible; margin: 0; font-size: var(--text-xs); line-height: 1.8; }
.task-description .scope-content .scope-note { border-top: 1px solid var(--line); margin-top: var(--space-sm); padding-top: var(--space-xs); color: var(--muted); }
.review-queue ul { padding: 0; margin: 0; list-style: none; }
.review-queue li { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: var(--space-xs); }
.review-queue li + li { border-top: 1px solid var(--line); }
.review-queue li > span { display: flex; gap: var(--space-2xs); align-items: center; }
.review-queue code { font-size: .6875rem; color: var(--muted); }
.review-queue a { display: inline-flex; align-items: center; gap: .35rem; min-height: 44px; color: var(--accent-ink); }
.task-creation-options { border-block: 1px solid var(--line); }
.task-creation-options summary { display: flex; flex-wrap: wrap; gap: var(--space-xs); align-items: center; }
.task-creation-options > label { max-width: 32rem; }
.rubric-editor { display: grid; grid-template-columns: minmax(8rem, .6fr) minmax(0, 1.4fr); gap: var(--space-md); align-items: start; border-top: 1px solid var(--line); padding-top: var(--space-sm); }
@media (max-width: 1200px) {
  .overview-item { padding: var(--space-sm); gap: .65rem; }
  .overview-item strong { font-size: 1.75rem; }
  .overview-metric { gap: .4rem; }
  .overview-metric svg { display: none; }
}
@media (max-width: 950px) {
  .overview-counts { gap: .5rem; }
  .overview-item { grid-template-columns: minmax(0,1fr); gap: .65rem; }
  .overview-item strong { grid-column: 1; grid-row: 2; }
  .overview-action { font-size: .6875rem; }
  .task-arrow span { display: none; }
  .task-arrow { min-width: 44px; padding: .4rem; }
}
@media (max-width: 640px) {
  .rubric-editor { grid-template-columns: minmax(0,1fr); gap: 0; }
  .task-card { grid-template-columns: minmax(0,1fr) auto; gap: .5rem; }
  .task-card .task-icon { display: none; }
  .task-description h2 { font-size: 1rem; }
  .work-filter { align-items: flex-start; flex-direction: column; gap: .5rem; }
  .queue-label { width: 100%; margin: 0; }
  .filter-result { display: none; }
  .scope-groups { grid-template-columns: minmax(0,1fr); gap: var(--space-sm); }
  .scope-group + .scope-group { border-left: 0; padding-left: 0; border-top: 1px solid var(--line); padding-top: var(--space-sm); }
  .scope-content { padding: var(--space-xs); }
  .task-links { gap: 0 .7rem; }
}
@media (max-width: 480px) {
  .overview-heading { flex-wrap: wrap; gap: .25rem; }
  .overview-counts { grid-template-columns: minmax(0,1fr); gap: .5rem; }
  .overview-item { grid-template-columns: minmax(0,1fr) auto; gap: .45rem; padding: .85rem var(--space-sm); }
  .overview-item strong { grid-column: 2; grid-row: 1 / 3; }
  .overview-metric svg { display: block; }
  .overview-action { font-size: var(--text-xs); }
  .loaded-note { font-size: .6875rem; }
  .task-meta { column-gap: .5rem; }
  .task-kind { padding-left: .5rem; }
  .task-state { padding-inline: .35rem; }
  .task-arrow { margin-top: .1rem; }
}
/* 雾港手稿 (2026-10-04) */
.overview-item { border: 0; border-top: 1px solid var(--ink); border-radius: 0; background: transparent; transition: background 220ms var(--ease-out), border-color 220ms var(--ease-out); }
.overview-item:hover:not(:disabled) { background: var(--paper); border-color: var(--accent); }
.overview-priority { background: transparent; border-color: var(--accent); }
.overview-priority:hover:not(:disabled) { background: var(--accent-soft); }
.overview-item strong { font-family: var(--font-body); font-size: 1.75rem; letter-spacing: 0; }
.overview-metric { font-family: var(--font-body); letter-spacing: 0; font-size: .8125rem; }
.queue-filters button { position: relative; border-radius: 0; padding-inline: .2rem; margin-right: .6rem; }
.queue-filters button[aria-pressed="true"] { background: transparent; color: var(--ink); }
.queue-filters button::after { content: ''; position: absolute; left: 0; right: 0; bottom: .45rem; height: 1.5px; background: var(--accent); scale: 0 1; transform-origin: left; transition: scale 420ms var(--ease-emphasis); }
.queue-filters button[aria-pressed="true"]::after { scale: 1 1; }
.task-state { border-radius: .25rem; font-family: var(--font-body); letter-spacing: 0; font-size: .75rem; }
.task-state::before { border-radius: 50%; rotate: none; }
.task-description h2 { font-family: var(--font-body); font-size: 1.0625rem; font-weight: 650; }
.task-scope { border-radius: var(--radius-input); border-color: var(--line); background: transparent; }
.task-description .task-excerpt { font-size: .875rem; line-height: 1.8; max-width: 75ch; color: var(--muted); }
.task-list > .task-card { padding-block: var(--space-md); }
.task-card .task-icon { border-radius: var(--radius-input); color: var(--accent); background: var(--accent-soft); border-color: transparent; }
.task-collection > .section-heading { margin-bottom: var(--space-sm); }
.task-collection > .section-heading h2 { font-size: 1.125rem; }
.loaded-note { font-size: .75rem; }
.overview-item { padding: var(--space-sm); column-gap: .75rem; row-gap: .5rem; }
.overview-item strong { grid-column: 2; grid-row: 1 / 3; }
.overview-action { font-size: .75rem; }
@media (min-width: 641px) {
  .overview-item { grid-template-columns: minmax(0,1fr) auto; }
}
@media (max-width: 760px) {
  .task-collection { padding: var(--space-sm); }
  .task-meta, .task-progress, .task-links a, .queue-filters button, .queue-filters button span, .loaded-note, .overview-action, .overview-metric { font-size: .875rem; }
  .task-progress .featured-link { min-height: 44px; }
  .collection-toolbar { flex-direction: column; gap: var(--space-xs); }
  .queue-filters { column-gap: .65rem; }
  .queue-filters button { margin-right: 0; }
}
.refresh-tasks { width: 44px; height: 44px; padding: 0; flex-shrink: 0; background: transparent; border-color: transparent; color: var(--muted); }
.refresh-tasks:hover:not(:disabled) { background: var(--surface); border-color: var(--line); }
.student-task-overview .overview-item { grid-template-columns: minmax(0,1fr) auto; grid-template-rows: auto; align-content: center; min-height: 56px; row-gap: 0; }
.student-task-overview .overview-item strong { grid-column: 2; grid-row: 1; font-size: 1.25rem; }
.student-task-overview .overview-action { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.task-type-guide { margin-top: var(--space-lg); border-top: 1px solid var(--line); color: var(--muted); font-size: var(--text-sm); }
.task-type-guide summary { min-height: 44px; align-content: center; font-weight: 500; }
.task-type-guide dl { margin-block: var(--space-sm); display: grid; gap: var(--space-sm); }
.task-type-guide dt { color: var(--ink); font-weight: 600; }
.task-type-guide dd { margin: .25rem 0 0; line-height: 1.8; max-width: 75ch; }
.task-type-guide a { display: inline-flex; align-items: center; gap: .3rem; min-height: 44px; margin-left: .5rem; }
.task-type-guide > p { max-width: 75ch; line-height: 1.8; }
@media (max-width: 640px) {
  .student-task-heading { display: grid; grid-template-columns: minmax(0,1fr) 44px; align-items: start; gap: .75rem; margin-bottom: var(--space-sm); }
  .student-task-heading > .actions { margin: 0; }
  .task-overview { margin-bottom: var(--space-sm); }
  .overview-counts { grid-template-columns: repeat(3, minmax(0,1fr)); gap: .5rem; }
  .overview-item { grid-template-columns: minmax(0,1fr); grid-template-rows: minmax(2.8em,auto) auto; align-content: start; gap: .5rem; padding: .65rem .25rem; min-height: 100px; }
  .overview-item strong { grid-column: 1; grid-row: 2; font-size: 1.5rem; }
  .overview-item strong small { margin-left: .15rem; font-size: .75rem; }
  .overview-metric { line-height: 1.4; align-self: start; }
  .overview-metric svg { display: none; }
  .overview-action, .queue-label { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  .task-collection > .section-heading { gap: .5rem; margin-bottom: .75rem; }
  .collection-toolbar { gap: .5rem; margin-bottom: .5rem; }
  .work-filter { padding-block: .5rem; }
  .task-list > .task-card { padding-block: var(--space-sm); }
  .student-task-overview .overview-item { grid-template-columns: minmax(0,1fr); grid-template-rows: minmax(2.8em,auto) auto; min-height: 88px; row-gap: .35rem; }
  .student-task-overview .overview-item strong { grid-column: 1; grid-row: 2; }
}
@media (prefers-reduced-motion: reduce) { .queue-filters button::after, .overview-item { transition: none; } }
</style>
