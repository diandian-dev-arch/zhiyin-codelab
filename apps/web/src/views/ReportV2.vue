<script setup lang="ts">
import StudioSelect from '../components/StudioSelect.vue';
import AnimatedNumber from '../components/AnimatedNumber.vue';
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, onBeforeRouteLeave, onBeforeRouteUpdate } from "vue-router";
import { apiV2, useSession } from "../api";
import type {
  Evidence,
  FeedbackItem,
  Publication,
  ReportRevision,
  RuleSnapshot,
  CaseResult,
  ReviewedCriterionResult,
} from "@codelab/contracts/v2";
import { canonicalJson } from "@codelab/contracts/v2";
import AgentStudio from '../components/AgentStudio.vue';
import PersonalModelDialog from '../components/PersonalModelDialog.vue';
import PublicationComparison from '../components/PublicationComparison.vue';
import { reviewDraftStore, type ReviewDraft } from '../review-draft-storage';
const modelDialog = ref<InstanceType<typeof PersonalModelDialog>>();
async function refreshModelAvailability() {
  // Preserve unsaved teacher edits when model settings change.
  try {
    const state = await apiV2('/model-settings');
    if (review.value) review.value.analysisAvailable = state.configured;
  } catch { error.value = '模型配置状态暂时无法读取，请刷新后重试。'; }
}
const route = useRoute(),
  session = useSession();
const operationLabels: Record<string, string> = {
  model_summary: "整理基础建议",
  model_agent: "分析材料",
  model_repair: "修正输出格式",
  read_check_result: "读取检查结果",
  read_source_excerpt: "查阅源码片段",
  read_console_evidence: "查阅运行日志",
  inspect_page_evidence: "读取页面证据索引",
  compare_submission: "对比前次提交",
  run_probe: "执行固定筛选补查",
};
const operationStates: Record<string, string> = {
  reserved: "等待执行",
  sent: "执行中",
  completed: "已完成",
  failed: "失败",
  unknown: "结果未确认",
};
const exactPublicationId = String(route.params.publicationId ?? "");
const runId = ref(String(route.params.id ?? "")),
  run = ref<any>(null),
  review = ref<any>(null),
  publication = ref<Publication | null>(null);
const error = ref(""),
  message = ref(""),
  busy = ref(false),
  dirty = ref(false),
  selected = ref("");
const analysisStale = ref(false);
const revisionConflict = ref(false);
const writeUnknown = ref(false);
let reviewWriteController: AbortController | undefined;
const pendingWrites = new Map<string, {signature: string; key: string}>();
async function mutate(url: string, options: RequestInit) {
  const signature = `${options.method ?? 'POST'}:${String(options.body ?? '')}`;
  const previous = pendingWrites.get(url);
  const identity = previous?.signature === signature ? previous : {signature, key: crypto.randomUUID()};
  pendingWrites.set(url, identity);
  const headers = new Headers(options.headers);
  headers.set('Idempotency-Key', identity.key);
  const controller = new AbortController();
  reviewWriteController = controller;
  const timeout = window.setTimeout(() => controller.abort(), 15000);
  try {
    const result = await apiV2(url, {...options, headers, signal: controller.signal});
    controller.signal.throwIfAborted();
    pendingWrites.delete(url);
    writeUnknown.value = false;
    return result;
  } catch (failure) {
    if (controller.signal.aborted || failure instanceof TypeError) {
      writeUnknown.value = true;
      throw new Error('尚未收到操作回执，结果未知；服务器可能已经处理。输入已保留，请先核对最新修订。没有自动重发，模型分析可能已计费。');
    }
    throw failure;
  } finally {
    window.clearTimeout(timeout);
    if (reviewWriteController === controller) reviewWriteController = undefined;
  }
}
const sessionExpired = ref(false), sessionPassword = ref('');
const recoverableDraft = ref<ReviewDraft | null>(null);
const localDraftError = ref(''), localDraftSavedAt = ref('');
let localStore: ReturnType<typeof reviewDraftStore> | undefined;
let localDraftReady = false;
function captureDraft(): ReviewDraft {
  return {id:crypto.randomUUID(),revisionId:revision.value!.revisionId,savedAt:new Date().toISOString(),
    feedback:JSON.parse(JSON.stringify(feedback.value)),judgments:JSON.parse(JSON.stringify(judgments.value)),
    publicEvidenceIds:[...publicIds.value],correctionReason:correctionReason.value};
}
function persistDraft() {
  if (!localDraftReady || !localStore || !teacher.value || !revision.value || recoverableDraft.value) return;
  try {
    const current = dirty.value || publicationOptionsDirty.value ? captureDraft() : null;
    localStore.write({current,preserved:JSON.parse(JSON.stringify(preservedDrafts.value))});
    localDraftError.value = ''; localDraftSavedAt.value = current?.savedAt ?? '';
  } catch {
    localDraftError.value = '本机草稿暂未保存：可能是浏览器存储受限、内容过大或另一窗口已更新草稿。请下载当前草稿，避免丢失。';
  }
}
function readLocalDraft() {
  if (localDraftReady || !teacher.value || !revision.value || !session.user) return;
  try {
    localStore = reviewDraftStore(window.localStorage, session.user.id, runId.value);
    const saved = localStore.read();
    if (saved) { recoverableDraft.value = saved.current; preservedDrafts.value = saved.preserved; }
  } catch { localStore = undefined; localDraftError.value = '本机草稿无法读取，未自动应用。当前报告仍可正常编辑，请下载重要修改作为备份。'; }
  localDraftReady = true;
}
function restoreLocalDraft() {
  const saved = recoverableDraft.value;
  if (!saved || saved.revisionId !== revision.value?.revisionId || !editable.value) return;
  // Restore only editable text; immutable observations/steps/identities come from the server.
  for (const item of feedback.value) {
    const old = saved.feedback.find(f => f.criterionId === item.criterionId);
    if (old) { item.observation = old.observation; item.possibleCause = old.possibleCause; item.nextStep = old.nextStep;
      if (!old.possibleCause || old.causeSupport === 'insufficient') { item.causeSupport = 'insufficient'; item.causeEvidenceRefs = []; } }
  }
  for (const [target, value] of Object.entries(judgments.value)) {
    const old = saved.judgments[target];
    if (old?.targetId === value.targetId && old.targetType === value.targetType)
      judgments.value[target] = JSON.parse(JSON.stringify(old));
  }
  publicIds.value = saved.publicEvidenceIds.filter(id => publishableEvidence.value.some(e => e.evidenceId === id));
  correctionReason.value = saved.correctionReason;
  recoverableDraft.value = null; dirty.value = true;
  message.value = '草稿已恢复到编辑区，尚未保存到服务器。请核对后保存并重新确认。';
  persistDraft();
}
function keepRecoveredCopy() {
  if (!recoverableDraft.value || preservedDrafts.value.length >= 10) return;
  preservedDrafts.value.push(recoverableDraft.value); recoverableDraft.value = null; persistDraft();
}
function discardLocalDraft() {
  if (!window.confirm('删除此报告在本机保留的草稿和副本？服务器报告不会改变。')) return;
  recoverableDraft.value = null; preservedDrafts.value = []; persistDraft();
}
function noteSessionFailure(e: unknown) {
  if ((e as {status?: number})?.status === 401) sessionExpired.value = true;
}
async function restoreSession() {
  await act(async () => {
    try { await session.reauthenticate(sessionPassword.value); }
    finally { sessionPassword.value = ''; }
    sessionExpired.value = false;
    message.value = '已重新登录，未保存内容保持不变。请重新点击保存；若修订已变化，将提示你合并。';
  });
}
function downloadCurrentDraft() {
  if (!revision.value) return;
  downloadPreservedDraft({id:crypto.randomUUID(),revisionId:revision.value.revisionId,savedAt:new Date().toISOString(),
    feedback:JSON.parse(JSON.stringify(feedback.value)),judgments:JSON.parse(JSON.stringify(judgments.value)),
    publicEvidenceIds:[...publicIds.value],correctionReason:correctionReason.value});
}
const preservedDrafts = ref<Array<{
  id: string; revisionId: string; savedAt: string; feedback: FeedbackItem[];
  judgments: Record<string, any>; publicEvidenceIds: string[]; correctionReason: string;
}>>([]);
let analysisPolling = false;
let analysisPollController: AbortController | undefined;
const feedback = ref<FeedbackItem[]>([]),
  judgments = ref<Record<string, any>>({}),
  publicIds = ref<string[]>([]),
  correctionReason = ref("");
const publicSelectionBaseline = ref<string | null>(null);
const correctionReasonBaseline = ref("");
const publicationOptionsDirty = computed(() =>
  (publicSelectionBaseline.value !== null &&
    JSON.stringify([...publicIds.value].sort()) !== publicSelectionBaseline.value) ||
  correctionReason.value !== correctionReasonBaseline.value,
);
function rememberPublicationOptions() {
  publicSelectionBaseline.value = JSON.stringify([...publicIds.value].sort());
  correctionReasonBaseline.value = correctionReason.value;
}
const evidenceDisplay = ref<{
  id: string;
  text?: string;
  image?: string;
} | null>(null);
const evidenceBusy = ref(false);
const evidenceDialog = ref<HTMLDialogElement | null>(null);
const evidenceError = ref("");
const evidenceSelection = ref("");
let evidenceRequest = 0;
let evidenceController: AbortController | undefined;
function clearEvidence() {
  evidenceDialog.value?.close();
  if (evidenceDisplay.value?.image)
    URL.revokeObjectURL(evidenceDisplay.value.image);
  evidenceDisplay.value = null;
}
const supersededByPublicationId = ref<string | null>(null);
const comparison = ref<any>(null);
const comparisonError = ref("");
const changeLabels: Record<string, string> = {
  resolved: "已修复",
  regression: "出现回归",
  remaining: "仍未满足",
  unchanged: "保持满足",
  unknown: "无法判断变化",
};
let timer: ReturnType<typeof setInterval>;
let publicSelectionInitialized = false;
const teacher = computed(
  () => session.user?.role === "teacher" && !exactPublicationId,
);
const rule = computed<RuleSnapshot | null>(() =>
  teacher.value ? review.value?.rule : publication.value?.snapshot.ruleSnapshot,
);
const revision = computed<ReportRevision | null>(() =>
  teacher.value ? review.value?.revision : publication.value?.snapshot.revision,
);
const editable = computed(
  () =>
    teacher.value &&
    !!revision.value &&
    (!review.value?.latestPublication ||
      revision.value.originPublicationId ===
        review.value.latestPublication.publicationId),
);
const criteria = computed(
  () =>
    rule.value?.packManifest.criteria.filter((c) =>
      rule.value!.enabledCriterionIds.includes(c.criterionId),
    ) ?? [],
);
const current = computed(() =>
  criteria.value.find((c) => c.criterionId === selected.value),
);
const draft = computed(() =>
  feedback.value.find((f) => f.criterionId === selected.value),
);
const results = computed<CaseResult[]>(
  () =>
    (teacher.value
      ? review.value?.baseResults
      : publication.value?.snapshot.baseResults) ?? [],
);
const selectedResults = computed(() =>
  results.value.filter((r) => r.criterionId === selected.value),
);
const reviewed = computed<ReviewedCriterionResult[]>(
  () =>
    (teacher.value
      ? review.value?.reviewedResults
      : publication.value?.snapshot.reviewedResults) ?? [],
);
const evidence = computed<Evidence[]>(() =>
  teacher.value
    ? [
        ...(review.value?.baseManifest?.evidence ?? []),
        ...(review.value?.supplementalManifests ?? [])
          .filter((m: any) =>
            revision.value?.selectedSupplementalManifestIds.includes(
              m.manifestId,
            ),
          )
          .flatMap((m: any) => m.evidence),
      ]
    : (publication.value?.snapshot.publicEvidence ?? []),
);
const selectedEvidence = computed(() =>
  evidence.value.filter(
    (e) => e.scope === "run" || e.criterionId === selected.value,
  ),
);
const publishableEvidence = computed(() =>
  evidence.value.filter(
    (e) =>
      e.phase !== "diagnostic" && e.contentOrigin !== "platform_diagnostic",
  ),
);
const unselectedSupplementalEvidence = computed<Evidence[]>(() => teacher.value
  ? (review.value?.supplementalManifests ?? [])
      .filter((m:any) => !revision.value?.selectedSupplementalManifestIds.includes(m.manifestId))
      .flatMap((m:any) => m.evidence)
      .filter((e:Evidence) => e.criterionId === selected.value && e.phase === 'probe')
  : []);
const confirmation = (criterionId: string) =>
  revision.value?.confirmations.some(
    (c) =>
      c.criterionId === criterionId &&
      (!teacher.value ||
        c.contentHash === review.value?.criterionContentHashes[criterionId]),
  );
const confirmedCount = computed(
  () => criteria.value.filter((c) => confirmation(c.criterionId)).length,
);
const publicationBlockers = computed(() => {
  const reasons: string[] = [];
  if (recoverableDraft.value) reasons.push('请先处理待恢复的本机草稿。');
  if (sessionExpired.value) reasons.push('请先在本页重新登录，当前输入会保留。');
  if (busy.value) reasons.push('正在处理上一项操作，请等待完成。');
  if (dirty.value) reasons.push('反馈有未保存的修改，请先保存。');
  const creatingCorrection = review.value?.latestPublication && !editable.value;
  if (!creatingCorrection) {
    const pending = criteria.value.filter(c => !confirmation(c.criterionId));
    if (pending.length) reasons.push(`请逐项确认：${pending.map(c => c.title).join('、')}。`);
  }
  if ((creatingCorrection || revision.value?.originPublicationId) && !correctionReason.value.trim())
    reasons.push('请填写更正原因，说明原反馈需要修改的地方。');
  return reasons;
});
const labels: Record<string, string> = {
  passed: "满足要求",
  failed: "未满足",
  not_run: "未完成检查",
  manual: "待人工判断",
  completed: "基础检查已完成",
  build_error: "构建失败",
  infra_error: "执行环境异常",
  interrupted: "检查中断",
  cancelled: "已取消",
  queued: "等待检查",
  preparing: "准备中",
  building: "构建中",
  checking: "检查中",
};
function resetDraft() {
  feedback.value = JSON.parse(JSON.stringify(revision.value?.feedback ?? []));
  judgments.value = {};
  for (const criterion of criteria.value) {
    const targets =
      criterion.mode === "manual"
        ? [{ key: criterion.criterionId, targetType: "manualCriterion" }]
        : results.value
            .filter((r) => r.criterionId === criterion.criterionId)
            .map((r) => ({ key: r.caseId, targetType: "case" }));
    for (const target of targets) {
      const old = revision.value?.teacherJudgments.find(
        (j) => j.targetId === target.key && j.targetType === target.targetType,
      );
      judgments.value[target.key] = old
        ? {
            enabled: true,
            targetType: old.targetType,
            targetId: old.targetId,
            verdict: old.verdict,
            reason: old.reason,
            verificationMethod: old.verificationMethod,
            verificationNote: old.verificationNote,
            evidenceRefs: [...old.evidenceRefs],
          }
        : {
            enabled: false,
            targetType: target.targetType,
            targetId: target.key,
            verdict: "manual",
            reason: "",
            verificationMethod: "manual_reproduction",
            verificationNote: "",
            evidenceRefs: [],
          };
    }
  }
  const available = publishableEvidence.value.map((e) => e.evidenceId);
  publicIds.value = publicSelectionInitialized
    ? publicIds.value.filter((id) => available.includes(id))
    : available;
  // Polling may arrive before sealing: do not freeze an empty selection before
  // the actual report and its evidence have become available.
  if (revision.value) {
    if (!publicSelectionInitialized) rememberPublicationOptions();
    publicSelectionInitialized = true;
  }
  if (!criteria.value.some((c) => c.criterionId === selected.value)) {
    const pending = teacher.value
      ? criteria.value.find(c => !confirmation(c.criterionId))
        ?? criteria.value.find(c => reviewed.value.some(r =>
          r.criterionId === c.criterionId && r.reviewedVerdict !== 'passed'))
      : undefined;
    selected.value = (pending ?? criteria.value[0])?.criterionId ?? "";
  }
  dirty.value = false;
}
async function load() {
  if (exactPublicationId) {
    const result = await apiV2(`/publications/${exactPublicationId}`);
    publication.value = result.publication;
    supersededByPublicationId.value = result.supersededByPublicationId;
    runId.value = publication.value!.runId;
  }
  run.value = await apiV2(`/runs/${runId.value}`);
  if (teacher.value && run.value.baseSealed) {
    review.value = await apiV2(`/runs/${runId.value}/review`);
    comparisonError.value = "";
    try {
      comparison.value = await apiV2(`/runs/${runId.value}/comparison`);
    } catch {
      comparisonError.value = "暂时无法读取复提对比，仍可继续复核当前报告。";
    }
  } else if (
    !teacher.value &&
    !exactPublicationId &&
    run.value.report.latestPublication
  )
    publication.value = (
      await apiV2(
        `/publications/${run.value.report.latestPublication.publicationId}`,
      )
    ).publication;
  resetDraft();
  readLocalDraft();
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
    noteSessionFailure(e);
    if (['REVISION_CONFLICT', 'CONTENT_HASH_CONFLICT', 'CORRECTION_ORIGIN_CONFLICT'].includes((e as {code?: string}).code ?? ''))
      revisionConflict.value = true;
  } finally {
    busy.value = false;
  }
}
const request = (body: unknown) => ({
  method: "POST",
  headers: { "Idempotency-Key": crypto.randomUUID() },
  body: JSON.stringify(body),
});
async function recoverRevision() {
  if (busy.value) return;
  if ((dirty.value || publicationOptionsDirty.value) && preservedDrafts.value.length >= 10) {
    error.value = '已有10份草稿副本，请先下载保留的草稿并清理副本，再核对最新修订。当前输入仍保留。';
    return;
  }
  if ((dirty.value || publicationOptionsDirty.value) && revision.value) preservedDrafts.value.push({
    id: crypto.randomUUID(), revisionId: revision.value.revisionId, savedAt: new Date().toISOString(),
    feedback: JSON.parse(JSON.stringify(feedback.value)),
    judgments: JSON.parse(JSON.stringify(judgments.value)),
    publicEvidenceIds: [...publicIds.value], correctionReason: correctionReason.value,
  });
  await act(async () => {
    await load();
    revisionConflict.value = false;
    writeUnknown.value = false;
    message.value = '已载入最新修订。保留的本地草稿可在下方查看，请对照后逐项合并。';
  });
}
function downloadPreservedDraft(draft: (typeof preservedDrafts.value)[number]) {
  const url = URL.createObjectURL(new Blob([JSON.stringify({runId: runId.value, ...draft}, null, 2)], {type:'application/json'}));
  const link = document.createElement('a');link.href=url;link.download=`codelab-local-draft-${draft.id}.json`;
  document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),10000);
}
const activeAnalysis = computed(() =>
  review.value?.analyses?.find((a: any) =>
    ["queued", "running"].includes(a.status),
  ),
);
const analysisStrategy = ref<"summary" | "agent">("agent");
const exportingAnalysisId = ref("");
let exportController: AbortController | undefined;
async function exportPair(analysisId: string) {
  if (exportingAnalysisId.value) return;
  exportingAnalysisId.value = analysisId;
  error.value = "";
  let url: string | undefined;
  const controller = new AbortController();
  exportController = controller;
  let timedOut = false;
  const timeout = window.setTimeout(() => { timedOut = true; controller.abort(); }, 60000);
  try {
    const response = await fetch(
      `/api/v2/runs/${runId.value}/analyses/${analysisId}/export`,
      { credentials: "same-origin", signal: controller.signal },
    );
    if (!response.ok) {
      const body = await response.json();
      throw new Error(body.error?.message ?? "材料导出失败，请重试");
    }
    const blob = await response.blob();
    controller.signal.throwIfAborted();
    url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `codelab-pair-${analysisId}.zip`;
    document.body.append(link);
    link.click();
    link.remove();
    message.value =
      "配对材料已下载。包含私有证据及模型原始记录，请妥善保存；人工评测尚需单独记录。";
  } catch (e) {
    if (timedOut) error.value = "配对材料下载等待超过60秒，请检查连接后重新下载。已有报告和分析记录保持不变。";
    else if (!controller.signal.aborted) error.value = e instanceof Error ? e.message : "材料导出失败";
  } finally {
    window.clearTimeout(timeout);
    if (exportController === controller) exportController = undefined;
    if (url) setTimeout(() => URL.revokeObjectURL(url!), 10_000);
    exportingAnalysisId.value = "";
  }
}
const pairedWithAnalysisId = ref("");
const pairOptions = computed(() =>
  (review.value?.analyses ?? []).filter(
    (a: any) =>
      a.mode === "reanalysis" &&
      a.base_input_hash &&
      a.strategy !== analysisStrategy.value &&
      ["succeeded", "degraded", "interrupted", "cancelled"].includes(a.status),
  ),
);
const strategyLabel = (strategy: string) =>
  strategy === "summary" ? "一次性总结" : "Agent 调查";
const analysisStatusLabel = (status: string) =>
  ({
    queued: "排队中",
    running: "执行中",
    succeeded: "候选已生成",
    degraded: "未生成候选",
    interrupted: "已中断",
    cancelled: "已取消",
  })[status] ?? status;
let analysisRequest: { signature: string; key: string } | undefined;
async function reanalyze() {
  if (
    dirty.value ||
    !revision.value ||
    activeAnalysis.value ||
    !review.value?.analysisAvailable
  )
    return;
  await act(async () => {
    const revisionId = revision.value!.revisionId;
    const body = {
      expectedRevisionId: revisionId,
      strategy: analysisStrategy.value,
      ...(pairedWithAnalysisId.value
        ? { pairedWithAnalysisId: pairedWithAnalysisId.value }
        : {}),
    };
    const signature = canonicalJson(body);
    if (analysisRequest?.signature !== signature)
      analysisRequest = { signature, key: crypto.randomUUID() };
    const outcome = await mutate(`/runs/${runId.value}/analyses`, {
      ...request(body),
      headers: { "Idempotency-Key": analysisRequest!.key },
    });
    analysisRequest = undefined;
    const fresh = await apiV2(`/runs/${runId.value}/review`);
    review.value.analyses = fresh.analyses;
    message.value = ["queued", "running"].includes(outcome.analysis.status)
      ? "重新分析已排队，将生成独立候选，不会改动当前报告。"
      : "已找到上次请求的结果，没有重复发起分析。";
  });
}
async function cancelAnalysis() {
  const analysis = activeAnalysis.value;
  if (!analysis || analysis.mode !== "reanalysis") return;
  await act(async () => {
    await mutate(
      `/runs/${runId.value}/analyses/${analysis.id}/cancel`,
      request({}),
    );
    const fresh = await apiV2(`/runs/${runId.value}/review`);
    review.value.analyses = fresh.analyses;
    message.value = "分析已取消；已领取的资源会继续清理，当前报告保持不变。";
  });
}
async function save() {
  if (!editable.value || recoverableDraft.value) return;
  await act(async () => {
    const changes = Object.values(judgments.value)
      .filter((j) => j.enabled)
      .map(({ enabled: _enabled, ...judgment }) => judgment)
      .filter((judgment) => {
        const old = revision.value!.teacherJudgments.find(
          (j) =>
            j.targetId === judgment.targetId &&
            j.targetType === judgment.targetType,
        );
        if (!old) return true;
        const {
          judgmentId: _id,
          judgedBy: _author,
          judgedAt: _date,
          ...content
        } = old;
        return canonicalJson(content) !== canonicalJson(judgment);
      });
    const remove = revision
      .value!.teacherJudgments.filter(
        (j) => !judgments.value[j.targetId]?.enabled,
      )
      .map((j) => ({ targetType: j.targetType, targetId: j.targetId }));
    await mutate(`/runs/${runId.value}/review`, {
      ...request({
        expectedRevisionId: revision.value!.revisionId,
        feedbackChanges: feedback.value,
        teacherJudgments: changes,
        removeJudgments: remove,
      }),
      method: "PUT",
    });
    await load();
    message.value = "修改已保存。内容变化的条目需要重新确认。";
  });
}
async function confirmItem() {
  if (dirty.value || !editable.value || recoverableDraft.value) return;
  await act(async () => {
    await mutate(
      `/runs/${runId.value}/review/confirm`,
      request({
        expectedRevisionId: revision.value!.revisionId,
        items: [
          {
            criterionId: selected.value,
            contentHash: review.value.criterionContentHashes[selected.value],
          },
        ],
      }),
    );
    await load();
    message.value = "本条内容已确认，确认不会改变检查结论。";
  });
}
async function publish() {
  if (dirty.value || !editable.value || recoverableDraft.value) return;
  await act(async () => {
    const correction = !!revision.value!.originPublicationId;
    const result = await mutate(
      `/runs/${runId.value}/publications`,
      request({
        expectedRevisionId: revision.value!.revisionId,
        purpose: correction ? "historical_correction" : "latest",
        publicEvidenceIds: publicIds.value,
        ...(correction
          ? {
              expectedLatestPublicationId: revision.value!.originPublicationId,
              correctionReason: correctionReason.value,
            }
          : {}),
      }),
    );
    await load();
    correctionReason.value = "";
    rememberPublicationOptions();
    message.value = `报告已发布，版本 ${result.publication.publicationNo}。`;
  });
}
async function createCorrection() {
  if (dirty.value || recoverableDraft.value) return;
  await act(async () => {
    const latest = review.value.latestPublication.publicationId;
    await mutate(
      `/publications/${latest}/corrections`,
      request({
        expectedRevisionId: revision.value!.revisionId,
        expectedLatestPublicationId: latest,
        correctionReason: correctionReason.value,
      }),
    );
    await load();
    correctionReasonBaseline.value = correctionReason.value;
    message.value = "已基于已发布版本创建更正草稿，请核对并重新确认。";
  });
}
async function adopt(candidateId: string, criterionId = selected.value) {
  if (dirty.value || !editable.value || recoverableDraft.value) return;
  await act(async () => {
    await mutate(
      `/runs/${runId.value}/review/adopt`,
      request({
        expectedRevisionId: revision.value!.revisionId,
        candidateId,
        criterionIds: [criterionId],
      }),
    );
    await load();
    message.value = "已采纳本条候选，等待教师核对。";
  });
}
async function openEvidence(item: Evidence) {
  const requestId = ++evidenceRequest;
  evidenceController?.abort();
  evidenceController = new AbortController();
  const controller = evidenceController;
  let timedOut = false;
  const timeout = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 15000);
  clearEvidence();
  evidenceSelection.value = item.evidenceId;
  evidenceBusy.value = true;
  evidenceError.value = "";
  try {
    const url = teacher.value
      ? `/api/v2/runs/${runId.value}/evidence/${item.evidenceId}`
      : `/api/v2/publications/${publication.value!.publicationId}/evidence/${item.evidenceId}`;
    const response = await fetch(url, {
      credentials: "same-origin",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error("证据暂不可用，请重新选择或稍后重试。");
    const body =
      item.mediaType === "image/png"
        ? await response.blob()
        : await response.text();
    controller.signal.throwIfAborted();
    if (requestId !== evidenceRequest) return;
    evidenceDisplay.value =
      body instanceof Blob
        ? { id: item.evidenceId, image: URL.createObjectURL(body) }
        : { id: item.evidenceId, text: body };
  } catch (e) {
    if (requestId === evidenceRequest) {
      if (timedOut) evidenceError.value = "证据读取超时，请重试。已保存的报告和反馈不受影响。";
      else if ((e as Error).name !== "AbortError")
        evidenceError.value = "证据暂不可用，请重试或稍后再查看。";
    }
  } finally {
    window.clearTimeout(timeout);
    if (requestId === evidenceRequest) evidenceBusy.value = false;
  }
}
function retryEvidence() {
  const item = selectedEvidence.value.find(e => e.evidenceId === evidenceSelection.value);
  if (item) void openEvidence(item);
}
function studioEvidence(_criterionId: string, evidenceId: string) {
  const items: Evidence[] = [...(review.value?.baseManifest?.evidence ?? []),
    ...(review.value?.supplementalManifests ?? []).flatMap((m: any) => m.evidence)];
  const item = items.find(e => e.evidenceId === evidenceId);
  if (item) void openEvidence(item);
  else error.value = '这条引用的证据当前不可读取，请在候选记录中核对。';
}
watch(
  () => [
    selected.value,
    selectedEvidence.value.map((e) => e.evidenceId).join(","),
  ],
  () => {
    ++evidenceRequest;
    evidenceController?.abort();
    clearEvidence();
    evidenceSelection.value = "";
    evidenceError.value = "";
    evidenceBusy.value = false;
    const initial =
      selectedEvidence.value.find((e) => e.mediaType === "image/png") ??
      selectedEvidence.value[0];
    if (initial) void openEvidence(initial);
  },
);
function changeJudgment(key: string, event: Event) {
  const value = (event.target as HTMLSelectElement).value;
  judgments.value[key].enabled = value !== "original";
  if (value !== "original") judgments.value[key].verdict = value;
  dirty.value = true;
}
function toggleJudgmentEvidence(
  target: string,
  item: Evidence,
  checked: boolean,
) {
  const refs = judgments.value[target].evidenceRefs.filter(
    (ref: any) => ref.evidenceId !== item.evidenceId,
  );
  if (checked)
    refs.push({
      scope: "current",
      manifestId: item.manifestId,
      evidenceId: item.evidenceId,
    });
  judgments.value[target].evidenceRefs = refs;
  dirty.value = true;
}
const judgmentTargets = computed(() =>
  current.value?.mode === "manual"
    ? [current.value.criterionId]
    : selectedResults.value.map((r) => r.caseId),
);
const judgmentEvidence = (target: string) =>
  publishableEvidence.value.filter(
    (item) =>
      item.caseId === target ||
      (current.value?.mode === "manual" && item.criterionId === target),
  );
const needsLeaveWarning = computed(() => teacher.value &&
  (dirty.value || publicationOptionsDirty.value || busy.value || preservedDrafts.value.length > 0));
function confirmLeave() {
  return !needsLeaveWarning.value || window.confirm(
    "当前有未保存的修改、进行中的操作或页面内草稿副本。离开可能丢失内容；请先保存修改并下载需要保留的副本。仍要离开吗？",
  );
}
onBeforeRouteLeave(confirmLeave);
onBeforeRouteUpdate(confirmLeave);
const removeLogoutGuard = session.beforeLogout(confirmLeave);
function warnBeforeUnload(event: BeforeUnloadEvent) {
  persistDraft();
  if (!needsLeaveWarning.value) return;
  event.preventDefault();
  event.returnValue = "";
}
onMounted(async () => {
  window.addEventListener("beforeunload", warnBeforeUnload);
  await act(load);
  timer = setInterval(() => {
    if (sessionExpired.value) return;
    if (teacher.value && run.value?.baseSealed && !busy.value) {
      if (analysisPolling) return;
      analysisPolling = true;
      // Candidate polling must never reset unsaved teacher edits or advance the CAS head.
      const controller = new AbortController();
      analysisPollController = controller;
      const timeout = window.setTimeout(() => controller.abort(), 15000);
      void apiV2(`/runs/${runId.value}/review`, {signal: controller.signal})
        .then((fresh) => {
          controller.signal.throwIfAborted();
          analysisStale.value = false;
          if (review.value) {
            review.value.candidates = fresh.candidates;
            review.value.analyses = fresh.analyses;
          }
        })
        .catch((e) => { analysisStale.value = true; noteSessionFailure(e); })
        .finally(() => {
          window.clearTimeout(timeout);
          if (analysisPollController === controller) analysisPollController = undefined;
          analysisPolling = false;
        });
      return;
    }
    // A sealed run can still be awaiting its first teacher publication. Keep that
    // student page current, but never silently replace an explicitly opened snapshot.
    if (
      !busy.value &&
      !dirty.value &&
      run.value &&
      ((!run.value.baseSealed && !["cancelled"].includes(run.value.status)) ||
        (!teacher.value && !exactPublicationId && !publication.value))
    )
      void act(load);
  }, 4000);
});
watch([feedback, judgments, publicIds, correctionReason, dirty, publicationOptionsDirty, preservedDrafts], persistDraft, {deep:true,flush:'post'});
onUnmounted(() => {
  exportController?.abort();
  reviewWriteController?.abort();
  analysisPollController?.abort();
  removeLogoutGuard();
  window.removeEventListener("beforeunload", warnBeforeUnload);
  clearInterval(timer);
  ++evidenceRequest;
  evidenceController?.abort();
  clearEvidence();
});
</script>
<template>
  <RouterLink v-if="run" :to="'/tasks/' + run.taskId" class="back"
    >← 返回任务</RouterLink
  >
  <p v-if="error" class="error" role="alert">{{ error }}</p>
  <p v-if="message" class="notice" role="status">{{ message }}</p>
  <section v-if="teacher && sessionExpired" class="panel" aria-label="重新登录并保留草稿">
    <h2>登录已过期，当前输入仍在</h2>
    <p>无需刷新页面。为 {{ session.user?.email }} 重新登录后，再保存修改；不会自动提交或覆盖新修订。</p>
    <form @submit.prevent="restoreSession">
      <label>当前账号密码<input v-model="sessionPassword" type="password" autocomplete="current-password" required :disabled="busy" /></label>
      <button type="submit" :disabled="busy || !sessionPassword">重新登录并继续编辑</button>
    </form>
    <button v-if="revision" :disabled="busy" @click="downloadCurrentDraft">下载当前未保存草稿</button>
    <p class="muted">草稿包含未发布的教师内容，请妥善保存。下方显示本机备份状态；存储受限时请下载备份。</p>
  </section>
  <section v-if="teacher && (revisionConflict || writeUnknown)" class="panel" aria-label="修订冲突处理">
    <h2>{{ writeUnknown ? '操作结果待核对' : '报告已有新修订' }}</h2>
    <p>你的输入仍保留在页面中。先保留本地草稿并载入最新内容，再对照合并；不会自动覆盖其他人的修改。</p>
    <button :disabled="busy" @click="recoverRevision">保留草稿并载入最新修订</button>
  </section>
  <section v-if="teacher && preservedDrafts.length" class="panel" aria-label="保留的本地草稿">
    <h2>保留的本地草稿</h2>
    <p class="muted">副本随本机草稿保留，未提交到服务器。需要长期保留时请下载；公共电脑使用后请删除本机副本。</p>
    <details v-for="backup in preservedDrafts" :key="backup.id">
      <summary>{{ new Date(backup.savedAt).toLocaleString('zh-CN') }} 的未保存内容</summary>
      <button @click="downloadPreservedDraft(backup)">下载此草稿副本</button>
      <article v-for="item in backup.feedback" :key="item.criterionId">
        <h3>{{ criteria.find(c => c.criterionId === item.criterionId)?.title ?? item.criterionId }}</h3>
        <p>事实与观察：{{ item.observation }}</p>
        <p>可能原因：{{ item.possibleCause || '未填写' }}</p>
        <p>建议的下一步：{{ item.nextStep }}</p>
      </article>
      <p class="muted">教师判断、证据选择和更正理由同时保留在下载副本中；不会自动应用到新修订。</p>
    </details>
  </section>
  <div class="page-heading">
    <div>
      <h1>{{ teacher ? "验收报告复核" : "项目验收报告" }}</h1>
      <p class="muted">
        {{ labels[run?.status] ?? "正在读取"
        }}<template v-if="revision">
          · {{ teacher ? "修订" : "发布" }}
          {{
            teacher ? revision.revisionNo : publication?.publicationNo
          }}</template
        >
      </p>
    </div>
    <button :disabled="busy || dirty" @click="act(load)">刷新报告</button>
  </div>
  <section v-if="teacher && revision" class="panel draft-recovery" :class="{ 'draft-recovery-quiet': !recoverableDraft && !localDraftError }" aria-label="本机草稿恢复">
    <div>
      <h2>{{ recoverableDraft ? '找到了未保存的草稿' : '本机草稿保护' }}</h2>
      <p v-if="recoverableDraft">{{ new Date(recoverableDraft.savedAt).toLocaleString('zh-CN') }} 保存于此浏览器。
        {{ recoverableDraft.revisionId === revision.revisionId && editable ? '版本一致，可恢复到编辑区后核对。' : '服务器版本已变化或已发布，请保留为副本，逐项对照合并。' }}</p>
      <p v-else-if="localDraftSavedAt">未保存内容已备份到本机 · {{ new Date(localDraftSavedAt).toLocaleTimeString('zh-CN') }}</p>
      <p v-else class="muted">编辑时自动备份，7天未更新后再次读取时清除。仅限本浏览器，不是服务器保存；同一浏览器配置的使用者可能读取这些内容。</p>
      <p v-if="localDraftError" class="error" role="alert">{{ localDraftError }}</p>
    </div>
    <div class="draft-recovery-actions">
      <button v-if="recoverableDraft && recoverableDraft.revisionId === revision.revisionId && editable" :disabled="busy" @click="restoreLocalDraft">恢复到编辑区</button>
      <button v-if="recoverableDraft" :disabled="busy || preservedDrafts.length >= 10" @click="keepRecoveredCopy">保留为副本并继续</button>
      <button v-if="recoverableDraft" @click="downloadPreservedDraft(recoverableDraft)">下载待恢复草稿</button>
      <button v-if="localDraftError" @click="downloadCurrentDraft">下载当前未保存草稿</button>
      <button v-if="recoverableDraft || preservedDrafts.length" :disabled="busy" @click="discardLocalDraft">删除本机草稿副本</button>
    </div>
  </section>
  <p v-if="run && !revision" class="notice">
    {{
      teacher
        ? "基础结果尚未就绪，请等待检查完成。"
        : "教师尚未发布反馈，请稍后查看。"
    }}
  </p>
  <template v-if="revision && rule">
    <section class="review-hero" aria-labelledby="report-title">
      <div>
        <p class="eyebrow">
          {{ teacher ? "核对证据 · 完成反馈" : "教师已发布" }}
        </p>
        <h2 id="report-title">
          {{ teacher ? "逐项验收，确认后发布" : "你的项目验收反馈" }}
        </h2>
        <p class="review-hero-copy">
          {{
            teacher
              ? "先核对运行证据，再给出可解释的教师判断。每一项确认后才能进入发布。"
              : "教师已将运行结果、判断依据和下一步建议整理成这份反馈。"
          }}
        </p>
      </div>
      <div
        class="review-progress"
        aria-label="验收进度"
        :style="{
          '--progress':
            (criteria.length ? (confirmedCount / criteria.length) * 100 : 0) +
            '%',
        }"
      >
        <strong
          ><AnimatedNumber :value="confirmedCount" /><span>/{{ criteria.length }}</span></strong
        >
        <small>已确认条目</small>
      </div>
    </section>
    <p v-if="supersededByPublicationId" class="notice">
      此版本已有更正，原内容仍保留。<RouterLink
        :to="'/publications/' + supersededByPublicationId"
        >查看后续更正版本</RouterLink
      >
    </p>
    <p v-if="teacher && !editable" class="notice">
      当前内容已经发布。如需修改，请在下方填写原因并建立更正草稿。
    </p>
    <p v-if="teacher && dirty" class="notice">
      有未保存的修改，请先保存，再确认与发布。
    </p>
    <div id="review-evidence" class="review-layout v2-report">
      <nav class="review-nav" aria-label="验收条目">
        <div class="review-nav-heading">
          <span>验收清单</span
          ><small>{{ confirmedCount }}/{{ criteria.length }} 已确认</small>
        </div>
        <button
          v-for="criterion in criteria"
          :key="criterion.criterionId"
          :class="[
            'review-nav-item',
            { active: selected === criterion.criterionId },
          ]"
          :aria-pressed="selected === criterion.criterionId"
          @click="selected = criterion.criterionId"
        >
          <span class="review-nav-index">{{ criterion.displayCode }}</span>
          <span class="review-nav-copy"
            ><strong>{{ criterion.title }}</strong
            ><small
              >{{
                labels[
                  reviewed.find(
                    r => r.criterionId === criterion.criterionId,
                  )?.reviewedVerdict ?? 'not_run'
                ]
              }}{{
                confirmation(criterion.criterionId) ? " · 已确认" : ""
              }}</small
            ></span
          >
        </button>
      </nav>
      <section v-if="current && draft" class="panel v2-detail">
        <header class="criterion-heading">
          <span class="tag mono">{{ current.displayCode }}</span>
          <div>
            <h2>{{ current.title }}</h2>
            <p>{{ current.expectedBehavior }}</p>
          </div>
        </header>
        <div class="review-split">
          <div class="evidence-workspace">
            <h3>可查看的证据</h3>
            <div
              class="evidence-selector"
              role="group"
              aria-label="选择运行证据"
            >
              <button
                v-for="item in selectedEvidence"
                :key="item.evidenceId"
                :aria-pressed="evidenceSelection === item.evidenceId"
                @click="openEvidence(item)"
              >
                {{ item.caseId ?? "运行记录" }} ·
                {{ item.mediaType === "image/png" ? "截图" : "文字证据" }}
              </button>
              <p v-if="!selectedEvidence.length" class="muted">
                没有可读取的证据文件，按上方实际状态理解结论。
              </p>
            </div>
            <details v-if="unselectedSupplementalEvidence.length" class="supplemental-preview">
              <summary>尚未纳入报告的补充材料 · {{ unselectedSupplementalEvidence.length }} 份</summary>
              <p class="muted small">可先查看再决定是否采用。查看不会修改教师判断，也不会自动向学生公开。</p>
              <div class="evidence-selector" role="group" aria-label="查看未采纳的补充材料">
                <button v-for="(item,index) in unselectedSupplementalEvidence" :key="item.evidenceId"
                  :aria-pressed="evidenceSelection === item.evidenceId" @click="openEvidence(item)">
                  补充{{ item.mediaType === 'image/png' ? '截图' : '观察' }} {{ index + 1 }} · {{ item.evidenceId.slice(0,8) }}
                </button>
              </div>
            </details>
            <p v-if="evidenceBusy" class="evidence-loading" role="status">
              正在读取运行证据…
            </p>
            <p v-if="evidenceError" class="error" role="alert">
              {{ evidenceError }}
            </p>
            <button v-if="evidenceError && !evidenceBusy" class="text-button" @click="retryEvidence">
              重试读取证据
            </button>
            <div v-if="evidenceDisplay" class="v2-evidence">
              <img
                v-if="evidenceDisplay.image"
                :src="evidenceDisplay.image"
                alt="当前报告的运行截图"
              />
              <pre v-else>{{ evidenceDisplay.text }}</pre>
            </div>
            <button
              v-if="evidenceDisplay"
              class="text-button evidence-enlarge"
              @click="evidenceDialog?.showModal()"
            >
              放大查看证据 ↗
            </button>
            <dialog
              ref="evidenceDialog"
              class="evidence-dialog"
              aria-labelledby="evidence-dialog-title"
            >
              <div class="section-heading">
                <h2 id="evidence-dialog-title">
                  运行证据 · {{ current.title }}
                </h2>
                <button
                  type="button"
                  autofocus
                  @click="evidenceDialog?.close()"
                >
                  关闭
                </button>
              </div>
              <img
                v-if="evidenceDisplay?.image"
                :src="evidenceDisplay.image"
                :alt="current.title + '的运行截图，放大查看'"
              />
              <pre v-else>{{ evidenceDisplay?.text }}</pre>
            </dialog>

            <h3 class="facts-title">实际检查结果</h3>
            <section
              v-for="result in selectedResults"
              :key="result.caseId"
              class="v2-case"
            >
              <h3>
                {{ result.caseId }} · 原始检查：{{ labels[result.verdict] }}
              </h3>
              <p>{{ result.observed }}</p>
              <p v-if="result.blockedBy.length" class="notice">
                检查受阻：{{
                  result.blockedBy
                    .map((b) => b.id + " · " + b.reasonCode)
                    .join("；")
                }}
              </p>
              <details>
                <summary>实际执行过程</summary>
                <ol v-if="result.executedSteps.length">
                  <li v-for="step in result.executedSteps" :key="step.stepId">
                    {{ step.observation }}（{{
                      step.state === "completed"
                        ? "完成"
                        : step.state === "failed"
                          ? "失败"
                          : "中断"
                    }}）
                  </li>
                </ol>
                <p v-else>没有已确认执行的步骤。</p>
                <p v-if="result.unexecutedStepIds.length">
                  尚未执行：{{ result.unexecutedStepIds.join("、") }}
                </p>
              </details>
            </section>
          </div>
          <div class="feedback-workspace">
            <p class="eyebrow">
              {{ teacher ? "教师反馈" : "YOUR NEXT STEP" }}
            </p>
            <fieldset v-if="editable" class="feedback-edit-fields" :disabled="busy || !!recoverableDraft" aria-label="编辑教师反馈"
              ><h3>给学生的反馈</h3>
              <label
                >事实与观察<textarea
                  v-model="draft.observation"
                  rows="4"
                  @input="dirty = true"
                /></label
              ><label
                >可能原因<textarea
                  v-model="draft.possibleCause"
                  rows="2"
                  @input="
                    dirty = true;
                    if (!draft.possibleCause) {
                      draft.causeSupport = 'insufficient';
                      draft.causeEvidenceRefs = [];
                    }
                  "
                />
              </label>
              <p class="hint">
                原因支持程度：{{
                  {
                    direct: "有直接材料",
                    limited: "有限支持",
                    insufficient: "证据不足",
                  }[draft.causeSupport]
                }}。补充判断应说明依据。
              </p>
              <label
                >建议的下一步<textarea
                  v-model="draft.nextStep"
                  rows="3"
                  @input="dirty = true"
                />
              </label>
              <details>
                <summary>补充教师判断（保留原始检查）</summary>
                <section
                  v-for="target in judgmentTargets"
                  :key="target"
                  class="v2-case"
                >
                  <label
                    >{{ target }} 的教师判断<StudioSelect
                      :value="
                        judgments[target]?.enabled
                          ? judgments[target]?.verdict
                          : 'original'
                      "
                      @change="changeJudgment(target, $event)"
                    >
                      <option value="original">沿用原始检查 / 暂不判断</option>
                      <option value="passed">满足要求</option>
                      <option value="failed">未满足</option>
                      <option value="not_run">未完成检查</option>
                      <option value="manual">待人工判断</option>
                    </StudioSelect></label
                  ><template v-if="judgments[target]?.enabled"
                    ><label
                      >判断理由<textarea
                        v-model="judgments[target].reason"
                        @input="dirty = true"
                      /></label
                    ><label
                      >核实方式<StudioSelect
                        v-model="judgments[target].verificationMethod"
                        @change="dirty = true"
                      >
                        <option value="manual_reproduction">人工复现</option>
                        <option value="evidence_review">
                          证据复核（需要已关联证据）
                        </option>
                        <option value="other_documented">
                          其他有记录的核实
                        </option>
                      </StudioSelect></label
                    ><label
                      >核实记录<textarea
                        v-model="judgments[target].verificationNote"
                        placeholder="记录实际核实步骤和结果"
                        @input="dirty = true"
                      />
                    </label>
                    <fieldset>
                      <legend>关联判断依据</legend>
                      <label
                        v-for="item in judgmentEvidence(target)"
                        :key="item.evidenceId"
                        class="v2-check"
                        ><input
                          type="checkbox"
                          :checked="
                            judgments[target].evidenceRefs.some(
                              (ref: any) => ref.evidenceId === item.evidenceId,
                            )
                          "
                          @change="
                            toggleJudgmentEvidence(
                              target,
                              item,
                              ($event.target as HTMLInputElement).checked,
                            )
                          "
                        />{{ item.caseId ?? item.criterionId }} ·
                        {{ item.mediaType }}</label
                      >
                      <p v-if="!judgmentEvidence(target).length" class="hint">
                        当前没有可关联的条目证据，请记录实际人工核实过程。
                      </p>
                    </fieldset></template
                  >
                </section>
              </details>
              <div class="actions">
                <button :disabled="busy || !dirty" @click="save">
                  保存修改</button
                ><button
                  class="primary"
                  :disabled="busy || dirty || confirmation(selected)"
                  @click="confirmItem"
                >
                  {{ confirmation(selected) ? "本条已确认" : "确认本条内容" }}
                </button>
              </div>
              <details v-if="review?.candidates?.length">
                <summary>模型候选（需明确采纳）</summary>
                <section
                  v-for="candidate in review.candidates"
                  :key="candidate.candidateId"
                >
                  <h4>
                    {{ strategyLabel(candidate.strategy) }} ·
                    {{ candidate.candidateId.slice(0, 8) }}
                  </h4>
                  <template
                    v-for="item in candidate.feedback.filter(
                      (f: FeedbackItem) => f.criterionId === selected,
                    )"
                    :key="item.criterionId"
                    ><p>{{ item.observation }}</p>
                    <p>{{ item.nextStep }}</p>
                    <button
                      :disabled="busy || dirty"
                      @click="adopt(candidate.candidateId)"
                    >
                      采纳本条候选
                    </button></template
                  >
                </section>
              </details>
            </fieldset>
            <template v-else
              ><h3>教师反馈</h3>
              <p>{{ draft.observation }}</p>
              <p v-if="draft.possibleCause">
                可能原因：{{ draft.possibleCause }}
              </p>
              <h3>下一步</h3>
              <p>
                {{
                  draft.nextStep || "当前要求已满足，后续修改请保持已验证行为。"
                }}
              </p>
              <section
                v-for="judgment in revision.teacherJudgments.filter((j) =>
                  judgmentTargets.includes(j.targetId),
                )"
                :key="judgment.judgmentId"
                class="notice"
              >
                <strong>教师判断：{{ labels[judgment.verdict] }}</strong>
                <p>{{ judgment.reason }}</p>
                <p>{{ judgment.verificationNote }}</p>
              </section></template
            >
          </div>
        </div>
      </section>
    </div>
    <RouterLink to="/projects" class="back">直接上传普通项目 ZIP，开始 AI 项目解读 →</RouterLink>
    <section v-if="teacher && review?.personalModelBilling" class="course-model-choice section-heading">
      <div><strong>使用我的模型分析</strong><p class="muted small">{{ review.analysisAvailable ? '下方 AI 总结与 Agent 分析使用当前教师账号的密钥，费用由该密钥所属账户承担。' : '请先配置自己的模型。基础报告仍可复核和发布，不会借用学生或平台的密钥。' }}</p></div>
      <button @click="modelDialog?.open()" :disabled="busy">模型设置</button>
    </section>
    <PersonalModelDialog ref="modelDialog" @changed="refreshModelAvailability" />
    <PublicationComparison v-if="!teacher && publication" :publication-id="publication.publicationId" />
    <AgentStudio v-if="teacher && review" :analyses="review.analyses ?? []"
      :candidates="review.candidates ?? []" :results="results" :criteria="criteria"
      :available="!!review.analysisAvailable" :busy="busy" :dirty="dirty" :editable="editable" :stale="analysisStale"
      @start="analysisStrategy = 'agent'; reanalyze()" @cancel="cancelAnalysis"
      @select="selected = $event" @adopt="adopt" @evidence="studioEvidence" />
    <div class="report-tools">
      <details v-if="teacher && review" class="analysis-drawer">
        <summary>分析设置与历史 <span>分析方式与导出记录</span></summary>
        <p v-if="teacher && review" class="muted" aria-live="polite">
          <template v-if="review.analyses?.[0]?.status === 'queued'"
            >重新分析已排队，当前报告仍可复核。</template
          >
          <template v-else-if="review.analyses?.[0]?.status === 'running'"
            >正在整理 AI 候选建议，你可以先复核基础报告。</template
          >
          <template v-else-if="review.analyses?.[0]?.status === 'succeeded'"
            >AI
            候选建议已就绪，可在各项要求中预览并选择采用；尚未改动教师报告。</template
          >
          <template v-else-if="review.analyses?.length"
            >AI 建议暂不可用，基础检查证据与报告仍可正常确认、发布。</template
          >
          <template v-else
            >当前使用基础检查报告；配置模型后，新检查可生成 AI
            候选建议。</template
          >
        </p>
        <div v-if="teacher && review" class="analysis-actions">
          <label
            >分析方式
            <StudioSelect
              v-model="analysisStrategy"
              aria-label="分析方式"
              :disabled="busy || !!activeAnalysis || !review.analysisAvailable"
              @change="pairedWithAnalysisId = ''"
            >
              <option value="agent">Agent 调查 · 可查阅材料和补查</option>
              <option value="summary">一次性总结 · 仅整理基础文字</option>
            </StudioSelect>
          </label>
          <label v-if="pairOptions.length"
            >对照已有分析（可选）
            <StudioSelect
              v-model="pairedWithAnalysisId"
              aria-label="对照已有分析（可选）"
              :disabled="busy || !!activeAnalysis || !review.analysisAvailable"
            >
              <option value="">独立分析</option>
              <option
                v-for="analysis in pairOptions"
                :key="analysis.id"
                :value="analysis.id"
              >
                {{ strategyLabel(analysis.strategy) }} ·
                {{ analysisStatusLabel(analysis.status) }} ·
                {{ analysis.id.slice(0, 8) }}
              </option>
            </StudioSelect>
          </label>
          <button
            type="button"
            :disabled="
              busy || dirty || !!activeAnalysis || !review.analysisAvailable
            "
            @click="reanalyze"
          >
            重新分析存档
          </button>
          <span class="muted">{{
            !review.analysisAvailable
              ? "模型未配置，基础报告可正常使用。"
              : dirty
                ? "请先保存报告修改。"
                : "读取已有检查材料生成新建议；不会重新执行基础检查。"
          }}</span>
        </div>
        <details
          v-if="teacher && review?.analyses?.length"
          class="analysis-history"
        >
          <summary>
            查看分析记录 ·
            {{ review.analyses[0].operations?.length ?? 0 }} 次操作
          </summary>
          <p class="muted">
            这里记录材料读取和调用状态。AI
            建议须由教师采用；补查不会改写基础检查结果。
          </p>
          <ul class="analysis-records">
            <li v-for="analysis in review.analyses" :key="analysis.id">
              {{ strategyLabel(analysis.strategy) }} ·
              {{ analysisStatusLabel(analysis.status) }} ·
              {{ analysis.id.slice(0, 8) }}
              <span v-if="analysis.paired_with_analysis_id">
                · 对照 {{ analysis.paired_with_analysis_id.slice(0, 8) }}</span
              >
              <button
                v-if="
                  analysis.paired_with_analysis_id &&
                  [
                    'succeeded',
                    'degraded',
                    'interrupted',
                    'cancelled',
                  ].includes(analysis.status)
                "
                class="secondary"
                :disabled="!!exportingAnalysisId"
                @click="exportPair(analysis.id)"
              >
                {{
                  exportingAnalysisId === analysis.id
                    ? "正在核验材料…"
                    : "下载配对材料"
                }}
              </button>
            </li>
          </ul>
          <ol v-if="review.analyses[0].operations?.length">
            <li
              v-for="operation in review.analyses[0].operations"
              :key="operation.operationId"
            >
              <span>{{ operationLabels[operation.kind] ?? "分析操作" }}</span>
              <span
                >{{ operationStates[operation.state] ?? "状态待确认"
                }}{{
                  operation.hasSupplementalEvidence ? " · 已归档补充材料" : ""
                }}</span
              >
            </li>
          </ol>
          <p v-else class="muted">尚无调用记录。</p>
          <p class="muted">调用费用暂未核定，不能按零费用计算。</p>
        </details>
      </details>
      <details v-if="teacher" class="panel comparison">
        <summary>与上次提交对比 <span>查看案例变化</span></summary>

        <p v-if="comparisonError" role="status">{{ comparisonError }}</p>
        <template v-else-if="comparison?.status === 'compatible'">
          <p class="muted">
            仅比较相同规则与实测环境下的原始案例结果；教师判断不改变此处的检查事实。
          </p>
          <div class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>案例</th>
                  <th>上次</th>
                  <th>本次</th>
                  <th>变化</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="item in comparison.caseDiffs" :key="item.caseId">
                  <td>{{ item.caseId }}</td>
                  <td>{{ labels[item.before] }}</td>
                  <td>{{ labels[item.after] }}</td>
                  <td>{{ changeLabels[item.change] }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>
        <p v-else-if="comparison?.status === 'unavailable'" class="muted">
          尚无上一次已完成检查的提交。
        </p>
        <p v-else-if="comparison" class="notice">
          两次检查的规则、案例或实测环境不能确认一致，暂不判定修复或回归。原因：{{
            comparison.reasonCode
          }}
        </p>
        <RouterLink
          v-if="comparison?.beforeRunId"
          :to="'/runs/' + comparison.beforeRunId"
          >查看上次完整报告 →</RouterLink
        >
      </details>
    </div>
    <section v-if="teacher" class="panel v2-publication">
      <h2>发布给学生</h2>
      <p>
        已确认 {{ confirmedCount }}/{{ criteria.length }}
        条。确认表示教师认可当前反馈内容，检查未通过的条目可以照实发布。
      </p>
      <details>
        <summary>随报告公开的证据（{{ publicIds.length }}）</summary>
        <label
          v-for="item in publishableEvidence"
          :key="item.evidenceId"
          class="v2-check"
          ><input
            type="checkbox"
            v-model="publicIds"
            :value="item.evidenceId"
            :disabled="!editable || busy || !!recoverableDraft"
          />{{ item.caseId ?? "构建记录" }} · {{ item.mediaType }} ·
          {{ item.evidenceId.slice(0, 8) }}</label
        >
      </details>
      <p v-if="review.latestPublication">
        <RouterLink
          :to="'/publications/' + review.latestPublication.publicationId"
          >查看已发布版本
          {{ review.latestPublication.publicationNo }}</RouterLink
        >
      </p>
      <label v-if="review.latestPublication"
        >更正原因<textarea
          v-model="correctionReason"
          :disabled="busy || !!recoverableDraft"
          rows="2"
          placeholder="说明原反馈何处需要更正"
        />
      </label>
      <button
        v-if="review.latestPublication && !editable"
        :disabled="publicationBlockers.length > 0"
        aria-describedby="publication-next-steps"
        @click="createCorrection"
      >
        从已发布版本建立更正草稿
      </button>
      <button
        v-else
        class="primary"
        :disabled="publicationBlockers.length > 0"
        aria-describedby="publication-next-steps"
        @click="publish"
      >
        {{ revision.originPublicationId ? "发布更正报告" : "发布报告" }}
        {{ confirmedCount }}/{{ criteria.length }}
      </button>
      <div id="publication-next-steps" role="region" aria-live="polite" aria-label="发布前待办">
        <ul v-if="publicationBlockers.length"><li v-for="reason in publicationBlockers" :key="reason">{{ reason }}</li></ul>
        <p v-else>当前页面已满足操作条件。提交时仍会核对最新修订、提交资格与公开证据。</p>
      </div>
    </section>
  </template>
</template>
<style scoped>

.draft-recovery { border: 1px solid var(--line); display: grid; gap: 12px; }
.draft-recovery-quiet { background: transparent; padding: var(--space-sm); margin-bottom: var(--space-md); box-shadow: none; }
.draft-recovery h2 { font-size: 1rem; margin: 0 0 8px; }
.draft-recovery p { font-size: .85rem; line-height: 1.7; margin: 6px 0; }
.draft-recovery-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.draft-recovery-actions button { min-height: 40px; }
.feedback-edit-fields {
  border: 0;
  padding: 0;
  margin: 0;
  min-width: 0;
}
.analysis-actions {
  display: flex;
  align-items: end;
  gap: 1rem;
  flex-wrap: wrap;
  margin: 1rem 0;
}
.analysis-actions label {
  min-width: 0;
  max-width: 100%;
}
.analysis-actions > span {
  flex-basis: 100%;
  font-size: 0.8rem;
}
.analysis-history {
  margin-top: 1rem;
  padding-top: 1rem;
  border-top: 1px solid var(--line);
}
.analysis-history li {
  padding: 0.5rem 0;
  overflow-wrap: anywhere;
}
.analysis-history li span + span {
  margin-left: 1rem;
  color: var(--muted);
}
.analysis-records {
  padding-left: 1.25rem;
}
.report-tools {
  display: flex;
  gap: 0.75rem;
  flex-wrap: wrap;
}
.report-tools > details {
  flex: 1 1 20rem;
  min-width: 0;
  margin: 0;
}
.report-tools > details[open] {
  flex-basis: 100%;
}
.review-hero {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 2rem;
  padding: 1.8rem 2rem;
  margin: 0 0 1.25rem;
  color: var(--gl-text);
  background: var(--dark);
  border-radius: 1.5rem;
}
.review-hero .eyebrow {
  color: var(--apricot);
}
.review-hero h2 {
  color: var(--gl-text);
  font-size: 1.8rem;
  letter-spacing: -0.035em;
  margin-bottom: 0.65rem;
}
.review-hero-copy {
  max-width: 42rem;
  color: var(--gl-muted);
  font-size: 0.85rem;
  margin: 0;
}
.review-progress {
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  width: 7.5rem;
  height: 7.5rem;
  flex-shrink: 0;
  border-radius: 50%;
  background:
    radial-gradient(closest-side, var(--dark) 87%, transparent 89%),
    conic-gradient(var(--apricot) var(--progress), var(--muted) 0);
}
.review-progress strong {
  color: var(--gl-text);
  font-size: 2.4rem;
  font-weight: 550;
  font-variant-numeric: tabular-nums;
  line-height: 1.1;
}
.review-progress strong span {
  font-size: 1rem;
  color: var(--gl-muted);
}
.review-progress small {
  color: var(--gl-muted);
  font-size: 0.65rem;
}
.analysis-drawer,
.comparison {
  background: transparent;
  border: 1px solid var(--line);
  border-radius: 1rem;
  padding: 1rem 1.25rem;
  margin-bottom: 1rem;
  box-shadow: none;
}
summary {
  cursor: pointer;
  font-weight: 600;
  font-size: 0.85rem;
}
summary > span {
  color: var(--muted);
  font-size: 0.75rem;
  margin-left: 0.75rem;
  font-weight: 400;
}
.v2-report {
  grid-template-columns: 12.5rem minmax(0, 1fr);
  gap: 1rem;
  margin-top: 1.5rem;
}
.review-nav {
  padding: 0.5rem;
  background: transparent;
  border: 0;
  border-radius: 1rem;
  position: sticky;
  top: 6rem;
}
.review-nav-heading {
  display: flex;
  justify-content: space-between;
  padding: 0.7rem 0.5rem 1rem;
  font-size: 0.8rem;
  gap: 0.4rem;
  flex-wrap: wrap;
}
.review-nav-heading small {
  margin: 0;
}
.review-nav-item {
  display: flex;
  flex-direction: column;
  align-items: start;
  width: 100%;
  text-align: left;
  padding: 0.85rem;
  margin-bottom: 0.35rem;
  border: 1px solid transparent;
  border-radius: 0.85rem;
  background: transparent;
  white-space: normal;
  gap: 0.25rem;
}
.review-nav-item:hover {
  background: var(--surface);
}
.review-nav-item.active {
  background: var(--gl-solid);
  border-color: var(--line);
  color: var(--accent);
  box-shadow: 0 2px 6px var(--gl-bg);
}
.review-nav-item strong {
  font-size: 0.85rem;
}
.review-nav-item small {
  font-size: 0.7rem;
  color: var(--muted);
  margin-top: 0.3rem;
}
.review-nav-index {
  font:
    500 0.65rem ui-monospace,
    Consolas,
    monospace;
  letter-spacing: 0.04em;
}
.v2-detail {
  min-width: 0;
  padding: 0;
  overflow: hidden;
}
.criterion-heading {
  display: flex;
  align-items: start;
  gap: 0.8rem;
  padding: 1.5rem;
  border-bottom: 1px solid var(--line);
}
.criterion-heading h2 {
  font-size: 1.2rem;
  margin-bottom: 0.45rem;
}
.criterion-heading p {
  font-size: 0.8rem;
  color: var(--muted);
  margin: 0;
}
.review-split {
  display: grid;
  grid-template-columns: minmax(0, 1.05fr) minmax(0, 1fr);
}
.evidence-workspace,
.feedback-workspace {
  min-width: 0;
  padding: 1.5rem;
}
.evidence-workspace {
  border-right: 1px solid var(--line);
  background: var(--surface);
}
.evidence-workspace > h3:first-child,
.feedback-workspace > h3 {
  margin-top: 0;
  font-size: 1rem;
}
.feedback-workspace .eyebrow {
  margin-bottom: 0.7rem;
}
.evidence-selector {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  max-height: 9rem;
  overflow: auto;
  margin: 0.8rem 0;
}
.evidence-selector button {
  font-size: 0.7rem;
  padding: 0.45rem 0.6rem;
  min-height: 2rem;
  border-radius: 0.5rem;
  white-space: normal;
}
.evidence-selector button[aria-pressed="true"] {
  background: var(--accent-soft);
  color: var(--accent-ink);
  border-color: var(--accent);
}
.evidence-loading {
  padding: 3rem 1rem;
  text-align: center;
  color: var(--muted);
  background: var(--surface);
  border-radius: 0.75rem;
}
.v2-evidence {
  border: 1px solid var(--line);
  background: var(--gl-solid);
  border-radius: 0.75rem;
  overflow: hidden;
}
.v2-evidence img {
  display: block;
  width: 100%;
  height: auto;
}
.v2-evidence pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 28rem;
  overflow: auto;
  margin: 0;
  padding: 1rem;
  font-size: 0.75rem;
  line-height: 1.7;
}
.evidence-enlarge {
  margin-top: 0.5rem;
  font-size: 0.75rem;
}
.evidence-dialog {
  width: min(75rem, 94vw);
  max-height: 90dvh;
  padding: 1.5rem;
  border: 1px solid var(--line);
  border-radius: 1.2rem;
  color: var(--ink);
  background: var(--gl-solid);
  box-shadow: 0 24px 80px var(--gl-bg);
}
.evidence-dialog::backdrop {
  background: var(--gl-solid);
}
.evidence-dialog img {
  display: block;
  width: 100%;
}
.evidence-dialog pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 0.85rem;
}
.evidence-dialog .section-heading {
  position: sticky;
  top: -1.5rem;
  background: var(--gl-solid);
  padding-block: 0.75rem;
}
.facts-title {
  margin-top: 1.5rem;
}
.v2-case {
  padding: 1rem 0;
  border-bottom: 1px solid var(--line);
}
.v2-case h3 {
  margin: 0 0 0.6rem;
  font-size: 0.8rem;
}
.v2-case p,
.v2-case li {
  font-size: 0.8rem;
  overflow-wrap: anywhere;
}
.v2-detail details {
  margin: 1.2rem 0;
}
.v2-detail label {
  margin: 1rem 0;
}
.v2-detail .actions {
  margin-top: 1.3rem;
}
.v2-publication {
  margin-top: 1.5rem;
  border-radius: 1.2rem;
}
.v2-publication h2 {
  font-size: 1.2rem;
}
.v2-check {
  flex-direction: row;
  align-items: center;
  gap: 0.6rem;
  overflow-wrap: anywhere;
}
.v2-check input {
  width: auto;
}
@media (max-width: 1200px) {
  .v2-report {
    display: block;
  }
  .review-nav {
    position: static;
    display: flex;
    overflow: auto;
    gap: 0.5rem;
    margin-bottom: 1rem;
    padding: 0 0 0.25rem;
  }
  .review-nav-heading {
    display: none;
  }
  .review-nav-item {
    flex: 0 0 10rem;
    margin: 0;
  }
}
@media (max-width: 900px) {
  .review-split {
    grid-template-columns: minmax(0, 1fr);
  }
  .evidence-workspace {
    border-right: 0;
    border-bottom: 1px solid var(--line);
  }
}
@media (max-width: 600px) {
  .review-hero {
    padding: 1.25rem;
    gap: 1rem;
  }
  .review-hero h2 {
    font-size: 1.3rem;
  }
  .review-hero-copy {
    font-size: 0.75rem;
  }
  .review-progress {
    width: 5rem;
    height: 5rem;
  }
  .review-progress strong {
    font-size: 1.6rem;
  }
  .review-progress small {
    font-size: 0.6rem;
  }
  .criterion-heading,
  .evidence-workspace,
  .feedback-workspace {
    padding: 1rem;
  }
  summary > span {
    display: block;
    margin: 0.3rem 0 0 1rem;
  }
}

.review-hero { border-radius: var(--radius); padding: var(--space-md); }
.review-hero p { max-width: 65ch; }
.review-nav { top: calc(var(--banner-height) + var(--space-sm)); }
.review-nav-item { min-height: 48px; font-size: var(--text-sm); }
.review-nav-item small { font-size: var(--text-xs); }
.v2-detail > header { padding: var(--space-md); }
.evidence-workspace, .feedback-workspace { padding: var(--space-md); min-width: 0; }
.evidence-selector button { min-height: 44px; font-size: var(--text-xs); }
.evidence-selector { padding: var(--space-3xs); }
.v2-case { border-radius: var(--radius-input); }
.v2-publication { overflow-wrap: anywhere; }
.evidence-dialog header { background: var(--paper); }
.evidence-dialog header button { flex-shrink: 0; }
@media (max-width: 600px) { .evidence-workspace, .feedback-workspace, .v2-detail > header { padding: var(--space-sm); } .review-hero { align-items: flex-start; } .review-progress { flex-shrink: 0; } }
</style>
