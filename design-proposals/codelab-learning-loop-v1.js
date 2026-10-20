/* CodeLab learning loop: local, dependency-free interaction prototype.
 * All projects, source excerpts and feedback are illustrative fixtures.
 * No network requests, model calls, file reads or business writes occur here.
 */
"use strict";

const icons = {
  home: '<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z"/>',
  tasks: '<rect x="4" y="4" width="16" height="17" rx="2"/><path d="M9 4V2h6v2M8 10h8M8 14h5M8 18h3"/>',
  project: '<path d="M3 7h7l2-3h8a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/><path d="m9 11-3 3 3 3m6-6 3 3-3 3"/>',
  book: '<path d="M12 5c-3-2-6-2-10-1v15c4-1 7-1 10 1 3-2 6-2 10-1V4c-4-1-7-1-10 1v15"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  layers: '<path d="m12 3 10 5-10 5L2 8zm-9 10 9 5 9-5M3 18l9 5 9-5"/>',
  route: '<circle cx="5" cy="5" r="2"/><circle cx="19" cy="19" r="2"/><path d="M7 5h8a4 4 0 0 1 0 8H9a4 4 0 0 0 0 8h8"/>',
  code: '<path d="m8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18"/>',
  database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0"/>',
  layout: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 9v12"/>',
  shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6zM8 12l3 3 5-6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
  search: '<circle cx="10.5" cy="10.5" r="7.5"/><path d="m16 16 5 5"/>',
  upload: '<path d="M4 16v5h16v-5M12 16V3m-5 5 5-5 5 5"/>',
  file: '<path d="M14 2H5v20h14V7zm0 0v5h5M8 12h8M8 16h6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l4 2"/>',
  people: '<circle cx="9" cy="7" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 4a3 3 0 0 1 0 6m2 4a5 5 0 0 1 3 4v3"/>',
  bookmark: '<path d="M6 3h12v19l-6-4-6 4z"/>',
  refresh: '<path d="M3 10a9 9 0 0 1 15-6l3 3M21 3v4h-4m4 7a9 9 0 0 1-15 6l-3-3M3 21v-4h4"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  link: '<path d="m10 13 4-4m-7 6-2 2a4 4 0 0 0 6 6l4-4a4 4 0 0 0 0-6m2-4 2-2a4 4 0 0 0-6-6L9 5a4 4 0 0 0 0 6" transform="translate(0 -2)"/>',
};
const icon = (name, extra = "") => `<svg class="icon ${extra}" viewBox="0 0 24 24" aria-hidden="true">${icons[name] || icons.info}</svg>`;
const escapeHTML = (value) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const sources = {
  entry: { path: "src/App.vue", label: "应用入口", start: 1, highlights: [5, 6], explanation: "App 将工具栏、看板和任务编辑器组合起来。先读这里，就能把看到的页面与负责它的组件对应起来。", lines: ["<script setup lang=\"ts\">", "import TaskBoard from './components/TaskBoard.vue'", "import TaskEditor from './components/TaskEditor.vue'", "import { useTasks } from './composables/useTasks'", "const { tasks, addTask, moveTask } = useTasks()", "const editingTask = ref(null)", "</script>", "", "<template>", "  <TaskBoard :tasks=\"tasks\" @move=\"moveTask\" />", "  <TaskEditor @submit=\"addTask\" />", "</template>"] },
  state: { path: "src/composables/useTasks.ts", label: "任务状态流转", start: 12, highlights: [17, 18, 19], explanation: "moveTask 只更新指定任务的状态。看板根据状态重新分组；持久化逻辑订阅同一份状态。这样界面、状态和存储保持单向关系。", lines: ["type Status = 'todo' | 'doing' | 'done'", "const tasks = ref<Task[]>(loadTasks())", "", "function moveTask(id: string, status: Status) {", "  const target = tasks.value.find(task => task.id === id)", "  if (!target) return", "  target.status = status", "}", "", "watch(tasks, saveTasks, { deep: true })", "", "return { tasks, addTask, moveTask }"] },
  storage: { path: "src/storage/tasks.ts", label: "本地数据持久化", start: 1, highlights: [4, 5], explanation: "这里把任务写入当前浏览器的 localStorage。它说明示例具有本地持久化，但不能据此声称支持服务端存储、多账号同步或多人实时协作。", lines: ["const STORAGE_KEY = 'task-board:v1'", "", "export function saveTasks(tasks: Task[]) {", "  localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks))", "}", "", "export function loadTasks(): Task[] {", "  const saved = localStorage.getItem(STORAGE_KEY)", "  return saved ? JSON.parse(saved) : []", "}"] },
  validation: { path: "src/components/TaskEditor.vue", label: "输入边界与待确认问题", start: 18, highlights: [21, 22, 23], explanation: "片段里出现了 trim，但没有看见空字符串的拦截。需要继续检查调用方或运行一个空标题用例，才能确认问题；不能单凭这个局部片段定性为已经验证的缺陷。", lines: ["const title = ref('')", "const emit = defineEmits(['submit'])", "", "function submitTask() {", "  emit('submit', { title: title.value.trim() })", "  title.value = ''", "}", "", "// 待确认：调用方是否拒绝空标题", "// 建议用例：输入三个空格后点击保存"] },
};
const baseTasks = [
  { id: "board", title: "任务管理看板：从需求到协作", course: "Web 应用开发 · 软件工程 2301", status: "active", statusLabel: "互评进行中", due: "10 月 14 日", detail: "建立任务创建、状态流转和数据保存的完整流程。技术栈不限，重点说明设计选择。", count: "示例作品 3 份" },
  { id: "library", title: "校园图书检索：让信息更易发现", course: "综合项目实践 · 计算机 2302", status: "active", statusLabel: "可提交", due: "10 月 21 日", detail: "实现图书搜索、筛选与详情阅读。可选择前端应用、全栈应用或带说明的 API 项目。", count: "尚待示例提交" },
  { id: "files", title: "命令行文件整理工具", course: "程序设计实践 · 软件工程 2301", status: "ended", statusLabel: "已结束", due: "09 月 26 日", detail: "设计可撤销的文件分类方案，明确异常处理和操作边界。", count: "精选案例已整理" },
];
const state = {
  view: ["home", "tasks", "projects", "cases", "analysis", "review"].includes(location.hash.slice(1)) ? location.hash.slice(1) : "analysis",
  role: "student", tab: "overview", analysisState: "complete", taskFilter: "all", search: "", selectedSubmission: 0, criterion: "flow", selectedUpload: null,
  tasks: [...baseTasks], projects: [{ id: "board", name: "任务管理看板", stack: "Vue · TypeScript", analyzed: true, association: "任务管理看板：从需求到协作" }, { id: "api", name: "校园借阅 API", stack: "Java · Spring Boot", analyzed: false, association: null }],
  reviewDraftsByRole: Object.fromEntries(["student", "teacher"].map(role => [role, Array.from({ length: 3 }, () => ({ text: "", strength: "", improvement: "", recommended: false }))])),
  get reviewDrafts() { return this.reviewDraftsByRole[this.role]; },
  receipt: "", reviewReceipt: "", lastFocus: null,
};
const main = document.getElementById("main-content");
const modal = document.getElementById("modal");
const drawer = document.getElementById("drawer");
const button = (label, action, attrs = "", style = "") => `<button class="button ${style}" data-action="${action}" ${attrs}>${label}</button>`;
const sourceButton = (key, label) => `<button class="source-link" data-action="source" data-source="${key}">${icon("code")}${escapeHTML(label || sources[key].path)}${icon("arrow")}</button>`;
const textButton = (label, action, attrs = "") => `<button class="text-button" data-action="${action}" ${attrs}>${label}${icon("arrow")}</button>`;

function renderNavigation() {
  const active = state.view === "analysis" ? "projects" : state.view === "review" ? "tasks" : state.view;
  document.getElementById("main-nav").innerHTML = [["home", "home", "工作台"], ["tasks", "tasks", "实训任务"], ["projects", "project", "我的项目"], ["cases", "book", "学习案例"]].map(([view, glyph, label]) => `<button class="nav-item ${view === active ? "active" : ""}" data-action="navigate" data-view="${view}" ${view === active ? 'aria-current="page"' : ""}>${icon(glyph)}<span>${label}</span>${view === active ? '<span class="nav-indicator" aria-hidden="true"></span>' : ""}</button>`).join("");
  const crumbs = { home: ["学习空间", "工作台"], tasks: ["教学与实践", "实训任务"], projects: ["学习空间", "我的项目"], cases: ["共同学习", "学习案例"], analysis: ["我的项目", "项目分析"], review: ["实训任务", "评阅工作台"] }[state.view];
  document.getElementById("breadcrumbs").innerHTML = state.view === "analysis" || state.view === "review" ? `<button data-action="navigate" data-view="${active}">${crumbs[0]}</button>${icon("chevron")}<strong>${crumbs[1]}</strong>` : `<span>${crumbs[0]}</span>${icon("chevron")}<strong>${crumbs[1]}</strong>`;
  document.getElementById("sidebar-user").textContent = state.role === "teacher" ? "林老师" : "林同学";
  document.getElementById("demo-role").value = state.role;
}
function render(options = {}) {
  renderNavigation();
  main.innerHTML = ({ analysis: renderAnalysis, home: renderHome, tasks: renderTasks, projects: renderProjects, cases: renderCases, review: renderReview }[state.view])();
  if (options.focus) main.focus({ preventScroll: true });
}
function navigate(view) {
  closeDialogs(); state.view = view; state.receipt = "";
  history.replaceState(null, "", `#${view}`); render({ focus: true }); window.scrollTo({ top: 0, behavior: "instant" });
}
function heading(eyebrow, title, description, actions = "") {
  return `<div class="page-heading"><div><span class="eyebrow">${eyebrow}</span><h1>${title}</h1>${description ? `<p class="page-description">${description}</p>` : ""}</div>${actions ? `<div class="heading-actions">${actions}</div>` : ""}</div>`;
}
function renderAnalysis() {
  const tabs = [["overview", "项目概览"], ["modules", "模块与链路"], ["issues", "问题与证据"], ["learning", "学习路线"]];
  return `${heading("项目分析 · 示例作品", "任务管理看板", "先了解项目解决什么问题，再顺着业务链路读懂代码。", button(`${icon("info")}分析详情`, "details"))}
    <div class="tag-row" style="margin-top:-12px;margin-bottom:19px"><span class="tag">Vue</span><span class="tag">TypeScript</span><span class="tag">本地数据存储</span><span class="tag gray">静态分析 · 未执行项目</span><span class="dot-divider"></span><span class="version-note">示例版本 v1 · 结论可追溯到源码</span></div>
    <div class="analysis-tabs" role="tablist" aria-label="项目分析内容">${tabs.map(([id, title]) => `<button class="analysis-tab" role="tab" id="tab-${id}" aria-controls="analysis-panel" aria-selected="${state.tab === id}" tabindex="${state.tab === id ? 0 : -1}" data-action="tab" data-tab="${id}">${title}</button>`).join("")}</div>
    <section id="analysis-panel" role="tabpanel" aria-labelledby="tab-${state.tab}">${state.analysisState === "complete" || state.analysisState === "partial" ? `${state.analysisState === "partial" ? '<div class="callout" style="margin-bottom:20px">' + icon("info") + '<div>部分完成示例：已校验的导读内容可阅读；输入边界仍需补充调用方证据，相关结论保留“待验证”。可以先阅读，再按需补充分析。</div></div>' : ""}${({ overview: renderOverview, modules: renderModules, issues: renderIssues, learning: renderLearning }[state.tab])()}` : renderAnalysisState()}</section>
    <label class="demo-state-control" for="analysis-demo-state">原型状态演示<select id="analysis-demo-state"><option value="complete" ${state.analysisState === "complete" ? "selected" : ""}>完整分析示例</option><option value="empty" ${state.analysisState === "empty" ? "selected" : ""}>尚未开始分析</option><option value="processing" ${state.analysisState === "processing" ? "selected" : ""}>分析进行中</option><option value="partial" ${state.analysisState === "partial" ? "selected" : ""}>部分完成</option><option value="failed" ${state.analysisState === "failed" ? "selected" : ""}>分析失败</option></select></label>`;
}
function renderOverview() {
  return `<div class="analysis-content"><div><div class="overview-paper"><section class="purpose-section"><div class="section-kicker">${icon("project")}这个项目是做什么的</div><p class="project-purpose">把零散的待办变成清晰的看板，<br />帮助个人<mark>创建、推进并完成任务</mark>。</p><p class="purpose-support">适合学习“界面如何跟着数据变化”。当前示例围绕单人任务管理展开，暂不包含多人实时协作。</p></section>
      <section class="business-flow"><div class="section-heading"><h2>一次任务，怎样走完整个流程</h2><p>按业务顺序理解代码</p></div><ol class="flow-list">${[["创建任务", "输入标题与基本信息"], ["进入看板", "按状态组织任务"], ["推进状态", "从待办到已完成"], ["保存结果", "刷新后恢复任务"]].map(([title, detail], i) => `<li class="flow-step"><span class="flow-number">0${i + 1}</span><strong>${title}</strong><small>${detail}</small></li>`).join("")}</ol></section></div>
      <div class="overview-lower"><section><div class="section-heading"><h2>四个模块，各有分工</h2>${textButton("看完整链路", "tab", 'data-tab="modules"')}</div><ul class="module-list">${[["layout", "界面与交互", "展示看板，接收创建和状态变更操作。", "entry"], ["route", "任务状态", "维护任务列表，集中处理状态流转。", "state"], ["database", "本地存储", "保存当前任务，支持刷新后的恢复。", "storage"], ["shield", "输入与边界", "收集任务信息；空输入处理需进一步确认。", "validation"]].map(([glyph, title, desc, key]) => `<li class="module-row"><span class="module-icon">${icon(glyph)}</span><div class="module-copy"><strong>${title}</strong><p>${desc}</p></div><button data-action="source" data-source="${key}" aria-label="查看${title}示例源码">${icon("arrow")}</button></li>`).join("")}</ul></section>
      <section><div class="section-heading"><h2>第一次读，建议从这里开始</h2></div><ol class="reading-list"><li><span class="step-index">1</span><div><strong>先把页面和代码对上</strong><p>看看板由哪些组件组成。</p>${sourceButton("entry")}</div></li><li><span class="step-index">2</span><div><strong>跟着一次状态变化走</strong><p>追踪“待办 → 已完成”如何发生。</p>${sourceButton("state", "useTasks.ts · moveTask")}</div></li><li><span class="step-index">3</span><div><strong>弄清数据最后去了哪里</strong><p>理解本地保存，以及它的边界。</p>${sourceButton("storage")}</div></li></ol><p class="reading-bottom">源码引用可点开阅读 · 当前为合成示例片段</p></section></div>
      <div class="review-entry"><div><strong>已经读懂，可以开始交流了</strong><p>对照任务标准，用代码证据给出具体建议。</p></div>${button("进入同伴评阅 " + icon("arrow"), "navigate", 'data-view="review"', "small")}</div>
    </div><aside class="analysis-side" aria-label="学习上下文"><section class="side-block"><h2>这份作品来自</h2><div class="task-context-label">${icon("tasks")}实训任务</div><h3>任务管理看板：<br />从需求到协作</h3><p>本次关注完整业务流程、设计解释和异常处理。可自由选择技术栈。</p><div class="teacher-line"><span class="avatar">周</span>周老师 · Web 应用开发 · 示例</div>${textButton("查看任务要求", "task", 'data-task="board"')}</section><section class="side-block"><h2>值得带着问题去读</h2><h3>为什么把状态从组件中抽离？</h3><p>如果增加筛选、撤销或多人协作，哪些模块会受到影响？</p>${textButton("查看学习路线", "tab", 'data-tab="learning"')}</section><section class="side-block analysis-boundary"><h2>结论的边界</h2><p>概览依据静态源码示例整理。没有执行项目；运行效果、部署配置和真实安全性仍需验证。</p></section></aside></div>`;
}
function renderModules() {
  return `<div class="panel"><h2>跟着“把任务标记为完成”走一遍</h2><p class="subhead">将业务行为、模块职责和源码证据连成一条线。</p><div class="chain-columns"><section>${[["界面发出意图", "用户在看板上修改任务状态。组件传出任务标识和目标状态。", "entry"], ["状态模块处理变更", "moveTask 找到对应任务并更新 status；界面根据响应式数据重新分组。", "state"], ["存储模块保存结果", "状态变化触发保存，序列化后写入当前浏览器的 localStorage。", "storage"]].map(([title, text, source], index) => `<div class="chain-step"><span class="step-index">${index + 1}</span><div><h3>${title}</h3><p>${text}</p>${sourceButton(source)}</div></div>`).join("")}</section><section><div class="callout neutral">${icon("layers")}界面 → 状态 → 存储<br />把“用户做了什么”和“数据怎么变化”分开理解。</div><h3 style="margin:24px 0 10px">这里最重要的设计取舍</h3><p class="plain-note">当前本地存储简单、容易演示，也意味着数据只留在当前浏览器。若扩展为多人协作，需要引入账号、服务端持久化与并发处理；现有源码不能证明这些能力已经具备。</p><h3 style="margin:23px 0 10px">扩展功能时，先看哪一层</h3><dl class="metadata-list"><div><dt>增加筛选</dt><dd>先看界面与任务查询逻辑</dd></div><div><dt>支持撤销</dt><dd>先看状态变更与历史记录</dd></div><div><dt>跨设备同步</dt><dd>先看存储边界与数据接口</dd></div></dl></section></div></div>`;
}
function renderIssues() {
  return `<div class="panel"><h2>区分已看到的事实，与需要继续验证的问题</h2><p class="subhead">每条判断保留证据和下一步动作。AI 建议辅助理解，由师生确认。</p><div class="callout">${icon("info")}本页是报告表达方式的示例。源码片段为合成素材，问题未经真实项目运行验证。</div><div class="issues-list"><article class="issue"><span class="issue-symbol">${icon("info")}</span><div><span class="issue-label">建议优先验证</span><h3>空标题能否创建为任务？</h3><p>编辑器会去掉首尾空格，但片段中未看到空标题拦截。仍需检查调用方；建议用三个空格提交一次，确认交互反馈。</p>${sourceButton("validation")}</div><span class="tag apricot">待验证</span></article><article class="issue"><span class="issue-symbol">${icon("info")}</span><div><span class="issue-label">数据恢复边界</span><h3>已保存的数据损坏时，页面怎样恢复？</h3><p>示例 loadTasks 直接解析 JSON。若浏览器中的值无效，需要错误处理和恢复策略；可用无效 JSON 检验。</p>${sourceButton("storage")}</div><span class="tag apricot">待验证</span></article><article class="issue"><span class="issue-symbol good">${icon("check")}</span><div><span class="issue-label" style="color:var(--green)">值得学习的设计</span><h3>状态变更集中，阅读路径更清楚</h3><p>moveTask 将查找与更新集中在一个函数里。对初学者来说，更容易跟踪一次操作造成的数据变化。</p>${sourceButton("state")}</div><span class="tag green">片段可见</span></article></div></div>`;
}
function renderLearning() {
  return `<div class="panel"><h2>从读懂一个项目，到能解释自己的选择</h2><p class="subhead">每一步都有阅读入口，也有能检验理解的小练习。</p><ol class="learning-route">${[["认识页面与组件", "先看入口与组件树，建立页面结构的整体印象。", "用自己的话说清：一次点击从哪个组件开始？", "entry"], ["跟踪任务状态", "沿 moveTask 理解数据如何驱动看板变化。", "画出“待办 → 已完成”的调用路径，并指出唯一负责修改数据的位置。", "state"], ["识别能力的边界", "比较本地存储与服务端存储，理解当前方案的适用范围。", "如果换一台电脑访问，任务会不会还在？为什么？", "storage"]].map(([title, description, exercise, source], index) => `<li><span class="step-index">${index + 1}</span><div><strong>${title}</strong><p>${description}</p><div class="learning-exercise">自测 · ${exercise}</div></div>${button("阅读源码", "source", `data-source="${source}"`, "small")}</li>`).join("")}</ol><div class="review-entry"><div><strong>把理解变成一次有依据的互评</strong><p>尝试指出一个优点和一个改进点，并附上对应代码。</p></div>${button("开始示例互评", "navigate", 'data-view="review"', "small primary")}</div></div>`;
}
function renderAnalysisState() {
  const states = {
    empty: ["book", "项目已保存，还没有开始分析", "保存项目与 AI 分析是两个独立动作。你可以先关联作业；准备好时，再选择分析范围并确认预计费用。", button("查看分析选项", "analysis-options", "", "primary")],
    processing: ["route", "正在建立项目阅读地图", "这是进行中状态示例，没有后台任务运行。正式产品可先展示已校验的目录与结构信息；AI 结论通过校验后再发布。", '<ol class="state-steps"><li>' + icon("check") + '识别目录与主要技术</li><li>' + icon("check") + '定位入口与核心模块</li><li class="current">' + icon("clock") + '梳理业务链路与证据</li><li>' + icon("clock") + '生成建议阅读顺序</li></ol>' + button("查看完成状态示例", "show-complete", "", "primary") + " " + button("停止本地状态演示", "stop-analysis", "", "ghost")],
    failed: ["info", "分析未完成，项目仍然保留", "示例原因：分析服务暂时不可用。可以阅读已校验的部分，或调整范围后重试；已保存的项目和作业关联不受影响。", button("查看部分结果示例", "show-partial", "", "primary") + " " + button("重新选择分析范围", "analysis-options")],
  };
  const [glyph, title, description, actions] = states[state.analysisState];
  return `<div class="empty-state"><span class="empty-icon">${icon(glyph)}</span><h2>${title}</h2><p>${description}</p><div class="action-row">${actions}</div></div>`;
}
function renderHome() {
  const teacher = state.role === "teacher";
  return `${heading("学习与实践 · 示例空间", teacher ? "把时间留给有价值的反馈。" : "从一个作品开始，学得更具体。", teacher ? "任务、项目理解、评阅与优秀案例，在同一条教学路径里衔接。" : "完成实践，读懂项目，再从同伴的设计里发现新的解法。")}
    <section class="workspace-intro"><div><span class="eyebrow">当前最值得继续的一件事</span><h2>${teacher ? "看懂作品，再开始评阅" : "读懂你的任务管理看板"}</h2><p>${teacher ? "先用项目概览理解作品思路，再对照任务标准核对源码证据。最终评语与优秀作品由你确认。" : "项目概览已经整理好阅读顺序。先看业务链路，再追踪一次状态变化，带着理解参与本次互评。"}</p>${button(teacher ? "打开评阅工作台 " + icon("arrow") : "继续阅读项目 " + icon("arrow"), "navigate", `data-view="${teacher ? "review" : "analysis"}"`)}</div><div class="intro-glyph" aria-hidden="true"><svg viewBox="0 0 120 120" fill="none"><rect x="15" y="15" width="40" height="40" rx="9" stroke="#d5bfae" stroke-width="1.5"/><rect x="65" y="15" width="40" height="40" rx="9" fill="#f3b58b"/><rect x="15" y="65" width="40" height="40" rx="9" fill="#ffffff14" stroke="#a1a6a9" stroke-width="1.5"/><rect x="65" y="65" width="40" height="40" rx="9" stroke="#b5b8b8" stroke-width="1.5"/><path d="m77 35 5 5 10-11M30 29h11M30 36h8M79 79h12M79 87h8" stroke="#784e32" stroke-width="2" stroke-linecap="round"/></svg></div></section>
    <section class="section-space"><div class="section-heading"><h2>接下来</h2><p>以下均为交互示例</p></div><div class="work-list">${[["tasks", teacher ? "发布一个容易开始的任务" : "查看本次实训要求", teacher ? "四个字段即可发布；评阅标准可使用默认项，再按需细化。" : "技术栈不限，提交已有项目或一个新的 ZIP 都可以。", "tasks", teacher ? "去发布任务" : "查看实训"], ["people", teacher ? "发现有启发的作品" : "给同伴一条有证据的建议", "项目分析帮助双方先理解设计，推荐作为优秀案例候选。", "review", "进入评阅"], ["book", "把优秀设计变成下次实践的起点", "按学到什么选案例，保留作者授权与作品来源。", "cases", "阅读案例"]].map(([glyph, title, detail, view, action]) => `<div class="work-row"><span class="module-icon">${icon(glyph)}</span><div class="work-row-main"><strong>${title}</strong><p>${detail}</p></div>${button(action + " " + icon("arrow"), "navigate", `data-view="${view}"`, "small")}</div>`).join("")}</div></section>`;
}
function renderTasks() {
  return `${heading("实训任务", state.role === "teacher" ? "让一次布置，带来一轮共同进步。" : "带着任务实践，也带着理解交流。", "从发布、提交到师生评阅，把每份作品留下的经验沉淀下来。", state.role === "teacher" ? button(icon("plus") + "发布任务", "publish-dialog", "", "primary") : button(icon("people") + "进入同伴评阅", "navigate", 'data-view="review"'))}
    ${state.receipt ? `<div class="local-receipt">${escapeHTML(state.receipt)}<p>只更新当前原型页面；没有通知师生，也没有写入真实任务。</p></div>` : ""}
    <div class="task-toolbar"><div class="segmented" aria-label="筛选实训任务">${[["all", "全部任务"], ["active", "进行中"], ["ended", "已结束"]].map(([filter, title]) => `<button class="segment ${state.taskFilter === filter ? "active" : ""}" aria-pressed="${state.taskFilter === filter}" data-action="task-filter" data-filter="${filter}">${title}</button>`).join("")}</div><label class="search-box">${icon("search")}<input id="task-search" type="search" placeholder="搜索任务或课程" aria-label="搜索任务或课程" value="${escapeHTML(state.search)}" /></label></div><div class="task-table"><div class="task-table-head"><span>任务 / 课程</span><span>当前阶段</span><span>截止时间</span><span>下一步</span></div><div id="task-records">${renderTaskRows()}</div></div><p class="task-note">提交作品可直接关联已有项目。普通项目上传不依赖课程模板，任务要求只影响本次作业的评阅标准。<br />当前为${state.role === "teacher" ? "教师" : "学生"}视角示例，可在右上角切换；真实身份应由账号权限决定。</p>`;
}
function renderTaskRows() {
  const tasks = state.tasks.filter(task => (state.taskFilter === "all" || task.status === state.taskFilter) && `${task.title} ${task.course}`.toLowerCase().includes(state.search.toLowerCase()));
  return tasks.length ? tasks.map(task => `<article class="task-record"><div><h3>${escapeHTML(task.title)}</h3><p>${escapeHTML(task.course)} · ${escapeHTML(task.count)}</p></div><div><span class="tag ${task.status === "ended" ? "gray" : "apricot"}">${escapeHTML(task.statusLabel)}</span></div><div class="due"><strong>${escapeHTML(task.due)}</strong>示例安排</div>${button(task.status === "ended" ? "阅读优秀案例" : state.role === "teacher" && task.id === "board" ? "开始评阅" : "查看任务", task.status === "ended" ? "navigate" : state.role === "teacher" && task.id === "board" ? "navigate" : "task", task.status === "ended" ? 'data-view="cases"' : state.role === "teacher" && task.id === "board" ? 'data-view="review"' : `data-task="${task.id}"`, "small")}</article>`).join("") : '<p class="filter-empty">没有匹配的任务。可以换个关键词，或查看全部任务。</p>';
}
function renderProjects() {
  return `${heading("我的项目", "作品先留下，理解慢慢深入。", "无需先选模板或限定技术栈。上传、关联作业与 AI 分析可以分别进行。", button(icon("plus") + "添加项目", "upload-dialog", "", "primary"))}
    ${state.receipt ? `<div class="local-receipt">${escapeHTML(state.receipt)}<p>这是当前页面中的示例项目记录。没有读取文件，也没有发起 AI 分析。</p></div>` : ""}
    <div class="project-list">${state.projects.map(project => `<article class="project-record"><div class="project-record-top"><span class="module-icon">${icon("project")}</span><span class="tag ${project.analyzed ? "green" : "gray"}">${project.analyzed ? "可阅读示例分析" : "已保存 · 未分析"}</span></div><h2>${escapeHTML(project.name)}</h2><p>${project.analyzed ? "从任务创建到状态流转，学习数据驱动界面的完整路径。" : "项目可先保存或关联实训，之后再按需要选择分析范围。"}</p><span class="tag">${escapeHTML(project.stack)}</span><div class="project-record-bottom"><span>${project.association ? "已关联实训任务（示例）" : "独立项目（示例）"}</span>${textButton(project.analyzed ? "阅读项目" : "分析选项", project.analyzed ? "open-board-analysis" : "analysis-options")}</div></article>`).join("")}</div>
    <div class="project-policy"><section><strong>先接纳作品</strong><p>ZIP 可包含不同语言、框架或多个子项目。上传入口不以某个模板是否匹配作为门槛。</p></section><section><strong>先识别，再说明能力</strong><p>根据实际内容说明可分析的范围。不能运行或证据不足时，保留文件与已知信息。</p></section><section><strong>按需要选择分析</strong><p>上传不自动开启付费分析。先了解范围、预计费用与上限，再决定是否开始。</p></section></div>`;
}
const cases = [
  { title: "任务管理看板", type: "本次实训 · 设计表达", description: "一个清楚的状态模型，怎样让创建、流转和保存各司其职。", tags: ["状态管理", "模块职责"], lesson: "把变化集中在一个地方", text: "将任务的创建和流转放进独立状态模块，组件负责展示和发出意图。学习重点是职责边界，而不是照抄一个技术栈。", tradeoff: "本地存储便于初学者完整跑通流程，但不解决跨设备同步。解释清楚限制，和实现功能同样重要。", exercise: "给看板增加“仅看未完成任务”的筛选，先说明应该改哪个模块。" },
  { title: "校园图书检索", type: "跨技术栈 · 用户体验", description: "搜索、筛选与空结果状态，如何串成一个易理解的查找过程。", tags: ["React", "信息检索"], lesson: "让筛选条件成为可解释的状态", text: "关键词、分类与结果数量共同描述一次查询。改变分类时保留关键词，并让空结果说明下一步可以怎么调整。", tradeoff: "前端筛选便于快速反馈，但数据量增长后需要服务端分页。该案例的启发点是交互状态，不代表可无限扩展。", exercise: "设计“没有匹配图书”的状态，让用户能一键清除筛选，而不丢失原来的关键词。" },
  { title: "文件整理工具", type: "非前端项目 · 安全边界", description: "先预览、再执行、可撤销，让一个小工具值得信任。", tags: ["Python", "异常处理"], lesson: "先表达将要发生什么", text: "把文件分类计划与实际移动分离。预览输出来源、去向及冲突，再由使用者选择执行，便于学习不可逆操作的边界。", tradeoff: "操作日志可以辅助撤销，但不能保证所有跨磁盘失败都自动恢复。应说明覆盖范围和失败后的人工处理方式。", exercise: "考虑重名文件和无写入权限两种情况，设计预览提示与恢复步骤。" },
];
function renderCases() {
  const visuals = ['<div class="mini-board"><div class="mini-board-col"><strong>待处理</strong><span></span><span></span></div><div class="mini-board-col"><strong>进行中</strong><span></span></div><div class="mini-board-col"><strong>已完成</strong><span></span><span></span></div></div>', `<div class="mini-search"><div class="mini-search-field">${icon("search")}寻找一本好书</div>${[1, 2].map(() => '<div class="mini-search-row"><div class="mini-book"></div><div class="mini-lines"><span></span><span></span></div></div>').join("")}</div>`, '<div class="mini-tree">project/<br />&nbsp;├─ preview.py<br />&nbsp;├─ organize.py<br />&nbsp;└─ undo.json</div>'];
  return `${heading("学习案例", "好作品，不止值得一个分数。", "沿着具体的设计问题阅读，理解同伴做过的选择，再带回自己的实践。", button("看看不同设计思路", "compare-cases"))}<p class="cases-intro">精选机制示例：同伴推荐与教师复核共同形成候选，作者确认后再进入案例库。<br />每个案例说明推荐理由、可学内容与适用边界，不展示人气排名。</p><div class="case-grid">${cases.map((item, i) => `<article class="case-card"><div class="case-visual ${i === 1 ? "warm" : i === 2 ? "gray" : ""}" aria-hidden="true">${visuals[i]}</div><div class="case-body"><span class="case-category">${item.type}</span><h2>${item.title}</h2><p>${item.description}</p><div class="tag-row">${item.tags.map(tag => `<span class="tag">${tag}</span>`).join("")}</div><div class="case-meta">作者授权状态仅为示例 · 合成教学素材</div>${textButton("阅读解题思路", "case", `data-case="${i}"`)}</div></article>`).join("")}</div>`;
}
const submissions = [{ title: "清晰的任务看板", meta: "作品 A · 匿名互评示例", status: "待评阅" }, { title: "轻量任务协作台", meta: "作品 B · 匿名互评示例", status: "待评阅" }, { title: "专注待办清单", meta: "作品 C · 匿名互评示例", status: "已读过" }];
const criteria = {
  flow: { title: "业务流程是否完整", desc: "能否说清创建、流转、保存的完整路径？关键流程是否有可定位的代码依据？", evidence: "状态更新与保存之间存在可定位的连接", detail: "示例 useTasks 在任务变更后触发保存。运行成功与否仍需通过演示或测试确认。", source: "state" },
  design: { title: "设计选择是否说得清楚", desc: "模块职责是否清晰？学生能否解释为什么这样划分，以及方案的适用范围？", evidence: "界面组件与状态维护分别承担职责", detail: "入口组合页面，任务状态模块承接数据变化。可以追问：增加撤销时应修改哪一层？", source: "entry" },
  boundary: { title: "异常与边界是否被考虑", desc: "空输入、缺失数据与恢复失败时，产品是否有明确的处理与说明？", evidence: "空标题拦截尚需核对调用方", detail: "当前片段只做了 trim。用三个空格提交的结果，可以作为师生共同核验的入口。", source: "validation" },
};
function renderReview() {
  const submission = submissions[state.selectedSubmission];
  const criterion = criteria[state.criterion];
  const draft = state.reviewDrafts[state.selectedSubmission];
  const teacher = state.role === "teacher";
  const feedbackFields = teacher
    ? `<label class="form-label" for="review-feedback">给作者一条具体评语<span class="optional">结合任务标准与已核对的代码证据</span></label><textarea id="review-feedback" name="feedback" maxlength="1500" rows="3" required placeholder="例如：状态职责清楚；请补充空标题处理，并说明验证结果。">${escapeHTML(draft.text)}</textarea>`
    : `<div class="form-two-col"><div class="field"><label class="form-label" for="review-strength">一处具体优点</label><textarea id="review-strength" name="strength" maxlength="600" rows="2" required placeholder="例如：任务状态集中管理，代码流程容易追踪。">${escapeHTML(draft.strength)}</textarea></div><div class="field"><label class="form-label" for="review-improvement">一条改进建议</label><textarea id="review-improvement" name="improvement" maxlength="600" rows="2" required placeholder="例如：补充空标题的处理，并说明怎样验证。">${escapeHTML(draft.improvement)}</textarea></div></div><p class="plain-note">请写下自己的观察；输入框中的例子只提示表达方式。</p>`;
  return `${heading("实训任务 / 评阅工作台", "先读懂，再给出有价值的反馈。", "任务管理看板：从需求到协作 · 当前为" + (teacher ? "教师评阅" : "匿名同伴互评") + "示例", button("查看任务要求", "task", 'data-task="board"'))}<div class="callout neutral review-header-note">${icon("info")}AI 帮助解释项目与定位证据。评分、是否达标与最终入选由教师确认；同伴推荐作为参考。</div><div class="review-layout"><aside class="submission-queue" aria-label="待评作品"><h2>选择一份作品</h2>${submissions.map((item, i) => `<button class="submission-item ${state.selectedSubmission === i ? "active" : ""}" data-action="submission" data-submission="${i}" aria-pressed="${state.selectedSubmission === i}"><strong>${item.title}</strong><span>${item.meta}</span><span class="tag">${state.reviewDrafts[i].done ? "示例评阅已完成" : item.status}</span></button>`).join("")}</aside><section class="review-desk"><div class="review-desk-title"><div><h2>${submission.title}</h2><p>${submission.meta} · 每份作品的真实分析应独立生成，原型共用教学片段</p></div>${textButton("先看项目概览", "open-board-analysis")}</div><div class="review-standard-tabs" aria-label="评阅标准">${[["flow", "业务流程"], ["design", "设计解释"], ["boundary", "异常与边界"]].map(([key, title]) => `<button class="criterion ${state.criterion === key ? "active" : ""}" data-action="criterion" data-criterion="${key}" aria-pressed="${state.criterion === key}">${title}</button>`).join("")}</div><div class="review-evidence"><h3>${criterion.title}</h3><p>${criterion.desc}</p><div class="evidence-row">${icon("code")}<div><strong>${criterion.evidence}</strong><p>${criterion.detail}</p>${sourceButton(criterion.source)}</div></div></div><form id="review-form" class="review-form">${feedbackFields}<label class="check-row"><input id="recommend-project" name="recommended" type="checkbox" ${draft.recommended ? "checked" : ""} /><span>${teacher ? "标记为优秀案例候选" : "向教师推荐这份作品"}<small>${teacher ? "进入候选后仍需复核推荐理由，并取得作者分享授权。" : "说明值得学习的地方；推荐不自动决定成绩或最终入选。"}</small></span></label>${state.reviewReceipt ? `<div class="local-receipt">${escapeHTML(state.reviewReceipt)}<p>仅保存于当前原型内存，刷新后重置；未向任何人发送反馈。</p></div>` : ""}<div class="action-row">${button("保存示例草稿", "save-review", "", "ghost")}<button class="button primary" type="submit">${teacher ? "发布示例反馈" : "提交示例互评"}${icon("arrow")}</button></div></form></section></div>`;
}
function modalShell(title, body, footer = "", wide = false) {
  if (!modal.open && !drawer.open) state.lastFocus = document.activeElement;
  if (drawer.open) drawer.close(); if (modal.open) modal.close();
  modal.classList.toggle("wide", wide);
  document.getElementById("modal-content").innerHTML = `<header class="modal-header"><div><span class="eyebrow">交互设计原型 · 示例数据</span><h2 id="modal-title">${title}</h2></div><button class="icon-button" data-action="close-modal" aria-label="关闭对话框">${icon("close")}</button></header>${body}${footer ? `<footer class="modal-footer">${footer}</footer>` : ""}`;
  modal.showModal();
}
function drawerShell(title, content) {
  if (!modal.open && !drawer.open) state.lastFocus = document.activeElement;
  if (modal.open) modal.close(); if (drawer.open) drawer.close();
  document.getElementById("drawer-content").innerHTML = `<header class="drawer-header"><div><span class="eyebrow">交互设计原型 · 示例数据</span><h2 id="drawer-title">${title}</h2></div><button class="icon-button" data-action="close-drawer" aria-label="关闭侧边详情">${icon("close")}</button></header><div class="drawer-body">${content}</div>`;
  drawer.showModal();
}
function closeDialogs() { if (modal.open) modal.close(); if (drawer.open) drawer.close(); }
function openSource(key) {
  const source = sources[key] || sources.entry;
  drawerShell(source.label, `<div class="callout neutral" style="margin-bottom:22px">${icon("info")}合成源码片段 · 用于说明引用阅读体验，并非当前上传项目的真实代码。</div><div class="code-title"><span>${source.path}</span><span>L${source.start}–L${source.start + source.lines.length - 1}</span></div><pre class="code-block"><code>${source.lines.map((line, index) => `<span class="code-line ${source.highlights.includes(source.start + index) ? "highlight" : ""}" data-line="${source.start + index}">${escapeHTML(line) || " "}</span>`).join("")}</code></pre><div class="source-explain"><h3>这段代码说明了什么</h3><p>${source.explanation}</p></div><p class="plain-note">正式产品中引用需要绑定项目版本、文件路径和行号。证据不足时应说明缺口，不能生成无法定位的结论。</p>`);
}
function openDetails() {
  drawerShell("分析详情", `<h3>报告范围</h3><dl class="metadata-list"><div><dt>当前版本</dt><dd>v1 · 任务管理看板教学示例</dd></div><div><dt>可阅读内容</dt><dd>用途、业务链路、模块职责、源码引用与学习路线</dd></div><div><dt>覆盖范围</dt><dd>示例入口、任务状态、本地存储和输入边界</dd></div><div><dt>尚未验证</dt><dd>实际运行、部署配置、网络服务与真实安全性</dd></div><div><dt>模型与费用</dt><dd>此原型不调用模型，不产生分析费用，也不展示虚构用量</dd></div></dl><h3>正式分析前，先让成本可预期</h3><p>先完成目录盘点与代码索引，再按目标选择需要阅读的内容。开始付费分析前展示预计费用、预算上限与覆盖范围；重复版本优先复用已经有效的结果。</p><h3>分析过程示例</h3><ol class="trace-list">${[["目录盘点", "区分源码、依赖、构建产物与说明文档。"], ["定位关键入口", "找到页面入口、状态流转和数据存储边界。"], ["建立证据关联", "让核心判断能回到版本化的源码位置。"], ["组织可读的报告", "先给整体认识，按需展开细节与不确定之处。"]].map(([title, detail]) => `<li>${icon("check")}<div><strong>${title}</strong><p>${detail}</p></div></li>`).join("")}</ol><div class="callout neutral">${icon("info")}过程、费用与覆盖范围保留在详情中；项目正文优先回答“它做什么、怎么工作、从哪里开始读”。</div>`);
}
function openTask(id) {
  const task = state.tasks.find(item => item.id === id) || state.tasks[0];
  modalShell(escapeHTML(task.title), `<div class="modal-body"><p class="plain-note">${escapeHTML(task.course)} · ${escapeHTML(task.due)}截止（示例）</p><div class="brief-meta"><span class="tag apricot">技术栈不限</span><span class="tag">已有项目可关联</span><span class="tag">支持同伴互评</span></div><div class="task-brief"><h3>这次要完成什么</h3><p>${escapeHTML(task.detail)}</p><h3>提交哪些内容</h3><ul><li>一个可阅读的项目 ZIP，或关联已经保存的项目。</li><li>简短说明如何启动、核心设计与已知限制；允许有未完成部分。</li></ul><h3>怎样一起评价</h3><p>围绕业务流程、设计解释和异常边界给出反馈。AI 提供项目理解与证据线索，同伴提出建议，教师确认最终评价。</p></div><div id="association-receipt"></div><p class="dialog-statement">本窗口是教学流程示例，所有提交仅在当前页面演示。</p></div>`, state.role === "teacher" ? button("进入评阅工作台", "navigate", 'data-view="review"', "primary") : button("关联已有项目", "associate-dialog", `data-task="${task.id}"`) + button("添加项目再提交", "upload-dialog", `data-task="${task.id}"`, "primary"));
}
function openPublish() {
  modalShell("发布一个实训任务", `<form id="publish-form"><div class="modal-body"><p class="plain-note">四个必填项，先让学生明确要做什么。默认采用业务流程、设计解释、异常边界三项评阅标准。</p><div class="field"><label class="form-label" for="task-title">任务标题</label><input id="task-title" name="title" maxlength="80" required placeholder="例如：做一个可以解释清楚的任务看板" /></div><div class="field"><label class="form-label" for="task-instruction">任务说明</label><textarea id="task-instruction" name="instruction" required maxlength="2000" rows="3" placeholder="说明目标与需要提交什么，无需先配置复杂的自动评测模板。"></textarea><small>技术栈默认不限；具体约束直接写在说明中。</small></div><div class="form-two-col"><div class="field"><label class="form-label" for="task-deadline">截止时间</label><input id="task-deadline" name="deadline" type="date" required value="2026-10-14" /></div><div class="field"><label class="form-label" for="task-class">参与班级</label><select id="task-class" name="class"><option>软件工程 2301</option><option>计算机 2302</option></select></div></div>
    <label class="check-row"><input type="checkbox" id="enable-class-analysis" name="enableAnalysis" /><span>为本班生成项目导读<span class="optional">（可选，默认关闭）</span><small>未开启也可正常发布、提交和人工评阅。开启后需要明确费用承担者与预算。</small></span></label>
    <div id="class-analysis-settings" class="analysis-consent" hidden><div class="form-two-col"><div class="field"><label class="form-label" for="class-analysis-payer">费用承担者</label><select id="class-analysis-payer" name="analysisPayer" disabled><option>教师账户（示例）</option><option>学校统一账户（示例）</option></select></div><div class="field"><label class="form-label" for="class-analysis-model">分析模型</label><select id="class-analysis-model" name="analysisModel" disabled><option>课程轻量模型（示例）</option><option>课程深度模型（示例）</option></select></div></div><div class="form-two-col"><div class="field"><label class="form-label" for="analysis-per-project">每份预算上限 · 元</label><input id="analysis-per-project" name="perProjectBudget" type="number" min="0.1" step="0.1" value="1" required disabled /></div><div class="field"><label class="form-label" for="analysis-total-budget">任务总预算上限 · 元</label><input id="analysis-total-budget" name="totalBudget" type="number" min="0.1" step="0.1" value="20" required disabled /></div></div><p class="plain-note">金额只用于说明预算交互，不是实际报价。正式功能应在授权前展示费用汇总与停止条件；不向学生静默转嫁费用。</p></div>
    <div class="callout neutral">${icon("info")}这是本地发布演示，不会调用模型或授权真实扣费。正式产品中，复杂配置不阻挡首次发布。</div></div><footer class="modal-footer"><span class="plain-note">不会发送通知或创建真实任务</span>${button("取消", "close-modal", 'type="button"', "ghost")}<button class="button primary" type="submit">发布到原型列表${icon("arrow")}</button></footer></form>`);
}
const uploadExamples = {
  vue: { name: "我的任务看板", filename: "task-board.zip", stack: "Vue · TypeScript" },
  java: { name: "校园借阅服务", filename: "campus-library.zip", stack: "Java · Spring Boot" },
  python: { name: "文件整理工具", filename: "file-organizer.zip", stack: "Python · 命令行工具" },
};
function openUpload(taskId = "") {
  state.selectedUpload = null;
  modalShell("添加一个项目", `<form id="upload-form"><div class="modal-body"><p class="plain-note">不要求匹配 Vue 模板。先保存项目，再决定是否关联作业或使用 AI 分析。</p><div class="example-picker">${icon("upload")}<h3>ZIP 项目，保留你熟悉的技术栈</h3><p>正式产品支持选择或拖入文件；此原型使用内置样例，不读取你的文件。</p><div class="example-choices">${[["vue", "Vue / TypeScript"], ["java", "Java / Spring Boot"], ["python", "Python 工具"]].map(([key, label]) => `<button type="button" class="example-choice" data-action="select-upload" data-example="${key}">${label} 示例</button>`).join("")}</div><div id="selected-file"></div></div><div class="field"><label class="form-label" for="project-name">项目名称</label><input id="project-name" name="name" maxlength="80" required placeholder="先选择上方的一个示例" /></div><div class="field"><label class="form-label" for="project-task">关联实训任务<span class="optional">可选</span></label><select id="project-task" name="task"><option value="">暂不关联，作为普通项目保存</option>${state.tasks.filter(task => task.status !== "ended").map(task => `<option value="${task.id}" ${taskId === task.id ? "selected" : ""}>${escapeHTML(task.title)}</option>`).join("")}</select></div><p class="plain-note">“允许上传”与“能分析多深、能否执行”分别说明。遇到不支持的运行环境，仍保留项目与可完成的阅读分析。</p><div id="upload-validation" class="dialog-statement" role="status"></div></div><footer class="modal-footer"><span class="plain-note">上传不自动触发付费分析</span><button class="button" type="submit" name="next" value="save">仅保存示例</button><button class="button primary" type="submit" name="next" value="analyze">保存并看分析选项</button></footer></form>`);
}
function selectUpload(key) {
  state.selectedUpload = key;
  const file = uploadExamples[key];
  document.getElementById("project-name").value = file.name;
  document.querySelectorAll(".example-choice").forEach(element => { element.classList.toggle("active", element.dataset.example === key); element.setAttribute("aria-pressed", String(element.dataset.example === key)); });
  document.getElementById("selected-file").innerHTML = `<div class="selected-file">${icon("file")}<div><strong>${file.filename}</strong><small>${file.stack} · 内置演示数据，无真实文件</small></div></div>`;
  document.getElementById("upload-validation").textContent = "";
}
function openAnalysisOptions() {
  modalShell("按目的选择分析范围", `<div class="modal-body"><p class="plain-note">正式产品先识别项目，再提供覆盖范围、预计费用和预算上限。此处仅展示流程，不计算虚构价格。</p><button class="analysis-option" data-action="start-demo-analysis" data-mode="overview"><strong>先读懂项目<span class="tag green">首次推荐</span></strong><p>用途、核心流程、模块职责与阅读入口。优先使用结构索引和关键文件，避免反复读取整份项目。</p></button><button class="analysis-option" data-action="start-demo-analysis" data-mode="task"><strong>结合实训任务阅读<span class="tag">已关联时可用</span></strong><p>在项目概览基础上，对照任务标准补充证据与待确认问题。已有效的项目理解结果应复用。</p></button><button class="analysis-option" data-action="start-demo-analysis" data-mode="focus"><strong>围绕具体问题深入<span class="tag">按需追加</span></strong><p>只深入当前关注的模块。正式分析需确认问题、范围和本次预算，不默认启动全量代码审查。</p></button><p class="dialog-statement">点击任一选项只进入“分析中”状态演示，随后可主动切换为同一份教学示例报告。</p></div>`, button("现在先不分析", "close-modal", "", "ghost"));
}
function openAssociation(taskId) {
  modalShell("关联已保存的项目", `<form id="association-form" data-task="${taskId}"><div class="modal-body"><p class="plain-note">一个项目可以被复用为课程提交。无需重新上传，也不强制重复执行 AI 分析。</p><div class="field"><label class="form-label" for="existing-project">选择项目</label><select id="existing-project" name="project">${state.projects.map(project => `<option value="${project.id}">${escapeHTML(project.name)} · ${escapeHTML(project.stack)}</option>`).join("")}</select></div><div class="callout neutral">${icon("info")}本次演示只更新项目的关联标记。真实提交应记录版本、截止状态与可见范围。</div></div><footer class="modal-footer">${button("取消", "close-modal", 'type="button"', "ghost")}<button type="submit" class="button primary">关联并提交示例作业</button></footer></form>`);
}
function openCase(index) {
  const item = cases[index];
  modalShell(item.title + " · 解题思路", `<div class="modal-body"><span class="tag apricot">${item.type}</span><section class="case-lesson"><h3>${item.lesson}</h3><p>${item.text}</p></section><section class="case-lesson"><h3>这个选择付出了什么</h3><p>${item.tradeoff}</p></section><section class="case-lesson"><h3>带回自己的项目试一试</h3><p>${item.exercise}</p></section><div class="callout neutral">${icon("book")}该案例是合成教学素材。正式案例需有作者授权、作品来源和教师确认的推荐理由。</div></div>`, index === 0 ? button("阅读对应项目分析", "open-board-analysis", "", "primary") : button("对比三种学习角度", "compare-cases", "", "primary"));
}
function openCompare() {
  modalShell("换一个项目，也能迁移同一种思考", `<div class="modal-body"><p class="plain-note">不同技术栈不妨碍共同学习：先看问题、边界与取舍，再决定具体实现。</p><table class="compare-table"><thead><tr><th scope="col">案例</th><th scope="col">核心设计问题</th><th scope="col">可以迁移的经验</th></tr></thead><tbody><tr><td>任务管理看板</td><td>状态应该由谁修改？</td><td>集中变化，明确模块职责。</td></tr><tr><td>校园图书检索</td><td>查询失败时如何继续？</td><td>把空状态设计为下一步入口。</td></tr><tr><td>文件整理工具</td><td>怎样让操作可以确认、恢复？</td><td>分开预览与执行，清楚表达边界。</td></tr></tbody></table><p class="plain-note">以上为原型教学示例，不是对真实同学作品的评级或排名。</p></div>`, button("返回案例", "close-modal"), true);
}
function saveReview(publish) {
  const draft = state.reviewDrafts[state.selectedSubmission];
  if (state.role === "teacher") draft.text = document.getElementById("review-feedback").value;
  else {
    draft.strength = document.getElementById("review-strength").value;
    draft.improvement = document.getElementById("review-improvement").value;
  }
  draft.recommended = document.getElementById("recommend-project").checked;
  if (publish) draft.done = true;
  state.reviewReceipt = publish ? `这份示例${state.role === "teacher" ? "反馈" : "互评"}已在本页标记为完成${draft.recommended ? "，并加入本地候选标记" : ""}。` : "示例草稿已保留在当前页面，可切换作品后继续编辑。";
  render();
  document.getElementById("announcer").textContent = state.reviewReceipt;
}

document.addEventListener("click", (event) => {
  const element = event.target.closest("[data-action]");
  if (!element || element.disabled) return;
  const action = element.dataset.action;
  event.preventDefault();
  if (action === "navigate") navigate(element.dataset.view);
  else if (action === "tab") { state.tab = element.dataset.tab; render(); document.getElementById(`tab-${state.tab}`).focus({ preventScroll: true }); }
  else if (action === "source") openSource(element.dataset.source);
  else if (action === "details") openDetails();
  else if (action === "close-modal") modal.close();
  else if (action === "close-drawer") drawer.close();
  else if (action === "task") openTask(element.dataset.task);
  else if (action === "publish-dialog") openPublish();
  else if (action === "upload-dialog") openUpload(element.dataset.task || "");
  else if (action === "select-upload") selectUpload(element.dataset.example);
  else if (action === "analysis-options") openAnalysisOptions();
  else if (action === "associate-dialog") openAssociation(element.dataset.task);
  else if (action === "case") openCase(Number(element.dataset.case));
  else if (action === "compare-cases") openCompare();
  else if (action === "task-filter") { state.taskFilter = element.dataset.filter; render(); document.querySelector(`[data-filter="${state.taskFilter}"]`).focus({ preventScroll: true }); }
  else if (action === "submission") { state.selectedSubmission = Number(element.dataset.submission); state.reviewReceipt = ""; render(); document.querySelector(`[data-submission="${state.selectedSubmission}"]`).focus({ preventScroll: true }); }
  else if (action === "criterion") { state.criterion = element.dataset.criterion; render(); document.querySelector(`[data-criterion="${state.criterion}"]`).focus({ preventScroll: true }); }
  else if (action === "save-review") saveReview(false);
  else if (action === "open-board-analysis") { state.analysisState = "complete"; state.tab = "overview"; navigate("analysis"); }
  else if (action === "show-complete") { state.analysisState = "complete"; render(); }
  else if (action === "show-partial") { state.analysisState = "partial"; render(); }
  else if (action === "stop-analysis") { state.analysisState = "empty"; render(); }
  else if (action === "start-demo-analysis") { state.analysisState = "processing"; state.tab = "overview"; navigate("analysis"); }
});
document.addEventListener("input", (event) => {
  if (event.target.id === "task-search") { state.search = event.target.value; document.getElementById("task-records").innerHTML = renderTaskRows(); }
  if (event.target.id === "review-feedback") state.reviewDrafts[state.selectedSubmission].text = event.target.value;
  if (event.target.id === "review-strength") state.reviewDrafts[state.selectedSubmission].strength = event.target.value;
  if (event.target.id === "review-improvement") state.reviewDrafts[state.selectedSubmission].improvement = event.target.value;
  if (event.target.id === "analysis-total-budget" || event.target.id === "analysis-per-project") document.getElementById("analysis-total-budget").setCustomValidity("");
});
document.addEventListener("change", (event) => {
  if (event.target.id === "demo-role") { state.role = event.target.value; state.reviewReceipt = ""; render(); document.getElementById("announcer").textContent = `已切换为${state.role === "teacher" ? "教师" : "学生"}原型视角。`; }
  if (event.target.id === "analysis-demo-state") { state.analysisState = event.target.value; render(); document.getElementById("analysis-demo-state").focus({ preventScroll: true }); }
  if (event.target.id === "recommend-project") state.reviewDrafts[state.selectedSubmission].recommended = event.target.checked;
  if (event.target.id === "enable-class-analysis") {
    const settings = document.getElementById("class-analysis-settings");
    settings.hidden = !event.target.checked;
    settings.querySelectorAll("input, select").forEach(field => { field.disabled = !event.target.checked; });
  }
});
document.addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.target;
  if (form.id === "review-form") { saveReview(true); return; }
  const data = new FormData(form);
  if (form.id === "publish-form") {
    const title = data.get("title").trim(); const instruction = data.get("instruction").trim();
    if (!title || !instruction) { (title ? form.elements.instruction : form.elements.title).focus(); return; }
    const classAnalysis = data.get("enableAnalysis") === "on" ? { payer: String(data.get("analysisPayer")), model: String(data.get("analysisModel")), perProjectBudget: Number(data.get("perProjectBudget")), totalBudget: Number(data.get("totalBudget")) } : null;
    if (classAnalysis && classAnalysis.totalBudget < classAnalysis.perProjectBudget) {
      form.elements.totalBudget.setCustomValidity("任务总预算上限需要不小于每份预算上限。");
      form.elements.totalBudget.reportValidity();
      return;
    }
    const date = String(data.get("deadline")).split("-");
    state.tasks.unshift({ id: `local-${state.tasks.length}`, title, course: `新实训 · ${data.get("class")}`, status: "active", statusLabel: "已发布（示例）", due: `${Number(date[1])} 月 ${Number(date[2])} 日`, detail: instruction, classAnalysis, count: classAnalysis ? "已配置导读授权（示例）" : "导读未开启（示例）" });
    closeDialogs(); state.view = "tasks"; state.taskFilter = "all"; state.search = ""; state.receipt = `“${title}”已添加到原型任务列表。`; render({ focus: true }); window.scrollTo({ top: 0, behavior: "instant" });
  } else if (form.id === "upload-form") {
    if (!state.selectedUpload) { document.getElementById("upload-validation").textContent = "请先选择一个内置示例，用于演示文件添加流程。"; document.querySelector(".example-choice").focus(); return; }
    const name = data.get("name").trim();
    if (!name) { form.elements.name.focus(); return; }
    const association = state.tasks.find(task => task.id === data.get("task"));
    state.projects.push({ id: `local-${state.projects.length}`, name, stack: uploadExamples[state.selectedUpload].stack, analyzed: false, association: association ? association.title : null });
    closeDialogs(); state.view = "projects"; state.receipt = `“${name}”已添加到本地示例列表${association ? "，并标记为关联实训任务" : ""}。`; render({ focus: true });
    if (event.submitter?.value === "analyze") openAnalysisOptions();
  } else if (form.id === "association-form") {
    const project = state.projects.find(item => item.id === data.get("project")); const task = state.tasks.find(item => item.id === form.dataset.task);
    if (!project || !task) return;
    project.association = task.title; closeDialogs(); state.view = "projects"; state.receipt = `“${project.name}”已在原型中关联到“${task.title}”。`; render({ focus: true });
  }
});
document.addEventListener("keydown", (event) => {
  if (!event.target.matches('.analysis-tab[role="tab"]')) return;
  const tabs = [...document.querySelectorAll('.analysis-tab[role="tab"]')];
  const index = tabs.indexOf(event.target); let next = index;
  if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
  else if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
  else if (event.key === "Home") next = 0;
  else if (event.key === "End") next = tabs.length - 1;
  else return;
  event.preventDefault(); tabs[next].click();
});
for (const dialog of [modal, drawer]) {
  dialog.addEventListener("click", (event) => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
  });
  dialog.addEventListener("close", () => {
    if (state.lastFocus?.isConnected && !modal.open && !drawer.open) state.lastFocus.focus({ preventScroll: true });
  });
}
window.addEventListener("hashchange", () => {
  const view = location.hash.slice(1);
  if (["home", "tasks", "projects", "cases", "analysis", "review"].includes(view)) { state.view = view; render({ focus: true }); }
});
render();
