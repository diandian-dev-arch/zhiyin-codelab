# 03 · 验收清单

> 2026-10-19 执行记录：本清单已按当前实现复核。命令基线差异、截图、验证范围与独立发布边界见 `docs/verification/2026-10-18/GLASS-LAB.md`；勾选不代表既有失败的测试已变为通过，也不代表真实模型或课堂验收。

完成后逐项打勾，并在最终汇报里附上每条命令的输出摘要。**任何一项不满足都不算完成。**

## 1. 自动化检查（必须全部不比基线差）

```bash
pnpm --filter @codelab/web typecheck
pnpm --filter @codelab/web build
pnpm test
pnpm exec playwright test --config=playwright.design.config.ts
pnpm exec playwright test --config=playwright.login.config.ts
pnpm test:e2e:v2
pnpm exec playwright test --config=playwright.coursework.config.ts
pnpm exec playwright test --config=playwright.project-course.config.ts
node design-proposals/2026-10-18-glass-lab/handoff/tools/contrast-check.mjs apps/web/src/styles/glass/tokens.css
```

- [x] 上面每条命令通过；基线就失败的用例，失败原因与基线相同。
- [x] 改动过程中**没有修改任何测试文件**来让测试通过。如果确实是测试的视觉假设过时（例如断言旧的浅色背景），先停下，在汇报里说明，不要自行改测试。

## 2. 无障碍与布局（`tests/e2e-design` 会检查其中一部分）

- [x] 320 / 375 / 390 / 414 / 768 / 1280 / 1440 宽度下 `document.documentElement.scrollWidth <= innerWidth`。
- [x] 以下元素在上述宽度下不溢出视口：`main`、`.page-heading`、`.panel`、`.task-collection`、`.task-card`、`.upload-stage`、`.personal-model-bar`、`.source-report`、`.v2-report`、`.review-split`、`.agent-studio`、`dialog[open]`、`.model-columns`、`.login-container`。
- [x] 所有可点击目标 ≥ 44×44px。
- [x] 聚焦时 `outline` 可见（密码框 `outlineStyle !== "none"`）。
- [x] `prefers-reduced-motion: reduce` 下，按钮的 `transitionDuration === "0s"`；液体只渲染静态画面；没有任何循环动画。
- [x] 文字对比度 ≥ 4.5:1，控件边框 ≥ 3:1（运行 contrast-check，并抽查页面里新写的组合）。
- [x] 工作台内可点击目标悬停时不位移（不使用 `v-gl-tilt`、`v-gl-magnetic`、悬停 `translate`）。
- [x] `prefers-reduced-transparency`、`prefers-contrast: more`、`forced-colors` 下仍然可用。
- [x] 读屏：装饰性画布 / 图标都有 `aria-hidden`；逐字拆分的标题有 `aria-label`。

## 3. 必须保留的类名、DOM 结构与可访问名称

测试和验证脚本依赖下列选择器。**名字不能改、结构不能删**，只能改外观。

**通用结构**：原生 `<details>/<summary>`、`<form>`、`<select>/<option>`、`<pre>`、`dialog[open]`、`input[type=file]`，以及 `code.highlight`。

**外壳与登录**：

- 外壳：`.workspace`、`.account`、`nav[aria-label="工作台主导航"]`（链接用 `aria-current="page"`）、`nav[aria-label="工作台导航"]`、`.skip-link`、`#main-content`。
- 登录页：`form.login-form`、`.login-container`。

**任务与提交**：

- 任务卡与描述：`.task-scope > summary`、`.task-description h2 a`、`.task-desk`、`.task-card`、`.task-progress`。
- 提交与创建：`.v2-submission`、`.task-creation-options > summary`、`.submission-guide`。
- 规则：`.requirements .criterion`、`.rule-history`、`.rule-version summary`、`.rule-draft-fields`、`.v2-check input`。

**证据、复核与报告**：

- 证据：`.v2-evidence`、`.v2-evidence pre`、`.v2-evidence img`。
- 复核：`.review-queue > summary`、`.review-nav-item`、`.supplemental-preview summary`、`.review-decision`。
- 分析：`.analysis-drawer > summary`、`details.analysis-drawer`、`.analysis-records`、`.analysis-records > li`、`.analysis-details`。
- 反馈与对比：`.feedback-edit-fields select`、`.publication-comparison`、`.feedback-pair summary`、`.feedback-columns`、`details.comparison`、`.comparison table`。
- 状态：`.studio-status`、`.studio-status .lit`、`.studio-title h1`。

**源码阅读器**：

- 证据窗格：`.evidence-pane`、`.evidence-pane .highlight`、`.evidence-path > span`、`.evidence-path button`、`.evidence-workspace.is-split`、`.evidence-header button svg`、`.locate-source`。
- 阅读记录与报告：`.reader-entry`、`.reader-entry-body`、`.reader-source`、`.source-ledger`、`.source-report`、`.citations button`。
- 历史与分析状态：`.project-history`、`.project-history a`、`.next-analysis`、`details.next-analysis`、`details.advanced-analysis`、`.reading-more > summary`、`.project-reading-state`、`#project-analysis-record`、`.project-record-status`。
- 地图：`.map-root`、`.module-node`、`.map-inspector h3`、`.project-map`、`.directory-map`。
- 文件树：`.source-file-tree`、`.tree-search`、`.tree-clear`、`.tree-collapse`、`.tree-row.is-selected`。
- 发现与学习：`.reader-finding h3`、`.reader-learning-list h3`、`.reader-next-step`、`.reader-verification`、`.reader-verification.withdrawn`、`.reader-verification > summary`。
- 场景与概览：`.scene-evidence button`、`.core-scenario`、`.overview-text`、`.purpose-text`、`.flow-relation.inferred`、`.investigation h2`。
- 执行与统计：`.round-track li`、`.round-track li.complete`、`.live-label`、`.model-usage`、`.execution-snapshot`、`.call-usage summary`、`.verification-note`、`.cost-unknown`、`.omitted`。

**模型设置**：`.model-success`、`.model-advanced summary`、`.course-model-choice`、`.personal-model-bar`、`.model-columns`。

**项目课程**：`.project-task`、`.task-navigation`、`.submission-detail`、`.work-layout`、`.submission-form`、`.peer-reviews`、`.feature-reason`、`.teacher-feedback`、`.zip-drop strong`。

**Agent**：`[data-testid="agent-studio"]`、`.agent-studio`。

**可访问名称**（`getByRole` / `getByLabel` 精确匹配，文字一个字都不能改）：

- 输入框：标签「邮箱」「密码」「建议的下一步」「上传项目 ZIP」。
- 按钮：「登录」「正在登录…」「显示密码」「隐藏密码」「重试连接」「正在重试…」「保存修改」「保存配置」「关闭模型设置」「退出登录」。
- 标题：「欢迎使用 CodeLab」「实训任务」「工作台暂时无法连接」。
- 区域：「本机草稿恢复」。

完整依赖以 `tests/**` 和 `scripts/verify-*.ts|mjs` 为准。改动任何类名前，先在这两个目录里 `grep` 一遍。

## 4. 视觉验收（对照 `screenshots/`）

用 `node design-proposals/2026-10-18-glass-lab/handoff/tools/capture-screens.mjs --base http://127.0.0.1:5174 --out output/glass-check` 截图（需要登录的页面请扩展脚本或手动截图），与交付包截图并排对比：

- [x] 四套配色都能在设置页切换。切换时有圆形揭示；刷新后保持选择；液体与粒子颜色同步变化。
- [x] 教师 / 学生身份色正确：教师用 c1，学生用 c2；主按钮、焦点、导航高亮都跟随。
- [x] 登录页（对照 `05-*`、`06-*`、`07-login-mobile`）：
  - 液体有水波；点击会荡开涟漪；移动鼠标不会频繁落滴；
  - 核心爆发时水面同步荡开一圈波；
  - 身份切换后主色平滑过渡，标语逐字重排。
- [x] 首页（如果实现了 `/welcome`，对照 `01-*` ～ `04-*`、`07-landing-mobile`）：
  - 首屏粒子不遮挡正文；
  - 证据树随滚动生长，五个阶段颜色正确；
  - 报告三层浮层有视差；
  - 导航随滚动隐藏 / 出现，并显示阅读进度。
- [x] 工作台各页（对照 `08-components-gallery-*`）：
  - 玻璃面板、状态胶囊、表格、表单、对话框、代码引用与画廊一致；
  - 没有残留的浅色背景、宣纸纹理或朱砂色；
  - 没有白色闪屏。
- [x] 不出现蓝紫渐变、高饱和霓虹色、大面积纯亮色块（规范 §1）。
- [x] 动效节奏与原型一致：慢、柔；循环装饰动画周期 ≥ 10 秒；工作台内没有粒子和液体。

## 5. 性能

- [x] 登录页、首页在 Chrome Performance 面板里持续 10 秒，主线程无长任务堆积，帧率稳定（中端笔记本应接近 60fps）。
- [x] 来回切换「登录 ↔ 首页 ↔ 工作台」10 次，控制台没有 WebGL 警告，`document.querySelectorAll('canvas').length` 不增长（液体 `destroy()` 正确释放上下文）。
- [x] 工作台页面不创建任何 WebGL 上下文。
- [x] `pnpm --filter @codelab/web build` 的产物体积相比基线增长不超过 60KB（gzip 后）。新增素材本身不引入任何第三方依赖。

## 6. 汇报内容

最终汇报应包含：

- 改动文件清单；
- 每条命令的结果；
- 与基线不同的地方及原因；
- 截图对比；
- 按规范自查的偏差，以及偏差的理由；
- 仍未完成或需要产品决策的事项（例如是否保留 `/welcome` 路由）。
