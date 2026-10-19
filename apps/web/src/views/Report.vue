<script setup lang="ts">
import StudioSelect from '../components/StudioSelect.vue';
import { ref, computed, onMounted, onUnmounted } from "vue";
import { useRoute } from "vue-router";
import { api, useSession } from "../api";
import { verdictLabels, statusLabels, type Feedback } from "@codelab/contracts";
import {
  Check,
  Send,
  ChevronRight,
  FileText,
  Image,
  RefreshCw,
} from "lucide-vue-next";
const id = String(useRoute().params.id),
  s = useSession(),
  data = ref<any>(null),
  selected = ref(""),
  draft = ref<Feedback | null>(null),
  manualStatus = ref("manual"),
  error = ref(""),
  notice = ref(""),
  busy = ref(false),
  evidenceText = ref<Record<string, string>>({}),
  expanded = ref<string | null>(null),
  compareId = ref(""),
  comparison = ref<any>(null),
  history = ref<any[]>([]);
let events: EventSource | undefined;
const report = computed(() =>
    s.user?.role === "student" ? data.value?.report : data.value,
  ),
  criteria = computed(() => report.value?.criteria ?? []),
  current = computed(() =>
    criteria.value.find((c: any) => c.id === selected.value),
  ),
  result = computed(() =>
    report.value?.results?.find((r: any) => r.criterionId === selected.value),
  ),
  references = computed(
    () =>
      report.value?.evidence?.filter((e: any) =>
        new Set([
          ...(result.value?.evidenceIds ?? []),
          ...(draft.value?.evidenceIds ?? []),
        ]).has(e.id),
      ) ?? [],
  ),
  editable = computed(
    () =>
      s.businessVersion === 1 &&
      s.user?.role === "teacher" &&
      data.value?.status === "review",
  );
function select(id: string) {
  selected.value = id;
  draft.value = JSON.parse(
    JSON.stringify(
      report.value?.feedback?.find((f: any) => f.criterionId === id) ?? null,
    ),
  );
  manualStatus.value =
    report.value?.results?.find((r: any) => r.criterionId === id)?.status ??
    "manual";
  expanded.value = null;
}
async function load() {
  try {
    data.value = await api("/runs/" + id);
    if (!selected.value || !editable.value)
      select(selected.value || criteria.value[0]?.id);
    if (!draft.value && criteria.value.length) select(criteria.value[0].id);
    const taskId = data.value.task_id;
    if (taskId) {
      const h = await api(`/tasks/${taskId}/submissions`);
      history.value = h.items.filter(
        (x: any) =>
          x.run_id &&
          x.run_id !== id &&
          x.user_id === data.value.user_id &&
          (s.user?.role === "teacher" || x.status === "published"),
      );
    }
  } catch (e) {
    error.value = (e as Error).message;
  }
}
onMounted(async () => {
  await load();
  events = new EventSource(`/api/v1/runs/${id}/events`);
  events.addEventListener("progress", () => {
    if (!editable.value) load();
  });
});
onUnmounted(() => events?.close());
async function save() {
  if (!draft.value) return;
  busy.value = true;
  error.value = "";
  try {
    await api(`/runs/${id}/review`, {
      method: "PUT",
      body: JSON.stringify({
        revision: data.value.revision,
        criterionId: selected.value,
        feedback: draft.value,
        ...(current.value.mode === "manual"
          ? { manualStatus: manualStatus.value }
          : {}),
      }),
    });
    await load();
    notice.value = "本条反馈已保存并确认。";
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
async function publish() {
  busy.value = true;
  error.value = "";
  try {
    await api(`/runs/${id}/publish`, {
      method: "POST",
      body: JSON.stringify({ revision: data.value.revision }),
    });
    await load();
    notice.value = "报告已发布，学生现在可以查看。";
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
async function evidence(e: any) {
  expanded.value = expanded.value === e.id ? null : e.id;
  if (e.kind !== "screenshot" && !evidenceText.value[e.id])
    try {
      evidenceText.value[e.id] = (
        await api(`/runs/${id}/evidence/${e.id}`)
      ).text;
    } catch (err) {
      error.value = (err as Error).message;
    }
}
async function compare() {
  try {
    comparison.value = await api(
      `/compare?before=${compareId.value}&after=${id}`,
    );
  } catch (e) {
    error.value = (e as Error).message;
  }
}
const changeLabels: Record<string, string> = {
  resolved: "检查层面已解决",
  regression: "出现回归",
  remaining: "仍未满足",
  unknown: "当前无法判断",
  unchanged: "未变化",
};
</script>
<template>
  <RouterLink :to="data?.task_id ? '/tasks/' + data.task_id : '/'" class="back"
    >← 返回任务</RouterLink
  >
  <p v-if="error" class="error" role="alert">{{ error }}</p>
  <p v-if="notice" class="notice" role="status">{{ notice }}</p>
  <div class="page-heading">
    <div>
      <p class="eyebrow">EVIDENCE REVIEW</p>
      <h1>
        {{ s.user?.role === "teacher" ? "验收报告复核" : "项目验收报告" }}
      </h1>
      <p class="muted">
        提交 {{ data?.submission_id?.slice(0, 8) }}
        <span v-if="data">· {{ statusLabels[data.status] }}</span>
      </p>
    </div>
    <div class="actions">
      <button @click="load"><RefreshCw aria-hidden="true" :size="16" />刷新</button
      ><button
        v-if="editable"
        class="primary"
        @click="publish"
        :disabled="busy || data.reviewed.length !== criteria.length"
      >
        <Send aria-hidden="true" :size="16" />发布报告 {{ data.reviewed.length }}/{{
          criteria.length
        }}
      </button>
    </div>
  </div>
  <div v-if="!report" class="empty">
    <FileText aria-hidden="true" :size="32" />
    <h2>
      {{ data?.status === "infra_error" ? "执行环境故障" : "报告尚未发布" }}
    </h2>
    <p>
      当前状态：{{
        statusLabels[data?.status] ?? "加载中"
      }}。教师发布后即可阅读反馈。
    </p>
  </div>
  <template v-else
    ><div
      v-if="report.model_status && report.model_status !== 'complete'"
      class="notice neutral"
    >
      自动解释未完成（{{ report.model_status }}）。基础检查结果仍可复核与发布。
    </div>
    <div class="review-summary">
      <span class="tag"
        >规则 v{{ report.rule_version ?? report.ruleVersion }}</span
      ><span class="mono">{{ (report.sha256 ?? "").slice(0, 16) }}</span
      ><span
        v-for="state in ['passed', 'failed', 'manual', 'not_run']"
        :class="['status', state]"
        >{{ verdictLabels[state as keyof typeof verdictLabels] }}
        {{
          report.results?.filter((r: any) => r.status === state).length ?? 0
        }}</span
      >
    </div>
    <div class="review-layout">
      <nav class="review-nav" aria-label="验收条目">
        <p class="nav-caption">验收要求</p>
        <button
          v-for="c in criteria"
          :class="['review-nav-item', { active: selected === c.id }]"
          @click="select(c.id)"
        >
          <span
            ><strong>{{ c.title }}</strong
            ><small>{{
              verdictLabels[
                report.results?.find((r: any) => r.criterionId === c.id)
                  ?.status as keyof typeof verdictLabels
              ]
            }}</small></span
          ><Check aria-hidden="true"
            v-if="data.reviewed?.includes(c.id)"
            :size="16"
          /><ChevronRight aria-hidden="true" v-else :size="16" />
        </button>
      </nav>
      <div v-if="current && result" class="review-body">
        <section class="panel">
          <div class="section-heading">
            <h2>{{ current.title }}</h2>
            <span :class="['status', result.status]">{{
              verdictLabels[result.status as keyof typeof verdictLabels]
            }}</span>
          </div>
          <p v-if="current.note" class="muted">{{ current.note }}</p>
          <div class="observation">
            <p class="eyebrow">实际观察</p>
            <p>{{ result.observation }}</p>
          </div>
          <h3>复现步骤</h3>
          <ol v-if="result.steps.length" class="steps">
            <li v-for="step in result.steps">{{ step }}</li>
          </ol>
          <p v-else class="muted">此项没有可执行的复现步骤。</p>
        </section>
        <section class="panel">
          <div class="section-heading">
            <h2>运行证据</h2>
            <span class="muted small"
              >{{ references.length }} 项 · 仅本次运行</span
            >
          </div>
          <div v-for="e in references" class="evidence-item">
            <button class="evidence-toggle" @click="evidence(e)">
              <Image aria-hidden="true" v-if="e.kind === 'screenshot'" :size="17" /><FileText aria-hidden="true"
                v-else
                :size="17"
              /><span
                >{{ e.title }}<small class="mono">{{ e.id }}</small></span
              ><span>{{ expanded === e.id ? "收起" : "展开" }}</span>
            </button>
            <div v-if="expanded === e.id" class="evidence-content">
              <img
                v-if="e.kind === 'screenshot'"
                :src="`/api/v1/runs/${id}/evidence/${e.id}`"
                :alt="e.title"
              />
              <pre v-else>{{ evidenceText[e.id] ?? "正在读取…" }}</pre>
            </div>
          </div>
          <p v-if="!references.length" class="muted">
            尚无运行证据。请勿把缺少证据当作功能未满足。
          </p>
        </section>
      </div>
      <aside v-if="draft" class="panel feedback-panel">
        <p class="eyebrow">{{ editable ? "教师复核" : "已确认反馈" }}</p>
        <h2>反馈与下一步</h2>
        <p class="hint">核对事实、引用与建议，再确认本条反馈。</p>
        <template v-if="editable"
          ><label
            >反馈中的实际观察<textarea
              v-model="draft.observation"
              rows="4"
              maxlength="3000"
            ></textarea></label
          ><label
            >可能原因（假设）<textarea
              v-model="draft.possibleCause"
              rows="3"
              maxlength="2000"
            ></textarea></label
          ><label
            >支持程度<StudioSelect v-model="draft.support">
              <option value="hypothesis">原因假设</option>
              <option value="insufficient">证据不足</option>
              <option value="observed">仅描述已观察事实</option>
            </StudioSelect></label
          ><label
            >建议的下一步<textarea
              v-model="draft.nextStep"
              rows="4"
              maxlength="2000"
            ></textarea></label
          ><label v-if="current.mode === 'manual'"
            >教师判断<StudioSelect v-model="manualStatus">
              <option v-for="(label, key) in verdictLabels" :value="key">
                {{ label }}
              </option>
            </StudioSelect></label
          ><label class="checkbox-label"
            ><input
              type="checkbox"
              v-model="draft.needsReview"
            />仍需进一步人工判断</label
          ><button class="primary wide" :disabled="busy" @click="save">
            <Check aria-hidden="true" :size="17" />保存并确认本条
          </button></template
        ><template v-else
          ><h3>实际观察</h3>
          <p>{{ draft.observation }}</p>
          <h3>
            可能原因 ·
            {{
              draft.support === "hypothesis"
                ? "假设"
                : draft.support === "insufficient"
                  ? "证据不足"
                  : "观察描述"
            }}
          </h3>
          <p>{{ draft.possibleCause || "无额外归因" }}</p>
          <h3>下一步</h3>
          <p>{{ draft.nextStep }}</p>
          <p v-if="draft.needsReview" class="hint">
            此项保留进一步人工判断标记。
          </p></template
        >
      </aside>
    </div>
    <section v-if="history.length" class="panel comparison">
      <h2>与历史版本对比</h2>
      <form class="inline-form" @submit.prevent="compare">
        <label
          >历史提交<StudioSelect required v-model="compareId">
            <option value="" disabled>选择一个历史版本</option>
            <option v-for="h in history" :value="h.run_id">
              {{ h.sha256.slice(0, 8) }} ·
              {{ new Date(h.created_at).toLocaleString("zh-CN") }}
            </option>
          </StudioSelect></label
        ><button>查看复验变化</button>
      </form>
      <p v-if="comparison && !comparison.compatible" class="notice">
        {{ comparison.reason }}
      </p>
      <div v-else-if="comparison" class="comparison-items">
        <p v-for="item in comparison.items">
          <strong>{{
            criteria.find((c: any) => c.id === item.criterionId)?.title ??
            item.criterionId
          }}</strong
          ><span>{{ changeLabels[item.change] }}</span>
        </p>
      </div>
      <p class="hint">
        状态变化说明检查结果发生变化，不直接证明某次修改的因果关系。
      </p>
    </section></template
  >
</template>
