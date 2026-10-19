<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from 'vue';
import { ChevronRight, ChevronsUp, FileCode2, Folder, FolderOpen, Search, X } from 'lucide-vue-next';
import { buildFileTree, normalizeMapPath, type FileTreeNode } from '../lib/project-map';

const props = defineProps<{
  files: readonly { path: string; lines?: number }[];
  citedPaths?: readonly string[];
  selectedPath?: string;
}>();
const emit = defineEmits<{ select: [path: string] }>();

type TreeRow = {
  node: FileTreeNode;
  depth: number;
  parentId: string | null;
  position: number;
  siblings: number;
};

const instanceId = useId();
const query = ref('');
const expanded = ref(new Set<string>());
const searchExpanded = ref(new Set<string>());
const focusedId = ref<string | null>(null);
const treeElement = ref<HTMLElement | null>(null);
const searchElement = ref<HTMLInputElement | null>(null);
const normalizedQuery = computed(() => normalizeMapPath(query.value.trim()).toLocaleLowerCase());
const selected = computed(() => normalizeMapPath(props.selectedPath ?? ''));
const cited = computed(() => new Set((props.citedPaths ?? []).map(normalizeMapPath)));
const fileInfo = computed(() => new Map(props.files.map(file => [normalizeMapPath(file.path), file])));
// Project polling replaces file objects without changing the hierarchy. Keep
// that refresh from reopening folders the reader has deliberately collapsed.
const filePathSignature = computed(() => JSON.stringify([...new Set(props.files.map(file => normalizeMapPath(file.path)))].sort()));
const tree = computed(() => buildFileTree(JSON.parse(filePathSignature.value) as string[]));
let initialized = false;

function filterNodes(nodes: readonly FileTreeNode[], needle: string): FileTreeNode[] {
  return nodes.flatMap(node => {
    if (node.kind === 'file') return node.path.toLocaleLowerCase().includes(needle) ? [node] : [];
    const children = filterNodes(node.children, needle);
    return children.length ? [{ ...node, children }] : [];
  });
}
const filteredTree = computed(() => normalizedQuery.value ? filterNodes(tree.value, normalizedQuery.value) : tree.value);

function flattenNodes(nodes: readonly FileTreeNode[], open: ReadonlySet<string> | null, depth = 0, parentId: string | null = null): TreeRow[] {
  return nodes.flatMap((node, index) => {
    const row = { node, depth, parentId, position: index + 1, siblings: nodes.length };
    return node.kind === 'directory' && (!open || open.has(node.id))
      ? [row, ...flattenNodes(node.children, open, depth + 1, node.id)]
      : [row];
  });
}
const allRows = computed(() => flattenNodes(tree.value, null));
const activeExpanded = computed(() => normalizedQuery.value ? searchExpanded.value : expanded.value);
const visibleRows = computed(() => flattenNodes(filteredTree.value, activeExpanded.value));
const fileCount = computed(() => allRows.value.filter(row => row.node.kind === 'file').length);
const matchingCount = computed(() => flattenNodes(filteredTree.value, null).filter(row => row.node.kind === 'file').length);
const hasCitedFiles = computed(() => allRows.value.some(row => row.node.kind === 'file' && cited.value.has(row.node.path)));
const tabStop = computed(() => visibleRows.value.find(row => row.node.id === focusedId.value)?.node.id
  ?? visibleRows.value.find(row => row.node.path === selected.value)?.node.id
  ?? visibleRows.value[0]?.node.id);

function revealSelection() {
  const target = allRows.value.find(row => row.node.kind === 'file' && row.node.path === selected.value);
  if (!target) return;
  const byId = new Map(allRows.value.map(row => [row.node.id, row]));
  const next = new Set(activeExpanded.value);
  let parentId = target.parentId;
  while (parentId) {
    next.add(parentId);
    parentId = byId.get(parentId)?.parentId ?? null;
  }
  if (normalizedQuery.value) searchExpanded.value = next;
  else expanded.value = next;
  focusedId.value = target.node.id;
}

watch(tree, (_value, previous) => {
  const validDirectories = new Set(allRows.value.filter(row => row.node.kind === 'directory').map(row => row.node.id));
  expanded.value = new Set([...expanded.value].filter(id => validDirectories.has(id)));
  if (!initialized && tree.value.length) {
    if (tree.value.length === 1 && tree.value[0].kind === 'directory') expanded.value.add(tree.value[0].id);
    initialized = true;
  }
  if (normalizedQuery.value) searchExpanded.value = new Set(flattenNodes(filteredTree.value, null).filter(row => row.node.kind === 'directory').map(row => row.node.id));
  if (!previous || !flattenNodes(previous, null).some(row => row.node.kind === 'file' && row.node.path === selected.value)) revealSelection();
}, { immediate: true });

watch(normalizedQuery, value => {
  if (value) searchExpanded.value = new Set(flattenNodes(filteredTree.value, null).filter(row => row.node.kind === 'directory').map(row => row.node.id));
}, { flush: 'sync' });

watch(selected, value => {
  if (value && normalizedQuery.value && !value.toLocaleLowerCase().includes(normalizedQuery.value)) query.value = '';
  revealSelection();
}, { immediate: true });

function setOpen(id: string, open: boolean) {
  const next = new Set(activeExpanded.value);
  if (open) next.add(id);
  else next.delete(id);
  if (normalizedQuery.value) searchExpanded.value = next;
  else expanded.value = next;
}

function activate(row: TreeRow) {
  focusedId.value = row.node.id;
  if (row.node.kind === 'directory') setOpen(row.node.id, !activeExpanded.value.has(row.node.id));
  else emit('select', fileInfo.value.get(row.node.path)?.path ?? row.node.path);
}

function collapseAll() {
  if (normalizedQuery.value) searchExpanded.value = new Set();
  else expanded.value = new Set();
  focusedId.value = filteredTree.value[0]?.id ?? null;
}

async function clearSearch() {
  query.value = '';
  await nextTick();
  searchElement.value?.focus({ preventScroll: true });
}

async function focusRow(id: string) {
  focusedId.value = id;
  await nextTick();
  const target = Array.from(treeElement.value?.querySelectorAll<HTMLButtonElement>('[role="treeitem"]') ?? [])
    .find(element => element.dataset.nodeId === id);
  target?.focus({ preventScroll: true });
  if (target && treeElement.value) {
    const itemBounds = target.getBoundingClientRect();
    const containerBounds = treeElement.value.getBoundingClientRect();
    if (itemBounds.top < containerBounds.top) treeElement.value.scrollTop -= containerBounds.top - itemBounds.top;
    else if (itemBounds.bottom > containerBounds.bottom) treeElement.value.scrollTop += itemBounds.bottom - containerBounds.bottom;
  }
}

function handleKeydown(event: KeyboardEvent, row: TreeRow, index: number) {
  let next: TreeRow | undefined;
  if (event.key === 'ArrowDown') next = visibleRows.value[Math.min(index + 1, visibleRows.value.length - 1)];
  else if (event.key === 'ArrowUp') next = visibleRows.value[Math.max(index - 1, 0)];
  else if (event.key === 'Home') next = visibleRows.value[0];
  else if (event.key === 'End') next = visibleRows.value.at(-1);
  else if (event.key === 'ArrowRight') {
    if (row.node.kind === 'directory') {
      if (!activeExpanded.value.has(row.node.id)) setOpen(row.node.id, true);
      else next = visibleRows.value[index + 1];
    }
  } else if (event.key === 'ArrowLeft') {
    if (row.node.kind === 'directory' && activeExpanded.value.has(row.node.id)) setOpen(row.node.id, false);
    else next = visibleRows.value.find(item => item.node.id === row.parentId);
  } else if (event.key === 'Enter' || event.key === ' ') activate(row);
  else return;
  event.preventDefault();
  if (next) void focusRow(next.node.id);
}

async function focusSelected() {
  if (selected.value && normalizedQuery.value && !selected.value.toLocaleLowerCase().includes(normalizedQuery.value)) query.value = '';
  revealSelection();
  await nextTick();
  const target = visibleRows.value.find(row => row.node.path === selected.value);
  if (target) await focusRow(target.node.id);
}
defineExpose({ focusSelected });
</script>

<template>
  <div class="source-file-tree">
    <div class="tree-toolbar">
      <div class="tree-search">
        <Search :size="16" aria-hidden="true" />
        <label :for="`${instanceId}-search`" class="tree-sr-only">搜索文件或路径</label>
        <input :id="`${instanceId}-search`" ref="searchElement" v-model="query" type="search" placeholder="搜索文件或路径" autocomplete="off" spellcheck="false" />
        <button v-if="query" class="tree-clear" type="button" aria-label="清除文件搜索" title="清除文件搜索" @click="clearSearch"><X :size="15" aria-hidden="true" /></button>
      </div>
      <button class="tree-collapse" type="button" aria-label="收起全部目录" title="收起全部目录" :disabled="!activeExpanded.size" @click="collapseAll"><ChevronsUp :size="18" aria-hidden="true" /></button>
    </div>
    <div class="tree-status">
      <span role="status" aria-live="polite">{{ normalizedQuery ? `${matchingCount} / ${fileCount}` : fileCount }} 个文件</span>
      <span v-if="hasCitedFiles" class="tree-legend"><i aria-hidden="true" />报告引用</span>
    </div>
    <p :id="`${instanceId}-instructions`" class="tree-sr-only">上下方向键浏览文件，左右方向键展开或收起目录，Enter 或空格键打开文件。</p>
    <div v-if="visibleRows.length" ref="treeElement" class="tree-scroll" role="tree" aria-label="项目文件" :aria-describedby="`${instanceId}-instructions`">
      <button v-for="(row, index) in visibleRows" :key="row.node.id" class="tree-row" :class="{ 'is-directory': row.node.kind === 'directory', 'is-selected': row.node.path === selected }"
        type="button" role="treeitem" :data-node-id="row.node.id" :aria-level="row.depth + 1" :aria-posinset="row.position" :aria-setsize="row.siblings"
        :aria-expanded="row.node.kind === 'directory' ? activeExpanded.has(row.node.id) : undefined"
        :aria-selected="row.node.kind === 'file' ? row.node.path === selected : undefined"
        :aria-label="`${row.node.name}${row.node.kind === 'file' && cited.has(row.node.path) ? '，已被报告引用' : ''}`"
        :tabindex="tabStop === row.node.id ? 0 : -1" :title="row.node.path" :style="{ '--tree-depth': Math.min(row.depth, 8) }"
        @focus="focusedId = row.node.id" @click="activate(row)" @keydown="handleKeydown($event, row, index)">
        <span v-for="level in Math.min(row.depth, 8)" :key="level" class="tree-guide" :style="{ '--guide-depth': level - 1 }" aria-hidden="true" />
        <ChevronRight v-if="row.node.kind === 'directory'" class="tree-chevron" :class="{ 'is-open': activeExpanded.has(row.node.id) }" :size="14" aria-hidden="true" />
        <span v-else class="tree-chevron-space" aria-hidden="true" />
        <FolderOpen v-if="row.node.kind === 'directory' && activeExpanded.has(row.node.id)" class="tree-folder" :size="17" aria-hidden="true" />
        <Folder v-else-if="row.node.kind === 'directory'" class="tree-folder" :size="17" aria-hidden="true" />
        <FileCode2 v-else class="tree-file" :size="16" aria-hidden="true" />
        <span class="tree-name">{{ row.node.name }}</span>
        <i v-if="row.node.kind === 'file' && cited.has(row.node.path)" class="tree-cited" aria-hidden="true" />
        <small v-if="row.node.kind === 'file' && fileInfo.get(row.node.path)?.lines" class="tree-lines" aria-hidden="true">{{ fileInfo.get(row.node.path)?.lines }} 行</small>
      </button>
    </div>
    <div v-else class="tree-empty" role="status"><Search v-if="normalizedQuery" :size="20" aria-hidden="true" /><Folder v-else :size="20" aria-hidden="true" /><span>{{ normalizedQuery ? '暂无匹配文件' : '暂无可浏览的文件' }}</span><small v-if="normalizedQuery">试试文件名、扩展名或目录路径</small></div>
    <div v-if="selected" class="tree-selection" :title="props.selectedPath"><span>已选择</span><span>{{ props.selectedPath }}</span></div>
  </div>
</template>

<style scoped>
.source-file-tree { min-width: 0; max-width: 100%; color: var(--ink); }
.tree-toolbar { display: flex; align-items: center; gap: .5rem; }
.tree-search { display: flex; flex: 1; align-items: center; gap: .55rem; min-width: 0; min-height: 44px; padding: 0 .75rem; border: 1px solid var(--control-line); border-radius: .55rem; background: var(--paper); }
.tree-search > svg { flex: 0 0 auto; color: var(--muted); }
.tree-search:focus-within { outline: 2px solid var(--accent); outline-offset: 2px; }
.tree-search input { width: 100%; min-width: 0; min-height: 42px; margin: 0; padding: 0; border: 0; border-radius: 0; outline: none; background: transparent; color: var(--ink); box-shadow: none; font: .8125rem var(--font-body); }
.tree-search input::placeholder { color: var(--muted); opacity: 1; }
.tree-search input:focus-visible { outline: none; box-shadow: none; }
.tree-search input::-webkit-search-cancel-button { display: none; }
.tree-clear, .tree-collapse { display: grid; place-items: center; flex: 0 0 44px; width: 44px; min-width: 44px; min-height: 44px; margin: 0; padding: 0; border: 0; border-radius: .5rem; background: transparent; color: var(--muted); box-shadow: none; cursor: pointer; }
.tree-clear { margin-right: -.75rem; }
.tree-clear:hover, .tree-collapse:hover:not(:disabled) { background: var(--surface); color: var(--ink); }
.tree-collapse:disabled { opacity: .4; cursor: default; }
.tree-status { display: flex; align-items: center; justify-content: space-between; gap: .75rem; padding: .65rem .2rem; color: var(--muted); font-size: .6875rem; line-height: 1.5; }
.tree-legend { display: inline-flex; align-items: center; gap: .35rem; }
.tree-legend i, .tree-cited { width: 5px; height: 5px; flex: 0 0 5px; border-radius: 50%; background: var(--accent); }
.tree-scroll { max-height: 320px; overflow: auto; overscroll-behavior: contain; scrollbar-width: thin; scrollbar-color: var(--control-line) transparent; padding: 3px; border: 1px solid var(--line); border-radius: .55rem; background: var(--paper); }
.tree-row { position: relative; display: flex; align-items: center; gap: .4rem; width: 100%; max-width: 100%; min-width: 0; min-height: 44px; margin: 0; padding: .3rem .65rem .3rem calc(.55rem + var(--tree-depth) * 1rem); border: 0; border-radius: .3rem; background: transparent; color: var(--ink); box-shadow: none; text-align: left; font: .75rem/1.5 var(--font-outlier); cursor: pointer; transition: background var(--duration-state), color var(--duration-state); }
.tree-row:hover { background: var(--surface); }
.tree-row.is-selected { background: var(--accent-soft); color: var(--accent-ink); }
.tree-row.is-selected::before { content: ''; position: absolute; inset-block: .6rem; left: 6px; width: 3px; border-radius: 2px; background: var(--accent); }
.tree-row > svg, .tree-chevron-space { flex: 0 0 auto; }
.tree-row.is-directory { font-weight: 550; }
.tree-chevron { color: var(--muted); transition: transform var(--duration-state); }
.tree-chevron.is-open { transform: rotate(90deg); }
.tree-chevron-space { width: 14px; height: 14px; }
.tree-folder { color: var(--accent); }
.tree-file { color: var(--muted); }
.tree-name { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.tree-guide { position: absolute; top: 0; bottom: 0; left: calc(.95rem + var(--guide-depth) * 1rem); width: 1px; background: var(--line); pointer-events: none; }
.tree-lines { flex: 0 0 auto; padding-left: .2rem; color: var(--muted); font: .625rem var(--font-body); white-space: nowrap; }
.tree-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: .6rem; min-height: 140px; padding: 1.25rem; color: var(--muted); border: 1px solid var(--line); border-radius: .55rem; background: var(--paper); font-size: .8125rem; text-align: center; }
.tree-empty small { font-size: .75rem; line-height: 1.7; }
.tree-selection { display: flex; align-items: baseline; gap: .5rem; padding: .7rem .2rem 0; color: var(--muted); font-size: .6875rem; line-height: 1.7; }
.tree-selection > span:first-child { flex: 0 0 auto; }
.tree-selection > span:last-child { min-width: 0; overflow-wrap: anywhere; font-family: var(--font-outlier); }
.source-file-tree button:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.source-file-tree .tree-clear:focus-visible { outline-offset: -6px; }
.tree-sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
@media (max-width: 480px) {
  .tree-lines { display: none; }
  .tree-row { padding-left: calc(.4rem + var(--tree-depth) * .75rem); gap: .3rem; }
  .tree-guide { left: calc(.8rem + var(--guide-depth) * .75rem); }
}
@media (prefers-reduced-motion: reduce) {
  .source-file-tree *, .source-file-tree *::before, .source-file-tree *::after { transition: none !important; scroll-behavior: auto !important; }
}
</style>
