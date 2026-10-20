# GOAL · 知因 CodeLab 全站视觉升级为「Glass Lab」

> 把下面「目标」到「停止条件」整段粘贴给 Codex 作为 Goal。交付包路径假定为仓库内的 `design-proposals/2026-10-18-glass-lab/handoff/`；如果你把包放到了别处，替换路径即可。

---

## 目标

把 `apps/web`（Vue 3 + Vite，入口 `src/main-codelab.ts`）全站前端升级为交付包定义的 **Glass Lab 深色玻璃视觉**：

- 深色、带色调的中性底，叠半透明毛玻璃层；
- 四套可切换配色（石墨·铜金 / 墨色·青瓷 / 炭灰·赭石 / 烟墨·灰玫），每套四个明度对齐的色相，按语义分工；
- 登录页与新首页使用 WebGL 液体水波 + 检查核心粒子动画；
- 工作台各页统一使用玻璃组件，动效慢、柔、克制。

**只改视觉层，不改业务逻辑、API 调用、权限、路由行为（`/welcome` 公开路由是唯一新增）和任何测试依赖的结构与文案。**

## 必读（按顺序）

1. `design-proposals/2026-10-18-glass-lab/handoff/README.md`：交付包结构。
2. `handoff/01-DESIGN_SPEC.md`：视觉规范。§1「被否决的做法」和 §8「不可违反的约束」必须读完。
3. `handoff/02-IMPLEMENTATION_PLAN.md`：分阶段实施步骤，具体到文件。
4. `handoff/03-ACCEPTANCE.md`：验收清单，以及测试依赖的类名与可访问名称。
5. 视觉参照：
   - `handoff/screenshots/*.png`；
   - `handoff/prototype/index.html`、`login.html`（可直接用浏览器打开）；
   - `handoff/assets/gallery.html`（组件画廊）；
   - `handoff/assets/examples/*.vue`（Vue 参考实现）。
6. 项目约定：`apps/web/DESIGN.md`。其中的无障碍与数据真实性规则继续有效，视觉规则被本次升级取代。

## 已提供的生产级素材（直接拷贝使用，不要重写）

| 素材 | 内容 |
|---|---|
| `handoff/assets/src/styles/glass/` | `tokens.css`、`base.css`、`motion.css`、`components.css`：令牌、基础层、动效、全套工作台组件 |
| `handoff/assets/tokens.css` | 令牌桥接，**整体替换** `apps/web/tokens.css`：旧令牌名不变，值指向新配色 |
| `handoff/assets/src/glass/*.ts` | 配色与主题切换、共享指针、液体水波 WebGL 引擎、检查核心粒子、Vue 指令（`v-gl-reveal / spotlight / tilt / magnetic / count / split`）、插件入口 `GlassLab` |
| `handoff/assets/src/components/glass/*.vue` | `GlAmbient`、`GlLiquid`、`GlEvidenceCore`、`GlEvidenceTree`、`GlThemeSwitcher` |

这些素材已通过 vue-tsc strict 类型检查，在 Vite + Vue 中实测运行过；四套配色的对比度已验证达标。液体水波的参数经过多轮设计评审，**不要调整**（见规范 §6）。

## 执行方式

1. **基线**：先运行 `03-ACCEPTANCE.md` §1 的全部命令，记录结果。
2. 按 `02-IMPLEMENTATION_PLAN.md` 的阶段顺序执行：
   1. 拷贝素材；
   2. 接入基础层；
   3. 外壳；
   4. 登录页与首页；
   5. 先写 `legacy-skin.css`，再逐页精修；
   6. 文档。
3. **每完成一个阶段**就运行 typecheck 和相关 E2E。出现失败立即修复，不要攒到最后。
4. 改动任何类名或 DOM 结构之前，先在 `tests/` 和 `scripts/` 里 grep 该选择器。
5. 颜色一律使用令牌（`--gl-*` 或桥接后的旧令牌），不新增硬编码色值。
6. 完成后按 `03-ACCEPTANCE.md` 逐项自查，并用 `handoff/tools/capture-screens.mjs` 截图，与交付包截图对比。

## 硬性约束

- 不修改：任何 API 请求与响应处理、Pinia store 逻辑、权限与角色判断、路由守卫行为、`packages/`、`apps/api`、`apps/runner`。
- 不修改测试文件来让测试通过。如果确实发现测试的视觉假设过时，停下来在汇报中说明。
- 保留 `03-ACCEPTANCE.md` §3 列出的所有类名、DOM 结构、`data-testid` 和可访问名称（中文按钮名、标签、标题一个字都不能改）。
- 无障碍：
  - 点击区 ≥ 44px；
  - 聚焦 `outline` 可见；
  - 减少动态效果时过渡时长为 `0s`；
  - 任何宽度不出现横向滚动；
  - 文字对比度 ≥ 4.5:1，边框 ≥ 3:1；
  - 工作台内悬停不移动可点击目标。
- 不编造数据：工作台里的数字、进度、环形图只展示 API 返回的值。
- 不新增第三方依赖；不加载网络字体。
- 不出现蓝紫渐变、高饱和霓虹色、大面积纯亮色块。
- 液体水波和粒子只用于登录页与首页；工作台不创建 WebGL 上下文。
- 登录页的教师 / 学生切换只改变外观，不改变登录请求。

## 完成定义

- `03-ACCEPTANCE.md` 的所有条目已勾选，每条命令不比基线差。
- 全部在用页面完成升级（`02-IMPLEMENTATION_PLAN.md` §5.2 表格的 7 行）：没有残留的浅色背景、宣纸纹理或朱砂色。
- 设置页可以切换四套配色，选择会被保存。
- `apps/web/DESIGN.md` 已追加 Glass Lab 条目。
- 提交一份汇报，内容见 `03-ACCEPTANCE.md` §6。

## 停止条件（遇到以下情况先停下来汇报，不要自行决定）

- 某个测试只能通过修改测试本身才能通过。
- 实现某个视觉效果必须改动业务逻辑、API 或权限。
- 需要删除或重命名 `03-ACCEPTANCE.md` §3 里的任何选择器。
- 项目负责人尚未确认是否新增 `/welcome` 公开路由。默认实现；如果被否决，跳过 §4.2。
