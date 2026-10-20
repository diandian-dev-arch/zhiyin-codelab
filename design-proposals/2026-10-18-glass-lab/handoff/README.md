# 知因 CodeLab · Glass Lab 视觉升级交付包

版本 v1 · 2026-10-18 · 面向 Codex（GPT-6.1 sol）执行全站前端升级

## 怎么用

1. 把整个 `handoff/` 目录保留在仓库的 `design-proposals/2026-10-18-glass-lab/handoff/`（或解压 zip 到这个位置）。
2. 打开 `GOAL.md`，把「目标」到「停止条件」整段粘贴给 Codex 作为 Goal。
3. Codex 按 `02-IMPLEMENTATION_PLAN.md` 分阶段执行，按 `03-ACCEPTANCE.md` 自查并汇报。

## 目录

```
handoff/
├─ GOAL.md                    给 Codex 的执行目标（直接粘贴）
├─ README.md                  本文件
├─ 01-DESIGN_SPEC.md          视觉规范：色彩、字体、材质、动效、液体水波、页面规格、硬性约束
├─ 02-IMPLEMENTATION_PLAN.md  实施计划：基线 → 素材 → 基础层 → 外壳 → 登录/首页 → 工作台 → 文档
├─ 03-ACCEPTANCE.md           验收清单：命令、无障碍、必须保留的选择器、视觉对比、性能
├─ assets/                    生产级素材（目录结构与 apps/web 对应，直接拷贝）
│  ├─ tokens.css              令牌桥接 → 整体替换 apps/web/tokens.css
│  ├─ gallery.html            组件画廊（浏览器直接打开）
│  ├─ src/
│  │  ├─ styles/glass/        tokens.css · base.css · motion.css · components.css
│  │  ├─ glass/               theme · pointer · canvas-loop · liquid(WebGL) · evidence-core · directives · split-text · index
│  │  └─ components/glass/    GlAmbient · GlLiquid · GlEvidenceCore · GlEvidenceTree · GlThemeSwitcher
│  └─ examples/               Vue 参考实现（不直接拷贝，照着改写页面）
│     ├─ LandingHero.vue      首页首屏 + 证据树分区
│     ├─ LoginScene.vue       登录页分屏（保留测试依赖的标签与类名）
│     └─ harness/             最小 Vite 运行壳，用于本地预览参考实现
├─ prototype/                 已定稿的 HTML 原型（index.html 首页 · login.html 登录页，可直接打开）
├─ screenshots/               20 张参考截图（四套配色、各分区、登录两种身份、移动端、组件画廊）
└─ tools/
   ├─ capture-screens.mjs     截图采集（原型或实现后的页面），用于并排对比
   └─ contrast-check.mjs      四套配色对比度检查（当前 40 项全部达标）
```

## 本地预览

- **原型**：直接双击 `prototype/index.html`、`prototype/login.html`。
- **组件画廊**：双击 `assets/gallery.html`，顶部可以切换配色和身份。
- **Vue 参考实现**：在仓库根目录运行

```bash
node apps/web/node_modules/vite/bin/vite.js design-proposals/2026-10-18-glass-lab/handoff/assets/examples/harness
```

  打开 http://127.0.0.1:5189/ 是首页首屏，`#/login` 是登录页。harness 复用 `apps/web` 已安装的依赖；如果包被移出仓库，用环境变量 `CODELAB_WEB` 指向 `apps/web` 目录。
- **重新截图**：在仓库根目录运行

```bash
node design-proposals/2026-10-18-glass-lab/handoff/tools/capture-screens.mjs
```

## 素材验证记录（交付前已完成）

- `assets/src/**`、`examples/*.vue`、`harness/main.ts` 已通过 `vue-tsc` strict 类型检查（复用 apps/web 的编译器与 Vue 版本）。
- Vue 参考实现在 Vite 中实测：
  - 液体水波、检查核心、证据卡轮换、配色切换（含持久化）、身份切换都正常；
  - 「首页 ↔ 登录」来回切换后无 WebGL 警告，画布数量不增长。
- 四套配色对比度：40 项全部达标（正文 ≥15.9:1，次级文字 ≥5.8:1，控件边框 ≥3.3:1）。
- 组件层已按项目测试约束调整：点击区 ≥44px、聚焦 outline 可见、减少动态效果时过渡精确为 `0s`、悬停不位移、控件边框 ≥3:1。

## 需要你（项目负责人）决定的事

- **是否新增 `/welcome` 公开首页路由**：现有 `Landing.vue` 是未被引用的死代码，未登录用户目前直接看到登录页。计划里默认新增，不需要的话告诉 Codex 跳过 §4.2。
- **正式产品默认用哪套配色**：目前默认「石墨·铜金」，四套都可以在设置页切换。如果只想保留一套，删掉 `tokens.css` 里另外三个 `html[data-theme]` 块，并去掉设置页的切换器即可。
