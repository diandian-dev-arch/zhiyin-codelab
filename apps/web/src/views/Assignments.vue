<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { api, useSession } from "../api";
import { createCourseworkApi } from '../lib/coursework-api';
import CourseworkWriteRecovery from '../components/CourseworkWriteRecovery.vue';
import { useRouter } from "vue-router";
import CourseTaskOptions from "../components/CourseTaskOptions.vue";
import CourseTaskBrief from "../components/CourseTaskBrief.vue";
import { courseDeadline, courseTime } from "../coursework-time";
import { ArrowUpRight, BookOpen, CalendarClock, ClipboardList, FilePenLine, Plus, Save, SearchX, Users } from 'lucide-vue-next';
import StudioSearch from '../components/StudioSearch.vue';
const session = useSession(),
  router = useRouter(),
  teacher = computed(() => session.user?.role === "teacher");
const writes = createCourseworkApi(`${session.user?.id}/assignments`);
const { request: apiV2, uncertain, checking, checked } = writes;
let alive = true;
onUnmounted(() => { alive = false; writes.dispose(); });
async function reconcileWrite() {
  try { await writes.reconcile(load); } catch (e) { if (alive) error.value = (e as Error).message; }
}
function resumeWrites() { writes.resume(); error.value = ''; }
const assignments = ref<any[]>([]),
  legacy = ref<any[]>([]),
  classes = ref<any[]>([]),
  error = ref(""),
  loading = ref(true),
  busy = ref(false),
  show = ref(false),
  enabled = ref(true);
const preview = ref(false),
  createStatus = ref("published");
const search = ref(''), statusFilter = ref('all'), classFilter = ref('');
const visibleAssignments = computed(() => {
  const query = search.value.trim().toLocaleLowerCase();
  return assignments.value.filter(a =>
    (statusFilter.value === 'all' || a.status === statusFilter.value) &&
    (!classFilter.value || a.class_id === classFilter.value) &&
    (!query || `${a.title} ${a.class_name}`.toLocaleLowerCase().includes(query)),
  );
});
function clearFilters() { search.value = ''; statusFilter.value = 'all'; classFilter.value = ''; }
const form = ref({
  classId: "",
  title: "",
  subjectMode: "individual",
  taskTitle: "",
  description: "",
  requirements: "",
  dueAt: "",
  allowCode: true,
  allowedSources: ["snippet", "files", "zip", "gitee", "github"],
  requiredPaths: [] as string[],
  scope: [] as string[],
  starter: "",
});
const taskInput = computed(() => ({
  title: form.value.taskTitle || form.value.title,
  description: form.value.description,
  requirements: form.value.requirements
    .split("\n")
    .filter((x) => x.trim())
    .map((title, i) => ({ id: `R${i + 1}`, title })),
  dueAt: courseDeadline(form.value.dueAt),
  allowCode: form.value.allowCode,
  allowedSources: form.value.allowedSources,
  requiredPaths: form.value.requiredPaths,
  scope: form.value.scope,
  starter: form.value.starter,
}));
async function load() {
  loading.value = true;
  error.value = "";
  try {
    enabled.value = (await apiV2("/coursework/status")).enabled;
    if (!enabled.value) return false;
    const [list, cls] = await Promise.all([
      apiV2("/assignments"),
      api("/classes"),
    ]);
    if (!alive) return false;
    assignments.value = list.items;
    legacy.value = list.legacy;
    classes.value = cls.items ?? cls;
    form.value.classId ||= classes.value[0]?.id ?? "";
    return true;
  } catch (e) {
    if (alive) error.value = (e as Error).message;
    return false;
  } finally {
    loading.value = false;
  }
}
async function create() {
  if (busy.value || uncertain.value) return;
  busy.value = true;
  error.value = "";
  try {
    const f = form.value;
    const result = await apiV2("/assignments", {
      method: "POST",
      body: JSON.stringify({
        classId: f.classId,
        title: f.title,
        subjectMode: f.subjectMode,
        status: createStatus.value,
        tasks: [taskInput.value],
      }),
    });
    if (alive) await router.push(`/assignments/${result.id}`);
  } catch (e) {
    if (alive) error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
onMounted(load);
</script>
<template>
  <section class="course-page assignments-page" aria-label="课程作业">
    <header class="course-heading">
      <div>
        <h1><BookOpen :size="26" aria-hidden="true" />课程作业</h1>
        <p class="muted">函数、文件或一组连续子任务，各自保留提交版本与评价。</p>
      </div>
      <button v-if="teacher && enabled" class="primary" :aria-expanded="show" aria-controls="assignment-create" @click="show = !show">
        <Plus :size="18" aria-hidden="true" />创建作业
      </button>
    </header>
    <p v-if="error" role="alert" class="error">
      {{ error }} <button @click="load">重新读取</button>
    </p>
    <CourseworkWriteRecovery v-if="uncertain" :busy="busy" :checking="checking" :checked="checked" @check="reconcileWrite" @resume="resumeWrites" />
    <p v-if="loading" class="assignment-loading" role="status">正在读取作业…</p>
    <p v-else-if="!enabled" class="assignment-unavailable">
      任务化入口暂未开放，<RouterLink to="/tasks">返回原有任务</RouterLink>。
    </p>
    <form v-if="show" id="assignment-create" class="course-panel course-form assignment-create" :aria-busy="busy" @submit.prevent="create">
      <h2><FilePenLine :size="21" aria-hidden="true" />创建练习或大作业</h2>
      <fieldset class="assignment-fields">
      <legend>作业信息</legend>
      <label
        >班级<select v-model="form.classId" required>
          <option v-for="c in classes" :key="c.id" :value="c.id">
            {{ c.name }}
          </option>
        </select></label
      >
      <label
        >作业名称<input v-model="form.title" required maxlength="160" /></label
      ><label class="assignment-wide"
        >提交方式<select v-model="form.subjectMode" aria-label="提交方式">
          <option value="individual">个人</option>
          <option value="team">团队（成员确认加入，指定提交人）</option>
        </select></label
      >
      </fieldset>
      <fieldset class="assignment-fields">
      <legend>首个子任务</legend>
      <label class="assignment-wide"
        >首个子任务名称<input
          v-model="form.taskTitle"
          placeholder="留空则与作业同名" /></label
      ><label
        >目标与说明<textarea v-model="form.description" required rows="3" />
      </label>
      <label
        >评价标准（每行一条）<textarea
          v-model="form.requirements"
          required
          rows="3"
        /></label
      ><label class="assignment-wide"
        >截止时间（北京时间）<input v-model="form.dueAt" type="datetime-local"
      /></label>
      </fieldset>
      <CourseTaskOptions v-model="form" />
      <label class="course-check"
        ><input
          v-model="form.allowCode"
          type="checkbox"
        />允许学生主动请求辅助代码</label
      >
      <p class="muted">
        默认正式代码仅提交主体和授课教师可读。提交不自动调用付费模型。
      </p>
      <div class="assignment-create-actions">
        <button
          type="button"
          :aria-expanded="preview"
          @click="preview = !preview"
        >
          <BookOpen :size="16" aria-hidden="true" />预览学生视图
        </button>
        <button type="submit" :disabled="busy || uncertain" @click="createStatus = 'draft'">
          <Save :size="16" aria-hidden="true" />保存草稿
        </button>
        <button
          type="submit"
          class="primary"
          :disabled="busy || uncertain"
          @click="createStatus = 'published'"
        >
          <Plus :size="16" aria-hidden="true" />{{ busy ? "正在创建…" : "创建并发布" }}
        </button>
      </div>
      <aside v-if="preview" class="assignment-preview" aria-label="学生视图预览">
        <p class="course-notice">学生视图预览 · 尚未发布，学生不能访问。</p>
        <CourseTaskBrief :task="taskInput" heading />
      </aside>
    </form>
    <section v-if="!loading && enabled" class="assignment-collection" aria-labelledby="assignment-list-title">
      <div class="assignment-list-heading"><h2 id="assignment-list-title">作业列表 <span class="assignment-count">{{ assignments.length }}</span></h2><span v-if="assignments.length" class="muted">已加载 {{ assignments.length }} 项</span></div>
      <div v-if="assignments.length" class="assignment-toolbar">
        <StudioSearch v-model="search" label="搜索作业或班级" />
        <label class="assignment-class-filter"><span class="gl-sr-only">筛选班级</span><select v-model="classFilter" aria-label="筛选班级"><option value="">全部班级</option><option v-for="c in classes" :key="c.id" :value="c.id">{{ c.name }}</option></select></label>
        <div class="assignment-status-filter" role="group" aria-label="作业状态"><button v-for="[value,label] in [['all','全部'],['published','已发布'],...(teacher ? [['draft','草稿']] : [])]" :key="value" type="button" :aria-pressed="statusFilter === value" @click="statusFilter = value">{{ label }}</button></div>
      </div>
      <div class="course-list">
      <div v-if="!assignments.length && !error" class="assignment-empty">
        <ClipboardList :size="32" aria-hidden="true" />
        <p>
        {{
          teacher
            ? "还没有新作业，点击“创建作业”开始。"
            : "暂时没有已发布作业，请等待教师发布。"
        }}
        </p>
      </div>
      <div v-else-if="assignments.length && !visibleAssignments.length" class="assignment-empty" role="status"><SearchX :size="30" aria-hidden="true" /><h3>没有匹配的作业</h3><button type="button" @click="clearFilters">清除筛选</button></div>
      <RouterLink
        v-for="a in visibleAssignments"
        :key="a.id"
        :to="`/assignments/${a.id}`"
        class="course-row assignment-row"
        ><div>
          <span class="assignment-meta"
            ><Users :size="14" aria-hidden="true" />{{ a.class_name }} ·
            {{ a.subject_mode === "team" ? "团队" : "个人" }}</span
          >
          <h2>{{ a.title }}</h2>
          <p class="assignment-progress">
            {{ teacher ? "本班进度" : "我的进度" }}：{{
              a.progress.submitted
            }}
            / {{ a.progress.expected }} 份任务成果已交 ·
            {{ a.progress.reviewed }} 份已评价
          </p>
          <p v-if="a.pendingDueAt" class="assignment-due">
            <CalendarClock :size="15" aria-hidden="true" />待交任务最早截止：{{ courseTime(a.pendingDueAt) }}（北京时间）
          </p>
          <p v-else class="muted">
            {{
              a.progress.submitted < a.progress.expected
                ? "待交任务暂未设置截止"
                : a.progress.expected
                  ? "全部任务成果已交，可进入查看评价"
                  : "等待确认团队成员"
            }}
          </p>
        </div>
        <span class="assignment-row-end"><span class="assignment-status" :class="{ 'is-draft': a.status === 'draft' }">{{ a.status === "draft" ? "草稿" : "已发布" }}</span><span>{{ a.task_count }} 个子任务</span><ArrowUpRight :size="19" aria-hidden="true" /></span></RouterLink
      >
      </div>
    </section>
    <details v-if="legacy.length" class="assignment-legacy">
      <summary>历史项目任务（{{ legacy.length }}）</summary>
      <p class="muted">来自实训任务的项目记录，保留原提交、评价与共享范围；历史快照信息可能不完整。</p>
      <RouterLink
        v-for="a in legacy"
        :key="a.id"
        class="course-row"
        :to="`/tasks/${a.id}`"
        >{{ a.class_name }} / {{ a.title }} →</RouterLink
      >
    </details>
  </section>
</template>
