<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useRoute } from "vue-router";
import { api, useSession } from "../api";
import { createCourseworkApi } from '../lib/coursework-api';
import CourseworkWriteRecovery from '../components/CourseworkWriteRecovery.vue';
import CourseTaskOptions from "../components/CourseTaskOptions.vue";
import { courseDeadline } from "../coursework-time";
const route = useRoute(),
  session = useSession(),
  teacher = computed(() => session.user?.role === "teacher"),
  id = String(route.params.id);
const writes = createCourseworkApi(`${session.user?.id}/assignments/${id}`);
const { request: apiV2, uncertain, checking, checked } = writes;
let alive = true;
onUnmounted(() => { alive = false; writes.dispose(); });
async function reconcileWrite() {
  error.value = '';
  try { await writes.reconcile(load); } catch (e) { if (alive) error.value = (e as Error).message; }
}
function resumeWrites() { writes.resume(); error.value = ''; }
const data = ref<any>(null),
  error = ref(""),
  busy = ref(false),
  students = ref<any[]>([]),
  teamName = ref(""),
  selected = ref<string[]>([]),
  submitter = ref("");
const taskForm = ref({
  title: "",
  description: "",
  requirements: "",
  dueAt: "",
  predecessorTaskId: "",
  allowCode: !session.teacherTrial,
  allowedSources: session.teacherTrial ? ["snippet", "files", "zip"] : ["snippet", "files", "zip", "gitee", "github"],
  requiredPaths: [] as string[],
  scope: [] as string[],
  starter: "",
});
async function load() {
  try {
    const result = await apiV2(`/assignments/${id}`);
    if (!alive) return false;
    data.value = result;
    if (teacher.value) {
      const r = await api(
        `/classes/${data.value.assignment.class_id}/students`,
      );
      if (alive) students.value = r.items ?? [];
    }
    return alive;
  } catch (e) {
    if (alive) error.value = (e as Error).message;
    return false;
  }
}
async function act(action: () => Promise<unknown>) {
  if (busy.value || uncertain.value) return;
  busy.value = true;
  error.value = "";
  try {
    await action();
    if (alive) await load();
  } catch (e) {
    if (alive) error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
async function addTask() {
  await act(async () => {
    const f = taskForm.value;
    await apiV2(`/assignments/${id}/tasks`, {
      method: "POST",
      body: JSON.stringify({
        title: f.title,
        description: f.description,
        requirements: f.requirements
          .split("\n")
          .filter((x) => x.trim())
          .map((title, i) => ({ id: `R${i + 1}`, title })),
        dueAt: courseDeadline(f.dueAt),
        predecessorTaskId: f.predecessorTaskId || null,
        allowCode: f.allowCode,
        allowedSources: f.allowedSources,
        requiredPaths: f.requiredPaths,
        scope: f.scope,
        starter: f.starter,
      }),
    });
    f.title = "";
    f.description = "";
    f.requirements = "";
  });
}
async function addTeam() {
  await act(() =>
    apiV2(`/assignments/${id}/teams`, {
      method: "POST",
      body: JSON.stringify({
        name: teamName.value,
        members: selected.value.map((userId) => ({
          userId,
          role: userId === submitter.value ? "submitter" : "member",
        })),
      }),
    }),
  );
}
onMounted(load);
</script>
<template>
  <section class="course-page course-assignment-detail">
    <RouterLink to="/assignments">← 课程作业</RouterLink>
    <p v-if="error" role="alert" class="error">
      {{ error }} <button @click="load">重试</button>
    </p>
    <CourseworkWriteRecovery v-if="uncertain" :busy="busy" :checking="checking" :checked="checked" @check="reconcileWrite" @resume="resumeWrites" />
    <template v-if="data"
      ><header class="course-heading">
        <div>
          <p class="eyebrow">
            {{ data.assignment.class_name }} /
            {{
              data.assignment.subject_mode === "team" ? "团队作业" : "个人作业"
            }}
          </p>
          <h1>{{ data.assignment.title }}</h1>
        </div>
        <button
          v-if="teacher && data.assignment.status === 'draft'"
          :disabled="busy || uncertain"
          @click="
            act(() => apiV2(`/assignments/${id}/publish`, { method: 'POST' }))
          "
        >
          发布作业
        </button>
      </header>
      <div class="course-list">
        <RouterLink
          v-for="(t, index) in data.tasks"
          :key="t.task_id"
          :to="`/course-tasks/${t.task_id}`"
          class="course-row"
          ><div>
            <p class="eyebrow">
              T{{ index + 1 }} ·
              {{ t.config.predecessorTaskId ? "连续任务" : "独立任务" }} · 修订
              {{ t.revision_sequence }}
            </p>
            <h2>{{ t.config.title }}</h2>
            <p>{{ t.config.description }}</p>
            <p class="muted">
              {{ teacher ? "提交主体" : "我的进度" }}：{{
                t.progress.submitted
              }}
              / {{ t.progress.expected }} 已提交 ·
              {{ t.progress.reviewed }} 已发布评价
            </p>
          </div>
          <span>打开任务 →</span></RouterLink
        >
      </div>
      <details v-if="teacher" class="course-panel">
        <summary>添加子任务</summary>
        <form class="course-form" @submit.prevent="addTask">
          <label>任务名称<input v-model="taskForm.title" required /></label
          ><label
            >目标与说明<textarea
              v-model="taskForm.description"
              required
            /></label
          ><label
            >评价标准（每行一条）<textarea
              v-model="taskForm.requirements"
              required
            /></label
          ><label
            >前置任务<select v-model="taskForm.predecessorTaskId">
              <option value="">独立开始</option>
              <option
                v-for="t in data.tasks"
                :key="t.task_id"
                :value="t.task_id"
              >
                {{ t.config.title }}
              </option>
            </select></label
          ><label
            >截止时间（北京时间）<input
              v-model="taskForm.dueAt"
              type="datetime-local" /></label
          ><CourseTaskOptions v-model="taskForm" :local-only="session.teacherTrial" /><label v-if="!session.teacherTrial" class="course-check"
            ><input
              v-model="taskForm.allowCode"
              type="checkbox"
            />允许请求辅助代码</label
          ><button :disabled="busy || uncertain" class="primary">添加子任务</button>
        </form>
      </details>
      <section
        v-if="data.assignment.subject_mode === 'team'"
        class="course-panel"
      >
        <h2>团队与提交权限</h2>
        <p class="muted">
          成员须确认加入；指定提交人提交，个人自查对其他成员和教师均不可见。
        </p>
        <article v-for="s in data.subjects" :key="s.id" class="course-team">
          <h3>{{ s.name }}</h3>
          <p v-for="m in s.members" :key="m.userId">
            {{ m.name }} ·
            {{ m.role === "submitter" ? "指定提交人" : "成员" }} ·
            {{
              m.status === "active"
                ? "已加入"
                : m.status === "invited"
                  ? "待确认"
                  : "已离队"
            }}
            <button
              v-if="m.userId === session.user?.id && m.status === 'invited'"
              :disabled="busy || uncertain"
              @click="
                act(() =>
                  apiV2(`/course-teams/${s.id}/accept`, { method: 'POST' }),
                )
              "
            >
              确认加入
            </button>
            <button
              v-if="teacher && m.status !== 'left'"
              :disabled="busy || uncertain"
              @click="
                act(() =>
                  apiV2(`/course-teams/${s.id}/members/${m.userId}`, {
                    method: 'POST',
                    body: JSON.stringify({ role: m.role, status: 'left' }),
                  }),
                )
              "
            >
              移出团队
            </button>
          </p>
        </article>
        <form v-if="teacher" class="course-form" @submit.prevent="addTeam">
          <h3>邀请团队成员</h3>
          <label>团队名<input v-model="teamName" required /></label
          ><label v-for="s in students" :key="s.id" class="course-check"
            ><input v-model="selected" type="checkbox" :value="s.id" />{{
              s.name
            }}（{{ s.email }}）</label
          ><label
            >指定提交人<select v-model="submitter" required>
              <option value="">选择已勾选成员</option>
              <option
                v-for="s in students.filter((s) => selected.includes(s.id))"
                :key="s.id"
                :value="s.id"
              >
                {{ s.name }}
              </option>
            </select></label
          ><button :disabled="busy || uncertain" class="primary">发送团队邀请</button>
        </form>
      </section></template
    >
    <p v-else-if="!error" role="status">正在读取作业…</p>
  </section>
</template>
