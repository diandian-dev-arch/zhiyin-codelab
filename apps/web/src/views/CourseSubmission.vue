<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { useSession } from "../api";
import { createCourseworkApi } from '../lib/coursework-api';
import CourseworkWriteRecovery from '../components/CourseworkWriteRecovery.vue';
import CourseReport from "../components/CourseReport.vue";
import SourceEvidenceReader from "../components/SourceEvidenceReader.vue";
import type { SourceCitation } from "../lib/source-evidence";
const id = String(useRoute().params.id),
  session = useSession(),
  teacher = computed(() => session.user?.role === "teacher");
const writes = createCourseworkApi(`${session.user?.id}/course-submissions/${id}`);
const { request: apiV2, uncertain, checking, checked } = writes;
async function reconcileWrite() {
  error.value = '';
  try { await writes.reconcile(load); } catch (e) { if (alive) error.value = (e as Error).message; }
}
function resumeWrites() { writes.resume(); error.value = ''; }
const data = ref<any>(null),
  error = ref(""),
  busy = ref(false),
  diff = ref<any>(null),
  base = ref(""),
  versions = ref<any[]>([]),
  recipient = ref<any>(null),
  confirmed = ref(false),
  contribution = ref<any>(null),
  statement = ref(""),
  message = ref("");
const sourceReader = ref<InstanceType<typeof SourceEvidenceReader>>();
watch(
  () => recipient.value?.hash,
  () => {
    confirmed.value = false;
  },
  { flush: "sync" },
);
const loadEvidence = (
  citation: SourceCitation,
  _full: boolean,
  signal: AbortSignal,
) =>
  apiV2(
    `/course-submissions/${id}/source?path=${encodeURIComponent(citation.path)}`,
    { signal },
  );
const evaluation = ref({
  feedback: "",
  outcome: "pending",
  analysisId: null as string | null,
});
let alive = true,
  timer: ReturnType<typeof setTimeout> | undefined;
const fmt = (v: string) =>
  new Date(v).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour12: false,
  });
const statuses: Record<string, string> = {
  queued: "等待分析",
  running: "分析中",
  succeeded: "分析完成",
  failed: "分析失败",
  cancelled: "已取消",
};
async function load() {
  const result = await apiV2(`/course-submissions/${id}`);
  if (!alive) return;
  data.value = result;
  const [task, model] = await Promise.all([
    apiV2(`/course-tasks/${result.submission.task_id}`),
    teacher.value && !session.teacherTrial
      ? apiV2("/course-model-recipient")
      : Promise.resolve({ recipient: null }),
  ]);
  if (!alive) return;
  versions.value = task.submissions.filter(
    (s: any) => s.subject_id === result.submission.subject_id && s.id !== id,
  );
  recipient.value = teacher.value ? model.recipient : task.teacherRecipient;
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
      if (uncertain.value) confirmed.value = false;
    }
  } finally {
    if (alive) busy.value = false;
  }
}
async function poll() {
  try {
    if (!busy.value) await load();
  } catch {
    /* Keep the last confirmed version on transient poll failure. */
  } finally {
    if (alive) timer = setTimeout(poll, 4000);
  }
}
async function readSource(path: string, start?: number, end?: number) {
  if (start)
    await sourceReader.value?.openCitation({ path, start, end: end ?? start });
  else await sourceReader.value?.openFile(path);
}
async function consent() {
  await act(async () => {
    await apiV2(`/course-submissions/${id}/model-consent`, {
      method: "POST",
      body: JSON.stringify({
        recipientHash: recipient.value.hash,
        confirmed: confirmed.value,
      }),
    });
    message.value = "已保存本次快照、当前接收方的正式评阅授权。";
  });
}
async function analyze() {
  await act(() =>
    apiV2(`/course-submissions/${id}/analyses`, {
      method: "POST",
      body: JSON.stringify({
        recipientHash: recipient.value.hash,
        confirmed: confirmed.value,
      }),
    }),
  );
}
async function save() {
  await act(async () => {
    await apiV2(`/course-submissions/${id}/evaluations`, {
      method: "POST",
      body: JSON.stringify(evaluation.value),
    });
    message.value = "评价草稿已保存。确认发布后学生才可见。";
  });
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
      :identity="id"
      :version-label="`正式提交 V${data?.submission.sequence ?? ''} · 固定快照 ${data?.submission.snapshot_id ?? ''}`"
      :load-source="loadEvidence"
    >
      <p v-if="error" class="error" role="alert">
        {{ error }} <button @click="act(load)">重新读取</button>
      </p>
      <p v-if="message" class="course-notice" role="status">{{ message }}</p>
      <CourseworkWriteRecovery v-if="uncertain" :busy="busy" :checking="checking" :checked="checked" @check="reconcileWrite" @resume="resumeWrites" />
      <template v-if="data"
        ><RouterLink :to="`/course-tasks/${data.submission.task_id}`"
          >← {{ data.task.config.title }}</RouterLink
        >
        <header class="course-heading">
          <div>
            <p class="eyebrow">
              {{ data.task.assignment.class_name }} /
              {{ data.task.assignment.title }} / {{ data.task.config.title }}
            </p>
            <h1>
              {{ data.submission.subject_name }} · V{{
                data.submission.sequence
              }}
            </h1>
            <p>
              {{ data.submission.submitted_name }} 提交 ·
              {{ data.submission.late_grant_id ? "限时补交" : "正常提交" }} ·
              原任务修订已固定
            </p>
          </div>
          <div class="course-stamp">
            正式提交已接受<br />{{ fmt(data.submission.accepted_at)
            }}<br /><code>{{ data.submission.id }}</code>
          </div>
        </header>
        <section class="course-panel">
          <h2>固定成果与提交回执</h2>
          <a :href="`/api/v2/course-submissions/${id}/download`"
            >下载本次固定源码 ZIP</a
          >
          <p>{{ data.submission.note || "未填写提交说明" }}</p>
          <p class="course-code">
            快照 {{ data.snapshot.id }}<br />内容哈希
            {{ data.snapshot.content_hash }}
          </p>
          <p v-if="data.snapshot.source.commit">
            {{ data.snapshot.source.provider }} /
            {{ data.snapshot.source.owner }} / {{ data.snapshot.source.name }} /
            <code>{{ data.snapshot.source.commit }}</code>
          </p>
          <p v-if="data.submission.base_submission_id">
            前置基线：<RouterLink
              :to="`/course-submissions/${data.submission.base_submission_id}`"
              >{{ data.submission.base_submission_id }}</RouterLink
            >（后续任务不随前置新版本改变）
          </p>
          <button
            v-for="f in data.snapshot.manifest"
            :key="f.path"
            :disabled="busy"
            @click="act(() => readSource(f.path))"
          >
            {{ f.path }} · {{ f.bytes }} B
          </button>
          <details v-if="data.snapshot.omitted.length">
            <summary>未纳入快照的文件</summary>
            <p v-for="o in data.snapshot.omitted" :key="o.path">
              {{ o.path }} · {{ o.reason }}
            </p>
          </details>
          <p class="muted">
            提交有效性独立于 AI 状态。未运行测试；本页不会自动调用付费模型。
          </p>
        </section>
        <details class="course-panel">
          <summary>比较固定版本</summary>
          <label
            >基线<select v-model="base">
              <option value="">选择同一主体的版本</option>
              <option v-for="v in versions" :key="v.id" :value="v.id">
                V{{ v.sequence }} · {{ fmt(v.accepted_at) }}
              </option>
            </select></label
          ><button
            :disabled="busy || !base"
            @click="
              act(async () => {
                diff = await apiV2(
                  `/course-submissions/${id}/diff?base=${base}`,
                );
              })
            "
          >
            比较版本
          </button>
          <div v-if="diff">
            <p>
              新增 {{ diff.added.length }} · 修改 {{ diff.modified.length }} ·
              删除 {{ diff.removed.length }}
            </p>
            <details v-for="f in diff.files" :key="f.path">
              <summary>{{ f.path }}</summary>
              <div class="course-diff">
                <div>
                  <h4>基线</h4>
                  <pre>{{ f.before ?? "文件不存在" }}</pre>
                </div>
                <div>
                  <h4>本次版本</h4>
                  <pre>{{ f.after ?? "文件不存在" }}</pre>
                </div>
              </div>
            </details>
          </div>
        </details>
        <section v-if="!session.teacherTrial" class="course-panel">
          <h2>正式 AI 辅助评阅</h2>
          <p v-if="!teacher">
            教师只能看到正式成果，不会读取你的私人自查。候选报告在教师采用并发布后可见。
          </p>
          <div v-if="recipient">
            <p>
              模型接收方：{{ recipient.provider }} / {{ recipient.model }} /
              {{ recipient.endpoint }}
            </p>
            <label class="course-check"
              ><input v-model="confirmed" type="checkbox" />{{
                teacher
                  ? "确认由本人模型配置承担本次调用，并向上述服务发送已授权源码。"
                  : "我有权为当前快照授权，允许向上述服务发送源码，用于本次作业的教师评阅。"
              }}授权不包含班内公开；已发送数据无法收回。</label
            ><button
              v-if="teacher"
              class="primary"
              :disabled="busy || uncertain || !confirmed"
              @click="analyze"
            >
              使用本人模型发起正式分析</button
            ><button
              v-else-if="data.submission.submitted_by === session.user?.id"
              :disabled="busy || uncertain || !confirmed"
              @click="consent"
            >
              授权当前接收方分析本次成果
            </button>
          </div>
          <p v-else>
            模型尚未配置，教师仍可人工评价。<RouterLink
              v-if="teacher"
              to="/settings"
              >配置本人模型</RouterLink
            >
          </p>
          <p v-for="c in data.consents" :key="c.id">
            {{ c.recipient.model }} · {{ c.revoked_at ? "已撤销" : "已授权" }}
            <button
              v-if="!c.revoked_at && c.actor_id === session.user?.id"
              :disabled="busy || uncertain"
              @click="
                act(() =>
                  apiV2(`/course-model-consents/${c.id}/revoke`, {
                    method: 'POST',
                  }),
                )
              "
            >
              撤销未来外发
            </button>
          </p>
          <p v-if="!data.analyses.length">
            {{
              teacher
                ? "尚未发起正式 AI，或仍未生成结果。"
                : "教师尚未发布正式 AI 报告。"
            }}
          </p>
          <article v-for="a in data.analyses" :key="a.id">
            <h3>{{ statuses[a.status] }} · {{ a.model_config.model }}</h3>
            <p v-if="a.failure_code" class="error">
              {{ a.failure_code }}。本次成果仍然有效；可人工评价或明确重新发起。
            </p>
            <p class="muted">
              {{
                a.usage
                  ? `已知输入 ${a.usage.inputTokens} / 输出 ${a.usage.outputTokens} Token`
                  : "尚无已知实际用量"
              }}
              · 计费人
              {{
                a.billing_user_id === session.user?.id
                  ? "本人"
                  : "发起评阅的教师"
              }}
            </p>
            <CourseReport
              v-if="a.report"
              :report="a.report"
              @evidence="
                (path, start, end) => act(() => readSource(path, start, end))
              "
            /><button
              v-if="teacher && ['queued', 'running'].includes(a.status)"
              :disabled="busy || uncertain"
              @click="
                act(() =>
                  apiV2(`/course-analyses/${a.id}/cancel`, { method: 'POST' }),
                )
              "
            >
              取消分析
            </button>
          </article>
        </section>
        <section class="course-panel">
          <h2>教师评价与发布历史</h2>
          <p v-if="!data.evaluations.length">
            {{
              teacher
                ? "尚未保存评价。可以直接人工评价，无需 AI。"
                : "教师尚未发布评价。"
            }}
          </p>
          <article v-for="e in data.evaluations" :key="e.id">
            <h3>
              评价修订 {{ e.revision }} ·
              {{ e.status === "published" ? "已发布" : "草稿" }}
            </h3>
            <p>{{ e.feedback }}</p>
            <p>
              {{
                (
                  {
                    achieved: "已达成",
                    needs_revision: "需要修改",
                    pending: "待确认",
                  } as any
                )[e.outcome]
              }}
            </p>
            <button
              v-if="teacher && e.status === 'draft'"
              :disabled="busy || uncertain"
              @click="
                act(() =>
                  apiV2(`/course-evaluations/${e.id}/publish`, {
                    method: 'POST',
                  }),
                )
              "
            >
              确认发布此评价
            </button>
          </article>
          <form v-if="teacher" class="course-form" @submit.prevent="save">
            <label
              >本次教师反馈<textarea
                v-model="evaluation.feedback"
                required
                maxlength="5000"
                rows="5"
              /></label
            ><label
              >目标达成<select v-model="evaluation.outcome">
                <option value="pending">待确认</option>
                <option value="achieved">已达成</option>
                <option value="needs_revision">需要修改</option>
              </select></label
            ><label v-if="!session.teacherTrial"
              >采用的本次正式 AI 报告<select v-model="evaluation.analysisId">
                <option :value="null">仅人工评价</option>
                <option
                  v-for="a in data.analyses.filter(
                    (a: any) => a.status === 'succeeded',
                  )"
                  :key="a.id"
                  :value="a.id"
                >
                  {{ a.model_config.model }} · {{ a.id.slice(0, 8) }}
                </option>
              </select></label
            >
            <p class="muted">
              保存会创建新的评价修订；已发布评价和旧版本的评价保留原样。
            </p>
            <button :disabled="busy || uncertain" class="primary">保存新评价草稿</button>
          </form>
        </section>
        <details class="course-panel">
          <summary>团队成员与贡献材料</summary>
          <p>
            提交操作人：{{
              data.submission.submitted_name
            }}。上传人不等于代码作者，不按行数或提交数评分。
          </p>
          <p v-for="m in data.submission.member_snapshot" :key="m.userId">
            {{ m.name }} ·
            {{
              m.role === "submitter" ? "指定提交人" : "成员"
            }}（提交时成员快照）
          </p>
          <button
            :disabled="busy"
            @click="
              act(async () => {
                contribution = await apiV2(
                  `/course-submissions/${id}/contributions`,
                );
              })
            "
          >
            读取固定区间贡献证据
          </button>
          <div v-if="contribution">
            <p>
              {{ contribution.limitation || contribution.evidence?.limitation }}
            </p>
            <p v-for="c in contribution.evidence?.commits" :key="c.sha">
              <code>{{ c.sha.slice(0, 12) }}</code> · {{ c.author }}（{{
                c.verifiedIdentity
                  ? `平台账号已核验：${c.memberName}`
                  : "身份未验证"
              }}）<span v-if="c.merge"> · 合并提交，需结合原始分支核对</span> ·
              {{ c.message }}
            </p>
          </div>
          <h3>本人说明</h3>
          <p v-for="s in data.statements" :key="s.user_id">
            {{
              data.submission.member_snapshot.find(
                (m: any) => m.userId === s.user_id,
              )?.name
            }}：{{ s.statement }}（本人说明，待教师核对）
          </p>
          <form
            v-if="!teacher"
            class="course-form"
            @submit.prevent="
              act(() =>
                apiV2(`/course-submissions/${id}/contribution-statements`, {
                  method: 'POST',
                  body: JSON.stringify({ statement }),
                }),
              )
            "
          >
            <label
              >本人的设计、开发、测试或协作说明<textarea
                v-model="statement"
                required
                maxlength="3000"
              /></label
            ><button :disabled="busy || uncertain">保存本人说明</button>
          </form>
        </details>
      </template>
      <p v-else-if="!error" role="status">正在读取固定提交…</p>
    </SourceEvidenceReader>
  </section>
</template>
