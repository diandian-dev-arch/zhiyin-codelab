<script setup lang="ts">
import StudioSelect from './StudioSelect.vue';
import { computed, nextTick, ref, useId, watch } from 'vue';
import { ArrowLeft, ArrowRight, ArrowUpRight, BookOpen, ChevronDown, ChevronUp, FileCode2, FolderTree, Layers3, LocateFixed, Map, Route } from 'lucide-vue-next';
import { buildProjectMap, type MapCitation, type MapReport } from '../lib/project-map';
import SourceFileTree from './SourceFileTree.vue';

const props = defineProps<{ report: MapReport; projectName?: string; files?: readonly { path: string; lines?: number }[]; modulesOnly?: boolean }>();
const emit = defineEmits<{ citation: [citation: MapCitation]; file: [path: string] }>();
type Mode = 'overview' | 'flows' | 'reading';
const uid = useId();
const mode = ref<Mode>('overview');
const expanded = ref(true);
const selectedId = ref('project');
const flowId = ref('flow-0');
const filesExpanded = ref(false);
const selectedPath = ref('');
const filesDisclosure = ref<HTMLDetailsElement>();
const fileTree = ref<InstanceType<typeof SourceFileTree>>();
const canvas = ref<HTMLElement>();
const inspector = ref<HTMLElement>();
const inspectorTitle = ref<HTMLElement>();
const modes = [
  { id: 'overview' as const, title: '全局地图', icon: Layers3 },
  { id: 'flows' as const, title: '业务场景', icon: Route },
  { id: 'reading' as const, title: '阅读路线', icon: BookOpen },
];
const map = computed(() => buildProjectMap(props.report, props.projectName));
const nodes = computed(() => [map.value.root, ...map.value.modules, ...map.value.flows, ...map.value.reading]);
const selected = computed(() => nodes.value.find(node => node.id === selectedId.value) ?? map.value.root);
const flow = computed(() => map.value.flows.find(node => node.id === flowId.value) ?? map.value.flows[0]);
const diagramModules = computed(() => mode.value === 'flows'
  ? map.value.modules.filter(node => flow.value?.relatedModuleIds.includes(node.id))
  : map.value.modules);
const allCitations = computed(() => nodes.value.flatMap(node => node.citations));
const citedPaths = computed(() => [...new Set(allCitations.value.map(citation => citation.path))]);
const treeFiles = computed(() => props.files ?? citedPaths.value.map(path => ({ path })));
const kindLabel = computed(() => ({ project: '项目全景', module: '模块职责', flow: '业务场景', reading: '阅读步骤' })[selected.value.kind]);
const selectedFlows = computed(() => selected.value.kind === 'module'
  ? map.value.flows.filter(item => item.relatedModuleIds.includes(selected.value.id)) : []);
const readingIndex = computed(() => map.value.reading.findIndex(node => node.id === selected.value.id));
const filename = (path: string) => path.split('/').pop() || path;
const stackLabel = (value: string) => value.split(/[：:]/)[0];

// Polling replaces the report object even when its content is unchanged.
watch(() => JSON.stringify([props.projectName, props.report]), () => {
  mode.value = 'overview'; selectedId.value = 'project'; flowId.value = 'flow-0'; selectedPath.value = ''; filesExpanded.value = false;
});

async function chooseMode(value: Mode, focus = false) {
  mode.value = value;
  selectedId.value = value === 'overview' ? 'project' : value === 'flows' ? flow.value?.id ?? 'project' : map.value.reading[0]?.id ?? 'project';
  if (focus) { await nextTick(); document.getElementById(`${uid}-tab-${value}`)?.focus({ preventScroll: true }); }
}
function modeKeydown(event: KeyboardEvent, index: number) {
  let next = index;
  if (event.key === 'ArrowRight') next = (index + 1) % modes.length;
  else if (event.key === 'ArrowLeft') next = (index - 1 + modes.length) % modes.length;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = modes.length - 1;
  else return;
  event.preventDefault(); void chooseMode(modes[next].id, true);
}
function chooseFlow(id: string) { flowId.value = id; selectedId.value = id; }
async function selectNode(id: string) {
  selectedId.value = id;
  await nextTick();
  const canvasBounds = canvas.value?.getBoundingClientRect();
  const detailBounds = inspector.value?.getBoundingClientRect();
  if (canvasBounds && detailBounds && detailBounds.top >= canvasBounds.bottom - 2) {
    inspectorTitle.value?.focus({ preventScroll: true });
    inspector.value?.scrollIntoView({ block: 'start', behavior: 'instant' });
  }
}
function returnToMap() {
  const button = canvas.value?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]');
  button?.focus({ preventScroll: true });
  (button ?? canvas.value)?.scrollIntoView({ block: 'center', behavior: 'instant' });
}
async function locate(citation: MapCitation) {
  selectedPath.value = citation.path; filesExpanded.value = true;
  await nextTick(); await fileTree.value?.focusSelected(); filesDisclosure.value?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
}
function openFile(path: string) {
  selectedPath.value = path;
  emit('file', path);
}
async function exploreFlow(id: string) { await chooseMode('flows', true); chooseFlow(id); }
function stepReading(direction: number) {
  const entry = map.value.reading[readingIndex.value + direction];
  if (entry) selectedId.value = entry.id;
}
</script>

<template>
  <section class="project-map" aria-label="交互项目地图">
    <header class="map-heading">
      <div class="map-heading-main"><span class="map-symbol"><Map aria-hidden="true" :size="22" /></span><div><h2>项目地图</h2><p>先看全局，再沿业务与源码深入。</p></div></div>
      <button class="map-collapse" type="button" :aria-expanded="expanded" :aria-controls="`${uid}-content`" @click="expanded = !expanded"><component :is="expanded ? ChevronUp : ChevronDown" :size="16" /><span>{{ expanded ? '收起地图' : '展开地图' }}</span></button>
    </header>
    <div v-show="expanded" :id="`${uid}-content`">
      <div class="map-toolbar">
        <div v-if="!modulesOnly" class="map-modes" role="tablist" aria-label="项目地图视角">
          <button v-for="(item, index) in modes" :id="`${uid}-tab-${item.id}`" :key="item.id" type="button" role="tab" :aria-selected="mode === item.id" :aria-controls="`${uid}-panel`" :tabindex="mode === item.id ? 0 : -1" @click="chooseMode(item.id)" @keydown="modeKeydown($event, index)"><component :is="item.icon" :size="15" />{{ item.title }}</button>
        </div>
        <span class="map-totals">{{ map.modules.length }} 个模块<span aria-hidden="true"> · </span>{{ map.flows.length }} 个场景</span>
      </div>
      <div :id="`${uid}-panel`" class="map-body" :role="modulesOnly ? 'region' : 'tabpanel'" :aria-label="modulesOnly ? '模块与源码地图' : undefined" :aria-labelledby="modulesOnly ? undefined : `${uid}-tab-${mode}`">
        <div ref="canvas" class="map-canvas">
          <template v-if="mode !== 'reading'">
            <label v-if="mode === 'flows' && map.flows.length" class="flow-picker"><span>选择业务场景</span><StudioSelect aria-label="选择业务场景" :value="flowId" @change="chooseFlow(($event.target as HTMLSelectElement).value)"><option v-for="item in map.flows" :key="item.id" :value="item.id">{{ item.title }}</option></StudioSelect></label>
            <div v-if="mode === 'overview' || flow" class="module-diagram">
              <button v-if="mode === 'overview'" type="button" class="map-root" :class="{ chosen: selected.id === 'project' }" :aria-pressed="selected.id === 'project'" @click="selectNode('project')"><span class="root-icon"><Layers3 aria-hidden="true" :size="21" /></span><span><small>整个项目</small><strong :title="map.root.title">{{ map.root.title }}</strong></span><LocateFixed aria-hidden="true" v-if="selected.id === 'project'" :size="17" class="root-location" /></button>
              <button v-else-if="flow" type="button" class="map-root flow-root" :class="{ chosen: selected.id === flow.id }" :aria-pressed="selected.id === flow.id" @click="selectNode(flow.id)"><span class="root-icon"><Route aria-hidden="true" :size="21" /></span><span><small>当前业务场景</small><strong>{{ flow.title }}</strong></span></button>
              <p class="diagram-relation"><span />{{ mode === 'overview' ? '项目包含的模块 · 点选查看职责' : '引用了相同文件的模块 · 点选查看职责' }}</p>
              <div v-if="diagramModules.length" class="module-branches" :class="{ 'one-module': diagramModules.length === 1, 'flow-branches': mode === 'flows' }">
                <button v-for="node in diagramModules" :key="node.id" type="button" class="module-node" :class="{ chosen: selected.id === node.id }" :aria-pressed="selected.id === node.id" :aria-label="`查看模块：${node.title}`" :title="node.title" @click="selectNode(node.id)">
                  <span class="module-number">{{ String(map.modules.findIndex(item => item.id === node.id) + 1).padStart(2, '0') }}</span><span class="node-content"><strong>{{ node.title }}</strong><small><FileCode2 aria-hidden="true" :size="12" /><span>{{ node.citations[0] ? filename(node.citations[0].path) : '暂无源码引用' }}</span><span v-if="node.citations.length > 1" class="citation-more">+{{ node.citations.length - 1 }}</span></small></span><span class="node-port" aria-hidden="true" />
                </button>
              </div>
              <p v-else class="map-empty">{{ mode === 'flows' ? '这个场景还没有与模块共用的文件引用，可以直接阅读场景说明与源码。' : '这份报告暂未划分模块，可以先查看项目说明或展开文件树。' }}</p>
            </div>
            <p v-else class="map-empty">这份报告尚未形成业务场景。可以从全局地图或文件树开始。</p>
          </template>
          <template v-else>
            <div class="reading-intro"><BookOpen aria-hidden="true" :size="19" /><div><strong>从哪里开始读</strong><p>按报告建议的顺序，逐步建立理解。</p></div><span>{{ map.reading.length }} 步</span></div>
            <ol v-if="map.reading.length" class="reading-map"><li v-for="(node, index) in map.reading" :key="node.id"><button type="button" :class="{ chosen: selected.id === node.id }" :aria-pressed="selected.id === node.id" @click="selectNode(node.id)"><span class="reading-stop">{{ index + 1 }}</span><span class="node-content"><strong>{{ node.title }}</strong><small>{{ node.citations[0] ? filename(node.citations[0].path) : '阅读本步说明' }}</small></span><ArrowRight aria-hidden="true" :size="16" /></button></li></ol>
            <p v-else class="map-empty">这份报告尚未给出阅读路线。可以先点选模块，了解它的职责与代码位置。</p>
          </template>
          <div class="map-legend"><span class="legend-line" :class="{ dashed: mode === 'flows' }" /><span>{{ mode === 'overview' ? '连线表示项目包含这些模块' : mode === 'flows' ? '关联依据为共同引用文件，不代表调用先后' : '连线表示建议阅读顺序' }}</span></div>
        </div>
        <aside ref="inspector" class="map-inspector" :aria-label="`${kindLabel}详情`">
          <div class="inspector-position"><LocateFixed aria-hidden="true" :size="14" /><span>你在这里</span><span class="position-kind">{{ kindLabel }}<template v-if="selected.kind === 'reading'"> {{ readingIndex + 1 }} / {{ map.reading.length }}</template></span></div>
          <h3 ref="inspectorTitle" tabindex="-1" aria-live="polite" aria-atomic="true">{{ selected.kind === 'project' ? '这个项目做什么' : selected.title }}</h3>
          <button class="map-return" type="button" @click="returnToMap"><ArrowLeft aria-hidden="true" :size="14" />返回地图选节点</button>
          <p class="inspector-body" role="group" tabindex="0" :aria-label="`${kindLabel}说明`">{{ selected.body || '当前报告还没有提供足够的说明。' }}</p>
          <div v-if="selected.kind === 'project' && report.stack.length" class="map-stack"><span v-for="stack in report.stack.slice(0, 5)" :key="stack" :title="stack">{{ stackLabel(stack) }}</span><span v-if="report.stack.length > 5" title="完整技术栈见下方项目概览">+{{ report.stack.length - 5 }}</span></div>
          <div v-if="selected.kind === 'project'" class="inspector-guide"><strong>选一个入口，开始探索</strong><button type="button" @click="chooseMode('flows', true)"><Route aria-hidden="true" :size="16" /><span>从业务场景理解代码</span><ArrowRight aria-hidden="true" :size="15" /></button><button type="button" @click="chooseMode('reading', true)"><BookOpen aria-hidden="true" :size="16" /><span>跟着推荐路线阅读</span><ArrowRight aria-hidden="true" :size="15" /></button></div>
          <template v-else>
            <div v-if="selected.nextStep" class="map-next-step"><strong>阅读提示</strong><p>{{ selected.nextStep }}</p></div>
            <div class="inspector-sources"><h4>源码依据 <span>{{ selected.citations.length }}</span></h4><p v-if="!selected.citations.length" class="map-empty">当前节点没有可打开的源码引用。</p><div v-for="citation in selected.citations" :key="`${citation.path}:${citation.start}:${citation.end}`" class="map-source-row"><button class="map-source" type="button" :title="citation.path" :aria-label="`查看源码 ${citation.path} L${citation.start}–${citation.end}`" @click="emit('citation', citation)"><FileCode2 aria-hidden="true" :size="16" /><span><strong>{{ filename(citation.path) }}</strong><small :title="citation.path">{{ citation.path }}</small><em>L{{ citation.start }}–{{ citation.end }}</em></span><ArrowUpRight aria-hidden="true" :size="14" /></button><button class="locate-source" type="button" :aria-label="`在文件树中定位 ${citation.path}`" title="在文件树中定位" @click="locate(citation)"><FolderTree aria-hidden="true" :size="17" /></button></div></div>
            <div v-if="selectedFlows.length" class="related-scenes"><h4>有共同引用的业务场景</h4><button v-for="item in selectedFlows" :key="item.id" type="button" @click="exploreFlow(item.id)"><Route aria-hidden="true" :size="14" /><span>{{ item.title }}</span><ArrowUpRight aria-hidden="true" :size="14" /></button></div>
            <div v-if="selected.kind === 'reading'" class="reading-controls"><button type="button" :disabled="readingIndex <= 0" @click="stepReading(-1)"><ArrowLeft aria-hidden="true" :size="15" />上一步</button><button type="button" :disabled="readingIndex >= map.reading.length - 1" @click="stepReading(1)">下一步<ArrowRight aria-hidden="true" :size="15" /></button></div>
          </template>
        </aside>
      </div>
      <details ref="filesDisclosure" class="map-files" :open="filesExpanded" @toggle="filesExpanded = ($event.target as HTMLDetailsElement).open">
        <summary><ChevronDown aria-hidden="true" class="files-chevron" :size="15" /><FolderTree aria-hidden="true" :size="17" /><strong>文件树</strong><span>{{ treeFiles.length }} 个{{ files ? '已导入文件' : '引用文件' }}</span><small>按目录逐级展开</small></summary>
        <SourceFileTree ref="fileTree" :files="treeFiles" :cited-paths="citedPaths" :selected-path="selectedPath" @select="openFile" />
      </details>
    </div>
  </section>
</template>

<style scoped>
.project-map { container-type: inline-size; min-width: 0; margin-bottom: 1.65rem; border: 1px solid var(--line); border-radius: var(--radius); background: var(--paper); overflow: clip; }
.project-map button { font-family: inherit; box-shadow: none; cursor: pointer; }
.project-map :focus-visible { outline: 3px solid var(--accent); outline-offset: 3px; }
.map-heading { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: 1.25rem 1.5rem 1rem; }
.map-heading-main { display: flex; align-items: center; gap: .8rem; min-width: 0; }
.map-symbol { display: grid; place-items: center; flex: 0 0 44px; height: 44px; color: var(--accent-ink); background: var(--accent-soft); border-radius: .8rem; }
.map-heading h2 { margin: 0; font-size: 1.125rem; line-height: 1.55; letter-spacing: -.025em; }
.map-heading p { margin: .2rem 0 0; font-size: .75rem; line-height: 1.7; color: var(--muted); }
.map-collapse { display: inline-flex; gap: .35rem; align-items: center; min-height: 44px; padding: .5rem; border: 0; background: transparent; color: var(--muted); font-size: .75rem; white-space: nowrap; }
.map-collapse:hover { color: var(--accent); background: var(--surface); }
.map-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: 0 1.5rem 1rem; }
.map-modes { display: inline-flex; gap: .15rem; padding: .2rem; border-radius: .65rem; background: var(--surface); }
.map-modes button { display: inline-flex; justify-content: center; gap: .4rem; align-items: center; border: 1px solid transparent; background: transparent; color: var(--muted); border-radius: .5rem; font-size: .78rem; padding: .55rem .8rem; min-height: 44px; white-space: nowrap; }
.map-modes button[aria-selected="true"] { color: var(--accent-ink); border-color: var(--line); background: var(--paper); font-weight: 600; }
.map-modes button:hover { color: var(--accent); }
.map-totals { color: var(--muted); font-size: .72rem; white-space: nowrap; }
.map-totals > span { margin: 0 .25rem; }
.map-body { display: grid; grid-template-columns: minmax(0, 1fr) minmax(260px, .55fr); border-top: 1px solid var(--line); }
.map-canvas { min-width: 0; padding: 1.5rem; background: var(--surface); display: flex; flex-direction: column; }
.module-diagram { flex: 1; }
.map-root { position: relative; display: flex; gap: .8rem; align-items: center; margin: 0 auto; width: 88%; min-height: 85px; padding: .85rem 1rem; border: 1px solid var(--control-line); border-radius: .75rem; background: var(--paper); color: var(--ink); text-align: left; }
.map-root.chosen { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-soft); }
.root-icon { display: grid; place-items: center; width: 38px; height: 38px; flex-shrink: 0; border-radius: .55rem; background: var(--gl-solid); color: var(--apricot); }
.map-root > span:nth-child(2) { min-width: 0; flex: 1; }
.map-root small { display: block; font-size: .6875rem; color: var(--muted); margin-bottom: .25rem; }
.map-root strong { font-size: .82rem; line-height: 1.65; font-weight: 600; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
.root-location { flex-shrink: 0; color: var(--accent); }
.diagram-relation { display: flex; align-items: center; justify-content: center; gap: .45rem; color: var(--muted); font-size: .6875rem; line-height: 1.7; margin: .85rem 0 1.1rem; }
.diagram-relation > span { height: 6px; width: 6px; flex: 0 0 auto; border-radius: 50%; background: var(--accent); }
.module-branches { position: relative; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); column-gap: 2rem; row-gap: .75rem; }
.module-branches::before { content: ''; position: absolute; width: 1px; top: -.7rem; bottom: 44px; left: 50%; background: var(--control-line); opacity: .65; }
.map-root::after { content: ''; position: absolute; width: 1px; height: 10px; bottom: -11px; left: 50%; background: var(--control-line); opacity: .65; }
.module-node { position: relative; z-index: 0; display: flex; align-items: flex-start; gap: .55rem; min-width: 0; min-height: 88px; padding: .85rem .7rem; border: 1px solid var(--line); border-radius: .55rem; background: var(--paper); color: var(--ink); text-align: left; transition: border-color 160ms, background 160ms; }
.module-node::after { content: ''; position: absolute; top: 43px; width: 1rem; right: calc(-1rem - 1px); border-top: 1px solid var(--control-line); opacity: .65; }
.module-node:nth-child(even)::after { right: auto; left: calc(-1rem - 1px); }
.module-node:hover { border-color: var(--control-line); }
.module-node.chosen { border-color: var(--accent); background: var(--accent-soft); }
.module-node.chosen::after { border-color: var(--accent); opacity: 1; }
.module-number { font: .65rem/1.7 var(--font-outlier); color: var(--muted); padding-top: .1rem; flex-shrink: 0; }
.module-node.chosen .module-number { color: var(--accent); }
.node-content { min-width: 0; flex: 1; }
.node-content > strong { font-size: .8125rem; font-weight: 550; line-height: 1.7; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.node-content > small { display: flex; align-items: center; gap: .25rem; min-width: 0; margin-top: .4rem; font: .65rem/1.5 var(--font-outlier); color: var(--muted); }
.node-content small > span:not(.citation-more) { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.node-content small > svg, .citation-more { flex-shrink: 0; }
.node-port { width: 5px; height: 5px; position: absolute; right: -3px; top: 41px; border: 1px solid var(--control-line); border-radius: 50%; background: var(--paper); }
.module-node:nth-child(even) .node-port { right: auto; left: -3px; }
.module-node.chosen .node-port { border-color: var(--accent); background: var(--accent); }
.flow-branches .module-node::after { border-top-style: dashed; }
.one-module { grid-template-columns: minmax(0, 1fr); max-width: 88%; margin-inline: auto; }
.one-module::before { bottom: auto; top: -18px; height: 18px; }
.one-module .module-node::after, .one-module .node-port { display: none; }
.map-legend { display: flex; align-items: center; gap: .5rem; margin-top: auto; padding-top: 1.35rem; color: var(--ink); font-size: .6875rem; line-height: 1.7; }
.legend-line { width: 19px; border-top: 1px solid var(--control-line); flex-shrink: 0; }
.legend-line.dashed { border-top-style: dashed; }
.map-inspector { min-width: 0; padding: 1.5rem 1.25rem; border-left: 1px solid var(--line); background: var(--paper); }
.map-return { display: none; }
.inspector-position { display: flex; align-items: center; gap: .35rem; color: var(--accent); font-size: .6875rem; line-height: 1.8; }
.position-kind { color: var(--muted); margin-left: auto; }
.map-inspector h3 { margin: .7rem 0; font-size: 1rem; line-height: 1.75; overflow-wrap: anywhere; }
.inspector-body { margin: 0; font-size: .8125rem; line-height: 1.95; color: var(--muted); white-space: pre-wrap; overflow-wrap: anywhere; max-height: 14rem; overflow-y: auto; overscroll-behavior: contain; padding-right: .4rem; scrollbar-width: thin; }
.map-stack { display: flex; flex-wrap: wrap; gap: .35rem; margin-top: 1rem; }
.map-stack span { color: var(--muted); background: var(--surface); border-radius: .3rem; padding: .25rem .45rem; font-size: .65rem; line-height: 1.65; }
.inspector-guide { border-top: 1px solid var(--line); margin-top: 1.25rem; padding-top: .95rem; }
.inspector-guide > strong { color: var(--muted); font-size: .75rem; font-weight: 500; }
.inspector-guide > button { display: flex; align-items: center; gap: .55rem; min-height: 44px; width: 100%; padding: .5rem 0; border: 0; background: transparent; color: var(--accent); font-size: .75rem; text-align: left; }
.inspector-guide > button span { flex: 1; }
.inspector-guide > button:hover { text-decoration: underline; text-underline-offset: 3px; }
.inspector-sources { margin-top: 1.1rem; }
.map-inspector h4 { margin: 0 0 .5rem; color: var(--muted); font-size: .72rem; font-weight: 500; }
.map-inspector h4 > span { font-family: var(--font-outlier); margin-left: .3rem; }
.map-source-row { display: flex; align-items: center; gap: .25rem; border-top: 1px solid var(--line); }
.map-source { display: flex; gap: .5rem; align-items: flex-start; min-width: 0; flex: 1; padding: .75rem 0; min-height: 44px; border: 0; background: transparent; color: var(--accent); text-align: left; }
.map-source > span { flex: 1; min-width: 0; }
.map-source > svg { flex-shrink: 0; margin-top: .15rem; }
.map-source strong { display: block; font: .75rem/1.7 var(--font-outlier); overflow-wrap: anywhere; }
.map-source small { display: block; font-size: .625rem; line-height: 1.7; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.map-source em { font: normal .65rem/1.8 var(--font-outlier); }
.map-source:hover strong { text-decoration: underline; text-underline-offset: 3px; }
.locate-source { display: grid; place-items: center; min-height: 44px; width: 44px; flex-shrink: 0; padding: .5rem; background: transparent; color: var(--muted); border: 0; border-radius: .4rem; }
.locate-source:hover { background: var(--surface); color: var(--accent); }
.map-next-step { border-left: 2px solid var(--apricot); padding-left: .75rem; margin-top: 1rem; font-size: .75rem; line-height: 1.8; }
.map-next-step > strong { font-weight: 550; }
.map-next-step p { margin: .3rem 0 0; color: var(--muted); }
.related-scenes { border-top: 1px solid var(--line); margin-top: .9rem; padding-top: .85rem; }
.related-scenes button { display: flex; gap: .4rem; align-items: center; min-height: 44px; width: 100%; padding: .4rem 0; background: transparent; border: 0; color: var(--accent); text-align: left; font-size: .75rem; line-height: 1.75; }
.related-scenes button span { flex: 1; }
.related-scenes svg { flex-shrink: 0; }
.flow-picker { display: grid; gap: .4rem; margin-bottom: 1.1rem; font-size: .7rem; color: var(--muted); }
.flow-picker select { width: 100%; min-width: 0; min-height: 44px; padding: .55rem .7rem; color: var(--ink); font-size: .78rem; border: 1px solid var(--control-line); border-radius: .5rem; background: var(--paper); }
.flow-root { width: 100%; }
.flow-root .root-icon { color: var(--accent); background: var(--accent-soft); }
.reading-intro { display: flex; gap: .65rem; align-items: flex-start; padding: 0 0 1rem; }
.reading-intro > svg { color: var(--accent); margin-top: .25rem; flex-shrink: 0; }
.reading-intro strong { font-size: .85rem; font-weight: 550; }
.reading-intro p { margin: .25rem 0 0; color: var(--muted); font-size: .72rem; line-height: 1.8; }
.reading-intro > span { margin-left: auto; white-space: nowrap; font-size: .7rem; color: var(--muted); }
.reading-map { margin: 0; padding: 0; list-style: none; }
.reading-map li { position: relative; padding-bottom: .55rem; }
.reading-map li:not(:last-child)::after { content: ''; position: absolute; bottom: -.1rem; height: .7rem; left: 1.9rem; width: 1px; background: var(--control-line); }
.reading-map button { display: flex; align-items: center; gap: .75rem; width: 100%; min-height: 64px; padding: .7rem .85rem; border: 1px solid var(--line); border-radius: .55rem; text-align: left; background: var(--paper); color: var(--ink); }
.reading-map button.chosen { background: var(--accent-soft); border-color: var(--accent); }
.reading-stop { display: grid; place-items: center; width: 30px; height: 30px; flex-shrink: 0; border: 1px solid var(--line); border-radius: 50%; font: .75rem var(--font-outlier); color: var(--muted); }
.chosen .reading-stop { background: var(--accent); color: var(--gl-on-c1); border-color: var(--accent); }
.reading-map button > svg { color: var(--muted); flex-shrink: 0; }
.reading-controls { display: flex; justify-content: space-between; margin-top: 1.1rem; gap: .75rem; }
.reading-controls button { display: flex; align-items: center; gap: .45rem; min-height: 44px; font-size: .75rem; padding: .5rem .7rem; border: 1px solid var(--control-line); background: var(--paper); color: var(--accent); border-radius: .5rem; }
.reading-controls button:disabled { opacity: .45; cursor: default; }
.map-files { margin: 0; padding: 0; border: 0; border-top: 1px solid var(--line); }
.map-files > summary { display: flex; align-items: center; gap: .55rem; padding: .75rem 1.5rem; min-height: 52px; cursor: pointer; font-size: .75rem; list-style: none; }
.map-files > summary::-webkit-details-marker { display: none; }
.map-files summary::marker { content: ''; }
.map-files summary > svg { flex-shrink: 0; color: var(--accent); }
.map-files summary strong { font-weight: 550; white-space: nowrap; }
.map-files summary > span, .map-files summary > small { color: var(--muted); font-size: .6875rem; }
.map-files summary > small { margin-left: auto; }
.files-chevron { transform: rotate(-90deg); transition: transform 160ms; }
.map-files[open] .files-chevron { transform: rotate(0); }
.map-files :deep(.source-file-tree) { margin: 0 1.5rem 1rem; }
.map-empty { margin: 1rem 0; color: var(--muted); font-size: .78rem; line-height: 1.9; }
@container (max-width: 850px) {
  .map-body { grid-template-columns: minmax(0, 1fr); }
  .map-inspector { border-left: 0; border-top: 1px solid var(--line); scroll-margin-top: calc(var(--banner-height) + .75rem); }
  .map-return { display: inline-flex; align-items: center; gap: .4rem; min-height: 44px; padding: .35rem 0; margin-bottom: .35rem; border: 0; background: transparent; color: var(--accent); font-size: .75rem; }
  .inspector-body { max-height: 11rem; }
  .map-root { width: 80%; }
  .map-inspector h3 { font-size: .9375rem; }
  .map-inspector .map-source-row { max-width: 100%; }
}
@container (max-width: 530px) {
  .map-heading { padding: 1rem; gap: .4rem; }
  .map-heading-main { gap: .6rem; }
  .map-symbol { flex-basis: 38px; height: 38px; }
  .map-heading h2 { font-size: 1rem; }
  .map-heading p { font-size: .6875rem; }
  .map-collapse { font-size: .6875rem; padding: .4rem 0 .4rem .4rem; }
  .map-toolbar { padding: 0 1rem 1rem; display: block; }
  .map-modes { display: flex; }
  .map-modes button { flex: 1; padding: .45rem .3rem; gap: .25rem; font-size: .72rem; }
  .map-totals { display: none; }
  .map-canvas { padding: 1rem; }
  .map-root { width: 100%; padding: .75rem; gap: .55rem; }
  .root-location { display: none; }
  .module-branches { column-gap: 1.25rem; row-gap: .65rem; }
  .module-node { gap: .3rem; padding: .7rem .5rem; min-height: 92px; }
  .module-node::after { width: .625rem; right: calc(-.625rem - 1px); }
  .module-node:nth-child(even)::after { left: calc(-.625rem - 1px); }
  .module-number { display: none; }
  .node-content > strong { font-size: .74rem; }
  .node-content > small { font-size: .625rem; }
  .map-inspector { padding: 1.1rem 1rem; }
  .map-files > summary { padding: .7rem 1rem; gap: .4rem; }
  .map-files summary > small { display: none; }
  .map-files :deep(.source-file-tree) { margin-inline: 1rem; }
  .diagram-relation { font-size: .65rem; }
}
/* 雾港手稿 (2026-10-04)：项目地图像一张手绘海图，墨线为骨，锈红只标"你在这里"。 */
.project-map { border: 0; border-top: 1px solid var(--ink); border-radius: 0; background: transparent; overflow: visible; }
.project-map :focus-visible { outline: 2px dashed var(--accent); outline-offset: 3px; }
.map-heading { padding: 1.35rem 0 1rem; }
.map-symbol { border-radius: 0; background: var(--gl-solid); color: var(--apricot); }
.map-heading h2 { font-family: var(--font-display); font-size: 1.35rem; font-weight: 600; letter-spacing: .02em; }
.map-collapse:hover { background: transparent; text-decoration: underline; text-underline-offset: 4px; }
.map-toolbar { padding: 0 0 1rem; }
.map-modes { gap: 1.5rem; padding: 0; border-radius: 0; background: transparent; }
.map-modes button { position: relative; padding: .55rem 0; border: 0; border-radius: 0; }
.map-modes button::after { content: ''; position: absolute; left: 0; right: 0; bottom: .3rem; height: 1.5px; background: var(--accent); scale: 0 1; transform-origin: left; transition: scale 420ms var(--ease-emphasis); }
.map-modes button[aria-selected="true"] { border: 0; background: transparent; color: var(--ink); }
.map-modes button[aria-selected="true"]::after { scale: 1 1; }
.map-totals { font-family: var(--font-outlier); letter-spacing: .06em; }
.map-body { border-top: 1px solid var(--ink-line); }
.map-canvas { background: color-mix(in srgb, var(--paper) 55%, transparent); background-image: linear-gradient(var(--line) 1px, transparent 1px), linear-gradient(90deg, var(--line) 1px, transparent 1px); background-size: 2.5rem 2.5rem; background-position: -1px -1px; }
.map-root { border: 1px solid var(--ink); border-radius: 0; box-shadow: none; outline: 1px solid var(--line); outline-offset: 3px; transition: outline-offset 420ms var(--ease-emphasis), outline-color 420ms var(--ease-out), border-color 420ms var(--ease-out); }
/* Double rule like a chart cartouche: the outer hairline opens on hover and turns rust when chosen. */
.map-root:hover { outline-offset: 6px; outline-color: var(--ink-line); }
.map-root:hover:not(:disabled) { background: var(--gl-solid); }
.map-root.chosen { box-shadow: none; border-color: var(--accent); outline-color: color-mix(in srgb, var(--accent) 45%, transparent); }
.project-map .map-root:focus-visible { outline: 2px dashed var(--accent); outline-offset: -5px; transition: none; }
.root-icon { border-radius: 0; }
.map-root strong { font-family: var(--font-display); font-size: .92rem; }
.flow-root .root-icon { border-radius: 0; }
.diagram-relation > span { border-radius: 0; rotate: 45deg; }
.module-branches::before, .map-root::after { background: var(--ink-line); opacity: 1; }
.module-node { border: 0; border-top: 1px solid var(--ink); border-radius: 0; background: var(--paper); transition: background 180ms var(--ease-out), border-color 180ms var(--ease-out); animation: studio-rise .7s var(--ease-out-expo) both; }
.module-node:nth-child(2) { animation-delay: .06s; } .module-node:nth-child(3) { animation-delay: .12s; } .module-node:nth-child(4) { animation-delay: .18s; } .module-node:nth-child(5) { animation-delay: .24s; } .module-node:nth-child(n+6) { animation-delay: .3s; }
.module-node::after { border-color: var(--ink-line); opacity: 1; }
.module-node:hover { border-color: var(--accent); }
.module-node:hover:not(:disabled) { background: var(--gl-solid); }
.module-node.chosen, .module-node.chosen:hover:not(:disabled) { border-color: var(--accent); background: color-mix(in srgb,var(--accent) 14%,var(--gl-solid)); }
.module-number { font: 600 1.45rem/1 var(--font-display); color: var(--muted); padding-top: .1rem; transition: color 220ms var(--ease-out); }
.module-node:hover .module-number, .module-node.chosen .module-number { color: var(--accent); }
.node-content > strong { font-family: var(--font-display); font-weight: 600; }
.node-port { border-radius: 0; rotate: 45deg; border-color: var(--ink); }
.legend-line { border-color: var(--ink); }
.map-inspector { border-left: 1px solid var(--ink-line); background: transparent; }
.inspector-position { font-family: var(--font-outlier); letter-spacing: .08em; }
.map-inspector h3 { font-family: var(--font-display); font-size: 1.2rem; font-weight: 600; animation: studio-fade .5s var(--ease-out) both; }
.map-stack span { border-radius: 0; border: 1px solid var(--line); background: transparent; font-family: var(--font-outlier); }
.inspector-guide { border-top: 1px solid var(--ink); }
.inspector-guide > button svg:last-child { transition: translate 260ms var(--ease-out); }
.inspector-guide > button:hover svg:last-child { translate: 4px 0; }
.map-inspector h4 { font-family: var(--font-display); color: var(--ink); font-size: .82rem; font-weight: 600; }
.map-inspector h4 > span { color: var(--accent); }
.map-source-row { border-top: 1px dashed var(--ink-line); }
.locate-source { border-radius: 0; }
.project-map .locate-source:focus-visible { outline-offset: -3px; }
.map-next-step { border-left-color: var(--accent); }
.map-next-step > strong { font-family: var(--font-display); }
.related-scenes { border-top: 1px dashed var(--ink-line); }
.reading-map li:not(:last-child)::after { background: var(--ink-line); }
.reading-map button { border: 0; border-top: 1px solid var(--ink); border-radius: 0; transition: background 220ms var(--ease-out); animation: studio-rise .7s var(--ease-out-expo) both; }
.reading-map li:nth-child(2) button { animation-delay: .07s; } .reading-map li:nth-child(3) button { animation-delay: .14s; } .reading-map li:nth-child(n+4) button { animation-delay: .21s; }
.reading-map button:hover { background: var(--canvas); }
.reading-map button.chosen { background: var(--accent-soft); border-color: var(--accent); }
.reading-map .node-content > strong { font-family: var(--font-display); }
.reading-stop { width: 34px; height: 34px; border: 0; border-radius: 0; font: 600 1.35rem/1 var(--font-display); color: var(--ink-line); }
.chosen .reading-stop { background: transparent; color: var(--accent); }
.reading-intro strong { font-family: var(--font-display); font-size: 1rem; font-weight: 600; }
.reading-intro > span { font-family: var(--font-outlier); }
.reading-controls button { border: 1px solid var(--ink); border-radius: 0; color: var(--ink); transition: background 220ms var(--ease-out), color 220ms var(--ease-out); }
.reading-controls button:not(:disabled):hover { background: var(--gl-solid); color: var(--gl-text); }
.flow-picker { font-family: var(--font-outlier); letter-spacing: .06em; }
.map-files { border-top: 1px solid var(--ink); }
.map-files > summary { padding-inline: 0; }
.map-files summary strong { font-family: var(--font-display); font-weight: 600; }
.map-files :deep(.source-file-tree) { margin-inline: 0; }
@container (max-width: 850px) {
  .map-inspector { border-left: 0; border-top: 1px solid var(--ink); padding-inline: 0; }
}
@container (max-width: 530px) {
  .map-heading { padding: 1rem 0; }
  .map-heading h2 { font-size: 1.12rem; }
  .map-toolbar { padding: 0 0 1rem; }
  .map-modes { gap: .4rem; }
  .map-modes button { padding: .45rem .2rem; }
  .map-canvas { padding: 1rem .75rem; }
  .module-node { padding: .7rem .5rem; }
  .map-inspector { padding: 1.1rem 0; }
  .map-files > summary { padding-inline: 0; }
  .map-files :deep(.source-file-tree) { margin-inline: 0; }
}
@media (prefers-reduced-motion: reduce) { .project-map *, .project-map *::before, .project-map *::after { transition: none !important; animation: none !important; scroll-behavior: auto !important; } .map-root:hover, .module-node:hover { translate: none; } }
</style>
