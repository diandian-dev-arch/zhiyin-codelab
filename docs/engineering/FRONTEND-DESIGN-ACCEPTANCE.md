# 前端设计优化验收 · 2026-09-29

本次将真实 Vue 工作台统一为「杏光 Studio」：暖灰背景、白色内容面、炭黑重点区域、杏色品牌细节与深橙主操作。设计服务于「要求 → 证据 → 反馈」，涵盖登录、导航、实训任务、任务详情、教师复核、学生反馈、项目分析、源码报告、账号与个人模型设置。

## 实施内容

| 范围 | 结果 |
| --- | --- |
| 基础系统 | `apps/web/tokens.css` 统一颜色、字体、间距、圆角、状态色；`src/styles/studio.css` 统一共享控件与响应式布局 |
| 应用框架 | 桌面侧栏、移动端三项导航、当前页标记、真实账号信息、键盘跳转与焦点 |
| 登录 | 品牌介绍与表单分区；移动端压缩介绍；移除不影响权限的身份选择；保留密码显示、错误与等待状态 |
| 任务 | 紧凑概览、任务行、原生验收范围折叠、搜索/筛选/清空、加载范围说明与下一页操作 |
| 复核 | 证据和反馈先于辅助分析；清晰的条目导航、草稿状态、确认进度、保存/确认/发布层级 |
| 源码分析 | 上传与分析选项分区、预算信息、真实分析轨迹、覆盖范围、章节切换、代码引用与分析边界 |
| 设置 | 账户信息与模型操作分区；模型弹窗在窄屏中滚动；费用归属与高级设置明确 |

原有全局 `style.css` 保留，新增层从两个入口加载。移除实际业务页中的纸张折角、衬线装饰和无功能轨道图。未增加运行时依赖、外部字体、图片服务或动画库。

## 验证结果

- `pnpm typecheck`：4 个工作区全部通过。
- `pnpm build`：Vue 类型检查与生产构建通过。
- `pnpm test:e2e:v2`：6 个测试集共 **33 项通过**：业务流程 6、复核恢复 6、写入恢复 6、源码恢复 5、登录 9、源码完整流程 1。
- `pnpm exec playwright test --config=playwright.design.config.ts`：**3 项通过**，覆盖 320、375、414、768、1280px 五种视口宽度。
- 共保留 **45 张页面与弹窗截图**：9 个场景 × 5 档宽度。源码弹窗使用视口截图，以避免全页截图中的固定遮罩拼接现象。
- 交互覆盖：密码可见性、Tab 焦点、搜索空态与清空、规则展开、任务子页面选中导航、模型弹窗 Escape 关闭与焦点归还、复核输入、减少动态效果、源码引用打开/关闭与焦点归还。
- 完整源码流程在隔离测试服务中使用合成模型，实际导入测试 ZIP，经过 worker 生成报告，检查过滤、引用、历史、缓存复用、费用门禁和跨账号不可读取。
- 对 `http://127.0.0.1:5174/` 的真实工作台作只读检查：任务、项目入口及已有河洛项目长文本报告。已载入真实报告、系统字体生效，检查的主体/代码引用区域未超出视口。未重新分析该项目。

### 对比度

按标准 sRGB 相对亮度公式计算；OKLCH 来自相应 sRGB 色值转换，舍入误差不影响门槛。

| 组合 | 比值 |
| --- | --- |
| 正文 `#24272C` / 背景 `#F2F2EF` | 13.36:1 |
| 次要文字 `#62656B` / 背景 `#F2F2EF` | 5.21:1 |
| 主操作 `#A54524` / 白色文字 | 6.04:1 |
| 输入框边界 `#858A84` / 白色 | 3.52:1 |
| 输入框边界 `#858A84` / 背景 `#F2F2EF` | 3.14:1 |

主要按钮最小高度 44px；表单焦点为 2px、其他键盘焦点为 3px；减少动态效果模式关闭动画与过渡。以上是检查范围内的结果，不等于完整 WCAG、屏幕阅读器或真机认证。

## 截图索引

以下为隔离测试数据截图，不代表真实学生的验收结论。

| 页面 | 桌面 | 窄屏 |
| --- | --- | --- |
| 登录 | [1280px](../../output/frontend-design/login-1280.png) | [375px](../../output/frontend-design/login-375.png) |
| 实训任务 | [1280px](../../output/frontend-design/tasks-1280.png) | [375px](../../output/frontend-design/tasks-375.png) |
| 任务详情 | [1280px](../../output/frontend-design/task-detail-1280.png) | [375px](../../output/frontend-design/task-detail-375.png) |
| 教师复核 | [1280px](../../output/frontend-design/teacher-review-1280.png) | [375px](../../output/frontend-design/teacher-review-375.png) |
| 项目分析 | [1280px](../../output/frontend-design/projects-1280.png) | [375px](../../output/frontend-design/projects-375.png) |
| 源码报告 | [1280px](../../output/frontend-design/source-report-1280.png) | [375px](../../output/frontend-design/source-report-375.png) |
| 源码引用 | [1280px](../../output/frontend-design/source-dialog-1280.png) | [320px](../../output/frontend-design/source-dialog-320.png) |
| 账号设置 | [1280px](../../output/frontend-design/settings-1280.png) | [375px](../../output/frontend-design/settings-375.png) |
| 模型弹窗 | [1280px](../../output/frontend-design/model-dialog-1280.png) | [320px](../../output/frontend-design/model-dialog-320.png) |

## 复现

在仓库根目录、受支持的 Node 运行时执行。Windows 可用 `pnpm workspace:runtime` 检查项目已选运行时。浏览器测试使用本机 Chrome：

```powershell
$env:PLAYWRIGHT_CHANNEL = 'chrome'
pnpm typecheck
pnpm build
pnpm test:e2e:v2
pnpm exec playwright test --config=playwright.design.config.ts
```

并行运行设计检查时，为该进程设置 `E2E_V2_API_PORT=3321`、`E2E_V2_WEB_PORT=5328`，避免与默认测试服务冲突。测试会启动隔离服务，不应指向真实教学数据。

## 边界

本次未调用付费模型，未向真实工作台上传 ZIP、保存模型设置、写入教师反馈或发布报告。业务写入测试仅发生在隔离夹具服务。未重做已有后端全集测试，未执行真实模型质量评测、移动设备/屏幕阅读器人工验收或公网部署。既有冻结交付包没有重新打包。

设计来源、取舍与便携 token 映射见 [DESIGN.md](../../apps/web/DESIGN.md)。Hallmark 记录保存在项目 `.hallmark/`；没有把自评或局部验证写成「所有设计门禁满分」。
