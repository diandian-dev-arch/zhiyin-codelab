<script setup lang="ts">
import { citationRange } from '../lib/source-evidence';
import { computed, onMounted, onUnmounted, ref, nextTick, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { apiV2 } from "../api";
import SourceAnalysisControls from "../components/SourceAnalysisControls.vue";
import SourceCostControls from '../components/SourceCostControls.vue';
import AnalysisModelSummary from '../components/AnalysisModelSummary.vue';
import StudioSelect from '../components/StudioSelect.vue';
import StudioSearch from '../components/StudioSearch.vue';
import PersonalModelDialog from "../components/PersonalModelDialog.vue";
import SourceProjectReport from "../components/SourceProjectReport.vue";
import type { SourceCitation as Citation, SourceProjectReportData as Report } from '@codelab/contracts/source';
import SourceFileTree from '../components/SourceFileTree.vue';
import AnalysisProgress from '../components/AnalysisProgress.vue';
import SourceImportCoverage from '../components/SourceImportCoverage.vue';
import SourceEvidenceReader from '../components/SourceEvidenceReader.vue';
import AnalysisDetailsSections from '../components/AnalysisDetailsSections.vue';
import { analysisStage, analysisStages, readableHistory } from '../lib/analysis-progress';
import { archiveSourceFolder } from '../lib/source-folder-archive';
import {
  sourceImportLimits,
  sourceAnalysisProfiles,
  sourceReportQuality,
  type SourceAnalysisMode,
  type SourceAnalysisOptions,
  type SourceModule,
  type SourceCoverage,
  type SourceContextSummary,
  type SourceUsageSummary,
} from "@codelab/contracts/source";
import {
  ArrowUpRight,
  Upload,
  FileCode2,
  Check,
  Square,
  RotateCcw,
  ChevronRight,
  FolderOpen,
  Info,
  ArrowRight,
  X,
  Compass,
  MessagesSquare,
} from "lucide-vue-next";
type Analysis = {
  id: string;
  canCancel?: boolean;
  modelUsage?: SourceUsageSummary;
  costSummary?: {price: NonNullable<SourceAnalysisOptions['cost']>; knownCny:number; reservedCny:number; unknownCalls:number} | null;
  analysis_options?: SourceAnalysisOptions | null;
  execution_snapshot?: {
    version: 1;
    model: { model: string };
    context: SourceContextSummary["policy"];
  } | null;
  status: string;
  events: {
    at: string;
    kind: string;
    label: string;
    path?: string;
    count?: number;
    issues?: { path: string; code: string; maximum?: number; minimum?: number; expected?: string; sourcePath?:string; start?:number; end?:number; allowedRanges?:{start:number;end:number}[] }[];
    round?: number;
    totalRounds?: number;
  }[];
  report?: {
    report: Report;
    read: Record<string, { start: number; end: number }>;
    readRanges?: Record<string, { start: number; end: number }[]>;
    coverage?: SourceCoverage;
    sourceMap?: (SourceModule & { readFiles: number })[];
    context?: SourceContextSummary;
    changes?: {added:string[];modified:string[];removed:string[];unchanged:number};
  };
  code?: string;
  started_at?: string;
  created_at: string;
  finished_at?: string;
};
type Project = {
  id: string;
  name: string;
  available: boolean;
  files: { path: string; lines: number }[];
  omitted: { path: string; reason: string }[];
  analyses: Analysis[];
  modules?: SourceModule[];
};
const route = useRoute(),
  router = useRouter();
const projects = ref<{ id: string; name: string; status: string; report_quality?: 'complete' | 'limited' | 'unknown'; created_at?: string; last_analyzed_at?: string | null }[]>([]),
  project = ref<Project>(),
  available = ref(false),
  busy = ref(false),
  error = ref(""),
  stale = ref(false),
  selected = ref(""),
  now = ref(Date.now()),
  drag = ref(false);
const projectQuery = ref('');
const filteredProjects = computed(() => projects.value.filter(item =>
  item.name.toLocaleLowerCase().includes(projectQuery.value.trim().toLocaleLowerCase()),
));
const importExpanded = ref(false);
const importPanel = ref<HTMLElement>();
const importTrigger = ref<HTMLButtonElement>();
const showImport = computed(() => importExpanded.value || (libraryLoaded.value && !projects.value.length));
async function toggleImport() {
  importExpanded.value = !importExpanded.value;
  await nextTick();
  if (importExpanded.value) {
    importPanel.value?.focus({ preventScroll: true });
    importPanel.value?.scrollIntoView({ block: 'start', behavior: 'instant' });
  } else importTrigger.value?.focus({ preventScroll: true });
}
const pendingFile = ref<File>();
const fileInput = ref<HTMLInputElement>();
const folderInput = ref<HTMLInputElement>();
const folderPreparing = ref(false);
const folderProgress = ref("");
const importNote = ref("");
let confirmAfterImport = false;
const analysisDetails = ref<HTMLDetailsElement>();
const omittedDetails = ref<HTMLDetailsElement>();
let folderRevision = 0;
let folderController: AbortController | undefined;
const modelDialog = ref<InstanceType<typeof PersonalModelDialog>>();
const mode = ref<SourceAnalysisMode>("quick");
const focusModules = ref<string[]>([]);
const costPolicy = ref<SourceAnalysisOptions['cost']>();
const costValid = ref(true), reuseReport = ref(true), analysisNotice = ref('');
const incrementalFrom = ref('');
const priceRevision = ref(0);
const modelConfirmed = ref(false);
function modelChanged() { priceRevision.value++; void load(); }
const modeLabel = (a?: Analysis) =>
  a?.analysis_options
    ? sourceAnalysisProfiles[a.analysis_options.mode].label
    : "历史分析";
const omittedLimit = ref(100);
let loadController: AbortController | undefined;
let mutationController: AbortController | undefined;
let loadPromise: Promise<void> | undefined;
const loading = ref(false);
const connectionError = ref("");
const rerunPanel = ref<HTMLDetailsElement>();
const setupVisible = ref(false);
const setupMounted = ref(false);
const moreMenu = ref<HTMLDetailsElement>();
const readingRoot = ref<HTMLElement>();
const expandedName = ref(false);
watch(() => project.value?.id, () => { expandedName.value = false; });
let auxiliaryTrigger: HTMLElement | undefined;
let auxiliaryScroll = 0;
function rememberReadingPosition() {
  auxiliaryTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
  auxiliaryScroll = window.scrollY;
}
function closeAuxiliary() {
  setupVisible.value = false;
  if (analysisDetails.value) analysisDetails.value.open = false;
  void nextTick(() => {
    window.scrollTo({ top: auxiliaryScroll, behavior: 'instant' });
    if (auxiliaryTrigger?.isConnected && auxiliaryTrigger.closest('.reading-more')) moreMenu.value?.querySelector('summary')?.focus({ preventScroll: true });
    else if (auxiliaryTrigger?.isConnected) auxiliaryTrigger.focus({ preventScroll: true });
  });
}
let timer: ReturnType<typeof setTimeout> | undefined,
  clock: ReturnType<typeof setInterval> | undefined,
  disposed = false;
const current = computed(
  () =>
    project.value?.analyses.find((a) => a.id === selected.value) ??
    project.value?.analyses[0],
);
const active = computed(() =>
  project.value?.analyses.find((a) => ["queued", "running"].includes(a.status)),
);
const report = computed(() => current.value?.report?.report);
const newReadableReport = computed(() => project.value?.analyses.find(a => a.report && a.id !== current.value?.id && a.created_at > (current.value?.created_at ?? '')));
const latestUnsuccessful = computed(() => {
  const latest = project.value?.analyses[0];
  return report.value && latest && latest.id !== current.value?.id && ['failed', 'cancelled'].includes(latest.status) ? latest : undefined;
});
const previousReport = computed(() => readableHistory(project.value?.analyses ?? [], current.value?.id));
const events = computed(() => current.value?.events ?? []);
const rounds = computed(() =>
  [1, 2].map((round) => ({
    round,
    started: events.value.some(
      (e) => e.kind === "investigate_plan" && e.round === round,
    ),
    done: events.value.some(
      (e) => e.kind === "investigate_done" && e.round === round,
    ),
    goal: events.value.find(
      (e) => e.kind === "investigate" && e.round === round,
    )?.label,
    result: events.value.find(
      (e) => e.kind === "investigate_done" && e.round === round,
    )?.label,
  })),
);
const reads = computed(() => [
  ...new Map(
    events.value
      .filter((e) => e.kind === "read" || e.kind === "read_verify")
      .map((e) => [e.path, e]),
  ).values(),
]);
const searchCount = computed(
  () => events.value.filter((e) => e.kind === "search").length,
);
const coverage = computed(() => current.value?.report?.coverage);
const contextBudget = computed(() => current.value?.report?.context);
// Presentation only: chart stations use the project's real module labels when present.
const chartLabels = computed(() => project.value?.modules?.length ? project.value.modules.slice(0, 5).map(m => m.label) : undefined);
const libraryStats = computed(() => ({
  total: projects.value.length,
  read: projects.value.filter(p => p.status === 'succeeded').length,
  running: projects.value.filter(p => p.status === 'running' || p.status === 'queued').length,
}));
const libraryLoaded = ref(false);
// Logbook strip (presentation only): every figure is read from the loaded project list or project record.
const logDate = computed(() => { const d = new Date(now.value); return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`; });
const logStrip = computed(() => project.value
  ? [`项目 · ${project.value.id.slice(0, 8)}`, `${project.value.files.length} 份源码 · ${project.value.files.reduce((sum, f) => sum + f.lines, 0).toLocaleString('zh-CN')} 行`, `${project.value.analyses.length} 次分析记录 · ${logDate.value}`]
  : [`${logDate.value} · 第 ${libraryStats.value.total} 份项目`, '静态阅读 · 不运行项目脚本', '知因 CodeLab · 项目航海日志']);
const readLinesShare = computed(() => coverage.value?.totalLines ? Math.min(100, coverage.value.readLines / coverage.value.totalLines * 100) : undefined);
const omittedGroups = computed(() => {
  const groups = new Map<string, number>();
  for (const file of project.value?.omitted ?? [])
    groups.set(file.reason, (groups.get(file.reason) ?? 0) + 1);
  return [...groups].map(([reason, count]) => ({ reason, count }));
});
const title = computed(() =>
  stale.value
    ? "连接暂时中断"
    : ({
        queued: "已排队，等待分析",
        running: analysisStages[analysisStage(events.value)],
        succeeded: "项目分析已完成",
        failed: "本次分析未完成",
        cancelled: "分析已停止",
      }[current.value?.status ?? ""] ?? "准备认识你的项目"),
);
const activeElapsed = computed(() => {
  const start = active.value?.started_at ?? active.value?.created_at;
  const seconds = start ? Math.max(0, Math.floor((now.value - new Date(start).getTime()) / 1000)) : 0;
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
});
const elapsed = computed(() => {
  const a = current.value;
  if (!a) return "00:00";
  const secs = Math.max(
    0,
    Math.floor(
      ((a.finished_at ? new Date(a.finished_at).getTime() : now.value) -
        new Date(a.started_at ?? a.created_at).getTime()) /
        1000,
    ),
  );
  return `${String(Math.floor(secs / 60)).padStart(2, "0")}:${String(secs % 60).padStart(2, "0")}`;
});
const states: Record<string, string> = {
  queued: "排队中",
  running: "分析中",
  succeeded: "报告可读",
  failed: "未完成",
  cancelled: "已停止",
};
function reportStatus(status: string, quality?: 'complete' | 'limited' | 'unknown') {
  if (status !== 'succeeded') return states[status] ?? '已保存 · 未分析';
  return quality === 'limited' ? '报告可读 · 范围受限' : quality === 'complete' ? '报告可读' : '历史报告 · 质量未记录';
}
const failureReasons: Record<string, string> = {
  SOURCE_COST_BUDGET: '单次预算不足以覆盖下一轮请求，已停止后续模型调用。已产生的用量保留；未完成的草稿不作为正式报告。可缩小分析范围或调整预算后重新分析。',
  SOURCE_BASELINE_UNAVAILABLE: '对比版本已不可用，未继续调用模型。请重新选择仍可访问的项目版本。',
  INTERRUPTED: "服务中断，本次请求没有自动重放。",
  TIME_LIMIT: "本次分析达到时间上限。",
  MODEL_OUTPUT_LIMIT: "模型输出达到上限，报告不完整，因此没有发布结果。",
  MODEL_EMPTY_OUTPUT: "模型返回了空内容，未形成报告。",
  MODEL_JSON_INVALID: "模型返回格式不完整，未形成可读取的报告。",
  INVALID_SOURCE_CITATION: "报告引用了未读或超出范围的代码，已拦截该结果。",
  MISSING_FINDING_VERIFICATION: "模型没有完整复核初步问题，已拦截该结果。",
  MISSING_VERIFIED_FINDING: "复核结果缺少完整建议，已拦截该结果。",
  REPORT_SCHEMA_INVALID: "模型输出未通过报告结构校验。",
  SOURCE_PLAN_INVALID:
    "源码调查计划未通过校验，且本次格式修正额度已用完，未生成报告。",
  MODEL_TRANSPORT_UNKNOWN: "模型连接中断，远端请求结果不明，没有自动重试。",
  MODEL_HTTP_429: "模型服务暂时限流，本次请求未自动重试。",
  MODEL_HTTP_403:
    "模型服务拒绝了请求（403），请检查服务商账号权限、额度和模型可用性。本次没有自动重试。",
  MODEL_CONTEXT_BUDGET: "本次上下文达到处理上限。可缩小重点目录后重新分析。",
  SOURCE_CONFIGURATION_CHANGED:
    "模型或容量设置在排队后发生了变化，本次分析已停止。确认当前设置后可重新分析；已有报告不受影响。",
  INVALID_SOURCE_MODULE: "关注目录已不匹配，请刷新页面后重新选择。",
};
function load(): Promise<void> {
  if (disposed) return Promise.resolve();
  if (loadPromise) return loadPromise;
  loadPromise = readProject().finally(() => { loadPromise = undefined; });
  return loadPromise;
}
async function readProject() {
  const controller = new AbortController();
  loadController = controller;
  loading.value = true;
  const timeout = window.setTimeout(() => controller.abort(), 15000);
  try {
    if (route.params.id) {
      const d = await apiV2<Project>(`/projects/${route.params.id}`, {signal:controller.signal});
      controller.signal.throwIfAborted();
      if (!disposed) {
        const readingId = current.value?.id;
        project.value = d;
        if (readingId && d.analyses.some(a => a.id === readingId)) selected.value = readingId;
        available.value = d.available;
        if (confirmAfterImport) {
          confirmAfterImport = false;
          await nextTick();
          await revealAnalysisOptions();
        }
      }
    } else {
      const d = await apiV2("/projects", {signal:controller.signal});
      controller.signal.throwIfAborted();
      if (!disposed) {
        projects.value = d.projects;
        libraryLoaded.value = true;
        available.value = d.available;
      }
    }
    if (!disposed) {
      connectionError.value = "";
      stale.value = false;
    }
  } catch (e) {
    if (!disposed) {
      stale.value = true;
      connectionError.value = controller.signal.aborted
        ? "项目状态读取超过15秒，将自动尝试恢复连接；也可点击重新连接。不会重新发起分析。"
        : "项目状态暂时无法读取，将自动尝试恢复连接。已有项目和分析记录不会因此删除。";
    }
  } finally {
    window.clearTimeout(timeout);
    if (!disposed) loading.value = false;
  }
}
async function poll() {
  await load();
  if (!disposed) timer = setTimeout(poll, 2500);
}
onMounted(() => {
  const importResult = window.history.state;
  if (importResult?.sourceImportProjectId === route.params.id) {
    confirmAfterImport = importResult.sourceImportConfirm === true;
    if (typeof importResult.sourceImportMessage === 'string') analysisNotice.value = importResult.sourceImportMessage;
    if (typeof importResult.sourceImportAnalysisId === 'string') selected.value = importResult.sourceImportAnalysisId;
    const { sourceImportProjectId, sourceImportMessage, sourceImportAnalysisId, sourceImportConfirm, ...historyState } = importResult;
    window.history.replaceState(historyState, '');
  }
  void poll();
  clock = setInterval(() => {
    now.value = Date.now();
  }, 1000);
});
onUnmounted(() => {
  disposed = true;
  folderRevision++;
  folderController?.abort();
  loadController?.abort();
  mutationController?.abort();
  clearTimeout(timer);
  clearInterval(clock);
});
async function mutate(url: string, body: BodyInit, importing = false, analyzingImport = true) {
  const controller = new AbortController();
  mutationController = controller;
  // Import includes the server's two-minute upload allowance and response time.
  const timeout = window.setTimeout(() => controller.abort(), importing ? 135000 : 15000);
  try {
    const result = await apiV2(url, {method: 'POST', body, signal: controller.signal});
    controller.signal.throwIfAborted();
    return result;
  } catch (failure) {
    if (controller.signal.aborted || !(failure as {status?: number})?.status)
      throw new Error(importing
        ? (analyzingImport ? '导入结果尚未确认，服务器可能已保存项目并开始分析。请先查看下方「我的项目」，不要立即重复上传；系统不会自动重发。' : '保存结果尚未确认，服务器可能已保存项目。请先查看下方「我的项目」，不要立即重复上传；本次未请求 AI 分析，系统不会自动重发。')
        : '操作结果尚未确认，正在重新读取分析状态。服务器可能已接受请求并产生模型费用；请先核对记录，不要立即重复分析。');
    throw failure;
  } finally {
    window.clearTimeout(timeout);
    if (mutationController === controller) mutationController = undefined;
  }
}
function chooseFile(file?: File) {
  if (!file || busy.value) return;
  folderRevision++;
  folderController?.abort();
  folderPreparing.value = false;
  error.value = "";
  importNote.value = "";
  if (!file.name.toLowerCase().endsWith('.zip') || file.size > sourceImportLimits.zipBytes) {
    pendingFile.value = undefined;
    error.value = '请选择不超过 100 MB 的 ZIP 项目压缩包，或使用「选择文件夹」。';
    return;
  }
  pendingFile.value = file;
}
async function chooseFolder(fileList: FileList | null) {
  if (!fileList?.length || busy.value) return;
  const revision = ++folderRevision;
  folderController?.abort();
  const controller = new AbortController();
  folderController = controller;
  error.value = "";
  pendingFile.value = undefined;
  importNote.value = "";
  folderPreparing.value = true;
  folderProgress.value = '正在准备文件夹…';
  try {
    const result = await archiveSourceFolder(Array.from(fileList), {
      signal: controller.signal,
      onProgress: (current, total) => {
        if (revision === folderRevision && !disposed) folderProgress.value = `正在本地打包 ${current} / ${total} 个文件`;
      },
    });
    if (!result || revision !== folderRevision || disposed) return;
    pendingFile.value = result.file;
    importNote.value = `已在本地打包 ${result.fileCount} 个文件${result.skippedCount ? `，跳过 ${result.skippedCount} 个依赖、构建产物或常见敏感文件` : ''}。尚未上传。`;
  } catch (failure) {
    if (revision === folderRevision && !disposed) error.value = (failure as Error).message;
  } finally {
    if (revision === folderRevision) { folderController = undefined; folderPreparing.value = false; }
  }
}
async function revealAnalysisOptions() {
  rememberReadingPosition();
  setupMounted.value = true;
  setupVisible.value = true;
  if (moreMenu.value) moreMenu.value.open = false;
  if (analysisDetails.value) analysisDetails.value.open = false;
  await nextTick();
  if (rerunPanel.value) rerunPanel.value.open = true;
  await nextTick();
  rerunPanel.value?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  rerunPanel.value?.querySelector('summary')?.focus({ preventScroll: true });
}
function revealDetails() {
  rememberReadingPosition();
  setupVisible.value = false;
  if (analysisDetails.value) analysisDetails.value.open = true;
  analysisDetails.value?.scrollIntoView({ block: 'start', behavior: 'instant' });
  analysisDetails.value?.querySelector('summary')?.focus({ preventScroll: true });
}
async function revealActiveDetails() {
  if (active.value) selected.value = active.value.id;
  await nextTick();
  revealDetails();
}
async function revealOmitted() {
  rememberReadingPosition();
  setupVisible.value = false;
  if (analysisDetails.value) analysisDetails.value.open = true;
  if (omittedDetails.value) omittedDetails.value.open = true;
  await nextTick();
  // Let the browser expose descendants of the newly opened native details
  // before scrolling/focusing them (Vue's nextTick only flushes DOM updates).
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  omittedDetails.value?.scrollIntoView({ block: 'start', behavior: 'instant' });
  omittedDetails.value?.querySelector('summary')?.focus({ preventScroll: true });
}
async function upload(continueToConfirmation = false) {
  // Saving source never starts a model request, even on the primary path.
  const analyze = false;
  const file = pendingFile.value;
  if (!file || busy.value || folderPreparing.value) return;
  error.value = "";
  if (
    !file.name.toLowerCase().endsWith(".zip") ||
    file.size > sourceImportLimits.zipBytes
  ) {
    error.value = "请选择不超过 100 MB 的 ZIP 项目压缩包";
    return;
  }
  busy.value = true;
  try {
    const form = new FormData();
    form.append("file", file);
    const query = new URLSearchParams({analyze: String(analyze)});
    const d = await mutate(`/projects?${query}`, form, true, analyze);
    if (disposed) return;
    const projectId = d.projectId ?? d.id;
    const dispositionMessages: Record<string, string> = {
      queued: '项目已保存，本次分析已排队。完成后会在这里显示报告。',
      active: '这份项目已有分析正在进行，已打开现有进度。本次没有重复发起分析。',
      reused: '已打开这份项目已有的兼容报告，本次没有新模型调用。报告中的用量属于原分析。',
      not_requested: '项目已保存，本次未请求 AI 分析。可以直接关联实训任务，或稍后再分析。',
    };
    const message = typeof d.message === 'string' && d.message.trim()
      ? d.message
      : dispositionMessages[d.analysisDisposition] ?? (analyze ? '项目已保存，请查看下方分析状态。' : dispositionMessages.not_requested);
    await router.push({
      path: `/projects/${projectId}`,
      state: {
        sourceImportProjectId: projectId,
        sourceImportConfirm: continueToConfirmation,
        sourceImportMessage: message,
        sourceImportAnalysisId: d.analysisId ?? '',
      },
    });
  } catch (e) {
    if (!disposed) { error.value = (e as Error).message; await load(); }
  } finally {
    busy.value = false;
  }
}
function clearSelectedFile() {
  if (busy.value || folderPreparing.value) return;
  pendingFile.value = undefined;
  importNote.value = "";
  if (fileInput.value) fileInput.value.value = "";
  if (folderInput.value) folderInput.value.value = "";
}
const comparisonError = ref("");
async function loadComparisonProjects() {
  if (projects.value.length) return;
  try {
    const result = await apiV2("/projects");
    if (!disposed) projects.value = result.projects;
  } catch {
    if (!disposed) comparisonError.value = "历史版本暂时无法读取；不影响解读当前项目。";
  }
}
function dropped(e: DragEvent) {
  drag.value = false;
  chooseFile(e.dataTransfer?.files[0]);
}
async function act(kind: "analyze" | "cancel") {
  if (busy.value || !project.value || (kind === 'cancel' && !active.value?.canCancel)) return;
  if (kind === 'analyze' && (stale.value || active.value)) { error.value = '请先恢复连接并核对现有分析状态，不会重复提交。'; return; }
  if (kind === 'analyze' && !available.value) { void modelDialog.value?.open(); return; }
  if (kind === 'analyze' && !modelConfirmed.value) { error.value = '请先核对本次模型，再确认开始解读。'; return; }
  if (kind === 'analyze' && !costValid.value) { error.value = '请填写有效的单价和预算。'; return; }
  busy.value = true;
  error.value = "";
  try {
    const response = await mutate(`/projects/${project.value!.id}/${kind}`, JSON.stringify(
        kind === "cancel"
          ? { analysisId: active.value!.id }
          : {
              version: 1,
              mode: mode.value,
              modules: mode.value === "deep" ? focusModules.value : [],
              cost: costPolicy.value,
              reuse: reuseReport.value,
              ...(incrementalFrom.value ? { incrementalFrom: incrementalFrom.value } : {}),
            },
      ));
    if (disposed) return;
    selected.value = report.value ? current.value!.id : response.id ?? '';
    analysisNotice.value = response.reused
      ? '源码、分析范围和模型配置均未变化，已打开已有报告。本次没有新模型调用；下方用量属于原报告。'
      : response.active ? '这份项目已有分析正在进行，已打开现有进度。本次没有重复发起分析。' : '';
    if (kind === "analyze") setupVisible.value = false;
    await load();
  } catch (e) {
    if (!disposed) { error.value = (e as Error).message; await load(); }
  } finally {
    busy.value = false;
  }
}
const evidenceReader = ref<InstanceType<typeof SourceEvidenceReader>>();
function loadEvidence(c: Citation, full: boolean, signal: AbortSignal) {
  return apiV2<{ path: string; content: string }>(
    `/projects/${project.value!.id}/source?path=${encodeURIComponent(c.path)}${current.value?.id ? `&analysisId=${encodeURIComponent(current.value.id)}` : ''}${citationRange(c, full)}`,
    { signal },
  );
}
function open(c: Citation) { return evidenceReader.value?.openCitation(c); }
function openFile(path: string) { return evidenceReader.value?.openFile(path); }

</script>

<template>
  <div class="project-studio compact-studio" :class="{ 'reading-complete': !!report, 'analysis-active': !!active }" ref="readingRoot">
    <header class="studio-header" :class="{ 'reading-header': !!report }">
      <div class="studio-header-content">
        <div class="studio-header-top">
          <span v-if="!report" class="ms-cap studio-cap"><b>01</b><span>— {{ project ? '项目导读' : 'AI 项目解读' }}</span><span>{{ project ? 'READING' : 'PROJECT READING' }}</span></span>
          <RouterLink v-else to="/projects" class="reading-breadcrumb" aria-label="我的项目">我的项目 / 项目解读</RouterLink>
          <div class="studio-header-actions">
            <button v-if="!route.params.id && projects.length" ref="importTrigger" type="button" :aria-expanded="showImport" aria-controls="project-import-panel" :disabled="busy || folderPreparing" @click="toggleImport">{{ showImport ? '收起导入' : '导入新项目' }}</button>
            <button v-if="project" type="button" class="details-trigger" @click="revealDetails"><Info aria-hidden="true" :size="16" />分析详情</button>
            <details v-if="report" ref="moreMenu" class="reading-more"><summary>更多</summary><button type="button" @click="revealAnalysisOptions">重新解读</button></details>
            <RouterLink v-if="project" to="/projects" class="studio-link ms-ul">我的项目 <ArrowUpRight aria-hidden="true" :size="18" /></RouterLink>
            <RouterLink v-else to="/tasks" class="studio-link ms-ul">前往实训任务 <ArrowUpRight aria-hidden="true" :size="18" /></RouterLink>
          </div>
        </div>
        <div class="studio-title">
          <h1 :class="{ 'name-collapsed': (report || active) && project && project.name.length > 48 && !expandedName }">
            {{
              project
                ? project.name
                : "AI 项目解读"
            }}
          </h1>
          <button v-if="(report || active) && project && project.name.length > 48" type="button" class="name-disclosure" :aria-expanded="expandedName" @click="expandedName = !expandedName">{{ expandedName ? '收起完整名称' : '展开完整名称' }}</button>
          <p v-if="!report && !active">
            {{
              project
                ? "从全局到代码，每个判断都有可回看的出处"
                : "读懂项目做什么、怎样实现，以及下一步从哪里改进"
            }}
          </p>
        </div>

      </div>

    </header>
    <PersonalModelDialog ref="modelDialog" @changed="modelChanged" />
    <p v-if="error" class="studio-error" role="alert">
      {{ error }}
    </p>
    <p v-if="connectionError" class="studio-error" role="alert">
      {{ connectionError }} <button :disabled="loading" @click="load">{{ loading ? '正在重新连接…' : '重新连接' }}</button>
    </p>
    <template v-if="!route.params.id">
      <p v-if="!libraryLoaded && !connectionError" role="status">正在读取我的项目…</p>
      <section v-if="libraryLoaded && projects.length" class="project-history">
        <div class="project-library-heading"><div><span class="ms-cap"><b>03</b>— 项目航海日志 / LOGBOOK</span><h2>我的项目 <span>{{ projects.length }}</span></h2><p>继续阅读已有导读，或将作品带入实训。</p></div><StudioSearch v-if="projects.length" v-model="projectQuery" label="搜索我的项目" /></div>
        <p v-if="!projects.length" class="quiet">
          添加第一份作品后，可以随时回到这里阅读、关联实训或继续分析。
        </p>
        <p v-else-if="!filteredProjects.length" class="project-search-empty" role="status">没有找到「{{ projectQuery }}」相关项目。<button type="button" @click="projectQuery = ''">清空搜索</button></p>
        <RouterLink v-for="(p, i) in filteredProjects" :key="p.id" :to="`/projects/${p.id}`"
          ><span class="log-no" aria-hidden="true">{{ String(i + 1).padStart(2, '0') }}</span><FileCode2 aria-hidden="true" :size="21" /><strong>{{ p.name }}<small class="project-list-dates"><span v-if="p.created_at">导入于 {{ new Date(p.created_at).toLocaleDateString() }}</span><span v-if="p.last_analyzed_at">最近解读 {{ new Date(p.last_analyzed_at).toLocaleDateString() }}</span><span v-else>暂无已完成解读</span></small></strong
          ><span class="project-list-status" :class="{ 'has-report': p.status === 'succeeded', 'in-progress': p.status === 'running' || p.status === 'queued' }">{{ reportStatus(p.status, p.report_quality) }}</span
          ><ArrowUpRight aria-hidden="true" :size="18"
        /></RouterLink>
      </section>

      <section v-show="showImport" id="project-import-panel" ref="importPanel" class="upload-stage compact-upload" tabindex="-1" aria-label="导入项目">
        <div class="upload-story">
          <h2>{{ projects.length ? '导入新项目' : '从一份项目开始，读懂它的实现' }}</h2>
          <p>上传项目，沿着核心业务找到实现它的代码。先保存源码，下一步再确认解读费用。</p>
        </div>
        <div class="upload-workspace">
        <div
          v-spotlight
          class="zip-drop"
          :class="{ drag, busy: busy || folderPreparing }"
          @dragover.prevent="drag = true"
          @dragleave.prevent="drag = false"
          @drop.prevent="dropped"
        >
          <input ref="fileInput" class="file-picker-input" aria-label="选择项目 ZIP" type="file" accept=".zip" tabindex="-1" :disabled="busy || folderPreparing" @change="chooseFile(($event.target as HTMLInputElement).files?.[0])" />
          <input ref="folderInput" class="file-picker-input" aria-label="选择项目文件夹" type="file" webkitdirectory multiple tabindex="-1" :disabled="busy || folderPreparing" @change="chooseFolder(($event.target as HTMLInputElement).files)" />
          <svg class="drop-scribble" viewBox="0 0 120 64" aria-hidden="true" focusable="false"><path class="ms-draw" style="--len: 170" d="M8 8C26 50 70 58 106 36" /><path class="ms-draw" style="--len: 40" d="M92 30L107 35L100 49" /></svg>
          <span class="upload-symbol"><Upload aria-hidden="true" :size="30" /></span
          ><strong>{{
            folderPreparing ? folderProgress : busy ? "正在保存项目…" : pendingFile ? pendingFile.name : "拖入项目 ZIP，或选择文件夹"
          }}</strong
          ><span>{{ pendingFile ? `${(pendingFile.size / 1024 / 1024).toFixed(2)} MB · 已选择，尚未保存` : '普通项目即可 · ZIP 最大 100 MB' }}</span>
          <div class="file-picker-actions"><button type="button" :disabled="busy || folderPreparing" @click="fileInput?.click()"><Upload aria-hidden="true" :size="16" />选择 ZIP</button><button type="button" :disabled="busy || folderPreparing" @click="folderInput?.click()"><FolderOpen aria-hidden="true" :size="16" />选择文件夹</button></div>
        </div>
        <p v-if="importNote" class="import-note" role="status">{{ importNote }}</p>
        <div class="import-actions"><button type="button" :disabled="busy || folderPreparing || !pendingFile" @click="upload(true)">{{ busy ? '正在保存…' : '保存并继续' }} <ArrowRight aria-hidden="true" :size="16" /></button><button class="save-project" type="button" :disabled="busy || folderPreparing || !pendingFile" @click="upload(false)">仅保存源码</button><button v-if="pendingFile" type="button" :disabled="busy || folderPreparing" @click="clearSelectedFile">移除文件</button></div>
        <p class="import-separation">下一步确认模型与费用，当前不会调用 AI。无需模型账户也可仅保存源码。</p>
        <details class="import-boundaries"><summary>可读取内容与导入范围</summary><p>支持常见语言的 UTF-8 源码与配置，不要求项目可运行。AI 仅做静态阅读，不运行项目脚本。</p><p>请先移除私人数据。依赖、构建产物和常见敏感配置会跳过；文件夹在本地打包后再上传。展开总量 ≤ 500 MB，最多 20,000 项；保留源码 ≤ 16 MB，单文件 ≤ 512 KB。项目页会列出未保留的文件与原因。</p></details>
        </div>
      </section>

    </template>
    <template v-else-if="project">
      <div v-if="current" class="project-record-strip" role="group" aria-label="当前分析记录">
        <div class="project-record-copy"><span class="project-record-status" :class="{ complete: current.status === 'succeeded' }"><Check aria-hidden="true" v-if="current.status === 'succeeded'" :size="13" />{{ reportStatus(current.status, sourceReportQuality(current.report?.report ?? {})) }}</span><span>{{ modeLabel(current) }}</span><time :datetime="current.created_at">{{ new Date(current.created_at).toLocaleString() }}</time></div>
        <label v-if="project.analyses.length > 1" class="project-record-select" for="project-analysis-record">分析记录<StudioSelect id="project-analysis-record" v-model="selected"><option value="">最新分析</option><option v-for="a in project.analyses" :key="a.id" :value="a.id">{{ new Date(a.created_at).toLocaleString() }} · {{ modeLabel(a) }} · {{ reportStatus(a.status, sourceReportQuality(a.report?.report ?? {})) }}</option></StudioSelect></label>
        <span v-if="report" class="quiet">静态源码解读 · 未执行项目或测试<span v-if="current.id !== project.analyses[0]?.id"> · 正在查看历史报告</span></span>
      </div>
      <AnalysisProgress v-if="active" :analysis-id="active.id" :events="active.events" :elapsed="active.id === current?.id ? elapsed : activeElapsed" :stale="stale" :queued="active.status === 'queued'" :can-cancel="active.canCancel" :busy="busy" :model="active.execution_snapshot?.model.model" :mode="modeLabel(active)" :cost="active.costSummary" @cancel="act('cancel')" @details="revealActiveDetails" />
      <div v-if="report && active" class="analysis-running-note" role="status"><span>{{ active.id === current?.id ? '本次分析仍在处理中。' : '另一份分析正在处理中，当前报告仍可阅读。' }}<template v-if="active.canCancel === false"> 本次分析由其他账号发起。</template></span></div>
      <p v-if="analysisNotice" class="reuse-notice" role="status">{{ analysisNotice }}</p>
      <p v-if="newReadableReport" class="reuse-notice" role="status">新报告已生成，当前阅读保持不变。<button type="button" @click="selected = newReadableReport!.id">查看新报告</button></p>
      <p v-if="latestUnsuccessful" class="reuse-notice" role="status">最新解读{{ latestUnsuccessful.status === 'failed' ? '未完成' : '已停止' }}，已有报告仍可阅读。<span v-if="latestUnsuccessful.code">{{ failureReasons[latestUnsuccessful.code] ?? '请查看记录核对原因与费用。' }}</span><button type="button" @click="selected = latestUnsuccessful!.id">查看最新记录</button></p>
      <details v-if="setupMounted" v-show="setupVisible" ref="rerunPanel" class="next-analysis">
        <summary><span>{{ current ? '确认新的项目解读' : '确认并开始解读' }}</span><small>模型、阅读范围与本次预算</small></summary>
        <button type="button" @click="closeAuxiliary">关闭解读配置</button>
        <section class="personal-model-bar" aria-label="个人模型配置"><div><strong>{{ available ? '使用我的模型账户' : '分析前连接自己的 AI 模型' }}</strong><span>{{ available ? '新分析调用费用由 API Key 所属账户承担；历史报告保留原模型信息。' : '源码已保存。你可以稍后配置个人密钥，或先关联实训任务。' }}</span></div><button type="button" @click="modelDialog?.open()">{{ available ? '模型设置' : '配置我的模型' }} <ArrowUpRight aria-hidden="true" :size="16" /></button></section>
        <p class="quiet">本次范围：{{ sourceAnalysisProfiles[mode].label }} · {{ focusModules.length ? focusModules.join('、') : '全项目入口与核心场景' }}。仅静态阅读，不运行项目。</p>
        <details class="advanced-analysis"><summary>高级选项：深入解读、重点目录与版本比较</summary>
        <SourceAnalysisControls
          v-model:mode="mode"
          v-model:modules="focusModules"
          :catalog="project.modules"
          context="rerun"
          :disabled="busy || !!active"
        />
        <label for="project-baseline">对比版本<StudioSelect id="project-baseline" v-model="incrementalFrom" :disabled="busy || !!active" @focus="loadComparisonProjects"><option value="">不对比，解读当前项目</option><option v-for="p in projects.filter(p => p.id !== project?.id)" :key="p.id" :value="p.id">{{ p.name }} · {{ p.id.slice(0,8) }}</option></StudioSelect></label>
        <p v-if="comparisonError" role="status">{{ comparisonError }}</p>
        </details>
        <AnalysisModelSummary :revision="priceRevision" :available="available" @ready="modelConfirmed = $event" />
        <SourceCostControls :revision="priceRevision" :mode="mode" :available="available" :disabled="busy || !!active" @change="costPolicy=$event" @valid="costValid=$event" />
        <label class="reuse-option"><input type="checkbox" v-model="reuseReport" :disabled="busy || !!active"/>相同源码、模型与分析范围，优先复用已验证报告（不新增费用）</label>
        <p class="quiet">仅兼容新版报告可直接复用；没有匹配结果时会按本次预算重新分析，并可能产生费用。</p>
        <p v-if="active" class="quiet">
          {{ active.canCancel ? '当前分析的模式和关注目录已经确定；完成或停止后可调整下一次分析。' : '当前分析由其他账号发起，完成后可调整下一次分析。' }}
        </p>
        <button v-else :disabled="busy || stale || !available || !costValid || !modelConfirmed" @click="act('analyze')">
          <RotateCcw aria-hidden="true" :size="15" />{{ current ? '确认并重新解读' : '确认并开始解读' }} ·
          {{ sourceAnalysisProfiles[mode].label }}
        </button>
      </details>
      <section v-if="!report && previousReport" class="reuse-notice" aria-label="可用历史报告">
        <strong>已有报告仍可阅读</strong>
        <p>当前记录没有可读报告；同一份已保存源码的历史解读仍保留，生成于 {{ new Date(previousReport.created_at).toLocaleString() }}。</p>
        <button type="button" @click="selected = previousReport!.id">阅读历史报告</button>
      </section>
      <p v-if="current && (!current.costSummary || current.costSummary.unknownCalls)" class="cost-unknown">{{ current.costSummary ? `${current.costSummary.unknownCalls} 次请求用量待确认，以服务商账单为准。` : '此记录未提供费用估算，不代表零费用。' }}</p>
      <SourceImportCoverage important-only :omitted="project.omitted" @details="revealOmitted" />
      <SourceEvidenceReader ref="evidenceReader" :identity="`${project.id}:${current?.id ?? ''}`" :version-label="`源码版本 ${project.id.slice(0, 8)} · 报告 ${current?.id ?? '无'}`" :load-source="loadEvidence">
      <SourceProjectReport v-if="report" boundary-in-metadata :key="current?.id" :report="report" :project-name="project.name" :files="project.files" :indexed-files="project.files.length" :read-files="coverage?.readFiles ?? Object.keys(current?.report?.read ?? {}).length" @citation="open" @file="openFile" @evidence="evidenceReader?.openEvidence($event)" @context-change="evidenceReader?.close(false)" />
      </SourceEvidenceReader>
      <section v-if="!report && !active" class="project-reading-state compact-reading-state" aria-label="项目分析状态">
        <div class="reading-state-copy">
          <h2 role="status" aria-live="polite">{{ current ? title : '先保存作品，准备好时再读懂它。' }}</h2>
          <p v-if="current?.status === 'failed'">{{ failureReasons[current.code ?? ''] ?? '本次分析未形成可发布的报告。已有源码与历史记录均保留。' }}</p>
          <p v-else-if="current?.status === 'cancelled'">已保留本次分析记录。可以调整范围后重新开始；停止后的请求仍可能收到用量回执。</p>
          <p v-else>项目已可供查看与关联实训。选择分析范围并确认模型与预算后，才会开始 AI 阅读；保存不会自动发起分析。</p>
          <div class="reading-state-actions"><button type="button" class="reading-state-primary" :disabled="busy" @click="revealAnalysisOptions">{{ current ? '调整范围并重新分析' : '开始解读' }} <ArrowRight aria-hidden="true" :size="16" /></button><button type="button" class="reading-state-secondary" @click="revealDetails">查看已保存的源码 <ArrowUpRight aria-hidden="true" :size="15" /></button></div>
        </div>
      </section>
      <p class="reading-training"><RouterLink to="/tasks">前往实训任务 <ArrowUpRight aria-hidden="true" :size="16" /></RouterLink></p>
      <details ref="analysisDetails" class="analysis-details">
      <summary><span>分析详情</span><small>源码范围、分析过程与费用依据</small></summary>
      <div class="analysis-details-body">
      <button type="button" @click="closeAuxiliary">关闭分析详情</button>
      <AnalysisDetailsSections>
      <template #model>
      <section class="reading-metadata" aria-label="报告版本与费用摘要">
        <h3>模型与费用</h3>
        <span>源码版本 {{ project.id.slice(0, 8) }} · 原始名称 {{ project.name }} · 项目 ID {{ project.id }}</span>
        <span v-if="current?.execution_snapshot">历史模型 {{ current.execution_snapshot.model.model }}</span>
        <span v-if="current?.costSummary">已知用量估算 ¥{{ current.costSummary.knownCny.toFixed(4) }} · {{ current.costSummary.unknownCalls }} 次请求用量待确认 · 以服务商账单为准</span>
        <span v-else>此记录未提供费用估算，不代表零费用</span>
      </section>
      </template>
      <template #history><p v-if="!project.analyses.length">尚无分析记录。</p><ul><li v-for="a in project.analyses" :key="a.id"><button type="button" @click="selected = a.id; closeAuxiliary()">{{ new Date(a.created_at).toLocaleString() }} · {{ modeLabel(a) }} · {{ reportStatus(a.status, sourceReportQuality(a.report?.report ?? {})) }}</button></li></ul></template>
      <template #process>
      <section
        v-if="current"
        class="investigation"
        :class="{ moving: current?.status === 'running' && !stale }"
      >
        <div class="investigation-main">
          <div class="live-label">
            <span class="live-dot" />源码调查 <time>{{ elapsed }}</time
            ><span>{{ modeLabel(current) }} · 静态分析</span>
          </div>
          <ol
            v-if="current?.analysis_options?.mode === 'deep'"
            class="round-track"
            aria-label="深入调查进度"
          >
            <li
              v-for="r in rounds"
              :key="r.round"
              :class="{ reached: r.started, complete: r.done }"
            >
              <span class="round-mark"
                ><Check aria-hidden="true" v-if="r.done" :size="15" /><span v-else>{{
                  r.round
                }}</span></span
              >
              <div>
                <strong
                  >调查 {{ r.round }}
                  <small>{{
                    r.done
                      ? "已返回"
                      : r.started
                        ? current?.status === "running"
                          ? "进行中"
                          : "未完成"
                        : "尚未开始"
                  }}</small></strong
                >
                <p>
                  {{
                    r.goal ??
                    (r.round === 1
                      ? "从入口追踪服务与数据层"
                      : "沿上一轮线索填补缺口、寻找反证")
                  }}
                </p>
                <small v-if="r.result">{{ r.result }}</small>
              </div>
            </li>
          </ol>
          <p
            v-if="current?.analysis_options?.modules.length"
            class="investigation-counts"
          >
            本次重点：{{ current.analysis_options.modules.join(" · ") }}
          </p>
          <h2 role="status" aria-live="polite">{{ title }}</h2>
          <p v-if="current?.execution_snapshot" class="execution-snapshot">
            本次模型：{{ current.execution_snapshot.model.model }} ·
            设置已在提交时固定
          </p>
          <p v-if="current?.status === 'running'">
            正在根据源码建立项目理解。模型响应时间不固定，以下轨迹来自实际分析事件。
          </p>
          <p v-else-if="current?.status === 'succeeded'">
            {{
              sourceReportQuality(report ?? {}) === 'limited'
                ? '本次报告范围受限。已保留通过结构与源码引用校验的内容，请先查看报告限制，未完成的核查不能视为通过。'
                : report?.verification
                ? "已查阅关联实现并复核初步判断，报告保留可回看的源码依据。"
                : "已核对报告引用。这份历史报告未执行跨文件反证复核，可重新分析。"
            }}
          </p>
          <p v-else-if="current?.status === 'failed'">
            {{
              failureReasons[current.code ?? ""] ??
              "模型请求或报告校验未成功，未生成可信报告。"
            }}可以重新发起分析，已有记录会保留。
          </p>
          <p v-else-if="current?.status === 'cancelled'">
            已保留本次分析轨迹，可以随时重新开始。
          </p>
          <p v-else>源码已保存，任务会自动开始。离开页面不会取消分析。</p>
          <div class="stage-track">
            <span :class="{ done: events.some((e) => e.kind === 'map') }"
              >文件地图</span
            ><i /><span :class="{ done: reads.length }">源码阅读</span
            ><i /><span
              :class="{ done: events.some((e) => e.kind === 'synthesize') }"
              >关联分析</span
            ><i /><span
              :class="{ done: events.some((e) => e.kind === 'verified') }"
              >反证复核</span
            ><i /><span :class="{ done: current?.status === 'succeeded' }"
              >引用校验</span
            >
          </div>
          <p v-if="searchCount" class="investigation-counts">
            已执行 {{ searchCount }} 次源码搜索 · 阅读
            {{ reads.length }} 个文件的部分行段
          </p>
          <div class="analysis-actions">
            <button v-if="active?.canCancel" :disabled="busy" @click="act('cancel')">
              <Square aria-hidden="true" :size="14" />停止当前分析</button
            >
          </div>
        </div>
      </section>
      </template>
      <template #receipt>
      <section v-if="current?.costSummary" v-reveal class="cost-receipt" aria-label="本次费用估算">
        <div class="receipt-top"><div><span>本次费用 · 保守估算</span><h3>¥ {{current.costSummary.knownCny.toFixed(4)}}</h3></div><div class="receipt-cap"><span>单次预算</span><strong>{{current.costSummary.price.limitCny ? `¥ ${current.costSummary.price.limitCny.toFixed(2)}` : '未设置'}}</strong></div></div>
        <div v-if="current.costSummary.price.limitCny" class="receipt-scale" role="img" :aria-label="`已知费用 ${current.costSummary.knownCny.toFixed(4)} 元，预留 ${current.costSummary.reservedCny.toFixed(4)} 元，预算 ${current.costSummary.price.limitCny} 元`">
          <span :style="{width: `${Math.min(100,current.costSummary.knownCny/current.costSummary.price.limitCny*100)}%`}"></span><i :style="{width: `${Math.min(Math.max(0,100-current.costSummary.knownCny/current.costSummary.price.limitCny*100),current.costSummary.reservedCny/current.costSummary.price.limitCny*100)}%`}"></i>
        </div>
        <div class="receipt-legend"><span>● 已知用量估算</span><span>▧ 待确认预留 ¥ {{current.costSummary.reservedCny.toFixed(4)}}</span></div>
        <p>{{current.costSummary.price.label}}。{{current.costSummary.unknownCalls ? `${current.costSummary.unknownCalls} 次请求用量未确认，预留不代表已扣费。` : '按已返回用量计算，未扣除缓存和时段优惠。'}} 以服务商账单为准。</p>
      </section>
      </template>
      <template #scope>
      <section v-if="current?.report?.changes" class="reuse-notice" aria-label="变更分析范围"><strong>变更专项分析</strong><p>新增 {{current.report.changes.added.length}} · 修改 {{current.report.changes.modified.length}} · 删除 {{current.report.changes.removed.length}} · 未变化 {{current.report.changes.unchanged}}</p><p>优先检查变更与关联代码；这份报告不代表全项目重新验收。</p><details><summary>查看变更文件</summary><p v-for="(paths,kind) in {新增:current.report.changes.added,修改:current.report.changes.modified,删除:current.report.changes.removed}" :key="kind">{{kind}}：{{paths.join('、') || '无'}}</p></details></section>
      <section class="source-coverage" aria-label="实际分析范围">
        <div class="coverage-heading">
          <h3>实际分析范围</h3>
          <span>文件导入 ≠ 全量审查</span>
        </div>
        <dl>
          <div>
            <dt>已导入源码</dt>
            <dd>{{ project.files.length }}<small>个文件</small></dd>
          </div>
          <div>
            <dt>已跳过文件</dt>
            <dd>{{ project.omitted.length }}<small>个文件</small></dd>
          </div>
          <div>
            <dt>本次已阅读</dt>
            <dd>
              {{ coverage?.readFiles ?? reads.length
              }}<small>个文件的片段</small>
            </dd>
          </div>
          <div v-if="coverage">
            <dt>已读行 / 导入行</dt>
            <dd>
              {{ coverage.readLines.toLocaleString()
              }}<small>/ {{ coverage.totalLines.toLocaleString() }}</small>
            </dd>
          </div>
        </dl>
        <div v-if="readLinesShare !== undefined" v-reveal class="coverage-gauge">
          <span>已读行占导入行 <b>{{ readLinesShare.toFixed(1) }}%</b></span>
          <div class="gauge" role="img" :aria-label="`已读行占导入行 ${readLinesShare.toFixed(1)}%`" :style="{ '--r': `${readLinesShare}%` }"><i /><b /></div>
        </div>
        <p v-if="coverage">
          入口规划参考了 {{ coverage.planningFiles }} /
          {{ coverage.indexedFiles }}
          个文件路径；搜索范围包含全部已导入源码。阅读了
          {{ coverage.charactersRead.toLocaleString() }}
          个字符（含行号及重复阅读）。覆盖量不代表正确率，未读部分尚未审查。
        </p>
        <p v-else>
          此处的已读数来自本次真实阅读事件，只代表部分行段。{{
            current?.status === "succeeded"
              ? "历史记录未保存完整覆盖统计，不补算规划范围。"
              : "完整覆盖统计在报告生成后显示。"
          }}
        </p>
      </section>
      </template>
      <template #usage>
        <details v-if="current?.modelUsage" class="call-usage">
          <summary>模型调用与已知用量</summary>
          <template v-if="current.modelUsage.recording === 'available'">
            <p>
              已登记 {{ current.modelUsage.registeredCalls }} 次请求； 收到
              {{ current.modelUsage.returnedCalls }} 次回复，
              {{ current.modelUsage.failedCalls }} 次请求明确失败。
              <span v-if="current.modelUsage.pendingCalls"
                >{{ current.modelUsage.pendingCalls }} 次等待回执。</span
              >
              <span v-if="current.modelUsage.unknownCalls"
                >{{
                  current.modelUsage.unknownCalls
                }}
                次结果未确认，不自动重发。</span
              >
            </p>
            <p
              v-if="
                current.modelUsage.knownInputTokens !== null &&
                current.modelUsage.knownOutputTokens !== null
              "
            >
              已知用量小计：输入
              {{ current.modelUsage.knownInputTokens.toLocaleString() }} token，
              输出
              {{
                current.modelUsage.knownOutputTokens.toLocaleString()
              }}
              token。
              <span v-if="current.modelUsage.callsWithoutUsage"
                >另有
                {{
                  current.modelUsage.callsWithoutUsage
                }}
                次登记请求的用量未知。</span
              >
            </p>
            <p v-else-if="current.modelUsage.registeredCalls">
              实际 token 消耗尚无法确定，不按零计算。
            </p>
            <p v-else>尚未登记模型请求。</p>
            <p>
              请求登记不等于服务商已经接收。{{current.costSummary ? '费用按本次保存的单价估算，不等于账单实付。' : '这份记录没有保存价格，不推算历史费用。'}}迟到用量回执不会改变报告或任务状态。
            </p>
          </template>
          <p v-else>
            这份历史分析没有独立调用账本，失败用量无法追溯。成功报告中原有的用量记录仍可查看。
          </p>
        </details>
        <details v-if="contextBudget" class="model-usage">
          <summary>模型容量与实际用量</summary>
          <p>
            {{
              contextBudget.policy.contextWindowTokens === null
                ? "尚未确认模型的上下文窗口，采用应用保守预算。"
                : `已配置模型窗口 ${contextBudget.policy.contextWindowTokens.toLocaleString()} token，已为输出和协议开销预留空间。`
            }}
            {{
              contextBudget.policy.counting === "utf8-conservative-estimate"
                ? "阅读预算使用 UTF-8 保守估算，不是模型实际 token 数。"
                : "输入按所配置分词器计数；服务端消息开销和计费用量可能不同。"
            }}
          </p>
          <p v-if="contextBudget.knownInputTokens !== null">
            服务商已报告：输入
            {{ contextBudget.knownInputTokens.toLocaleString() }} token， 输出
            {{ contextBudget.knownOutputTokens?.toLocaleString() }} token。
            {{
              contextBudget.callsWithoutUsage
                ? `另有 ${contextBudget.callsWithoutUsage} 次回复未返回用量，以上仅为已知小计。`
                : `涵盖本次 ${contextBudget.callsWithUsage} 次已返回的模型回复。`
            }}
            未配置实际价格，不据此推算费用。
          </p>
          <p v-else>服务商未返回可用的用量数据，实际 token 消耗与费用未知。</p>
        </details>
      </template>
      <template #directory>
        <details v-if="omittedGroups.length">
          <summary>查看跳过原因</summary>
          <ul>
            <li v-for="g in omittedGroups" :key="g.reason">
              {{ g.reason }}：{{ g.count }} 个
            </li>
          </ul>
        </details>
      <details v-if="current?.report?.sourceMap?.length" class="directory-map">
        <summary>
          目录阅读地图 · {{ current.report.sourceMap.length }} 个区域
        </summary>
        <p class="quiet">
          按目录和项目配置归组，帮助定位阅读范围；业务关系以报告中的代码依据为准。
        </p>
        <ul>
          <li v-for="m in current.report.sourceMap" :key="m.id">
            <code>{{ m.label }}</code
            ><span
              >已读 {{ m.readFiles }} / {{ m.fileCount }} 个文件的片段</span
            >
          </li>
        </ul>
      </details>
      </template>
      <template #events>
      <div class="analysis-detail-files">
        <aside class="source-ledger">
          <h3>
            分析轨迹 <span>{{ events.length }}</span>
          </h3>
          <p v-if="!events.length" class="quiet">等待开始读取源码…</p>
          <ol>
            <li v-for="(e, i) in events" :key="i">
              <span class="event-marker" />
              <div>
                <time>{{ new Date(e.at).toLocaleTimeString() }}</time>
                <p>{{ e.label }}</p>
                <details v-if="e.issues?.length">
                  <summary>查看格式诊断（{{ e.issues.length }} 项）</summary>
                  <ul><li v-for="(issue, j) in e.issues" :key="j">
                    <code>{{ issue.path || '报告根节点' }}</code>：{{ issue.code }}
                    <span v-if="issue.expected">，要求 {{ issue.expected }}</span>
                    <span v-if="issue.maximum !== undefined">，最多 {{ issue.maximum }}</span>
                    <span v-if="issue.minimum !== undefined">，至少 {{ issue.minimum }}</span>
                    <span v-if="issue.sourcePath">，{{ issue.sourcePath }}:{{ issue.start }}–{{ issue.end }}；可引用范围：{{ issue.allowedRanges?.map(r => `${r.start}–${r.end}`).join('、') || '无已读行段' }}</span>
                  </li></ul>
                </details>
                <small v-if="e.count !== undefined"
                  >返回 {{ e.count }} 处匹配（单次最多 30 处）</small
                >
                <button
                  v-if="e.path"
                  @click="open({ path: e.path, start: 1, end: 1 })"
                >
                  {{ e.path }}
                </button>
              </div>
            </li>
          </ol>
        </aside>
      </div>
      </template>
      <template #files>
          <details>
            <summary>文件地图 · {{ project.files.length }} 个文件</summary>
            <SourceFileTree :files="project.files" :selected-path="evidenceReader?.citation?.path" @select="openFile" />
          </details>
          <details v-if="project.omitted.length" ref="omittedDetails">
            <summary tabindex="0">已跳过 {{ project.omitted.length }} 个文件</summary>
            <p
              v-for="o in project.omitted.slice(0, omittedLimit)"
              :key="o.path"
              class="omitted"
            >
              {{ o.path }}<br /><span>{{ o.reason }}</span>
            </p>
            <button
              v-if="project.omitted.length > omittedLimit"
              @click="omittedLimit += 100"
            >
              再显示 100 个跳过文件
            </button>
          </details>
      </template>
      </AnalysisDetailsSections>
      </div>
      </details>
    </template>
    <p v-else role="status">正在读取项目…</p>

  </div>
</template>

<style scoped>
.reading-complete { max-width: 1200px; margin-inline: auto; }
.reading-complete, .reading-complete :deep(*) { letter-spacing: 0; }
.reading-complete .studio-header.reading-header { background: transparent; border: 0; border-radius: 0; padding: 0; margin-bottom: .5rem; overflow: visible; color: var(--ink); }
.reading-header .studio-header-content { padding: 0; }
.reading-header::before { display: none; }
.reading-header .studio-header-top { margin-bottom: .5rem; }
.reading-header .studio-title h1 { font: 600 1.75rem/1.5 var(--font-body); color: var(--ink); overflow-wrap: anywhere; }
.reading-header .studio-header-actions, .reading-header .studio-header-actions button, .reading-header .studio-header-actions a { color: var(--ink); }
.reading-breadcrumb { font-size: .875rem; color: var(--muted); }
.reading-complete .project-record-strip { margin-block: 0 .5rem; padding-block: .35rem; font-size: .875rem; }
.reading-more { position: relative; margin: 0; border: 0; padding: 0; }
.reading-more summary { min-height: 44px; padding: .5rem 1.75rem .5rem .5rem; }
.reading-more button { position: absolute; right: 0; z-index: 5; min-width: 8rem; background: var(--paper); min-height: 44px; }
.reading-complete .cost-unknown { font-size: .875rem; color: var(--muted); margin: .25rem 0 .5rem; }
.reading-training { margin-block: 1.5rem; font-size: .875rem; }
.reading-training a { display: inline-flex; align-items: center; gap: .5rem; min-height: 44px; }
.reading-complete .analysis-details > summary { display: none; }
.reading-complete .analysis-details { margin: 0; border: 0; }
.reading-complete .analysis-details:not([open]) { display: none; }
.reading-metadata { flex-direction: column; align-items: start; }
@media (max-width: 760px) { .reading-header .studio-header-top { align-items: start; flex-wrap: wrap; } .reading-header .studio-title h1 { font-size: 1.5rem; } }
.project-list-dates { display: flex; flex-wrap: wrap; gap: .25rem .8rem; margin-top: .25rem; font: 400 .75rem/1.6 var(--font-body, sans-serif); color: var(--muted); letter-spacing: normal; }
.reading-metadata { display: flex; flex-wrap: wrap; align-items: center; gap: .4rem 1rem; margin: .75rem 0; font-size: .8125rem; color: var(--muted); overflow-wrap: anywhere; }
.reading-metadata button { min-height: 44px; color: var(--accent-ink); }
.compact-studio .studio-header { padding-block: 1rem; margin-bottom: 1rem; }
.compact-studio .studio-title h1 { font-size: clamp(1.6rem, 3vw, 2.2rem); }
.compact-studio .project-history { margin-top: 0; }
.compact-studio .compact-upload { display: block; padding-block: 1rem; margin-top: 1rem; }
.compact-studio .upload-story h2 { font-size: 1.25rem; margin: 0 0 .5rem; }
.compact-studio .upload-story p { max-width: 65ch; margin-bottom: 1rem; }
.compact-studio .upload-workspace { width: 100%; }

.project-reading-state.compact-reading-state { grid-template-columns: minmax(0, 1fr); }
.project-studio { min-width: 0; }
.analysis-active .studio-title h1.name-collapsed { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }

/* 新的头部布局 */
.studio-header {
  display: flex;
  flex-direction: column;
  gap: var(--space-md);
  margin-bottom: var(--space-lg);
  padding: var(--space-lg);
  background: linear-gradient(135deg, var(--spine) 0%, var(--spine-2) 100%);
  border-radius: var(--radius);
  border: 1px solid var(--gold-line);
  position: relative;
  overflow: hidden;
}

.studio-header::before {
  content: '';
  position: absolute;
  inset: 0;
  background:
    radial-gradient(circle at 85% 15%, var(--sea-glow) 0%, transparent 52%),
    radial-gradient(circle at 8% 110%, var(--accent-glow) 0%, transparent 46%);
  pointer-events: none;
}

.studio-header-content {
  position: relative;
  z-index: 1;
}

.studio-header-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-md);
  margin-bottom: var(--space-md);
  flex-wrap: wrap;
}

.studio-cap {
  color: var(--gold-on-ink);
}

.studio-header-actions {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  flex-shrink: 0;
  flex-wrap: wrap;
}

.details-trigger {
  background: color-mix(in srgb, var(--on-ink) 6%, transparent);
  border-color: var(--gold-line);
  color: var(--on-ink);
  flex-shrink: 0;
  white-space: nowrap;
  transition: all 0.2s ease;
}

.details-trigger:hover:not(:disabled) {
  background: color-mix(in srgb, var(--on-ink) 12%, transparent);
  border-color: var(--gold-on-ink);
}

.studio-title {
  min-width: 0;
}

.studio-title h1 {
  font-size: clamp(1.35rem, 2.5vw, 1.75rem);
  font-weight: 650;
  letter-spacing: -0.025em;
  margin-bottom: var(--space-xs);
  color: var(--on-ink);
  line-height: 1.35;
}

.studio-title p {
  color: var(--on-ink-muted);
  font-size: clamp(0.875rem, 1.5vw, 0.9375rem);
  line-height: 1.75;
  max-width: 65ch;
  margin: 0;
}

.studio-stats {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--space-lg);
  margin-top: var(--space-md);
  padding-top: var(--space-md);
  border-top: 1px solid var(--gold-line);
}

.studio-stats > div {
  display: flex;
  flex-direction: column;
  gap: var(--space-2xs);
}

.studio-stats dt {
  font-size: 0.75rem;
  color: var(--on-ink-muted);
  font-weight: 500;
  letter-spacing: 0.02em;
  text-transform: uppercase;
}

.studio-stats dd {
  font-size: clamp(1.5rem, 3vw, 1.875rem);
  font-weight: 650;
  font-variant-numeric: tabular-nums;
  color: var(--on-ink);
  margin: 0;
  display: flex;
  align-items: center;
  gap: var(--space-xs);
}

.studio-log {
  position: relative;
  z-index: 1;
  font-size: 0.6875rem;
  color: var(--on-ink-muted);
  letter-spacing: 0.015em;
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem 1rem;
}

.studio-log span::after {
  content: '·';
  margin-left: 1rem;
  opacity: 0.5;
}

.studio-log span:last-child::after {
  display: none;
}

.studio-link {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2xs);
  min-height: 44px;
  color: var(--on-ink);
  flex-shrink: 0;
  font-size: 0.875rem;
  transition: all 0.2s ease;
}

.studio-link:hover {
  color: var(--accent-on-ink);
  text-decoration: underline;
  text-underline-offset: 4px;
}

.personal-model-bar { display: flex; align-items: center; justify-content: space-between; gap: var(--space-md); padding: var(--space-sm) var(--space-md); margin-bottom: var(--space-md); border: 1px solid var(--line); border-radius: var(--radius); background: var(--paper); }
.personal-model-bar > div { display: grid; gap: var(--space-3xs); min-width: 0; }
.personal-model-bar strong { font-size: var(--text-sm); }
.personal-model-bar span { font-size: var(--text-xs); color: var(--muted); }
.personal-model-bar button { flex-shrink: 0; }
.studio-error { padding: var(--space-sm); border: 1px solid color-mix(in oklch, var(--danger) 25%, var(--paper)); border-radius: var(--radius-input); color: var(--danger); background: var(--danger-soft); }
.upload-stage { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--space-xl); padding: var(--space-lg); border: 1px solid var(--line); border-radius: var(--radius); background: var(--paper); }
.upload-story { min-width: 0; max-width: 800px; margin: 0 auto; }
.upload-story h2 { margin-bottom: var(--space-md); font-size: clamp(1.5rem, 3vw, 1.875rem); line-height: 1.4; letter-spacing: -0.03em; text-align: center; }
.upload-animation { margin: var(--space-lg) 0; border-radius: var(--radius); overflow: hidden; }
.upload-story > p { color: var(--muted); font-size: 0.9375rem; margin: var(--space-md) 0; max-width: 65ch; line-height: 1.85; text-align: center; margin-left: auto; margin-right: auto; }
.story-path { display: flex; align-items: center; justify-content: center; gap: var(--space-xs); font-size: 0.8125rem; color: var(--muted); flex-wrap: wrap; margin-bottom: var(--space-md); }
.story-path svg { width: 14px; height: 14px; }
.upload-workspace { min-width: 0; max-width: 600px; margin: var(--space-xl) auto 0; }
.zip-drop { position: relative; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: var(--space-sm); align-self: start; text-align: center; background: var(--surface); border: 1.5px dashed var(--control-line); border-radius: var(--radius); min-height: 20rem; padding: var(--space-xl) var(--space-lg); margin: 0; cursor: pointer; transition: all 0.25s ease; }
.zip-drop:hover:not(.unavailable), .zip-drop.drag { border-color: var(--accent); background: var(--accent-soft); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 12%, transparent); }
.zip-drop:focus-within { outline: 3px solid var(--accent); outline-offset: 3px; }
/* Only the explicit buttons open pickers; invisible inputs must not intercept clicks. */
.zip-drop .file-picker-input { display: none; }
.zip-drop.unavailable { cursor: not-allowed; }
.upload-symbol { display: grid; place-items: center; width: 64px; height: 64px; border-radius: var(--radius); background: linear-gradient(135deg, var(--accent-soft), var(--gold-soft)); color: var(--accent); border: 1px solid color-mix(in srgb, var(--gold) 45%, transparent); transition: all 0.3s ease; }
.zip-drop:hover .upload-symbol { transform: translateY(-2px); box-shadow: 0 6px 16px -6px color-mix(in srgb, var(--accent) 35%, transparent); }
.zip-drop strong { font-size: 0.9375rem; font-weight: 550; line-height: 1.6; }
.zip-drop > span:not(.upload-symbol):not(.upload-cta) { color: var(--muted); font-size: 0.8125rem; line-height: 1.7; }
.upload-cta { display: inline-flex; align-items: center; justify-content: center; gap: var(--space-2xs); min-height: 44px; padding: var(--space-xs) var(--space-sm); background: var(--accent); color: var(--gl-on-c1); border-radius: var(--radius-input); font-size: var(--text-sm); }
.unavailable .upload-cta { background: var(--sidebar); color: var(--muted); }
.zip-drop small { font-size: var(--text-xs); line-height: 1.8; max-width: 40ch; font-weight: 400; text-align: left; }
.project-history { margin-top: var(--space-xl); }
.project-history h2 { margin-bottom: var(--space-sm); font-size: clamp(1.25rem, 2.5vw, 1.5rem); }
.project-history h2 span { color: var(--muted); font-size: 0.875rem; margin-left: var(--space-xs); font-weight: 500; }
.project-history > a { display: flex; align-items: center; gap: var(--space-sm); padding: var(--space-md) 0; min-height: 64px; border-bottom: 1px solid var(--line); color: var(--ink); transition: all 0.2s ease; }
.project-history > a:hover { color: var(--accent); background: linear-gradient(90deg, color-mix(in srgb, var(--accent) 6%, transparent) 0%, transparent 100%); }
.project-history > a strong { min-width: 0; flex: 1; font-weight: 550; overflow-wrap: anywhere; }
.project-history > a span { color: var(--muted); font-size: 0.8125rem; }
.project-library-heading { display: flex; align-items: center; justify-content: space-between; gap: var(--space-md); margin-bottom: var(--space-md); }
.project-library-heading > div:first-child { min-width: 0; }
.project-library-heading h2 { margin: 0 0 .25rem; }
.project-library-heading p { font-size: 0.875rem; color: var(--muted); margin: 0; line-height: 1.7; }
.project-library-heading :deep(.studio-search) { width: min(19rem, 42%); flex-shrink: 0; }
.project-search-empty { display: flex; align-items: center; justify-content: space-between; gap: var(--space-sm); padding: var(--space-md) 0; color: var(--muted); font-size: .8125rem; }
.project-history > a .project-list-status { display: inline-flex; align-items: center; gap: .45rem; }
.project-list-status::before { content: ''; width: 5px; height: 5px; border-radius: 50%; background: var(--control-line); }
.project-list-status.has-report::before { background: var(--success); }
.project-list-status.in-progress::before { background: var(--accent); }
.project-record-strip { display: flex; align-items: center; flex-wrap: wrap; gap: .6rem 1.2rem; padding: 0 0 var(--space-sm); margin-bottom: var(--space-md); border-bottom: 1px solid var(--line); }
.project-record-copy { display: flex; align-items: center; flex-wrap: wrap; gap: .65rem; margin-right: auto; color: var(--muted); font-size: .75rem; line-height: 1.8; }
.project-record-copy time { font-variant-numeric: tabular-nums; }
.project-record-status { display: inline-flex; align-items: center; gap: .35rem; color: var(--muted); }
.project-record-status.complete { color: var(--success); }
.project-record-select { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: center; gap: .65rem; width: min(100%, 24rem); margin: 0; color: var(--muted); font-size: .75rem; }
.project-record-select :deep(select) { font-size: .75rem; }
.record-settings { padding: .5rem 0; border: 0; background: transparent; color: var(--accent); font-size: .75rem; }
.record-settings:hover { background: transparent; text-decoration: underline; text-underline-offset: 3px; }
.investigation { background: var(--paper); border: 1px solid var(--line); border-radius: var(--radius); padding: var(--space-md); margin-bottom: var(--space-md); }
.investigation-main { min-width: 0; }
.live-label { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-xs); font-size: var(--text-xs); color: var(--muted); margin-bottom: var(--space-sm); }
.live-dot { height: 8px; width: 8px; border-radius: 50%; background: var(--muted); }
.moving .live-dot { background: var(--accent); }
.live-label time { font-variant-numeric: tabular-nums; }
.investigation h2 { font-size: 1.5rem; margin-bottom: var(--space-xs); }
.investigation-main > p { color: var(--muted); max-width: 75ch; }
.stage-track { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-xs); margin: var(--space-md) 0; color: var(--muted); font-size: var(--text-xs); }
.stage-track i { width: 24px; border-top: 1px solid var(--control-line); }
.stage-track .done { color: var(--success); font-weight: 600; }
.round-track { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: var(--space-md); list-style: none; padding: 0; margin: var(--space-md) 0; }
.round-track li { display: flex; gap: var(--space-xs); border-top: 1px solid var(--line); padding-top: var(--space-sm); }
.round-mark { width: 28px; height: 28px; flex-shrink: 0; border: 1px solid var(--line); background: var(--surface); border-radius: 50%; display: grid; place-items: center; font-size: var(--text-xs); }
.round-track .complete .round-mark { background: var(--success-soft); color: var(--success); }
.round-track strong { font-size: var(--text-sm); }
.round-track strong small { display: inline; margin-left: var(--space-2xs); }
.round-track p { font-size: var(--text-xs); color: var(--muted); margin: var(--space-2xs) 0; }
.analysis-actions { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-sm); }
.analysis-actions label { flex: 1; min-width: min(100%, 15rem); max-width: 36rem; margin: 0; }
.next-analysis, .directory-map { border-block: 1px solid var(--line); padding: var(--space-2xs) 0; margin-block: var(--space-md); }
.next-analysis :deep(.source-options) { margin-top: var(--space-sm); }
.next-analysis > button { margin-bottom: var(--space-sm); }
.next-analysis .reuse-option { flex-direction: row; align-items: flex-start; gap: var(--space-xs); font-weight: 400; }
.reuse-option input { margin-top: var(--space-3xs); }
.reuse-notice { background: var(--success-soft); color: var(--success); border: 1px solid var(--line); border-radius: var(--radius-input); padding: var(--space-sm); }
.quiet, .execution-snapshot, .investigation-counts { font-size: var(--text-xs); color: var(--muted); }
.cost-receipt { padding: var(--space-md); margin-block: var(--space-md); background: var(--paper); border: 1px solid var(--line); border-radius: var(--radius); }
.receipt-top { display: flex; align-items: center; justify-content: space-between; gap: var(--space-sm); }
.receipt-top span, .receipt-cap span, .receipt-legend, .cost-receipt p { font-size: var(--text-xs); color: var(--muted); }
.receipt-top h3 { font-size: 2rem; font-variant-numeric: tabular-nums; margin: var(--space-2xs) 0 var(--space-sm); }
.receipt-cap { display: grid; gap: var(--space-2xs); text-align: right; }
.receipt-scale { height: 12px; background: var(--surface); border-radius: .25rem; display: flex; overflow: hidden; }
.receipt-scale span { background: var(--accent); }
.receipt-scale i { background: repeating-linear-gradient(135deg,var(--apricot) 0,var(--apricot) 2px,var(--accent-soft) 2px,var(--accent-soft) 6px); }
.receipt-legend { display: flex; gap: var(--space-md); flex-wrap: wrap; margin-top: var(--space-xs); }
.cost-receipt p { margin: var(--space-xs) 0 0; }
.source-coverage { margin-block: var(--space-md); padding-block: var(--space-sm); }
.coverage-heading { display: flex; align-items: center; gap: var(--space-sm); flex-wrap: wrap; justify-content: space-between; }
.coverage-heading h3 { margin: 0; }
.coverage-heading > span { color: var(--muted); font-size: var(--text-xs); }
.source-coverage dl { display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); gap: var(--space-md); padding: var(--space-md) 0; border-bottom: 1px solid var(--line); margin: 0 0 var(--space-sm); }
.source-coverage dt { font-size: var(--text-xs); color: var(--muted); }
.source-coverage dd { margin: var(--space-2xs) 0 0; font-size: 1.75rem; font-weight: 550; font-variant-numeric: tabular-nums; }
.source-coverage small { display: inline; font-size: var(--text-xs); margin-left: var(--space-2xs); }
.source-coverage p, .source-coverage li { font-size: var(--text-xs); color: var(--muted); max-width: 85ch; line-height: 1.8; }
.source-coverage details { border-top: 1px solid var(--line); }
.source-coverage summary { font-size: var(--text-xs); }
.directory-map ul { list-style: none; padding: 0; }
.directory-map li { display: flex; gap: var(--space-sm); justify-content: space-between; border-top: 1px solid var(--line); padding-block: var(--space-xs); overflow-wrap: anywhere; }
.directory-map span { font-size: var(--text-xs); color: var(--muted); }
.analysis-layout { display: grid; grid-template-columns: minmax(0, .65fr) minmax(0, 1.6fr); gap: var(--space-md); align-items: start; margin-top: var(--space-md); }
.source-ledger { min-width: 0; padding: var(--space-sm) 0; }
.source-ledger h3 { display: flex; justify-content: space-between; align-items: center; }
.source-ledger h3 span { font-size: var(--text-xs); color: var(--muted); }
.source-ledger ol { list-style: none; padding: 0 var(--space-2xs) 0 0; margin: var(--space-md) 0; max-height: 30rem; overflow-y: auto; }
.source-ledger li { position: relative; display: flex; gap: var(--space-xs); padding-bottom: var(--space-md); min-width: 0; }
.source-ledger li > div { min-width: 0; }
.event-marker { margin-top: var(--space-2xs); width: 6px; height: 6px; border-radius: 50%; background: var(--accent); flex-shrink: 0; }
.source-ledger time { color: var(--muted); font-size: var(--text-xs); font-variant-numeric: tabular-nums; }
.source-ledger li p { font-size: var(--text-sm); margin: var(--space-3xs) 0; }
.source-ledger button { color: var(--accent-ink); font-size: var(--text-xs); text-align: left; justify-content: flex-start; max-width: 100%; overflow-wrap: anywhere; word-break: break-word; padding: var(--space-2xs); }
.source-ledger details { border-top: 1px solid var(--line); }
.file-item { display: flex; width: 100%; margin-top: var(--space-2xs); }
.omitted { font-size: var(--text-xs); overflow-wrap: anywhere; margin-block: var(--space-xs); }
.omitted span { color: var(--muted); }
.source-report { min-width: 0; border: 1px solid var(--line); border-radius: var(--radius); background: var(--paper); overflow: hidden; }
.report-intro { padding: var(--space-md); }
.report-intro > p { max-width: 75ch; line-height: 1.8; }
.stack-tags { display: flex; flex-wrap: wrap; gap: var(--space-2xs); }
.stack-tags span { padding: var(--space-3xs) var(--space-2xs); background: var(--surface); border-radius: .375rem; font-size: var(--text-xs); }
.report-tabs { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-3xs); padding: var(--space-2xs) var(--space-sm); border-block: 1px solid var(--line); background: var(--surface); }
.report-tabs button { background: transparent; border-color: transparent; padding: var(--space-2xs); font-size: var(--text-xs); }
.report-tabs button[aria-pressed="true"] { background: var(--paper); border-color: var(--line); color: var(--accent-ink); }
.report-tabs span { font-variant-numeric: tabular-nums; color: var(--muted); }
.report-sections { padding: 0 var(--space-md); }
.report-sections article { padding-block: var(--space-md); border-bottom: 1px solid var(--line); }
.report-sections article:last-child { border-bottom: 0; }
.section-title { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-2xs); margin-bottom: var(--space-sm); }
.section-title h3 { margin: 0; font-size: var(--text-md); }
.report-sections article > p { max-width: 75ch; white-space: pre-wrap; line-height: 1.85; }
.severity, .confidence, .review-decision { font-size: var(--text-xs); padding: var(--space-3xs) var(--space-2xs); background: var(--surface); border-radius: .375rem; color: var(--muted); }
.review-decision { background: var(--success-soft); color: var(--success); }
.review-decision.unresolved, .severity { background: var(--warning-soft); color: var(--warning); }
.verification-note { font-size: var(--text-xs); color: var(--muted); padding-top: var(--space-sm); }
.reading-number { font-family: var(--font-outlier); color: var(--accent); margin-right: var(--space-2xs); }
.next-step { padding-block: var(--space-xs); }
.next-step strong { font-size: var(--text-sm); }
.next-step p { font-size: var(--text-sm); margin: var(--space-2xs) 0; white-space: pre-wrap; }
.citations { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-2xs); margin-top: var(--space-sm); }
.citations button { font-size: var(--text-xs); max-width: 100%; text-align: left; overflow-wrap: anywhere; word-break: break-word; color: var(--accent-ink); }
.citations span { white-space: nowrap; color: var(--muted); }
.report-limits { padding: var(--space-md); border-top: 1px solid var(--line); background: var(--surface); }
.report-limits p { font-size: var(--text-xs); color: var(--muted); margin-bottom: var(--space-2xs); max-width: 75ch; }
.report-pending { background: var(--paper); border: 1px solid var(--line); border-radius: var(--radius); padding: var(--space-xl) var(--space-md); min-width: 0; }
.report-pending > svg { color: var(--accent); margin-bottom: var(--space-md); }
.report-pending h2 { font-size: 1.25rem; }
.report-pending p { color: var(--muted); }
.pending-preview { display: grid; gap: var(--space-sm); margin-top: var(--space-md); color: var(--muted); font-size: var(--text-xs); }
.pending-preview span { padding-top: var(--space-xs); border-top: 1px solid var(--line); }
.source-panel { width: min(70rem, calc(100vw - 2rem)); max-height: 88dvh; padding: 0; }
.source-panel[open] { display: flex; flex-direction: column; }
.source-panel header { display: flex; align-items: center; justify-content: space-between; gap: var(--space-sm); padding: var(--space-sm) var(--space-md); border-bottom: 1px solid var(--line); }
.source-panel header > div { min-width: 0; }
.source-panel h3 { margin: var(--space-3xs) 0 0; font: 600 var(--text-sm) var(--font-outlier); overflow-wrap: anywhere; }
.source-panel > p, .source-panel > div { padding: var(--space-md); }
.source-panel > .source-view-tools { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: var(--space-sm); padding: var(--space-xs) var(--space-md); border-bottom: 1px solid var(--line); color: var(--muted); font-size: var(--text-xs); }
.source-view-tools > button { min-height: 44px; flex-shrink: 0; }
.source-panel pre { margin: 0; padding: var(--space-sm) 0; overflow: auto; font-size: var(--text-xs); line-height: 1.8; background: var(--surface); }
.source-panel code { display: block; min-width: 100%; width: max-content; padding-inline: var(--space-sm); }
.source-panel code > span { display: inline-block; width: 4rem; padding-right: var(--space-sm); color: var(--muted); text-align: right; user-select: none; }
.source-panel code.highlight { background: var(--accent-soft); }
.studio-header-actions .studio-link { white-space: nowrap; }
.upload-stage { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); align-items: start; padding: var(--space-lg); gap: var(--space-xl); }
.upload-story h2 { font-size: 1.7rem; line-height: 1.55; letter-spacing: -.035em; }
.upload-story > p { font-size: var(--text-sm); line-height: 1.95; margin-block: var(--space-sm); }
.upload-principles { padding: 0; margin: var(--space-xl) 0 0; list-style: none; display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: var(--space-lg); }
.upload-principles li { display: flex; gap: var(--space-sm); padding: var(--space-md); border: 1px solid var(--line); border-radius: var(--radius); background: var(--paper); transition: all 0.25s ease; }
.upload-principles li:hover { border-color: var(--accent); box-shadow: 0 8px 20px -12px color-mix(in srgb, var(--ink) 30%, transparent); transform: translateY(-1px); }
.upload-principles li > span { color: var(--accent); font: 0.75rem/1.9 var(--font-outlier); padding-top: .1rem; flex-shrink: 0; }
.upload-principles .bean-icon { color: var(--accent); flex-shrink: 0; margin-top: 0.1rem; }
.upload-principles strong { font-size: 0.9375rem; font-weight: 600; display: block; margin-bottom: 0.25rem; }
.upload-principles p { font-size: 0.8125rem; color: var(--muted); line-height: 1.7; margin: 0; }
.delta-select { font-size: var(--text-sm); }
.delta-select small { color: var(--muted); }
.file-picker-actions { display: flex; flex-wrap: wrap; justify-content: center; gap: var(--space-xs); margin-top: var(--space-md); }
.file-picker-actions button { background: var(--paper); border-color: var(--control-line); transition: all 0.2s ease; }
.file-picker-actions button:hover:not(:disabled) { background: var(--surface); border-color: var(--accent); }
.import-actions { display: flex; align-items: center; gap: var(--space-sm); flex-wrap: wrap; margin-top: var(--space-lg); }
.import-actions button { min-height: 48px; flex: 1; font-weight: 550; transition: all 0.2s ease; }
.import-actions .save-project { background: var(--accent); color: var(--gl-on-c1); border-color: var(--accent); }
.import-actions .save-project:hover:not(:disabled) { background: var(--accent-hover); transform: translateY(-1px); box-shadow: 0 8px 18px -8px color-mix(in srgb, var(--accent) 55%, transparent); }
.import-separation, .import-note { color: var(--muted); font-size: 0.8125rem; line-height: 1.85; margin-top: var(--space-sm); text-align: center; }
.import-note { color: var(--success); }
.import-boundaries { margin-top: var(--space-md); border-top: 1px solid var(--line); }
.import-boundaries summary { font-size: 0.8125rem; font-weight: 500; }
.import-boundaries p { color: var(--muted); font-size: 0.8125rem; line-height: 1.9; }
.upload-analysis-options { border: 1px solid var(--line); border-radius: var(--radius); padding: var(--space-lg); margin-top: var(--space-lg); background: var(--paper); }
.analysis-options-heading { display: flex; justify-content: space-between; align-items: flex-start; gap: var(--space-md); margin-bottom: var(--space-md); }
.analysis-options-heading h2 { margin: 0; font-size: 1.25rem; }
.analysis-options-heading p { color: var(--muted); font-size: 0.875rem; line-height: 1.85; margin: var(--space-2xs) 0 0; }
.analysis-options-heading > button { flex-shrink: 0; }
.incremental-settings { border-top: 1px solid var(--line); margin-top: var(--space-md); }
.incremental-settings summary { font-size: var(--text-sm); }
.incremental-settings summary small, .next-analysis > summary small { color: var(--muted); font-size: .75rem; font-weight: 400; margin-left: .65rem; }
.incremental-settings .delta-select { margin: .75rem 0 .35rem; gap: .55rem; }
.analysis-running-note { display: flex; align-items: center; justify-content: space-between; gap: var(--space-sm); padding: var(--space-xs) var(--space-sm); background: var(--accent-soft); color: var(--accent-ink); border: 1px solid var(--line); border-radius: var(--radius-input); font-size: var(--text-sm); margin-bottom: var(--space-md); }
.project-reading-state { display: flex; align-items: flex-start; gap: var(--space-md); padding: var(--space-lg); border: 1px solid var(--line); border-radius: var(--radius); background: var(--paper); }
.project-reading-state > div { min-width: 0; }
.reading-state-kicker { display: block; color: var(--muted); font-size: var(--text-xs); margin: 0 0 var(--space-xs); }
.project-reading-state h2 { font-size: 1.35rem; line-height: 1.65; margin: 0 0 var(--space-xs); }
.project-reading-state p { color: var(--muted); font-size: var(--text-sm); line-height: 1.9; max-width: 76ch; margin: 0; }
.reading-state-actions { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-sm); margin-top: var(--space-md); }
.reading-state-actions .reading-state-secondary { color: var(--accent); background: transparent; border-color: transparent; }
.project-training-link { display: flex; align-items: center; justify-content: space-between; gap: var(--space-md); padding-block: var(--space-md); margin-top: var(--space-md); border-top: 1px solid var(--line); }
.project-training-link p { color: var(--muted); font-size: .8125rem; line-height: 1.85; margin: 0; }
.project-training-link strong { display: block; font-size: .875rem; font-weight: 550; margin-bottom: .35rem; }
.project-training-link > div { min-width: 0; }
.project-training-link a { display: inline-flex; align-items: center; gap: .4rem; min-height: 44px; flex-shrink: 0; font-size: var(--text-sm); color: var(--accent); }
.analysis-details { border: 1px solid var(--line); border-radius: var(--radius); background: var(--paper); overflow: hidden; margin-top: var(--space-sm); }
.analysis-details > summary { padding: var(--space-sm) var(--space-md); font-size: var(--text-sm); }
.analysis-details > summary small { font-weight: 400; color: var(--muted); margin-left: var(--space-sm); }
.analysis-details[open] > summary { border-bottom: 1px solid var(--line); margin-bottom: 0; }
.analysis-details-body { padding: var(--space-md); }
.analysis-details .investigation { padding: 0 0 var(--space-sm); border: 0; border-radius: 0; }
.analysis-details .investigation h2 { font-size: 1.1rem; }
.analysis-details .investigation-main > p { font-size: .8125rem; line-height: 1.9; }
.analysis-details .cost-receipt { border-radius: var(--radius-input); }
.analysis-details .source-ledger { padding: 0; }
.analysis-details .source-ledger h3 { font-size: var(--text-sm); }
.analysis-detail-files { min-width: 0; margin-top: var(--space-md); }
.analysis-detail-files .source-ledger > ol { max-height: 22rem; }
.project-studio :focus-visible { outline: 2px dashed var(--accent); outline-offset: 4px; }
@media (max-width: 1100px) {
  .studio-header { padding: var(--space-md); }
  .studio-header-top { flex-direction: column; align-items: flex-start; }
  .studio-stats { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--space-md); }
  .upload-stage { grid-template-columns: minmax(0,1fr); padding: var(--space-md); }
  .zip-drop { min-height: 18rem; }
  .analysis-layout { grid-template-columns: minmax(0,.8fr) minmax(0,1.5fr); }
  .upload-principles { grid-template-columns: minmax(0, 1fr); }
}
@media (max-width: 760px) {
  .studio-header { padding: var(--space-sm); flex-direction: column; gap: var(--space-sm); }
  .studio-header-top { gap: var(--space-sm); }
  .studio-title h1 { font-size: 1.35rem; }
  .studio-title p { font-size: 0.875rem; }
  .studio-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .studio-stats dd { font-size: 1.5rem; }
  .studio-header, .personal-model-bar { flex-direction: column; }
  .personal-model-bar { align-items: flex-start; padding: var(--space-sm); }
  .upload-stage { padding: var(--space-sm); gap: var(--space-md); }
  .upload-story h2 { font-size: 1.35rem; }
  .upload-story > p { font-size: .8125rem; }
  .zip-drop { padding: var(--space-md); min-height: 15rem; }
  .import-actions { flex-direction: column; gap: var(--space-2xs); }
  .import-actions button { width: 100%; font-size: .8125rem; padding-inline: var(--space-xs); }
  .upload-principles { gap: var(--space-md); display: none; }
  .analysis-layout { display: flex; flex-direction: column; }
  .analysis-layout > * { width: 100%; }
  .source-ledger { order: 2; }
  .source-ledger ol { max-height: 18rem; }
  .source-coverage dl { grid-template-columns: repeat(2,minmax(0,1fr)); }
  .round-track { grid-template-columns: minmax(0,1fr); }
  .directory-map li { flex-direction: column; gap: var(--space-3xs); }
  .investigation, .cost-receipt, .report-intro, .report-limits { padding: var(--space-sm); }
  .report-sections { padding-inline: var(--space-sm); }
  .source-panel { width: calc(100vw - 1rem); }
  .source-panel header { padding: var(--space-sm); }
  .studio-header-actions { width: 100%; justify-content: space-between; }
  .studio-header p { font-size: .8125rem; line-height: 1.85; }
  .studio-header-actions button, .studio-link { font-size: .8125rem; }
  .upload-stage { gap: var(--space-md); }
  .upload-story h2 { font-size: 1.35rem; }
  .upload-story > p { font-size: .8125rem; }
  .upload-principles { display: none; }
  .zip-drop { min-height: 15rem; }
  .file-picker-actions { width: 100%; }
  .file-picker-actions button { flex: 1; font-size: .8125rem; }
  .import-actions { gap: var(--space-2xs); }
  .import-actions button { font-size: .8125rem; padding-inline: var(--space-xs); }
  .upload-analysis-options { padding: var(--space-sm); }
  .analysis-options-heading { flex-direction: column; gap: var(--space-xs); }
  .project-reading-state { padding: var(--space-md); gap: var(--space-sm); flex-direction: column; }
  .project-reading-state h2 { font-size: 1.15rem; }
  .project-reading-state p { font-size: .8125rem; }
  .reading-state-actions { gap: var(--space-2xs); }
  .reading-state-actions button { font-size: .8125rem; }
  .project-training-link { align-items: flex-start; flex-direction: column; gap: var(--space-2xs); }
  .analysis-details > summary { padding: var(--space-sm); }
  .analysis-details > summary small { display: block; margin: .35rem 0 0 1rem; font-size: .75rem; }
  .analysis-details-body { padding: var(--space-sm); }
  .analysis-running-note { flex-wrap: wrap; font-size: .8125rem; }
  .project-history > a { gap: var(--space-xs); flex-wrap: wrap; }
  .project-history > a strong { flex-basis: calc(100% - 4rem); }
  .project-history > a > span { margin-left: 2rem; }
  .project-library-heading { align-items: flex-start; flex-direction: column; gap: var(--space-sm); }
  .project-library-heading :deep(.studio-search) { width: 100%; }
  .project-record-strip { gap: .55rem; }
  .project-record-copy { width: 100%; }
  .project-record-copy time { font-size: .6875rem; }
  .project-record-select { width: 100%; grid-template-columns: minmax(0, 1fr); gap: .3rem; }
  .incremental-settings summary small, .next-analysis > summary small { margin-left: 0; }
  .project-search-empty { align-items: flex-start; flex-direction: column; }
}
/* ── 雾港手稿 · AI 项目解读 (2026-10-04) ─────────────────────
   Ruled sheets, serif numbering, one rust accent. Gauges only move toward real API values. */

.upload-stage { grid-template-columns: minmax(0, 1.05fr) minmax(0, .95fr); gap: var(--space-xl); padding: var(--space-lg) 0 var(--space-xl); border: 0; border-top: 1px solid var(--ink); border-radius: 0; background: transparent; }
.upload-story h2 { font-size: clamp(1.6rem, 1.2rem + 1.2vw, 2.3rem); line-height: 1.45; letter-spacing: .04em; margin: var(--space-sm) 0 var(--space-md); }
.upload-chart { max-width: 34rem; margin: 0 0 var(--space-md); }
.story-path { font-family: var(--font-outlier); letter-spacing: .12em; }
.story-path svg { color: var(--accent); }

.upload-principles { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); margin: 0 0 var(--space-xl); padding: 0; border-top: 1px solid var(--ink); border-bottom: 1px solid var(--line); }
.upload-principles li { position: relative; isolation: isolate; display: grid; grid-template-columns: minmax(0, 1fr) auto; align-content: start; gap: var(--space-sm); padding: var(--space-md) var(--space-md) var(--space-lg); border-top: 0; border-left: 1px solid var(--line); }
.upload-principles li:first-child { border-left: 0; }
.upload-principles li::before { content: ''; position: absolute; inset: 0; z-index: -1; background: var(--paper); opacity: 0; transition: opacity .6s var(--ease-out); }
.upload-principles li:hover::before { opacity: 1; }
.upload-principles .bean-no { padding: 0; font: 600 clamp(2.75rem, 4.6vw, 4.5rem)/.9 var(--font-display); color: var(--ink); letter-spacing: 0; transition: color .6s var(--ease-out); }
.upload-principles .bean-icon { justify-self: end; color: var(--accent); transition: rotate 1.2s var(--ease-emphasis); }
.upload-principles li:hover .bean-no { color: var(--accent); }
.upload-principles li:hover .bean-icon { rotate: -28deg; }
.upload-principles li > div { grid-column: 1 / -1; }
.upload-principles strong { font: 600 1.05rem/1.6 var(--font-display); letter-spacing: .06em; }

.zip-drop { isolation: isolate; min-height: 20rem; padding: var(--space-xl) var(--space-md) var(--space-lg); background: color-mix(in srgb, var(--paper) 40%, transparent); border: 1px dashed var(--ink-line); border-radius: 0; }
/* Crop marks at the four corners; they open outward on hover/drag. */
.zip-drop::before {
  content: '';
  position: absolute;
  inset: -7px;
  pointer-events: none;
  background:
    linear-gradient(var(--gl-solid), var(--gl-solid)) 0 0 / 16px 1.5px no-repeat,
    linear-gradient(var(--gl-solid), var(--gl-solid)) 0 0 / 1.5px 16px no-repeat,
    linear-gradient(var(--gl-solid), var(--gl-solid)) 100% 0 / 16px 1.5px no-repeat,
    linear-gradient(var(--gl-solid), var(--gl-solid)) 100% 0 / 1.5px 16px no-repeat,
    linear-gradient(var(--gl-solid), var(--gl-solid)) 0 100% / 16px 1.5px no-repeat,
    linear-gradient(var(--gl-solid), var(--gl-solid)) 0 100% / 1.5px 16px no-repeat,
    linear-gradient(var(--gl-solid), var(--gl-solid)) 100% 100% / 16px 1.5px no-repeat,
    linear-gradient(var(--gl-solid), var(--gl-solid)) 100% 100% / 1.5px 16px no-repeat;
  transition: inset .8s var(--ease-emphasis);
}
.zip-drop:hover:not(.unavailable)::before, .zip-drop.drag::before { inset: -12px; }
.zip-drop:hover:not(.unavailable), .zip-drop.drag { border-color: var(--accent); background: color-mix(in srgb, var(--accent-soft) 55%, transparent); }
.zip-drop:focus-within { outline: 2px dashed var(--accent); outline-offset: 6px; }
.drop-scribble { position: absolute; top: calc(var(--space-xl) - 2px); left: max(var(--space-xs), calc(50% - 152px)); width: 96px; height: auto; rotate: -4deg; pointer-events: none; fill: none; stroke: var(--accent); stroke-width: 1.4; stroke-linecap: round; stroke-linejoin: round; }
.upload-symbol { width: 64px; height: 64px; border-radius: 50%; background: var(--paper); color: var(--accent); border: 1px solid var(--ink-line); }
.zip-drop strong { font: 600 1.15rem/1.7 var(--font-display); letter-spacing: .04em; }
.file-picker-actions button { background: transparent; border-color: var(--ink-line); }
.import-actions .save-project { background: var(--gl-solid); color: var(--gl-text); border-color: var(--ink); }
.import-actions .save-project:hover:not(:disabled) { background: var(--accent); border-color: var(--accent); }
.import-boundaries { border-top: 1px solid var(--line); }

.upload-analysis-options { border: 1px solid var(--line); border-top: 1px solid var(--ink); border-radius: 0; background: color-mix(in srgb, var(--paper) 55%, transparent); }
.personal-model-bar { border-radius: 0; background: transparent; border: 1px solid var(--line); border-left: 2px solid var(--ink); }
.studio-error { border: 0; border-left: 2px solid var(--danger); border-radius: 0; }
.analysis-running-note { border: 0; border-left: 2px solid var(--accent); border-radius: 0; }
.reuse-notice { border: 0; border-left: 2px solid var(--success); border-radius: 0; }

.project-history { margin-top: var(--space-xl); }
.project-library-heading { align-items: flex-end; margin-bottom: 0; padding-bottom: var(--space-sm); border-bottom: 1px solid var(--ink); }
.project-library-heading h2 { font-size: clamp(1.5rem, 1.2rem + .9vw, 2rem); margin: .35rem 0 .25rem; }
.project-history h2 span { font: .8125rem var(--font-outlier); letter-spacing: .1em; color: var(--accent); vertical-align: super; }
.project-history > a { position: relative; isolation: isolate; display: grid; grid-template-columns: 2.5rem auto minmax(0, 1fr) auto auto; align-items: center; column-gap: var(--space-sm); padding: var(--space-sm) var(--space-xs); min-height: 68px; border-bottom: 1px solid var(--line); text-decoration: none; }
.project-history > a::before { content: ''; position: absolute; inset: 0; z-index: -1; background: var(--paper); opacity: 0; transition: opacity .6s var(--ease-out); }
.project-history > a:is(:hover, :focus-visible)::before { opacity: 1; }
.project-history > a:hover { color: var(--ink); }
.project-history > a > svg:first-of-type { color: var(--accent); }
.project-history > a .log-no { font: .75rem var(--font-outlier); letter-spacing: .16em; color: var(--muted); }
.project-history > a strong { font: 600 1.05rem/1.6 var(--font-display); letter-spacing: .04em; transition: color .4s var(--ease-out); }
.project-history > a:hover strong { color: var(--accent); }
.project-history > a .project-list-status { font-family: var(--font-outlier); letter-spacing: .06em; }
.project-list-status.in-progress::before { color: var(--accent); animation: studio-pulse 2.8s var(--ease-out) infinite; }

.project-record-strip { border-bottom: 1px solid var(--ink); }
.project-record-copy time { font-family: var(--font-outlier); letter-spacing: .06em; }
.project-reading-state { position: relative; display: grid; grid-template-columns: minmax(0, 1fr) minmax(18rem, 27rem); align-items: center; gap: var(--space-xl); padding: var(--space-lg) 0; border: 0; border-top: 1px solid var(--ink); border-bottom: 1px solid var(--line); border-radius: 0; background: transparent; }
.reading-state-kicker { display: inline-flex; align-items: center; gap: .6rem; font: .6875rem/1.6 var(--font-outlier); letter-spacing: .2em; color: var(--muted); }
.project-reading-state h2 { font-size: clamp(1.5rem, 1.1rem + 1.2vw, 2.2rem); line-height: 1.45; letter-spacing: .04em; }
.reading-chart { min-width: 0; }

/* Ink block: the one inverted surface on the page. Secondary copy uses --on-ink-muted (8.3:1 on ink). */
.project-training-link { position: relative; overflow: hidden; display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: var(--space-md) var(--space-xl); margin-top: var(--space-xl); padding: var(--space-xl) var(--space-lg) var(--space-lg); background: var(--gl-solid); color: var(--gl-text); border: 0; }
.project-training-link .ms-flag { position: absolute; top: 0; left: var(--space-lg); }
.project-training-link > div, .project-training-link a { position: relative; z-index: 1; }
.project-training-link strong { font: 600 clamp(1.25rem, 1rem + .8vw, 1.75rem)/1.5 var(--font-display); letter-spacing: .06em; color: var(--gl-text); }
.project-training-link p { color: var(--on-ink-muted); }
.project-training-link a { color: var(--gl-text); }
.project-training-link a:hover { color: var(--apricot); }
.project-training-link a:focus-visible { outline-color: var(--apricot); }
.project-training-link .ms-wordmark { position: absolute; right: -.4rem; bottom: -1.1rem; z-index: 0; font-size: clamp(4rem, 2.5rem + 6vw, 8.5rem); pointer-events: none; }

.analysis-details { border: 1px solid var(--line); border-top: 1px solid var(--ink); border-radius: 0; background: transparent; }
.analysis-details > summary { font-family: var(--font-display); letter-spacing: .06em; }
.investigation { border: 0; border-top: 1px solid var(--ink); border-radius: 0; background: transparent; padding-inline: 0; }
.live-label { font-family: var(--font-outlier); letter-spacing: .12em; }
.moving .live-dot { color: var(--accent); animation: studio-pulse 2.8s var(--ease-out) infinite; }
/* Reading route: five stations joined by dashed legs; legs between two finished stations turn to solid ink. */
.stage-track { flex-wrap: nowrap; gap: 0; margin: var(--space-lg) 0; font: .75rem/1.4 var(--font-outlier); letter-spacing: .08em; }
.stage-track span { display: inline-flex; flex-direction: column; align-items: center; gap: .55rem; white-space: nowrap; }
.stage-track span::before { content: ''; width: 9px; height: 9px; border-radius: 50%; border: 1.2px solid var(--ink-line); color: var(--accent); transition: background .6s var(--ease-out), border-color .6s var(--ease-out); }
.stage-track .done { color: var(--ink); font-weight: 600; }
.stage-track .done::before { background: var(--accent); border-color: var(--accent); }
.stage-track i { flex: 1; width: auto; min-width: 1.5rem; align-self: flex-start; margin: 4px .5rem 0; border-top: 1px dashed var(--control-line); }
.stage-track .done + i:has(+ .done) { border-top: 1px solid var(--ink); }
.moving .stage-track > span:first-child:not(.done)::before,
.moving .stage-track .done + i + span:not(.done)::before { border-color: var(--accent); animation: studio-pulse 2.8s var(--ease-out) infinite; }
.round-mark { background: transparent; border-color: var(--ink-line); font: 600 .875rem var(--font-display); }
.round-track .complete .round-mark { background: var(--gl-solid); color: var(--gl-text); border-color: var(--ink); }
.round-track li { border-top: 1px solid var(--line); }

.cost-receipt { padding: var(--space-md) 0; border: 0; border-top: 1px solid var(--ink); border-bottom: 1px solid var(--line); border-radius: 0; background: transparent; }
.receipt-top h3 { font-family: var(--font-display); font-size: clamp(2rem, 1.5rem + 1.4vw, 2.75rem); letter-spacing: .02em; }
.receipt-top span, .receipt-cap span, .receipt-legend { font-family: var(--font-outlier); letter-spacing: .1em; }
.receipt-scale { align-items: flex-end; height: 30px; overflow: visible; border-radius: 0; border-bottom: 1px solid var(--ink); background: repeating-linear-gradient(90deg, var(--ink-line) 0 1px, transparent 1px 10%) bottom / 100% 8px no-repeat; }
.receipt-scale span { height: 14px; background: var(--accent); transform-origin: left; animation: studio-draw var(--duration-data) var(--ease-out-expo) .2s both; }
.receipt-scale i { height: 14px; background: repeating-linear-gradient(135deg, var(--apricot) 0 1.5px, transparent 1.5px 5px); transform-origin: left; animation: studio-draw var(--duration-data) var(--ease-out-expo) .5s both; }

.coverage-heading { padding-bottom: var(--space-2xs); }
.coverage-heading > span { font-family: var(--font-outlier); letter-spacing: .1em; }
.source-coverage dl { gap: 0; padding: 0; margin: var(--space-xs) 0 var(--space-md); border-top: 1px solid var(--ink); border-bottom: 0; }
.source-coverage dl > div { padding: var(--space-sm) var(--space-md) var(--space-xs); border-left: 1px solid var(--line); min-width: 0; }
.source-coverage dl > div:first-child { padding-left: 0; border-left: 0; }
.source-coverage dt { font-family: var(--font-outlier); letter-spacing: .14em; }
.source-coverage dd { font: 600 clamp(1.75rem, 1.3rem + 1.2vw, 2.5rem)/1.15 var(--font-display); color: var(--ink); }
.source-coverage dd small { font-family: var(--font-body); font-weight: 400; color: var(--muted); }
/* Tide gauge: sea-blue fill and a rust pointer travel to the real read-lines share. */
.coverage-gauge { display: grid; gap: .6rem; margin: 0 0 var(--space-md); }
.coverage-gauge > span { font: .6875rem/1.6 var(--font-outlier); letter-spacing: .16em; color: var(--muted); }
.coverage-gauge > span b { color: var(--accent); font-weight: 600; }
.gauge { position: relative; height: 30px; border-bottom: 1px solid var(--ink); background: repeating-linear-gradient(90deg, var(--ink-line) 0 1px, transparent 1px 10%) bottom / 100% 8px no-repeat; }
.gauge i { position: absolute; left: 0; bottom: 0; height: 14px; width: var(--r); background: color-mix(in srgb, var(--sea) 35%, transparent); transform-origin: left; animation: studio-draw var(--duration-data) var(--ease-out-expo) .2s both; }
.gauge b { position: absolute; top: 0; left: var(--r); width: 0; height: 0; border-inline: 6px solid transparent; border-top: 9px solid var(--accent); translate: -50% 0; animation: gauge-mark var(--duration-data) var(--ease-out-expo) .2s both; }
.rv:not(.in) .gauge > *, .rv:not(.in) .receipt-scale > * { animation-play-state: paused; }
@keyframes gauge-mark { from { left: 0; } }

.source-ledger ol { padding-left: 5px; }
.source-ledger li { border-left: 1px solid var(--line); padding-left: var(--space-sm); }
.event-marker { position: absolute; left: -5px; top: .3rem; margin: 0; width: 9px; height: 9px; border: 1.2px solid var(--accent); background: var(--canvas); }
.source-ledger li:last-child .event-marker { background: var(--accent); }
.source-report, .report-pending { border-radius: 0; border-top: 1px solid var(--ink); background: transparent; }
.report-tabs { background: transparent; }
.report-tabs button[aria-pressed="true"] { background: transparent; border-color: transparent; box-shadow: inset 0 -1.5px 0 var(--accent); }
.stack-tags span, .severity, .confidence, .review-decision { border-radius: 0; }
.source-panel code.highlight { box-shadow: inset 2px 0 0 var(--accent); }
/* 精致化 (2026-10-04)：日志刊头、页边注编号、虚线禁用态与菱形注记。 */
.studio-stats dt { transition: color .5s var(--ease-out); }
.studio-stats > div:hover dt { color: var(--accent); }
.import-actions button:disabled { background: transparent; color: var(--muted); border: 1px dashed var(--control-line); opacity: 1; }
/* Core action: ink block; a rust wash spreads from the left on hover. */
.reading-state-actions .reading-state-primary { position: relative; isolation: isolate; overflow: hidden; background: var(--gl-solid); color: var(--gl-text); border-color: var(--ink); transition: border-color .42s var(--ease-out); }
.reading-state-actions .reading-state-primary::before { content: ''; position: absolute; inset: 0; z-index: -1; background: var(--accent); scale: 0 1; transform-origin: left; transition: scale .56s var(--ease-emphasis); }
.reading-state-actions .reading-state-primary:hover:not(:disabled) { background: var(--gl-solid); color: var(--gl-text); border-color: var(--accent); }
.reading-state-actions .reading-state-primary:hover:not(:disabled)::before { scale: 1 1; }
.reading-state-actions .reading-state-primary svg { transition: translate .5s var(--ease-emphasis); }
.reading-state-actions .reading-state-primary:hover:not(:disabled) svg { translate: 4px 0; }
.import-boundaries p { position: relative; padding-left: 1.5em; }
.import-boundaries p::before { content: '◇'; position: absolute; left: 0; top: 0; color: var(--accent); font-size: .8em; line-height: 2.2; }
.upload-principles { border-bottom-color: transparent; }
@media (max-width: 1100px) {
  .upload-stage { grid-template-columns: minmax(0, 1fr); gap: var(--space-lg); }
  .zip-drop { min-height: 18rem; }
  .project-reading-state { grid-template-columns: minmax(0, 1fr); gap: var(--space-md); }
  .reading-chart { max-width: 30rem; }
}
@media (max-width: 760px) {
  .upload-stage { padding: var(--space-md) 0 var(--space-lg); }
  .upload-principles { display: grid; grid-template-columns: minmax(0, 1fr); margin-bottom: var(--space-lg); }
  .upload-principles li { grid-template-columns: 3.25rem minmax(0, 1fr) auto; padding: var(--space-sm) 0; border-left: 0; border-top: 1px solid var(--line); }
  .upload-principles li:first-child { border-top: 0; }
  .upload-principles .bean-no { font-size: 2.25rem; grid-column: 1; grid-row: 1; }
  .upload-principles li > div { grid-column: 2; grid-row: 1; }
  .upload-principles .bean-icon { grid-column: 3; grid-row: 1; }
  .project-library-heading { align-items: stretch; }
  .project-history > a { grid-template-columns: 2rem minmax(0, 1fr) auto; row-gap: .25rem; padding-inline: 0; }
  .project-history > a > svg:first-of-type { display: none; }
  .project-history > a .log-no { grid-row: 1 / 3; margin-left: 0; }
  .project-history > a strong { grid-column: 2; grid-row: 1; }
  .project-history > a > .project-list-status { grid-column: 2; grid-row: 2; margin-left: 0; }
  .project-history > a > svg:last-of-type { grid-column: 3; grid-row: 1 / 3; }
  .project-reading-state { padding: var(--space-md) 0; }
  .project-training-link { grid-template-columns: minmax(0, 1fr); padding: var(--space-xl) var(--space-sm) var(--space-md); }
  .project-training-link .ms-flag { left: var(--space-sm); }
  .stage-track { font-size: .625rem; letter-spacing: 0; }
  .stage-track i { min-width: .5rem; margin-inline: .25rem; }
  .source-coverage dl > div:nth-child(odd) { padding-left: 0; border-left: 0; }
  .source-coverage dl > div:nth-child(n + 3) { border-top: 1px solid var(--line); }
  .investigation, .cost-receipt { padding-inline: 0; }
}
@media (prefers-reduced-motion: reduce) { .upload-principles li:hover .bean-icon { rotate: none; } .project-studio *, .project-studio *::before, .project-studio *::after { transition: none !important; animation: none !important; scroll-behavior: auto !important; } }
:global(main.content:has(.reading-complete)) { padding-top: 1rem; }
.reading-complete .reading-header .studio-header-content { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: .25rem 1rem; align-items: center; }
.reading-complete .reading-header .studio-header-top { display: contents; }
.reading-complete .reading-header .reading-breadcrumb { grid-column: 1 / -1; }
.reading-complete .reading-header .studio-title { grid-column: 1; grid-row: 2; min-width: 0; }
.reading-complete .reading-header .studio-title h1 { font: 600 1.75rem/1.5 var(--font-body); margin: 0; }
.reading-complete .reading-header .studio-title h1.name-collapsed { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.name-disclosure { min-height: 44px; background: transparent; border: 0; color: var(--accent); padding: .25rem 0; font-size: .875rem; }
.reading-complete .reading-header .studio-header-actions { grid-column: 2; grid-row: 2; }
.reading-complete .reading-header .studio-header-actions > .studio-link { display: none; }
@media (max-width: 760px) {
  .reading-complete .reading-header .studio-header-content { grid-template-columns: minmax(0, 1fr); }
  .reading-complete .reading-header .studio-title h1 { font-size: 1.5rem; }
  .reading-complete .reading-header .studio-header-actions { grid-column: 1; grid-row: 3; justify-content: flex-start; flex-wrap: wrap; }
}
</style>
<style scoped>
.project-shell .zip-drop, .zip-drop { border-radius: var(--gl-r-xl); border: 1px dashed var(--gl-control-line); outline: none; box-shadow: var(--gl-inner-hl); }
.zip-drop::before, .zip-drop::after { content: none; }
.file-picker-actions { display: flex; gap: 12px; flex-wrap: wrap; justify-content: center; }
.file-picker-actions button { width: auto; min-width: 120px; min-height: 44px; white-space: nowrap; border-radius: var(--gl-r-pill); }
.upload-stage { border-top-color: var(--gl-line); }
.project-reading-state { border-radius: var(--gl-r-xl); }
</style>
