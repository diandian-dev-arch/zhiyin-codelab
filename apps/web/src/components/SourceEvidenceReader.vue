<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { ArrowLeft, ArrowRight, Copy, X } from 'lucide-vue-next';
import type { EvidenceContext, SourceCitation, SourceContent } from '../lib/source-evidence';

const props = defineProps<{
  identity: string;
  versionLabel: string;
  loadSource: (citation: SourceCitation, full: boolean, signal: AbortSignal) => Promise<SourceContent>;
}>();
const root = ref<HTMLElement>();
const pane = ref<HTMLElement>();
const width = ref(0);
const wide = computed(() => width.value >= 1040);
const selection = ref<EvidenceContext>();
const fileMode = ref(false);
const full = ref(false);
const busy = ref(false);
const error = ref('');
const copied = ref(false);
const source = ref<SourceContent>();
const citation = computed(() => selection.value?.citations[selection.value.selectedIndex]);
const content = computed(() => source.value?.content.split('\n') ?? []);
const lines = computed(() => {
  if (!citation.value || !source.value) return [];
  const start = full.value ? 1 : Math.max(1, citation.value.start - 5);
  const end = full.value ? content.value.length : citation.value.end + 10;
  const offset = source.value.startLine ?? 1;
  const first = Math.max(offset, start);
  return content.value.slice(first - offset, end - offset + 1).map((text, index) => ({ number: first + index, text }));
});
let sequence = 0;
let controller: AbortController | undefined;
let observer: ResizeObserver | undefined;
let trigger: HTMLElement | undefined;
let citationButtons: HTMLElement[] = [];
let returnScroll = 0;

async function present() {
  await nextTick();
  const element = pane.value;
  if (element instanceof HTMLDialogElement && selection.value && !element.open) element.showModal();
}
watch(wide, async () => {
  const hadFocus = pane.value?.contains(document.activeElement);
  await present();
  if (hadFocus) pane.value?.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
}, { flush: 'pre' });
watch(() => props.identity, () => {
  const hadFocus = pane.value?.contains(document.activeElement);
  close(false);
  if (hadFocus) void nextTick(() => root.value?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus({ preventScroll: true }));
});
onMounted(() => {
  observer = new ResizeObserver(entries => { width.value = entries[0].contentRect.width; });
  if (root.value) observer.observe(root.value);
});
onUnmounted(() => { sequence++; controller?.abort(); observer?.disconnect(); });

async function read() {
  if (!citation.value) return;
  const request = ++sequence;
  const identity = props.identity;
  controller?.abort();
  const abort = new AbortController();
  controller = abort;
  const timeout = window.setTimeout(() => abort.abort(), 15000);
  source.value = undefined;
  error.value = '';
  copied.value = false;
  busy.value = true;
  try {
    const result = await props.loadSource(citation.value, full.value, abort.signal);
    abort.signal.throwIfAborted();
    if (request !== sequence || identity !== props.identity) return;
    source.value = result;
    busy.value = false;
    await nextTick();
    const code = pane.value?.querySelector('.highlight') as HTMLElement | null;
    // Scroll only the local code viewport, never the explanation column.
    if (code?.parentElement) code.parentElement.scrollTop = Math.max(0, code.offsetTop - code.parentElement.offsetTop - 80);
  } catch (failure) {
    if (request === sequence && identity === props.identity) error.value = abort.signal.aborted
      ? '源码读取超时，请重试。无需重新分析。'
      : '源码暂时无法读取或无权访问。请重试，不会尝试其他项目的同名文件。';
  } finally {
    window.clearTimeout(timeout);
    if (request === sequence) busy.value = false;
  }
}
async function openEvidence(context: EvidenceContext, asFile = false) {
  if (!context.citations[context.selectedIndex]) return;
  if (!selection.value) {
    returnScroll = window.scrollY;
  }
  if (document.activeElement instanceof HTMLButtonElement && !pane.value?.contains(document.activeElement)) {
    trigger = document.activeElement;
    const group = trigger.closest('.reader-citations, .scene-evidence') ?? trigger.parentElement;
    const buttons = Array.from(group?.querySelectorAll<HTMLElement>('button') ?? []);
    citationButtons = buttons.length === context.citations.length ? buttons : [];
  }
  selection.value = context;
  updateHighlight();
  if (!asFile && document.activeElement instanceof HTMLButtonElement && !citationButtons.length) document.activeElement.setAttribute('data-evidence-selected', 'true');
  fileMode.value = asFile;
  full.value = asFile;
  await present();
  void read();
}
function openCitation(value: SourceCitation) {
  return openEvidence({ owner: { kind: 'module', key: value.path }, contextTitle: '源码阅读', citations: [value], selectedIndex: 0 });
}
function openFile(path: string) {
  return openEvidence({ owner: { kind: 'module', key: path }, contextTitle: '直接浏览源码文件', citations: [{ path, start: 1, end: 1 }], selectedIndex: 0 }, true);
}
function close(restore = true) {
  sequence++;
  controller?.abort();
  if (pane.value instanceof HTMLDialogElement) pane.value.close();
  selection.value = undefined;
  source.value = undefined;
  error.value = '';
  busy.value = false;
  root.value?.querySelectorAll('[data-evidence-selected]').forEach(node => node.removeAttribute('data-evidence-selected'));
  if (restore) {
    void nextTick(() => {
      window.scrollTo({ top: returnScroll, behavior: 'instant' });
      const target = trigger?.isConnected ? trigger : root.value?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"], h2');
      target?.focus({ preventScroll: true });
    });
  }
}
function move(delta: number) {
  if (!selection.value) return;
  const navigation = pane.value?.querySelector('.evidence-navigation');
  const focused = document.activeElement;
  selection.value = { ...selection.value, selectedIndex: selection.value.selectedIndex + delta };
  updateHighlight();
  full.value = false;
  void read();
  void nextTick(() => {
    if (focused instanceof HTMLButtonElement && navigation?.contains(focused) && focused.disabled) {
      navigation.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
    }
  });
}
function updateHighlight() {
  root.value?.querySelectorAll('[data-evidence-selected]').forEach(node => node.removeAttribute('data-evidence-selected'));
  const button = citationButtons[selection.value?.selectedIndex ?? -1];
  if (button?.isConnected) button.setAttribute('data-evidence-selected', 'true');
}
function toggleFull() {
  const restoreFocus = pane.value?.querySelector('.evidence-tools button') === document.activeElement;
  full.value = !full.value;
  const request = sequence + 1;
  void read().then(() => {
    const active = document.activeElement;
    const focusWasLost = active === document.body || active === pane.value;
    if (restoreFocus && request === sequence && focusWasLost) {
      pane.value?.querySelector<HTMLButtonElement>('.evidence-tools button, [role="alert"] + button')?.focus({ preventScroll: true });
    }
  });
}
async function copyPath() {
  if (!citation.value) return;
  try { await navigator.clipboard.writeText(citation.value.path); copied.value = true; }
  catch { copied.value = false; }
}
defineExpose({ openEvidence, openCitation, openFile, close, citation });
</script>

<template>
  <div ref="root" class="evidence-workspace" :class="{ 'is-split': wide && selection }">
    <div class="evidence-explanation"><slot /></div>
    <component :is="wide ? 'aside' : 'dialog'" v-if="selection" ref="pane" class="evidence-pane"
      :class="{ 'is-modal': !wide }" :aria-label="fileMode ? '项目源码文件' : '源码引用'"
      :role="wide ? 'region' : undefined" @cancel.prevent="close()" @keydown.esc.stop.prevent="close()" @click.self="!wide && close()">
      <header class="evidence-header">
        <div><small>{{ fileMode ? '直接浏览源码' : '正在核实' }}</small><h3>{{ selection.contextTitle }}</h3></div>
        <button type="button" autofocus aria-label="关闭源码" title="关闭源码" @click="close()"><X aria-hidden="true" :size="20" /></button>
      </header>
      <details v-if="selection.contextText" :key="`${selection.owner.kind}:${selection.owner.key}`" class="evidence-context-details">
        <summary>当前判断的完整上下文</summary>
        <p class="evidence-context">{{ selection.contextText }}</p>
      </details>
      <p class="evidence-version">{{ versionLabel }} · 已保存源码，未运行项目</p>
      <div class="evidence-path"><span>{{ citation?.path }}</span><button type="button" :aria-label="copied ? '路径已复制' : '复制完整路径'" :title="copied ? '路径已复制' : '复制完整路径'" @click="copyPath"><Copy aria-hidden="true" :size="16" /></button></div>
      <nav v-if="selection.citations.length > 1" class="evidence-navigation" aria-label="当前判断的引用">
        <button type="button" :disabled="selection.selectedIndex === 0" @click="move(-1)"><ArrowLeft aria-hidden="true" :size="16" />上一处</button>
        <span>{{ selection.selectedIndex + 1 }} / {{ selection.citations.length }}</span>
        <button type="button" :disabled="selection.selectedIndex === selection.citations.length - 1" @click="move(1)">下一处<ArrowRight aria-hidden="true" :size="16" /></button>
      </nav>
      <p v-if="busy" role="status">正在读取源码…</p>
      <div v-else-if="error"><p role="alert">{{ error }}</p><button type="button" @click="read">重试读取源码</button></div>
      <template v-else-if="source && citation">
        <div class="evidence-tools"><span>{{ full ? `完整文件 · ${source.totalLines ?? content.length} 行` : `引用 L${citation.start}–${citation.end} · 共 ${source.totalLines ?? content.length} 行` }}</span><button v-if="!fileMode" type="button" @click="toggleFull">{{ full ? '返回引用片段' : '查看完整文件' }}</button></div>
        <pre tabindex="0" role="group" aria-label="源码内容"><code v-for="line in lines" :key="line.number" :class="{ highlight: !fileMode && line.number >= citation.start && line.number <= citation.end }"><span>{{ line.number }}</span>{{ line.text || ' ' }}
</code></pre>
      </template>
    </component>
  </div>
</template>

<style scoped>
.evidence-workspace { min-width: 0; }
.is-split { display: grid; grid-template-columns: minmax(0, 45fr) minmax(0, 55fr); gap: 1.5rem; align-items: start; }
.evidence-explanation { min-width: 0; }
.evidence-explanation :deep([data-evidence-selected]) { outline: 2px solid var(--accent); outline-offset: 2px; background: var(--accent-soft); }
.evidence-pane { min-width: 0; padding: 1.25rem; border: 1px solid var(--line); background: var(--paper); color: var(--ink); overflow-wrap: anywhere; }
aside.evidence-pane { position: sticky; top: calc(var(--banner-height, 4rem) + 1rem); max-height: calc(100dvh - var(--banner-height, 4rem) - 2rem); overflow-y: auto; }
dialog.evidence-pane { width: min(56rem, calc(100vw - 2rem)); max-width: calc(100vw - 2rem); max-height: calc(100dvh - 2rem); margin: auto; box-sizing: border-box; overflow-y: auto; }
dialog::backdrop { background: color-mix(in srgb,var(--gl-bg) 70%,transparent); backdrop-filter: blur(8px); }
.evidence-header { display: flex; justify-content: space-between; align-items: start; gap: .75rem; }
.evidence-header > div { min-width: 0; }
.evidence-header small, .evidence-version { color: var(--muted); font-size: .875rem; }
.evidence-header h3 { font: 600 1.125rem/1.65 var(--font-body); margin: .25rem 0; letter-spacing: 0; }
.evidence-context { font-size: 1rem; line-height: 1.8; white-space: pre-wrap; }
.evidence-context-details { margin-block: .5rem; }
.evidence-context-details summary { min-height: 44px; display: flex; align-items: center; color: var(--muted); }
.evidence-path { display: flex; gap: .5rem; align-items: start; font: .875rem/1.8 var(--font-outlier); border-block: 1px solid var(--line); padding-block: .5rem; }
.evidence-path span { flex: 1; min-width: 0; }
button { min-height: 44px; min-width: 44px; display: inline-flex; align-items: center; justify-content: center; gap: .35rem; white-space: normal; }
.evidence-navigation, .evidence-tools { display: flex; align-items: center; flex-wrap: wrap; justify-content: space-between; gap: .5rem; font-size: .875rem; margin-block: .5rem; }
pre { max-height: 55dvh; position: relative; overflow: auto; background: var(--canvas); color: var(--ink); margin: .75rem 0 0; font: .875rem/1.8 monospace; tab-size: 2; }
code { display: block; min-width: max-content; font: inherit; padding-inline: .5rem; }
code > span { display: inline-block; width: 3rem; user-select: none; color: var(--muted); }
.highlight { background: var(--accent-soft); border-left: 3px solid var(--accent); padding-left: calc(.5rem - 3px); }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
@media (max-width: 760px) { .evidence-pane { padding: 1rem; } }
</style>
