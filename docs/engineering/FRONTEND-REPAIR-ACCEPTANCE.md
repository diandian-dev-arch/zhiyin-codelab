# 新前端修复与验收（2026-09-29）

本文件取代上轮互相矛盾的 Goal 完成报告；不代表整个参赛项目完成。

## 实际入口

- 持久工作台：http://127.0.0.1:5174/projects；PostgreSQL/API 3102，执行器沿用现有工作台配置。
- 启动命令：`pnpm dev:workspace:supervised`。已有服务运行时不要重复启动。
- 默认独立预览 5173 的后端 3100 不可用、且持久工作台健康时，文档请求转向 5174。不会改写 Origin 或代理写请求绕过权限。
- E2E 显式配置独立端口和代理，不经过上述兼容跳转。
- 原 history URL 保留；`/#/...` 旧原型链接在启动前转换为等价业务路径。

## 功能映射

| 功能 | 当前入口与实现 |
| --- | --- |
| 登录、身份恢复、退出 | 新 Login 视觉；原 App 工作台管理唯一会话加载与草稿退出保护 |
| AI 项目分析 | /projects、/projects/:id → Projects 原有真实导入、分析、引用和恢复逻辑 |
| 模型与账号 | /settings → 当前会话与 PersonalModelDialog；项目页也保留模型配置 |
| 教师任务、班级、学生 | /tasks → Tasks 的真实管理能力 |
| 学生提交、执行 | /tasks/:id → 按服务端 businessVersion 选择 Task/TaskV2 |
| 证据、复核、确认、发布 | /runs/:id → Report/ReportV2 |
| 学生反馈 | /publications/:publicationId → 已授权发布快照 |
| 旧角色列表入口 | /teacher/tasks、/teacher/students、/student/courses → 真实任务入口 |
| 原型详情与外围页面 | 不猜测原型 ID 与真实记录的映射；显示明确不可用说明和真实业务入口 |

已恢复全局样式、导航与移动退出，沿用新视觉的纸色/蓝色登录与浅色外壳。未接通原型不再出现在正式流程；源文件保留，不冒充真实成绩。通知/主题开关不再提供虚假的保存操作。

## 验证状态

本轮验证结果：

- `pnpm typecheck`：各工作区通过。最终界面修改后 `pnpm build` 再次通过（含 vue-tsc）。
- `pnpm test`：61 文件通过、3 文件跳过；716 项通过、32 项跳过，0 失败。跳过项不是通过，也没有在本轮冒充真实 PostgreSQL 专项补验。
- 系统 Chrome 新入口 E2E：教学/历史 6、恢复 6、写入恢复 6、源码/模型恢复 5、登录和新增入口测试 9，共32项通过。先执行 `pnpm test:e2e:v2`；发现旧登录表单定位和 hash 初始化缺陷后修复，单独重跑完整 login 配置9项通过。最终层级/减少动态效果修改后，再跑 workspace-entry 用例通过并完成构建。不是声称第一次串行总命令全绿。
- 新增 `tests/e2e-login/workspace-entry.spec.ts` 验证 hash 链接、真实登录、目的页、刷新、账号设置、模型弹窗、390px 导航、原型隔离与退出。旧登录重复提交测试只更新真实表单定位，保留防重复提交断言。
- 真实持久工作台只读冒烟：从5173旧登录链接跳转5174，现有教师账号登录、项目页、刷新、教学任务、退出均成功，退出码0。没有上传新业务数据或触发模型调用。
- 截图：`test-results/login/workspace-entry-prototype--c2536-tes-real-pages-and-logs-out/projects-desktop.png` 与 `settings-mobile.png`。检查截图发现项目背景遮住标题，已修正项目内容层级；最终截图复核标题恢复。

修复后的32项浏览器测试覆盖UI集成和恢复，不表示它们全部调用了真实模型或执行器。通知、成绩排名和主题切换仍不提供；原型源码保留但不在正式业务路由中。现有新界面的视觉方向得以保留，未对每个原型页面重写一份重复后端逻辑。

浏览器使用系统 Chrome、隔离 PGlite/API 和测试账号。UI fixture、拦截模型响应只证明集成与恢复，不等于真实模型质量或真实执行器验收。本轮不新增收费模型调用，不修改用户上传或冻结交付包。

## 补充：真实 ZIP 到报告的浏览器链路

- 新增 `pnpm test:e2e:source-flow`，并纳入 `pnpm test:e2e:v2`。最终 Chrome 用例 1/1 通过；与上文分组结果合计33项，不表示一次总命令运行33项。
- 无浏览器接口拦截：实际上传 ZIP，通过 HTTP、数据库和源码分析 worker 生成报告，核对文件过滤、源码引用、刷新与历史恢复不重复创建分析，以及另一个账号访问返回404。
- 仅模型输出由测试专用 `sourceUIProvider` 合成，无外部模型请求。测试配置只在受 `CODELAB_UI_FIXTURE=1` 保护的独立服务显式启用。不能据此宣称真实模型质量达标。
- 截图发现分析轨迹浅色文字缺少深色底，已补齐底色；最终截图检查文字恢复可读，新增浏览器断言防止回退。
- 截图：`test-results/source-flow/source-flow-real-ZIP-impor-6456c-y-with-synthetic-model-only/source-report.png`。
- 新测试及fixture加入后 `pnpm typecheck` 通过；最终显示修复后 `pnpm build` 通过。
- 隔离 PostgreSQL 17 专项补验：`pnpm test:postgres` 五文件215/215通过、0跳过、退出码0，覆盖报告、worker、生命周期、迁移与空闲连接恢复。该专项包含与普通测试重复的用例，不能简单与716相加；普通测试的跳过计数保持原记录。
- 本轮专用测试容器、卷和网络已清理；现有工作台5174与API3102复查均HTTP200，无业务数据清理或服务重启。
