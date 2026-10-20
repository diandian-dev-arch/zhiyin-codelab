<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useSession } from "../api";
import { createCourseworkApi } from '../lib/coursework-api';
import CourseworkWriteRecovery from '../components/CourseworkWriteRecovery.vue';
import CourseReport from "../components/CourseReport.vue";
import CourseTaskOptions from "../components/CourseTaskOptions.vue";
import CourseTaskBrief from "../components/CourseTaskBrief.vue";
import SourceEvidenceReader from "../components/SourceEvidenceReader.vue";
import type { SourceCitation } from "../lib/source-evidence";
import { courseDeadline } from "../coursework-time";
const route = useRoute(),
  router = useRouter(),
  session = useSession(),
  id = String(route.params.id),
  teacher = computed(() => session.user?.role === "teacher");
const writes = createCourseworkApi(`${session.user?.id}/course-tasks/${id}`);
const { request: apiV2, uncertain, checking, checked } = writes;
async function reconcileWrite() {
  error.value = '';
  try {
    await writes.reconcile(async () => {
      await load();
      if (check.value) {
        const current = await apiV2(`/self-checks/${check.value.check.id}`);
        if (alive) check.value = current;
      }
    });
  } catch (e) { if (alive) error.value = (e as Error).message; }
}
function resumeWrites() { writes.resume(); error.value = ''; }
const data = ref<any>(null),
  error = ref(""),
  message = ref(""),
  busy = ref(false),
  imports = ref<any[]>([]),
  checks = ref<any[]>([]),
  check = ref<any>(null),
  snapshot = ref<any>(null),
  recipient = ref<any>(null),
  connections = ref<any[]>([]),
  identities = ref<any[]>([]);
const sourceReader = ref<InstanceType<typeof SourceEvidenceReader>>(),
  readingSnapshotId = ref("");
const loadEvidence = (
  citation: SourceCitation,
  _full: boolean,
  signal: AbortSignal,
) =>
  apiV2(
    `/snapshots/${readingSnapshotId.value}/source?path=${encodeURIComponent(citation.path)}`,
    { signal },
  );
const inputType = ref("snippet"),
  filename = ref("solution.ts"),
  code = ref(""),
  uploaded = ref<{ path: string; content: string }[]>([]),
  zip = ref(""),
  subjectId = ref(""),
  baseline = ref(""),
  note = ref(""),
  confirmed = ref(false),
  modelConsent = ref(false),
  helpConsent = ref(false),
  question = ref("");
// Each confirmation applies only to the code and recipient shown beside it.
watch(
  [() => snapshot.value?.id, () => recipient.value?.hash],
  () => {
    modelConsent.value = false;
  },
  { flush: "sync" },
);
watch(
  [() => check.value?.check.id, () => recipient.value?.hash],
  () => {
    helpConsent.value = false;
  },
  { flush: "sync" },
);
const repository = ref({
  provider: "gitee",
  owner: "",
  name: "",
  ref: "main",
  connectionId: "",
});
const connection = ref({
  provider: "gitee",
  label: "",
  token: "",
  confirmed: false,
});
const edit = ref<any>(null),
  grant = ref({ subjectId: "", opensAt: "", closesAt: "", reason: "" }),
  showHistory = ref(false);
let alive = true,
  timer: ReturnType<typeof setTimeout> | undefined,
  submitKey = crypto.randomUUID(),
  submitBody = "";
const activeSubject = computed(() =>
  data.value?.subjects.find((s: any) => s.id === subjectId.value),
);
const canSubmit = computed(
  () =>
    !!activeSubject.value &&
    (activeSubject.value.user_id === session.user?.id ||
      activeSubject.value.members.some(
        (m: any) =>
          m.userId === session.user?.id &&
          m.status === "active" &&
          m.role === "submitter",
      )),
);
const visibleSubmissions = computed(
  () =>
    data.value?.submissions.filter((s: any) => showHistory.value || s.latest) ??
    [],
);
const selectedBase = computed(
  () =>
    data.value?.baselineOptions.filter(
      (s: any) => s.subject_id === subjectId.value,
    ) ?? [],
);
const fmt = (v: string) =>
  v
    ? new Date(v).toLocaleString("zh-CN", {
        timeZone: "Asia/Shanghai",
        hour12: false,
      })
    : "不设截止";
const statuses: Record<string, string> = {
  created: "等待导入",
  fetching: "正在读取仓库",
  validating: "正在校验",
  ready: "快照已保存",
  failed: "失败",
  cancelled: "已取消",
  queued: "等待分析",
  running: "正在分析",
  succeeded: "分析完成",
};
async function load() {
  const result = await apiV2(`/course-tasks/${id}`);
  if (!alive) return;
  data.value = result;
  if (!result.task.config.allowedSources.includes(inputType.value))
    inputType.value = result.task.config.allowedSources[0];
  subjectId.value ||=
    result.subjects.find(
      (s: any) =>
        s.user_id === session.user?.id ||
        s.members.some(
          (m: any) => m.userId === session.user?.id && m.status === "active",
        ),
    )?.id ?? "";
  if (!teacher.value) {
    const [i, c, r, conn, identity] = await Promise.all([
      apiV2(`/course-tasks/${id}/imports`),
      session.teacherTrial ? Promise.resolve({ items: [] }) : apiV2(`/course-tasks/${id}/self-checks`),
      session.teacherTrial ? Promise.resolve({ recipient: null }) : apiV2("/course-model-recipient"),
      session.teacherTrial ? Promise.resolve({ items: [] }) : apiV2("/repository-connections"),
      session.teacherTrial ? Promise.resolve({ items: [] }) : apiV2("/repository-identities"),
    ]);
    if (!alive) return;
    imports.value = i.items;
    checks.value = c.items;
    recipient.value = r.recipient;
    connections.value = conn.items;
    identities.value = identity.items;
  }
}
async function act(fn: () => Promise<unknown>) {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  message.value = "";
  try {
    await fn();
    if (alive) await load();
  } catch (e) {
    if (alive) {
      error.value = (e as Error).message;
      if (uncertain.value) { modelConsent.value = false; helpConsent.value = false; confirmed.value = false; }
    }
  } finally {
    if (alive) busy.value = false;
  }
}
async function poll() {
  try {
    if (!busy.value) {
      await load();
      if (check.value) {
        const r = await apiV2(`/self-checks/${check.value.check.id}`);
        if (alive) check.value = r;
      }
    }
  } catch {
    /* Explicit reads expose errors; polling keeps already read content. */
  } finally {
    if (alive) timer = setTimeout(poll, 4000);
  }
}
async function readUpload(event: Event) {
  const files = Array.from((event.target as HTMLInputElement).files ?? []);
  error.value = "";
  try {
    if (inputType.value === "zip") {
      const file = files[0];
      if (!file) return;
      if (file.size > 8 * 1024 * 1024)
        throw new Error("此入口 ZIP 最大 8 MB，请缩小材料");
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (let i = 0; i < bytes.length; i += 8192)
        binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      zip.value = btoa(binary);
      uploaded.value = [];
    } else {
      if (
        files.length > 200 ||
        files.reduce((n, f) => n + f.size, 0) > 4 * 1024 * 1024
      )
        throw new Error("最多 200 个文件，总量 4 MB");
      uploaded.value = await Promise.all(
        files.map(async (f) => ({
          path: f.webkitRelativePath || f.name,
          content: new TextDecoder("utf-8", { fatal: true }).decode(
            await f.arrayBuffer(),
          ),
        })),
      );
      zip.value = "";
    }
  } catch (e) {
    error.value = (e as Error).message;
  }
}
async function prepare() {
  await act(async () => {
    let body: any = { taskId: id, type: inputType.value };
    if (inputType.value === "snippet")
      body.files = [{ path: filename.value, content: code.value }];
    else if (inputType.value === "files") body.files = uploaded.value;
    else if (inputType.value === "zip") body.zipBase64 = zip.value;
    else {
      body.repository = { ...repository.value, provider: inputType.value };
      if (!body.repository.connectionId) delete body.repository.connectionId;
    }
    const r = await apiV2("/imports", {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (r.snapshot_id) await selectSnapshot(r.snapshot_id);
    message.value =
      r.status === "ready"
        ? "快照已保存，尚未正式提交。"
        : "仓库正在导入；可在下面查询进度。";
  });
}
async function selectSnapshot(snapshotId: string) {
  const r = await apiV2(`/snapshots/${snapshotId}`);
  if (!alive) return;
  snapshot.value = r;
  confirmed.value = false;
  sourceReader.value?.close(false);
}
async function readSource(
  path: string,
  start?: number,
  end?: number,
  snapshotId = snapshot.value?.id,
) {
  if (!snapshotId || !alive) return;
  readingSnapshotId.value = snapshotId;
  // Let the reader discard a previous identity before opening the next fixed snapshot.
  await nextTick();
  if (start)
    await sourceReader.value?.openCitation({ path, start, end: end ?? start });
  else await sourceReader.value?.openFile(path);
}
async function submit() {
  if (uncertain.value) return;
  await act(async () => {
    const body = JSON.stringify({
      subjectId: subjectId.value,
      snapshotId: snapshot.value.id,
      taskRevisionId: data.value.task.current_revision_id,
      baseSubmissionId: baseline.value || null,
      note: note.value,
    });
    if (submitBody !== body) {
      submitKey = crypto.randomUUID();
      submitBody = body;
    }
    const r = await apiV2(`/course-tasks/${id}/submissions`, {
      method: "POST",
      headers: { "idempotency-key": submitKey },
      body,
    });
    if (alive) await router.push(`/course-submissions/${r.submission.id}`);
  });
}
async function startCheck() {
  await act(async () => {
    const r = await apiV2(`/course-tasks/${id}/self-checks`, {
      method: "POST",
      body: JSON.stringify({
        snapshotId: snapshot.value.id,
        recipientHash: recipient.value.hash,
        confirmed: modelConsent.value,
      }),
    });
    const next = await apiV2(`/self-checks/${r.id}`);
    if (alive) check.value = next;
  });
}
async function help(level: number) {
  await act(() =>
    apiV2(`/self-checks/${check.value.check.id}/messages`, {
      method: "POST",
      body: JSON.stringify({
        level,
        question: question.value,
        recipientHash: recipient.value.hash,
        confirmed: helpConsent.value,
      }),
    }),
  );
}
async function saveConnection() {
  await act(async () => {
    await apiV2("/repository-connections", {
      method: "POST",
      body: JSON.stringify(connection.value),
    });
    connection.value.token = "";
    message.value = "仓库授权已加密保存，可在来源中选择。";
  });
}
async function revise() {
  await act(async () => {
    await apiV2(`/course-tasks/${id}/revisions`, {
      method: "POST",
      body: JSON.stringify(edit.value),
    });
    edit.value = null;
    message.value = "新修订已保存，已提交版本仍绑定原要求。";
  });
}
async function openGrant() {
  await act(() =>
    apiV2(`/course-tasks/${id}/late-grants`, {
      method: "POST",
      body: JSON.stringify({
        ...grant.value,
        opensAt: courseDeadline(grant.value.opensAt),
        closesAt: courseDeadline(grant.value.closesAt),
      }),
    }),
  );
}
onMounted(async () => {
  try {
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  }
  if (alive) timer = setTimeout(poll, 4000);
});
onUnmounted(() => {
  alive = false;
  writes.dispose();
  clearTimeout(timer);
});
</script>
<template>
  <section class="course-page">
    <SourceEvidenceReader
      ref="sourceReader"
      :identity="`${id}/${readingSnapshotId}`"
      :version-label="`固定快照 ${readingSnapshotId}`"
      :load-source="loadEvidence"
    >
      <p v-if="error" role="alert" class="error">
        {{ error }} <button @click="act(load)">重新读取</button>
      </p>
      <p v-if="message" role="status" class="course-notice">{{ message }}</p>
      <CourseworkWriteRecovery v-if="uncertain" :busy="busy" :checking="checking" :checked="checked" @check="reconcileWrite" @resume="resumeWrites" />
      <template v-if="data"
        ><RouterLink :to="`/assignments/${data.task.assignment_id}`"
          >← {{ data.task.assignment.title }}</RouterLink
        >
        <header class="course-heading">
          <div>
            <p class="eyebrow">
              {{ data.task.assignment.class_name }} /
              {{ data.task.assignment.title }} / 修订
              {{ data.task.revision_sequence }}
            </p>
            <h1>{{ data.task.config.title }}</h1>
            <p>{{ data.task.config.description }}</p>
          </div>
          <div class="course-stamp">
            截止 {{ fmt(data.task.config.dueAt) }}<template v-if="!session.teacherTrial"><br />{{
              data.task.config.allowCode
                ? "允许主动请求辅助代码"
                : "辅助代码已关闭"
            }}</template>
          </div>
        </header>
        <CourseTaskBrief :task="data.task.config" :local-only="session.teacherTrial" />
        <template v-if="!teacher"
          ><section class="course-panel course-form">
            <h2>准备本次成果</h2>
            <label
              >提交主体<select v-model="subjectId">
                <option value="">选择个人或已加入的团队</option>
                <option v-for="s in data.subjects" :key="s.id" :value="s.id">
                  {{ s.name }}
                </option>
              </select></label
            >
            <p v-if="!canSubmit" class="course-notice">
              请先在作业页确认团队邀请；只有指定提交人可以正式提交。
            </p>
            <label
              >{{
                data.task.config.predecessorTaskId
                  ? "固定前置基线"
                  : "贡献比较起点（可选）"
              }}<select v-model="baseline">
                <option value="">
                  {{
                    data.task.config.predecessorTaskId
                      ? "选择前置任务的成功提交"
                      : "不分析 Git 贡献区间"
                  }}
                </option>
                <option v-for="b in selectedBase" :key="b.id" :value="b.id">
                  版本 {{ b.sequence }} · {{ fmt(b.accepted_at) }} ·
                  {{ b.id.slice(0, 8) }}
                </option>
              </select></label
            >
            <p v-if="baseline">
              <a :href="`/api/v2/course-submissions/${baseline}/download`"
                >下载所选固定基线 ZIP</a
              >
              ·
              <RouterLink :to="`/course-submissions/${baseline}`"
                >查看基线源码与回执</RouterLink
              >
            </p>
            <label
              >成果来源<select
                v-model="inputType"
                @change="
                  snapshot = null;
                  confirmed = false;
                  uploaded = [];
                  zip = '';
                "
              >
                <option
                  v-for="type in data.task.config.allowedSources"
                  :key="type"
                  :value="type"
                >
                  {{
                    (
                      {
                        snippet: "代码片段",
                        files: "文件 / 多文件",
                        zip: "ZIP 压缩包",
                        gitee: "Gitee 仓库",
                        github: "GitHub 仓库",
                      } as any
                    )[type]
                  }}
                </option>
              </select></label
            >
            <template v-if="inputType === 'snippet'"
              ><label
                >文件路径<input
                  v-model="filename"
                  placeholder="src/search.ts" /></label
              ><label
                >一次性粘贴代码<textarea
                  v-model="code"
                  rows="9"
                  class="course-code"
                  spellcheck="false"
                /></label
            ></template>
            <template v-else-if="inputType === 'files' || inputType === 'zip'"
              ><label
                >{{
                  inputType === "zip"
                    ? "选择 ZIP（8 MB 内）"
                    : "选择文件（UTF-8 文本，总计 4 MB 内）"
                }}<input
                  :key="inputType"
                  type="file"
                  :multiple="inputType === 'files'"
                  :accept="inputType === 'zip' ? '.zip' : undefined"
                  @change="readUpload"
              /></label>
              <p v-if="uploaded.length">已选择 {{ uploaded.length }} 个文件</p>
              <label v-if="inputType === 'files'"
                >或选择文件夹（保留相对目录）<input
                  type="file"
                  webkitdirectory
                  multiple
                  @change="readUpload"
              /></label>
              <p v-if="zip">ZIP 已就绪</p></template
            >
            <template v-else
              ><label
                >仓库所属用户或组织<input
                  v-model="repository.owner"
                  placeholder="owner" /></label
              ><label
                >仓库名<input
                  v-model="repository.name"
                  placeholder="student-project" /></label
              ><label
                >分支、标签或完整提交标识<input
                  v-model="repository.ref" /></label
              ><label
                >读取授权<select v-model="repository.connectionId">
                  <option value="">公开仓库，无令牌</option>
                  <option
                    v-for="c in connections.filter(
                      (c) => c.provider === inputType && !c.revoked_at,
                    )"
                    :key="c.id"
                    :value="c.id"
                  >
                    {{ c.label }}
                  </option>
                </select></label
              >
              <p class="muted">
                首次解析后固定完整提交，重试不跟随新分支头。不会执行仓库代码、hooks、子模块或
                LFS。
              </p></template
            >
            <button :disabled="busy || uncertain" @click="prepare">
              {{ busy ? "处理中…" : "准备固定快照" }}
            </button>
          </section>
          <details v-if="!session.teacherTrial" class="course-panel">
            <summary>仓库读取授权（与模型外发授权分开）</summary>
            <form class="course-form" @submit.prevent="saveConnection">
              <label
                >托管平台<select v-model="connection.provider">
                  <option value="gitee">Gitee</option>
                  <option value="github">GitHub</option>
                </select></label
              ><label
                >授权名称<input v-model="connection.label" required /></label
              ><label
                >只读访问令牌<input
                  v-model="connection.token"
                  type="password"
                  autocomplete="off"
                  required /></label
              ><label class="course-check"
                ><input
                  v-model="connection.confirmed"
                  type="checkbox"
                  required
                />我有权读取此仓库，使用最小只读权限。撤销只停止未来读取，已交成果仍保留。</label
              ><button :disabled="busy || uncertain">加密保存读取授权</button>
            </form>
            <p v-for="c in connections" :key="c.id">
              {{ c.provider }} / {{ c.label }} ·
              {{ c.revoked_at ? "已断开" : "有效" }}
              <button
                v-if="!c.revoked_at"
                :disabled="busy || uncertain"
                @click="
                  act(() =>
                    apiV2(`/repository-connections/${c.id}/verify`, {
                      method: 'POST',
                    }),
                  )
                "
              >
                核验本人托管平台账号
              </button>
              <button
                v-if="!c.revoked_at"
                :disabled="busy || uncertain"
                @click="
                  act(() =>
                    apiV2(`/repository-connections/${c.id}/revoke`, {
                      method: 'POST',
                    }),
                  )
                "
              >
                断开
              </button>
            </p>
          </details>
          <p v-for="identity in identities" :key="identity.provider">
            {{ identity.provider }}：{{ identity.login }}（{{
              identity.revoked_at
                ? "授权已断开，未来提交不再采用"
                : "账号已核验；提交时固定映射"
            }}）
          </p>
          <section v-if="imports.length" class="course-panel">
            <h2>本任务导入记录</h2>
            <div v-for="i in imports" :key="i.id" class="course-row">
              <span
                >{{ i.source_type }} · {{ statuses[i.status] }}
                <code>{{ i.resolved_commit?.slice(0, 12) }}</code
                ><span v-if="i.failure_code">
                  · {{ i.failure_code }}</span
                ></span
              ><button
                v-if="i.snapshot_id"
                :disabled="busy"
                @click="act(() => selectSnapshot(i.snapshot_id))"
              >
                选择此快照</button
              ><button
                v-if="
                  i.status === 'failed' &&
                  ['gitee', 'github'].includes(i.source_type)
                "
                :disabled="busy || uncertain"
                @click="
                  act(() => apiV2(`/imports/${i.id}/retry`, { method: 'POST' }))
                "
              >
                按原版本重试</button
              ><button
                v-if="['created', 'fetching'].includes(i.status)"
                :disabled="busy || uncertain"
                @click="
                  act(() =>
                    apiV2(`/imports/${i.id}/cancel`, { method: 'POST' }),
                  )
                "
              >
                取消
              </button>
            </div>
          </section>
          <section v-if="snapshot" class="course-panel course-form">
            <h2>已保存的固定快照</h2>
            <p class="course-code">{{ snapshot.hash }}</p>
            <p v-if="snapshot.source.commit">
              {{ snapshot.source.provider }} / {{ snapshot.source.owner }} /
              {{ snapshot.source.name }} / {{ snapshot.source.commit }}
            </p>
            <div>
              <button
                v-for="f in snapshot.manifest"
                :key="f.path"
                :disabled="busy"
                @click="act(() => readSource(f.path))"
              >
                {{ f.path }} · {{ f.bytes }} B
              </button>
            </div>
            <details v-if="snapshot.omitted.length">
              <summary>排除项 {{ snapshot.omitted.length }}</summary>
              <p v-for="o in snapshot.omitted" :key="o.path">
                {{ o.path }}：{{ o.reason }}
              </p>
            </details>
            <label>本次说明<textarea v-model="note" maxlength="2000" /></label
            ><label class="course-check"
              ><input v-model="confirmed" type="checkbox" />确认提交到
              {{ data.task.assignment.title }} / {{ data.task.config.title }} /
              {{
                activeSubject?.name || "请选择主体"
              }}。本次提交仅主体和授课教师可读。</label
            ><button
              class="primary"
              :disabled="
                busy ||
                uncertain ||
                !confirmed ||
                !canSubmit ||
                (!!data.task.config.predecessorTaskId && !baseline)
              "
              @click="submit"
            >
              确认正式提交
            </button>
            <template v-if="!session.teacherTrial">
            <hr />
            <h3>先做私人自查（可选）</h3>
            <p>
              自查不自动交作业，教师和队友不能读取。自查使用你本人的模型配置。
            </p>
            <template v-if="recipient"
              ><p>
                接收方：{{ recipient.provider }} / {{ recipient.model }} /
                {{ recipient.endpoint }}
              </p>
              <label class="course-check"
                ><input
                  v-model="modelConsent"
                  type="checkbox"
                />同意向上述模型发送当前快照范围内源码，用于本人的教学辅导。已发送内容无法通过撤销收回。</label
              ><button :disabled="busy || uncertain || !modelConsent" @click="startCheck">
                开始 L1 问题与解释
              </button></template
            >
            <p v-else>
              尚未配置本人模型，仍可正式提交。<RouterLink to="/settings"
                >前往模型设置</RouterLink
              >
            </p>
            </template>
          </section>
          <section v-if="!session.teacherTrial && checks.length" class="course-panel">
            <h2>仅你可见的自查</h2>
            <button
              v-for="c in checks"
              :key="c.id"
              :disabled="busy"
              @click="
                act(async () => {
                  check = await apiV2(`/self-checks/${c.id}`);
                })
              "
            >
              {{ fmt(c.created_at) }} · {{ c.snapshot_id.slice(0, 8) }}
            </button>
          </section>
          <section v-if="!session.teacherTrial && check" class="course-panel">
            <h2>私人自查 · 快照 {{ check.check.snapshot_id.slice(0, 8) }}</h2>
            <article v-for="m in check.messages" :key="m.id">
              <h3>L{{ m.level }} · {{ statuses[m.status] }}</h3>
              <p v-if="m.failure_code" class="error">
                {{
                  m.failure_code
                }}。成果和正式提交仍保留，可调整材料后重新发起。
              </p>
              <p class="muted">
                计费人：本人 · {{ m.model_config.model }} ·
                {{
                  m.usage
                    ? `输入 ${m.usage.inputTokens} / 输出 ${m.usage.outputTokens} Token`
                    : "实际用量尚未返回"
                }}
              </p>
              <CourseReport
                v-if="m.report"
                :report="m.report"
                @evidence="
                  (path, start, end) =>
                    readSource(path, start, end, check.check.snapshot_id)
                "
              /><button
                v-if="['queued', 'running'].includes(m.status)"
                :disabled="busy || uncertain"
                @click="
                  act(() =>
                    apiV2(`/course-analyses/${m.id}/cancel`, {
                      method: 'POST',
                    }),
                  )
                "
              >
                取消分析
              </button>
            </article>
            <label
              >想继续了解的问题<textarea v-model="question" maxlength="2000" />
            </label>
            <p v-if="recipient">
              后续请求只发送此自查绑定的快照
              {{ check.check.snapshot_id }}，不使用上方待提交的新快照。
              接收方：{{ recipient.provider }} / {{ recipient.model }} /
              {{ recipient.endpoint }}。
            </p>
            <label v-if="recipient" class="course-check"
              ><input
                v-model="helpConsent"
                type="checkbox"
              />同意向上述接收方发送此自查快照，用于本次进一步辅导；使用本人的模型配置，已发送内容无法收回。</label
            >
            <button
              :disabled="busy || uncertain || !helpConsent || !recipient"
              @click="help(2)"
            >
              请求 L2 思路与验证提示</button
            ><button
              :disabled="
                busy ||
                uncertain ||
                !helpConsent ||
                !recipient ||
                !data.task.config.allowCode
              "
              @click="help(3)"
            >
              主动请求 L3 辅助代码
            </button>
          </section>
        </template>
        <section class="course-panel">
          <header class="course-heading">
            <h2>{{ teacher ? "最新有效提交队列" : "正式提交与评价" }}</h2>
            <label class="course-check"
              ><input
                v-model="showHistory"
                type="checkbox"
              />显示历史版本</label
            >
          </header>
          <p v-if="!data.submissions.length">尚无正式提交。</p>
          <RouterLink
            v-for="s in visibleSubmissions"
            :key="s.id"
            class="course-row"
            :to="`/course-submissions/${s.id}`"
            ><div>
              <strong>{{ s.subject_name }} · V{{ s.sequence }}</strong
              ><span v-if="s.late_grant_id"> · 补交</span
              ><span v-if="s.latest"> · 最新有效版</span>
              <p>{{ s.submitted_name }} 提交于 {{ fmt(s.accepted_at) }}</p>
            </div>
            <span
              >{{
                s.evaluations.some((e: any) => e.status === "published")
                  ? "评价已发布"
                  : "待评价"
              }}
              →</span
            ></RouterLink
          >
        </section>
        <template v-if="teacher"
          ><details class="course-panel">
            <summary>修订任务要求与辅导政策</summary>
            <button
              @click="edit = JSON.parse(JSON.stringify(data.task.config))"
            >
              载入当前要求
            </button>
            <form v-if="edit" class="course-form" @submit.prevent="revise">
              <label>标题<input v-model="edit.title" required /></label
              ><label
                >说明<textarea v-model="edit.description" required /></label
              ><label v-for="r in edit.requirements" :key="r.id"
                >{{ r.id }}<input v-model="r.title" required /></label
              ><label
                >截止时间（ISO 时间，留空为不设截止）<input
                  :value="edit.dueAt ?? ''"
                  @input="
                    edit.dueAt =
                      ($event.target as HTMLInputElement).value || null
                  " /></label
              ><CourseTaskOptions v-model="edit" :local-only="session.teacherTrial" /><label v-if="!session.teacherTrial" class="course-check"
                ><input
                  v-model="edit.allowCode"
                  type="checkbox"
                />允许辅助代码</label
              ><button class="primary" :disabled="busy || uncertain">保存为新修订</button>
            </form>
          </details>
          <details class="course-panel">
            <summary>指定对象限时补交</summary>
            <p class="muted">
              以下时间均为北京时间，成功接受时间须严格早于补交截止。
            </p>
            <form class="course-form" @submit.prevent="openGrant">
              <label
                >提交主体<select v-model="grant.subjectId" required>
                  <option value="">选择个人或团队</option>
                  <option v-for="s in data.subjects" :key="s.id" :value="s.id">
                    {{ s.name }}
                  </option>
                </select></label
              ><label
                >开放时间<input
                  v-model="grant.opensAt"
                  type="datetime-local"
                  required /></label
              ><label
                >补交截止<input
                  v-model="grant.closesAt"
                  type="datetime-local"
                  required /></label
              ><label>原因<textarea v-model="grant.reason" required /></label
              ><button :disabled="busy || uncertain">开放指定补交</button>
            </form>
          </details></template
        >
        <section v-if="data.grants.length" class="course-panel">
          <h2>补交窗口</h2>
          <p v-for="g in data.grants" :key="g.id">
            {{ data.subjects.find((s: any) => s.id === g.subject_id)?.name }} ·
            {{ fmt(g.opens_at) }} 至 {{ fmt(g.closes_at) }} ·
            {{ g.revoked_at ? "已撤销" : g.reason }}
            <button
              v-if="teacher && !g.revoked_at"
              :disabled="busy || uncertain"
              @click="
                act(() =>
                  apiV2(`/late-grants/${g.id}/revoke`, { method: 'POST' }),
                )
              "
            >
              撤销未来补交
            </button>
          </p>
        </section>
      </template>
      <p v-else-if="!error" role="status">正在读取子任务…</p>
    </SourceEvidenceReader>
  </section>
</template>
