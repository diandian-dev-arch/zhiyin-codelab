# 02 · 实施计划

> 目标：在**不改动业务逻辑、API、权限与测试依赖**的前提下，把 `apps/web` 全站升级为 Glass Lab 视觉。
> 真实工作台入口：`apps/web/index.html` → `src/main-codelab.ts` → `AppCodeLab.vue` → `App.vue`（外壳）+ `router-codelab.ts`。
> `src/main.ts` 是废弃入口，不要修改。

---

## 0. 基线（动手前先做）

在仓库根目录依次运行，**把结果记下来**作为基线。升级后同样的命令必须不比基线差：

```bash
pnpm --filter @codelab/web typecheck
pnpm --filter @codelab/web build
pnpm test
pnpm exec playwright test --config=playwright.design.config.ts
pnpm exec playwright test --config=playwright.login.config.ts
pnpm test:e2e:v2
pnpm exec playwright test --config=playwright.coursework.config.ts
pnpm exec playwright test --config=playwright.project-course.config.ts
```

如果某个 E2E 在基线就因为环境原因失败（例如端口占用、缺少 Docker），记录原因，后续只比较同一批用例。

## 1. 拷贝素材

| 交付包路径 | 拷贝到 |
|---|---|
| `assets/src/styles/glass/*.css` | `apps/web/src/styles/glass/` |
| `assets/src/glass/*.ts` | `apps/web/src/glass/` |
| `assets/src/components/glass/*.vue` | `apps/web/src/components/glass/` |
| `assets/tokens.css`（令牌桥接） | **整体替换** `apps/web/tokens.css` |

`assets/examples/*.vue` 是参考实现，不要直接拷进项目；照它的组合方式改写真实页面。

拷贝后运行 `pnpm --filter @codelab/web typecheck`。这些素材已在 strict 模式下通过 vue-tsc。

## 2. 接入基础层

### 2.1 `src/main-codelab.ts`：样式顺序与插件

```ts
import './style.css';
import './styles/glass/tokens.css';   // 新：--gl-* 令牌，必须在桥接之前
import '../tokens.css';                // 已替换为桥接：旧令牌名 → 新值
import './styles/studio.css';
import './styles/motion.css';
import './styles/manuscript.css';      // 见 §2.4 的清理
import './styles/coursework.css';
import './styles/glass/base.css';      // 新：放在最后，统一覆盖
import './styles/glass/motion.css';
import './styles/glass/components.css';
import './styles/glass/legacy-skin.css'; // 新建：把旧全局类改成玻璃外观，见 §5.1
import { GlassLab } from './glass';
// …
app.use(GlassLab);   // 恢复配色、注册 v-gl-* 指令、挂光标光晕
```

保留现有的 `v-spotlight` 和 `v-reveal` 指令（页面在用）。新代码优先使用 `v-gl-*` 系列。

### 2.2 `apps/web/index.html`

- `<html lang="zh-CN" data-theme="bronze">`。
- `theme-color` 改为 `#0d0c0b`。
- 首屏前的闪白问题：在 `<head>` 内联一行脚本，提前读取 `localStorage['codelab-theme']` 写入 `data-theme`，并设置 `html { background: #0d0c0b }`。

### 2.3 `App.vue` / `AppCodeLab.vue`

- 在根部放一次 `<GlAmbient :calm="!!s.user" />`：工作台用平静版，登录 / 公开页用默认版。
- 把会话身份同步到 `<body data-role>`：`watch(() => s.user?.role, r => document.body.dataset.role = r ?? 'teacher', { immediate: true })`。教师用 c1，学生用 c2，所有主按钮、焦点、导航高亮自动跟随。
- `AppCodeLab.vue` 的减少动态效果规则保留，它输出的就是测试需要的 `0s`。

### 2.4 清理旧皮肤里与新视觉冲突的部分

- `styles/manuscript.css`：去掉宣纸颗粒背景（改用 `.gl-grain`）；虚线焦点环改为 `components.css` 的实线 `outline`。`.sidebar` 里的墨色反白令牌重映射不再需要，新版整站都是深色。
- `style.css`：顶部 `:root` 里那份旧调色板（`#a54524` 等）删除，避免和桥接冲突；`color-scheme: light` 改为 `dark`。
- `prefers-contrast` / `forced-colors` / `prefers-reduced-transparency` 等现有规则保留；如与新规则重复，保留更严格的那条。
- 不要删除任何类名，只改它们的外观。

## 3. 外壳（`App.vue`）

| 现有结构（保留类名与 DOM 层级） | 新外观 |
|---|---|
| `.workspace` | `.gl-shell` 的网格：248px 侧栏 + 主区 |
| `aside.sidebar` | 玻璃侧栏：`rgb(surface / .35)`、`blur(18px)`、右侧细线 |
| `.brand` | 圆环 Logo（原型 `.brand-mark`：c1→c4→c5→c2 的锥形渐变圆环，18s 一圈）+「知因 **CodeLab**」 |
| `nav[aria-label=工作台主导航]` 里的 `RouterLink.nav-item` | `.gl-navlink` 外观；`aria-current="page"` 的项显示身份色渐变底和左侧色条。**aria-current 逻辑不动** |
| `.nav-caption` | `.gl-sidebar__group` 外观（等宽、字距、全大写） |
| `.account` / `.avatar` | `.gl-avatar`（教师 c1→c4、学生 c2→c5 渐变）；退出按钮保持 `aria-label="退出登录"` |
| `header.topbar`（`.is-scrolled`） | 透明顶栏；滚动后变为玻璃，带底部细线 |
| `nav.mobile-workspace-nav` | 底部玻璃导航条，满足 44px 点击区 |
| `main#main-content.content` 里的 `RouterView :key=fullPath` | 包一层 `<Transition name="gl-page" mode="out-in">`，保留 `:key` |

## 4. 首页（新增公开路由）与登录页

### 4.1 登录页 `views/Login.vue`

照 `assets/examples/LoginScene.vue` 改成分屏场景，**业务逻辑原样保留**（`handleLogin`、错误处理、重试、`aria-busy`）：

- 保留：`main#main-content.login-page`、`.login-container`、`.login-card`、`h1#login-title`「欢迎使用 CodeLab」、`form.login-form`、`<label for="email">邮箱</label>`、`<label for="password">密码</label>`、`显示密码 / 隐藏密码` 切换按钮、`role="alert"` 的错误、提交按钮「登录 / 正在登录…」。
- 左侧 `.login-intro` 改为场景：`<GlLiquid>`、`<GlEvidenceCore>`、公转证据标签、身份标语。原有的 `h2` 文案和工作流列表可以并入标语区，或改成示意标签。
- 新增的身份分段控件只改变外观（见规范 §7.2），不改登录请求，不新增任何字段。
- 输入框使用 `.gl-float` 浮动标签写法（支持 `<input> + <label for>`）。
- `App.vue` 里连接失败时的 `section.login-card`（「工作台暂时无法连接」「重试连接」）也套用玻璃卡片外观，文案不变。

### 4.2 首页 `/welcome`（新增）

现有 `views/Landing.vue` 没有被任何路由引用。改写这个文件实现首页：首屏和工作方式两段照 `assets/examples/LandingHero.vue`，其余分区照 `prototype/index.html`。

- 路由：在 `router-codelab.ts` 的 `*` 通配路由**之前**加 `{ path: '/welcome', component: () => import('./views/Landing.vue'), meta: { public: true } }`。
- `App.vue`：当 `route.meta.public` 为真时，直接渲染 `<RouterView />`，不包外壳，也不因为未登录而显示登录页。其余路由的判断逻辑不变。
- 首页按钮「进入工作台」链接到 `/`（未登录会显示登录页）；登录页底部加一个「了解 CodeLab →」链接到 `/welcome`。
- 首页文案以 README 为事实来源（8 个独立案例、5 项核心要求、6 种受限 Agent 工具、模型结果不自动发布等）。三层报告浮层里的示意数据要标注为「示意」，或使用明显的示例姓名。
- 首页属于展示区，可以使用 `v-gl-tilt`、`v-gl-magnetic`。

> 如果项目负责人不希望新增路由，就跳过 4.2，其余步骤不受影响。

## 5. 工作台页面

### 5.1 先做 `styles/glass/legacy-skin.css`：一次性给旧全局类换上玻璃外观

大部分页面依赖 `style.css`、`studio.css`、`coursework.css` 里的全局类，模板不必大改。新建 `legacy-skin.css`，用下表把旧类的**外观**改成对应的 Glass Lab 组件。做法是复制对应 `.gl-*` 规则里的声明，不要改 HTML 去追加类名：

| 旧类 / 元素 | 外观对照 |
|---|---|
| `button`（全局）、`.button`、`.primary`、`.btn-login` | `.gl-btn`；`.primary` → `.gl-btn--primary` |
| `.icon-button`、`.btn-icon`、`.btn-back`、`.back`、`.text-button` | `.gl-btn--icon` / `.gl-btn--subtle`（仍 ≥44px） |
| `input`、`textarea`、`select`、`StudioSelect`、`StudioSearch` | `.gl-input` / `.gl-textarea` / `.gl-select` |
| `.panel`、`.course-panel`、`.upload-panel`、`.task-desk` | `.gl-panel.gl-glass` |
| `.task-card`、`.stat-card`、`.course-row` | `.gl-card`（可加 `v-spotlight`；不得悬停位移） |
| `.status` 及 `.manual`、`.completed`、`.interrupted`、`.infra_error`、`.preparing`；`.status-badge`、`.tag` | `.gl-chip` 的语义变体：completed→success、manual→accent、preparing→info + live、interrupted→warning、infra_error→danger |
| `.notice`（`.neutral`）、`.error`、`.course-notice`、`.import-note` | `.gl-callout` 的 info / danger / warning 变体 |
| `.empty`（`.compact`）、`.empty[role=status]` 加载态 | `.gl-empty` / `.gl-skeleton` |
| `.segmented`、`.course-model-choice` | `.gl-segmented` 的外观（滑块可以先不做，只做选中态） |
| `.page-heading`、`.section-heading` | `.gl-pagehead` 的排版；`.eyebrow` → `.gl-eyebrow` |
| `<details>/<summary>`（`.task-scope`、`.analysis-drawer`、`.review-queue`、`.model-advanced` 等） | 玻璃面板；`summary` 加 chevron 旋转；**结构不改**，并覆盖 `details::details-content` 的减少动态效果规则 |
| `<table>`（`.comparison table` 等） | `.gl-table-wrap` + `.gl-table` 的外观 |
| `dialog`（`PersonalModelDialog`、`ReportV2`） | `.gl-dialog` 外观 + `::backdrop` 模糊 |
| `pre`、`code.highlight`、`.evidence-pane .highlight` | `.gl-code`；高亮行 → `.gl-code__line.is-hl`（c4） |
| `.zip-drop`、`input[type=file]` 区域 | `.gl-dropzone` |
| `.review-split`、`.evidence-workspace.is-split` | `.gl-split-view` |
| `ms-*` 手稿装饰类（`ms-cap`、`ms-ul`、`ms-flag`、`ms-diamond`、`ms-wordmark`…） | 逐个评估：装饰性的改为克制的 c1 / c3 细线，或直接隐藏（`display:none` 只针对纯装饰元素） |

### 5.2 然后逐页精修（按优先级）

| 顺序 | 页面 / 组件 | 要点 |
|---|---|---|
| 1 | `views/Tasks.vue`（`/`、`/tasks`） | 登录后的第一页。页头 + 统计（`gl-stat` 四色）+ 任务卡网格（`.task-card`，`v-gl-reveal` 轻入场）。教师的班级 / 学生区域用表格样式 |
| 2 | `views/ReportV2.vue`（`/runs/:id`、`/publications/:id`），以及 `AgentStudio`、`SourceEvidenceReader`、`PublicationComparison`、`AnalysisProgress` | 教师复核台是核心体验。证据 / 反馈 / 源码用 `.gl-tabs` 外观；`.v2-evidence` 截图用 `.gl-shot`；反馈编辑区玻璃面板；`AgentStudio` 刊头从「墨色反白」改为玻璃面板，加一圈很淡的 c1 光晕，**`data-testid="agent-studio"` 保留**；`AnimatedNumber` 和环形进度只显示 API 值 |
| 3 | `views/TaskEntry.vue` → `ProjectTask.vue` / `TaskV2.vue`、`components/ProjectSubmissionReview.vue`、`RuleHistory.vue` | 提交区用 `.gl-dropzone`；步骤条 `.gl-steps` 按五阶段色相；要求列表 `.criterion` 用卡片样式 |
| 4 | `views/Projects.vue`（scoped 样式约 690 行）、`SourceProjectReport`、`SourceProjectMap`、`SourceFileTree`、`SourceAnalysisControls`、`SourceCostControls`、`SourceImportCoverage`、`CoreScenarioReader`、`EvidenceFlowReader` | scoped 样式里的硬编码颜色全部换成令牌。**地图上的文字底下必须是不透明表面**（DESIGN.md 要求），用 `--gl-solid` |
| 5 | `views/Assignments.vue`、`AssignmentDetail.vue`、`CourseTask.vue`、`CourseSubmission.vue`、`CourseReport`、`CourseTaskBrief`、`CourseTaskOptions` | 主要依赖 `coursework.css`，在 legacy-skin 里一并处理；时间显示加 `.gl-num` |
| 6 | `views/Settings.vue`、`components/PersonalModelDialog.vue` | Settings 新增「外观」区块，放 `<GlThemeSwitcher variant="list" />`，可选四套配色。这是正式产品中唯一的配色入口；原型里右下角的悬浮切换器不进入工作台 |
| 7 | `views/Unavailable.vue`、`ProjectPageLoadError.vue`、全局加载态 `.loading[role=status]` | `.gl-empty` 风格 |

不处理的文件（死代码）：`src/main.ts`、`views/Notifications.vue`、`views/student/*`、`views/teacher/*`、`apps/web/apps/web/**`、`components/CodeFlowAnimation.vue`、`PaperBackground.vue`、`ProjectChart.vue`、`styles/paper-fold.css`。

### 5.3 每页的完成标准

- 页面里所有颜色都来自令牌，没有新增硬编码色值。可以用 `grep -nE "#[0-9a-fA-F]{3,6}|rgba?\(" <文件>` 自查，SVG 内联图标除外。
- 320 / 390 / 768 / 1280 / 1440 宽度下没有横向滚动，布局不重叠。
- 键盘 Tab 走一遍：焦点可见、顺序合理。
- 开启减少动态效果后，无动画、无残留模糊或透明。

## 6. 文档

在 `apps/web/DESIGN.md` 顶部追加一条 2026 年的条目：「Glass Lab 深色玻璃视觉」。内容包括：

- 四套配色与语义分工；
- 令牌来源变化：`--gl-*` + 桥接；
- 液体 / 粒子只在展示区使用；
- 保留的可访问性规则。

明确标注旧条目里的**视觉**规则已被取代（宣纸、朱砂单色、无阶梯入场等），**无障碍与数据真实性**规则继续有效。

## 7. 验证

见 `03-ACCEPTANCE.md`。每完成一个阶段（§2、§3、§4、§5 每一行）都跑一次 typecheck 和相关 E2E，不要攒到最后。
