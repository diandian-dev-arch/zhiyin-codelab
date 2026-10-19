<script setup lang="ts">
import StudioSelect from '../components/StudioSelect.vue';
import AnimatedNumber from '../components/AnimatedNumber.vue';
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import StudioSearch from "../components/StudioSearch.vue";
import PersonalModelDialog from '../components/PersonalModelDialog.vue';
import RuleHistory from '../components/RuleHistory.vue';
import type { PersonalModelState } from '@codelab/contracts/model-settings';
import { useRoute } from "vue-router";
import { apiV2, useSession } from "../api";
import type { RuleSnapshot, TaskPackManifest } from "@codelab/contracts/v2";
import { LIMITS_V1 } from "@codelab/contracts/v2";
const session = useSession(),
  id = String(useRoute().params.id);
const task = ref<any>(null),
  submissions = ref<any[]>([]),
  error = ref(""),
  message = ref(""),
  busy = ref(false);
const selectedPack = ref(""),
  enabled = ref<string[]>([]),
  parameters = ref<Record<string, any>>({}),
  confirmed = ref(false);
const submissionQuery = ref("");
const submissionTotal = ref(0), nextSubmissionCursor = ref<string | null>(null), historyLoading = ref(false);
async function loadEarlier() {
  if (historyLoading.value || !nextSubmissionCursor.value) return;
  historyLoading.value = true;
  try {
    const list = await apiV2(`/tasks/${id}/submissions?after=${encodeURIComponent(nextSubmissionCursor.value)}`);
    const seen = new Set(submissions.value.map(item => item.submissionId));
    submissions.value.push(...list.items.filter((item: any) => !seen.has(item.submissionId)));
    submissionTotal.value = list.total;
    nextSubmissionCursor.value = list.nextCursor;
  } catch (e) { error.value = (e as Error).message; }
  finally { historyLoading.value = false; }
}
const modelDialog = ref<InstanceType<typeof PersonalModelDialog>>();
const personalModel = ref<PersonalModelState>();
const personalAnalysisMode = ref<'off'|'summary'|'agent'>('off');
async function refreshModel() {
  try { personalModel.value = await apiV2('/model-settings'); }
  catch { personalModel.value = undefined; }
  personalAnalysisMode.value = 'off';
}
const requirementsOpen = window.matchMedia("(min-width: 1001px)").matches;
const submissionFilter = ref("all");
const submissionGroup = (item: any) =>
  !item.latestRun
    ? "saved"
    : terminal(item.latestRun.status)
      ? "finished"
      : "running";
const filteredSubmissions = computed(() =>
  submissions.value.filter(
    (item) =>
      (submissionFilter.value === "all" ||
        submissionGroup(item) === submissionFilter.value) &&
      [
        item.sourceManifestSha256,
        item.submissionId,
        new Date(item.createdAt).toLocaleString("zh-CN"),
      ].some((value) =>
        String(value)
          .toLowerCase()
          .includes(submissionQuery.value.trim().toLowerCase()),
      ),
  ),
);
const runningCount = computed(
  () =>
    submissions.value.filter((item) => submissionGroup(item) === "running")
      .length,
);
const file = ref<File | null>(null);
let uploadKey = crypto.randomUUID(),
  ruleKey = crypto.randomUUID(),
  timer: ReturnType<typeof setInterval>;
const pendingRunRequests = new Map<string, {body: string; key: string}>();
let writeController: AbortController | undefined;
let uploadRuleId: string | undefined;
const cancelKeys = new Map<string, string>();
async function mutate(url: string, options: RequestInit, timeoutMs = 15000) {
  const controller = new AbortController();
  writeController = controller;
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const result = await apiV2(url, {...options, signal: controller.signal});
    controller.signal.throwIfAborted();
    return result;
  } catch (failure) {
    if (controller.signal.aborted || failure instanceof TypeError) {
      throw new Error('尚未收到操作回执，结果未知；服务器可能已经处理。请先重新读取任务核对规则或检查记录。没有自动重发；涉及模型的检查可能已计费。');
    }
    throw failure;
  } finally {
    window.clearTimeout(timeout);
    if (writeController === controller) writeController = undefined;
  }
}
const currentRule = computed<RuleSnapshot | null>(
  () => task.value?.currentRule ?? null,
);
const pack = computed<TaskPackManifest | undefined>(() =>
  task.value?.availablePacks?.find(
    (p: TaskPackManifest) => p.contentHash === selectedPack.value,
  ),
);
const draftCriteria = computed(() =>
  pack.value?.criteria.filter((criterion) => enabled.value.includes(criterion.criterionId)) ?? [],
);
const draftCaseCount = computed(() =>
  pack.value?.cases.filter((entry) => enabled.value.includes(entry.criterionId)).length ?? 0,
);
const parameterLabel = (key: string) => key === 'requireValidationMessage'
  ? '空白提交时必须显示提示信息' : key;
// Confirmation and replay identity belong to the exact draft, not to the form session.
watch(() => JSON.stringify([selectedPack.value, [...enabled.value].sort(), parameters.value]), () => {
  confirmed.value = false;
  ruleKey = crypto.randomUUID();
}, {flush: 'sync'});
const labels: Record<string, string> = {
  queued: "等待检查",
  preparing: "准备中",
  building: "构建中",
  checking: "检查中",
  completed: "检查完成",
  build_error: "构建失败",
  infra_error: "环境异常",
  interrupted: "检查中断",
  cancelled: "已取消",
};
const terminal = (status: string) =>
  [
    "completed",
    "build_error",
    "infra_error",
    "interrupted",
    "cancelled",
  ].includes(status);
watch(
  () => pack.value?.contentHash,
  () => {
    const value = pack.value;
    enabled.value = value?.criteria.map((c) => c.criterionId) ?? [];
    parameters.value = Object.fromEntries(
      Object.entries(value?.parameterSchema ?? {}).map(([key, value]) => [
        key,
        value.default,
      ]),
    );
    confirmed.value = false;
    ruleKey = crypto.randomUUID();
  },
);
async function load() {
  if (historyLoading.value) return;
  historyLoading.value = true;
  error.value = '';
  try {
    const [detail, list] = await Promise.all([
      apiV2(`/tasks/${id}`),
      apiV2(`/tasks/${id}/submissions`),
    ]);
    task.value = detail;
    // Refresh every loaded page so polling does not discard older history.
    let cursor = list.nextCursor;
    while (cursor && list.items.length < submissions.value.length) {
      const older = await apiV2(`/tasks/${id}/submissions?after=${encodeURIComponent(cursor)}`);
      list.items.push(...older.items);
      cursor = older.nextCursor;
    }
    submissions.value = list.items;
    submissionTotal.value = list.total;
    nextSubmissionCursor.value = cursor;
    if (!selectedPack.value)
      selectedPack.value =
        (detail.availablePacks?.some(
          (p: TaskPackManifest) =>
            p.contentHash === detail.currentRule?.packManifestHash,
        )
          ? detail.currentRule.packManifestHash
          : undefined) ??
        detail.availablePacks?.[0]?.contentHash ??
        "";
  } catch (e) {
    error.value = (e as Error).message;
  } finally { historyLoading.value = false; }
}
async function act(action: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  message.value = "";
  try {
    await action();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
async function publishRule() {
  if (!pack.value || !confirmed.value) return;
  await act(async () => {
    await mutate(`/tasks/${id}/rules`, {
      method: "POST",
      headers: { "Idempotency-Key": ruleKey },
      body: JSON.stringify({
        packId: pack.value!.packId,
        packVersion: pack.value!.packVersion,
        packManifestHash: pack.value!.contentHash,
        enabledCriterionIds: enabled.value,
        parameterValues: parameters.value,
        confirmed: true,
      }),
    });
    ruleKey = crypto.randomUUID();
    confirmed.value = false;
    message.value = "新规则已发布，已有提交继续引用原规则。";
    await load();
  });
}
function selectFile(event: Event) {
  file.value = (event.target as HTMLInputElement).files?.[0] ?? null;
  uploadKey = crypto.randomUUID();
  uploadRuleId = undefined;
}
async function upload() {
  if (!file.value || !currentRule.value || task.value?.template.available === false) return;
  await act(async () => {
    const form = new FormData();
    form.append("file", file.value!);
    uploadRuleId ??= currentRule.value!.ruleId;
    const saved = await mutate(`/tasks/${id}/submissions`, {
      method: "POST",
      headers: {
        "Idempotency-Key": uploadKey,
        "X-Rule-Id": uploadRuleId,
      },
      body: form,
    }, 135000);
    message.value = `提交已保存，源码指纹 ${saved.sourceManifestSha256.slice(0, 12)}。${task.value.executionAvailable ? "可以在下方创建检查。" : "执行服务尚未开放，提交已保留。"}`;
    await load();
  });
}
async function start(item: any) {
  await act(async () => {
    const body = JSON.stringify({
      ...(item.latestRun && terminal(item.latestRun.status) ? { retryOfRunId: item.latestRun.runId } : {}),
      ...(task.value.personalModelBilling ? { personalAnalysisMode: personalAnalysisMode.value } : {}),
    });
    const prior = pendingRunRequests.get(item.submissionId);
    const pending = prior?.body === body ? prior : {body, key: crypto.randomUUID()};
    pendingRunRequests.set(item.submissionId, pending);
    try {
      await mutate(`/submissions/${item.submissionId}/runs`, {
        method: "POST",
        headers: { "Idempotency-Key": pending.key },
        body,
      });
    } catch (e) {
      throw new Error(`提交已保留，无需重新上传。${(e as Error).message} 请先刷新检查状态；如果尚未创建，可重试。`);
    }
    pendingRunRequests.delete(item.submissionId);
    message.value = "已进入检查队列。再次检查会生成独立记录。";
    personalAnalysisMode.value = 'off';
    await load();
  });
}
async function cancel(runId: string) {
  await act(async () => {
    const key = cancelKeys.get(runId) ?? crypto.randomUUID();
    cancelKeys.set(runId, key);
    await mutate(`/runs/${runId}/cancel`, {
      method: "POST",
      headers: { "Idempotency-Key": key },
    });
    await load();
  });
}
onMounted(async () => {
  await load();
  if (task.value?.personalModelBilling) await refreshModel();
  timer = setInterval(() => {
    if (
      !busy.value &&
      submissions.value.some(
        (s) => s.latestRun && !terminal(s.latestRun.status),
      )
    )
      void load();
  }, 4000);
});
onUnmounted(() => { clearInterval(timer); writeController?.abort(); });
</script>
<template>
  <PersonalModelDialog ref="modelDialog" @changed="refreshModel" />
  <RouterLink to="/" class="back">← 实训任务</RouterLink>
  <p v-if="error" role="alert" class="error">{{ error }} <button type="button" :disabled="historyLoading || busy" @click="load">重新读取任务</button></p>
  <p v-if="message" role="status" class="notice">{{ message }}</p>
  <template v-if="task">
    <div class="page-heading">
      <div>
        <h1>{{ task.title }}</h1>
        <p class="muted">
          {{
            currentRule
              ? "当前规则 v" + currentRule.version
              : "等待教师发布规则"
          }}
        </p>
      </div>
      <a v-if="task.template.available !== false" class="button" :href="task.template.downloadUrl">下载项目模板</a>
      <p v-else class="notice" role="status">当前规则对应模板暂不可用，请联系教师确认后再提交。</p>
    </div>
    <p class="task-intro">{{ task.description }}</p>
    <div class="task-pulse" aria-label="任务进度">
      <div>
        <span>已保存提交</span
        ><strong><AnimatedNumber :value="submissionTotal" /><small>份</small></strong>
      </div>
      <div>
        <span>已加载记录中正在检查</span
        ><strong><AnimatedNumber :value="runningCount" /><small>份</small></strong>
      </div>
      <div>
        <span>本次验收要求</span
        ><strong
          ><AnimatedNumber :value="currentRule?.enabledCriterionIds.length ?? 0" /><small>项</small></strong
        >
      </div>
      <p>
        {{
          session.user?.role === "teacher"
            ? "先看证据，\n再下判断。"
            : "提交、检查，\n让进步可见。"
        }}
      </p>
    </div>
    <div class="task-desk">
      <aside class="task-rule-column">
        <details class="panel requirements" :open="requirementsOpen">
          <summary>
            本次验收要求
            <span class="count-label">{{
              currentRule?.enabledCriterionIds.length ?? 0
            }}</span>
          </summary>
          <template v-if="currentRule"
            ><div
              v-for="criterion in currentRule.packManifest.criteria.filter(
                (c) => currentRule!.enabledCriterionIds.includes(c.criterionId),
              )"
              :key="criterion.criterionId"
              class="criterion"
            >
              <span class="tag">{{ criterion.displayCode }}</span>
              <div>
                <strong>{{ criterion.title }}</strong>
                <p>{{ criterion.expectedBehavior }}</p>
                <small>{{
                  criterion.mode === "auto" ? "独立案例检查" : "教师人工判断"
                }}</small>
              </div>
            </div></template
          >
          <p v-else class="muted">规则发布后，学生可以按明确版本提交项目。</p>
        </details>
        <details v-if="session.user?.role === 'teacher'" class="panel">
          <summary>选择验收包并发布新规则</summary>
          <p v-if="!task.availablePacks?.length" class="notice">
            当前尚无可用验收包，完成执行环境准备后才能发布规则。
          </p>
          <form v-else @submit.prevent="publishRule">
            <fieldset :disabled="busy" class="rule-draft-fields">
            <label
              >验收包<StudioSelect v-model="selectedPack">
                <option
                  v-for="p in task.availablePacks"
                  :key="p.contentHash"
                  :value="p.contentHash"
                >
                  {{ p.packId }} · {{ p.packVersion }}
                </option>
              </StudioSelect></label
            >
            <template v-if="pack"
              ><label
                v-for="criterion in pack.criteria"
                :key="criterion.criterionId"
                class="v2-check"
                ><input
                  type="checkbox"
                  v-model="enabled"
                  :value="criterion.criterionId"
                />{{ criterion.displayCode }} {{ criterion.title }}</label
              >
              <label
                v-for="(definition, key) in pack.parameterSchema"
                :key="key"
                >{{ parameterLabel(String(key))
                }}<input
                  v-if="definition.type === 'boolean'"
                  type="checkbox"
                  v-model="parameters[key]"
                /><input
                  v-else-if="definition.type === 'integer'"
                  type="number"
                  v-model.number="parameters[key]"
                  :min="definition.minimum"
                  :max="definition.maximum"
                /><StudioSelect v-else v-model="parameters[key]">
                  <option v-for="value in definition.values" :key="value">
                    {{ value }}
                  </option>
                </StudioSelect></label
              >
            </template>
            <section class="rule-draft-preview" aria-label="待发布要求预览">
              <strong>学生将按这些要求提交</strong>
              <p class="muted small">{{ draftCriteria.length }} 项要求 · {{ draftCaseCount }} 个自动案例 · {{ draftCriteria.filter(c => c.mode === 'manual').length }} 项教师判断</p>
              <div v-for="criterion in draftCriteria" :key="criterion.criterionId" class="criterion">
                <div><strong>{{ criterion.title }}</strong><p>{{ criterion.expectedBehavior }}</p></div>
              </div>
              <p v-if="!draftCriteria.length" class="notice">请至少选择一项要求。</p>
              <p class="muted small">发布后仅供新提交使用，已有提交继续按原规则检查。修改选择或参数后，需要重新确认。</p>
            </section>
            <label class="v2-check"
              ><input
                type="checkbox"
                v-model="confirmed"
              />我已确认以上要求与本次课程任务一致</label
            ><button
              class="primary"
              :disabled="busy || !confirmed || !enabled.length"
            >
              发布新规则
            </button>
            </fieldset>
          </form>
        </details>
        <RuleHistory v-if="session.user?.role==='teacher' && currentRule" :task-id="id" :current-version="currentRule.version" />
        <RouterLink class="history-link" :to="'/legacy/tasks/' + id"
          >查看旧版历史记录 →</RouterLink
        >
      </aside>
      <div class="task-submission-column">
        <form
          v-if="session.user?.role === 'student' && currentRule"
          class="panel"
          @submit.prevent="upload"
        >
          <h2>提交项目</h2>
          <p>上传固定模板的 ZIP。提交后将保留当前规则版本，再单独创建检查。</p>
          <p class="muted small">压缩包最多 {{ LIMITS_V1.originalZipMaxBytes / 1024 / 1024 }} MiB。课程检查使用下载的模板；普通项目 AI 源码分析请前往 <RouterLink to="/projects">项目分析</RouterLink>。</p>
          <details class="submission-guide">
            <summary>如何准备可提交的 ZIP</summary>
            <ol>
              <li>直接压缩项目内容，让 <code>src/</code> 与模板配置位于 ZIP 根目录，不要额外套一层项目文件夹。</li>
              <li>保留模板依赖和配置，仅修改允许的 <code>src/</code> 源码与 <code>public/</code> 静态资源。</li>
              <li>不要包含 <code>node_modules/</code>、<code>.git/</code>、<code>.env</code>、密钥或其他压缩包。</li>
            </ol>
            <p class="muted small">解压总量最多 {{ LIMITS_V1.sourceMaxBytes / 1024 / 1024 }} MiB，单文件最多 {{ LIMITS_V1.sourceFileMaxBytes / 1024 / 1024 }} MiB，最多 {{ LIMITS_V1.sourceMaxFiles.toLocaleString('zh-CN') }} 个条目。保存成功不代表检查通过；检查后由教师复核并发布反馈。</p>
          </details>
          <label
            >项目 ZIP<input
              type="file"
              accept=".zip,application/zip"
              :disabled="busy"
              @change="selectFile"
              required /></label
          ><button class="primary" :disabled="busy || !file || task.template.available === false">保存提交</button>
        </form>
        <section class="panel submission-records">
          <div class="section-heading">
            <div>
              <h2>
                提交与检查记录
                <span class="count-label">{{ submissionTotal }}</span>
              </h2>
              <p class="muted small">{{ session.user?.role === 'teacher' ? '检查完成后，进入报告复核证据并发布反馈。' : '先查看检查进度；教师发布后，才能阅读反馈和公开证据。' }}</p>
            </div>
            <button @click="load" :disabled="busy">刷新</button>
          </div>
          <div v-if="task.personalModelBilling" class="course-model-choice">
            <div class="section-heading">
              <div><strong>这次检查，是否请 AI 一起分析？</strong><p class="muted small">基础检查不调用模型。选择 AI 后，费用由你的 API Key 所属账户承担，不能使用提交者或其他人的额度。</p></div>
              <button @click="modelDialog?.open()" :disabled="busy">模型设置</button>
            </div>
            <label>检查后的 AI 分析
              <StudioSelect v-model="personalAnalysisMode" :disabled="busy">
                <option value="off">仅基础检查 · 不调用模型</option>
                <option value="summary" :disabled="!personalModel?.configured">AI 总结 · 使用我的模型</option>
                <option value="agent" :disabled="!personalModel?.configured">Agent 分析 · 使用我的模型</option>
              </StudioSelect>
            </label>
            <p class="muted small">{{ personalModel?.configured ? `当前模型：${personalModel.settings?.model}。本次选择仅用于下一次创建检查。` : '尚未配置个人模型。可以先做基础检查，或打开模型设置。' }}</p>
          </div>
          <div class="collection-toolbar">
            <div class="segmented" role="group" aria-label="按检查状态筛选">
              <button
                v-for="filter in [
                  { id: 'all', title: '全部' },
                  { id: 'running', title: '检查中' },
                  { id: 'finished', title: '已结束' },
                  { id: 'saved', title: '未检查' },
                ]"
                :key="filter.id"
                :aria-pressed="submissionFilter === filter.id"
                @click="submissionFilter = filter.id"
              >
                {{ filter.title }}
              </button>
            </div>
            <StudioSearch
              v-model="submissionQuery"
              label="搜索提交时间或源码指纹"
            />
          </div>
          <p class="muted small" aria-live="polite">已加载 {{ submissions.length }} / {{ submissionTotal }} 份提交；搜索和状态筛选作用于已加载记录。</p>
          <p v-if="!submissions.length" class="muted">暂无提交。</p>
          <article
            v-for="item in filteredSubmissions"
            :key="item.submissionId"
            class="v2-submission"
          >
            <div>
              <strong>{{
                new Date(item.createdAt).toLocaleString("zh-CN")
              }}</strong>
              <p class="small">
                源码指纹 {{ item.sourceManifestSha256.slice(0, 12) }}
              </p>
              <p :class="['status', item.latestRun?.status]">
                {{
                  item.latestRun
                    ? (labels[item.latestRun.status] ?? item.latestRun.status)
                    : "已保存，尚未创建检查"
                }}
              </p>
            </div>
            <div class="actions">
              <RouterLink
                v-if="item.latestRun"
                class="button report-link"
                :to="'/runs/' + item.latestRun.runId"
                >{{ session.user?.role === 'teacher' ? '查看报告' : '进度与反馈' }}</RouterLink
              ><button
                v-if="
                  task.executionAvailable &&
                  (!item.latestRun || terminal(item.latestRun.status))
                "
                :disabled="busy"
                @click="start(item)"
              >
                {{ item.latestRun ? "再次检查此提交" : "创建检查" }}</button
              ><button
                v-if="item.latestRun?.status === 'queued'"
                :disabled="busy"
                @click="cancel(item.latestRun.runId)"
              >
                取消排队
              </button>
            </div>
          </article>
          <div
            v-if="submissions.length && !filteredSubmissions.length"
            class="empty compact"
          >
            <h3>已加载记录中没有匹配的提交</h3>
            <button
              @click="
                submissionQuery = '';
                submissionFilter = 'all';
              "
            >
              清除筛选
            </button>
          </div>
          <button v-if="nextSubmissionCursor" type="button" :disabled="historyLoading || busy" @click="loadEarlier">{{ historyLoading ? '读取中…' : '加载更早提交' }}</button>
        </section>
      </div>
    </div>
  </template>
  <p v-else role="status">正在读取任务…</p>
</template>

<style scoped>
.rule-draft-fields { border: 0; padding: 0; margin: 0; min-width: 0; }
.rule-draft-preview { margin-block: var(--space-md); padding-block: var(--space-sm); border-block: 1px solid var(--line); }
.v2-check { display: flex; flex-direction: row; align-items: center; gap: var(--space-xs); min-height: 44px; margin: var(--space-2xs) 0; padding: var(--space-xs); border-radius: var(--radius-input); background: var(--surface); }
.v2-check input { flex: none; accent-color: var(--accent); }
.v2-submission { display: flex; align-items: center; justify-content: space-between; gap: var(--space-sm); padding: var(--space-md) 0; border-bottom: 1px solid var(--line); }
.v2-submission:last-child { border-bottom: 0; }
.v2-submission > div:first-child { flex: 1; min-width: 0; }
.v2-submission strong { display: block; font-size: var(--text-md); margin-bottom: var(--space-2xs); overflow-wrap: anywhere; }
.v2-submission .small { color: var(--muted); margin: var(--space-2xs) 0; overflow-wrap: anywhere; }
.v2-submission .status { display: inline-block; }
.report-link { background: var(--accent); color: var(--gl-on-c1); border-color: var(--accent); }
.report-link:hover { background: var(--accent-hover); color: var(--gl-text); }
summary + form { margin-top: var(--space-sm); }
@media (max-width: 760px) { .v2-submission { align-items: flex-start; flex-direction: column; } .v2-submission .actions { width: 100%; } }
</style>
