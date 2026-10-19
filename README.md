# 知因 CodeLab

面向编程实训的版本提交、证据核对与教师反馈平台。课程作业承接函数、文件与连续子任务成果；实训任务保留开放项目交流及受控 Vue 模板验收；普通项目解读提供静态源码阅读。AI 仅生成候选，教师决定最终反馈。

**当前接手入口：[平台路径与实施状态](docs/CURRENT_PLATFORM_STATUS.md)。先内部完善，再由用户交给老师试用；开发回归不代表真实教学减负已经验证。**

**日常使用请打开 http://127.0.0.1:5174/ ，这是 B 版真实工作台；output 下的 HTML 是历史设计原型。** v2 已提供持久任务/规则、ZIP 提交、五项核心要求的八案例真实检查、教师逐项复核发布、学生证据报告与复提比较。已验证 11 份团队构造样本、两种实现结构。受限 Agent、显式重新分析和真正 LangGraph 检查点已接入，工程验证使用合成 provider；真实模型质量、完整系统隔离和课程试点尚未验收。只有受控工作台开放已授权的团队样本执行。最新进度见 [实施状态](docs/IMPLEMENTATION_STATUS.md)。

## 日常可执行工作台（团队样本）

第一次使用先看 [完整操作路线](docs/QUICKSTART.md)：从登录、建任务、提交、复核发布到再次提交，区分教师与学生的操作以及异常处理。

首次在另一台机器复现请按 [干净环境复现步骤](docs/REPRODUCE.md) 操作。`pnpm reproduction:package` 可生成排除私有运行数据的源码包及逐文件哈希；打包/本机解压自检不能替代另一成员实际运行回执。模型接入另见 [配置说明](docs/MODEL_SETUP.md)。

模型分析使用每账号的「模型设置」窗口：学生和教师分别选择服务商、模型并保存自己的 API Key，费用由该密钥所属的服务商账户承担。普通 ZIP 分析、课程 AI 总结及 Agent 均不回退到平台共享密钥。课程检查默认「仅基础检查」，主动选择 AI 后才调用当前发起者的模型；教师重新分析使用教师自己的配置。保存配置不收费，显式测试连接可能产生少量费用；无密钥仍可查看历史报告、进行课程基础检查和教师复核。详见 [配置说明](docs/MODEL_SETUP.md) 与 [课程个人计费验证](docs/verification/2026-09-29/COURSE-PERSONAL-MODEL.md)。模型结果是教师可选择采用的候选，不自动发布。历史真实请求见 [接入记录](docs/verification/2026-09-28/T09-live-model-integration.md) 和 [输入与预算实测](docs/verification/2026-09-28/T09-summary-input-budget.md)；这些记录不代表当前个人配置的跨模型质量、稳定性或费用验收通过。[剩余验收项](docs/ACCEPTANCE_AUDIT.md)继续保留。

运行 `pnpm runner:desktop up` 后运行 `pnpm dev:workspace`，打开 http://127.0.0.1:5174/ 。该入口自动连接独立持久 PostgreSQL、v2 API、后台 worker 和实测 Docker runner；证据保存在 `.data/business-v2/evidence-v2`。原 5173 的 PGlite 预览及数据不受影响。

账号为 `teacher@codelab.local` 和 `student@codelab.local`。首次启动沿用私有 `.data/local-preview-password.txt` 中的开发口令；没有该文件时生成独立口令，保存在 `.data/business-v2/development-credentials.json`，不打印到日志。停止工作台保留数据库容器、持久卷和报告；再次运行同一命令恢复访问。当前仅开放已授权团队样本，执行包已扩展为五项核心要求、八个独立案例和人工可读性项。

2026-09-28 增量：八份样本（含两种内部结构不同的正确实现）已通过全案例预期核对及真实发布/读取，详见 [八案例真实记录](docs/verification/2026-09-28/desktop-v2-7cf528fb-402/results.json)。随后已接入受限 Agent 六工具、重新分析、独立补查与持久检查点，见 [T11 增量](docs/verification/2026-09-28/T11-reanalysis-progress.md)。没有真实模型配置时继续提供可发布的基础报告。下文 9 月 27 日四样本记录作为历史保留。

`pnpm exec tsx scripts/verify-workspace-ui.ts` 对此在线工作台执行真实 Chrome 教师/学生流程，创建明确标注的团队测试任务并保留提交、报告与截图。该检查会实际运行 `fixtures/correct.zip`，不同于下面的合成报告 E2E。

2026-10-18 增量：「课程作业」`/assignments` 已接入任务化版本提交。教师可拆分独立/连续任务和团队，学生用片段、文件/文件夹、ZIP、Gitee 或 GitHub 准备固定成果，再确认提交；可用个人模型私有自查，教师明确发起候选评阅并确认发布。提交不强制依赖模型。实现范围、迁移/回退和仍需真实账号验证的项目见 [任务化升级实施记录](docs/engineering/COURSEWORK_IMPLEMENTATION_2026-10-18.md)，自动化及恢复证据见 [本轮验证](docs/verification/2026-10-18/coursework/README.md)。

教师创建可预览学生任务说明或保存私有草稿，任务修订支持来源限制；列表显示各自进度和待交截止，时间输入统一按北京时间解释。报告引用可在桌面并排或手机弹窗读取固定源码行，查看旧自查不会替换待提交快照。课程 Chrome 4/4、同机列表/提交性能基线通过，最新全量测试 917 通过/33 跳过、PostgreSQL 专项 74/74、类型与构建通过。[静态报告语境校验](docs/verification/2026-10-18/coursework/REPORT_POLICY.md)另已修复明确非断言的误拦截，并完成空闲重载及师生只读复查。已进行 [10 次真实模型合成开发请求](docs/verification/2026-10-18/coursework/LIVE_MODEL.md)，8 份结构接受、2 拦截，发现语义问题，教学质量未通过；[AI 评测协议](eval/coursework-evaluation-protocol.md)继续保留，真实教师抽评和课堂试点未完成。

本机选定工作库已在备份恢复验证后升级到 schema 22，升级时原 35 张业务表内容不变；工作台已启动，可直接打开 [课程作业](http://127.0.0.1:5174/assignments)。既有师生账号的实际提交与人工发布流程已走通，零模型调用的原演示带 `[升级演示]` 标记；后续真实请求另建 `[合成评测]` 作业，未覆盖既有成果。

## 本地启动（PowerShell，无执行预览）

需要 Node.js 22.14+ 与 pnpm 11.21.0，推荐已验证的 Node 24.19.0。Windows工作台拒绝含已知网络缺陷的Node24.0—24.15；旧记录中的24.15属于历史环境。`pnpm workspace:runtime`检查实际选择，`dev:workspace`和守护入口共用项目运行时选择，不更改系统PATH。设置方法见[运行时选择](docs/REPRODUCE.md#工作台运行时选择)。

```powershell
pnpm install --frozen-lockfile
pnpm fixtures
pnpm exec tsx scripts/fixtures-independent.ts
$env:SEED_PASSWORD='自行设置至少12位的本地测试密码'
pnpm dev:local
```

打开 http://localhost:5173 。账号为 `teacher@codelab.local` 和 `student@codelab.local`，密码为刚设置的 `SEED_PASSWORD`。持久化本地开发数据位于 `.data/local-postgres`；重复启动不会重置账号密码。PGlite 仅供单进程本地开发和测试，正式部署使用 PostgreSQL。

学生可下载模板、上传 ZIP；收到执行未验收提示时，提交已保存，但不会运行。教师可配置任务和规则。本地启动不会伪造检查结果。`pnpm dev:local` 默认返回 `businessVersion=2`，因此 5173 直接进入 v2 工作台；执行仍需按下方 Docker Desktop 受控入口提供，不能把本地页面可用误认为执行环境已批准。需要临时查看旧版时设置 `$env:BUSINESS_API_VERSION='1'` 后再启动。

## Docker Desktop 受控开发执行（v2）

需要 Docker Desktop 的 `linux/amd64` daemon。当前范围是已经获准的团队构造样本；先完成以下镜像构建，再启动可信协调器。请从仓库根执行：

```powershell
docker build -f deploy/executor/Dockerfile.build -t codelab-build:v2-desktop .
docker build -f deploy/executor/Dockerfile.web -t codelab-web:v2-desktop .
docker build -f deploy/executor/Dockerfile.browser-v2 -t codelab-browser:v2-desktop .
docker build -f deploy/executor/Dockerfile.control -t codelab-control:v2-desktop .
pnpm runner:desktop up
pnpm runner:desktop status
```

协调器容器为 `codelab-desktop-control`，仅发布 `127.0.0.1:13200`，持久卷为 `codelab-desktop-runner-v2`。启动脚本按真实镜像 ID 运行，生成私有 `.data/desktop-runner/credentials.json`、实测记录 `measured-environment.json` 和 API/worker 共用的 `runtime-catalog.json`；令牌不会打印。控制容器内的 supervisor 分别启动 HTTP runner 与独立 `reaper-loop`，HTTP 进程退出不会同时终止回收进程。

确认状态为 `ready` 后，可用 `pnpm verify:desktop:v2` 对构造 ZIP 进行真实 HTTP、PostgreSQL、构建、浏览器、证据归档与恢复验证。脚本会建立自己的临时业务数据库，不使用 v1 预览库；结果按独立运行目录留存。镜像或控制代码更新后可用 `pnpm runner:desktop recreate`，它只允许重建处于 `ready` 的运行中协调器，并保留持久卷；繁忙或待清理时先处理状态。

2026-09-27 **20:03:50—20:04:34（Asia/Shanghai）** 的[真实开发执行记录](docs/verification/2026-09-27/desktop-v2-1d4413b7-474/results.json)已完成：`correct → passed`、`create-missing → failed`、`create-duplicate → failed`、`build-error → not_run / build_error`，归档 11 份证据。4 份报告均由示例教师账号通过真实 HTTP 修改、确认和发布，学生账号读取成功；每份报告还各下载 1 份公开证据核对大小和 SHA-256。这是构造样本的工程走查，没有真实教师参与评测。

同轮验证了原 operation 的一致响应重放、客户端收到后主动丢弃首份回复再查询恢复，以及短工作期限和 runner `SIGKILL` 后独立 reaper 清理恢复到 `ready`。浏览器使用 Playwright 1.58.2 的完整 Chromium（`channel: "chromium"`），实测版本 145.0.7632.6；可信空页测量确认固定页面 origin 的 secure context 与原生 `crypto.randomUUID()` 可用。完整镜像 ID、包哈希和恢复边界见 [部署说明](docs/DEPLOYMENT.md)。

验收脚本清理补强后，20:16:43—20:17:33 的[最终复验](docs/verification/2026-09-27/desktop-v2-b1e16939-cf5/results.json)再次通过相同四样本和两项恢复；[清理记录](docs/verification/2026-09-27/desktop-v2-b1e16939-cf5/cleanup.json)确认临时 API/数据库关闭、临时容器/网络按归属删除，overallState=passed。工程范围与下一步见 [实施与验证状态](docs/IMPLEMENTATION_STATUS.md)。

持续运行教师/学生 v2 工作台时，API 设置 `BUSINESS_API_VERSION=2`、`CODELAB_V2_RUNTIME_FILE`，worker 使用 `pnpm worker:v2` 并读取同一文件；两者的证据目录必须一致。完整配置见 [部署说明](docs/DEPLOYMENT.md)。`EXECUTION_APPROVED=true` 在本轮只开放已授权的开发样本入口，不是系统安全合格证明。不要在此 daemon 上启动历史 `pnpm runner` 或 v1 execution profile。

## 可复现验证

工作台数据离线备份与隔离恢复检查：停止工作台 API/worker 后执行 `node --import tsx scripts/verify-workspace-backup.ts`，随后重新运行 `pnpm dev:workspace`。不会覆盖原数据库；私有备份保留在 `.data/backups`，结果摘要写入验证目录。实际恢复范围和限制见 [T12 备份恢复记录](docs/verification/2026-09-28/T12-backup-recovery.md)。

```powershell
pnpm fixtures
pnpm exec tsx scripts/fixtures-independent.ts
pnpm typecheck
pnpm test
pnpm build
pnpm verify:services
pnpm exec playwright install chromium
pnpm test:e2e
pnpm test:e2e:v2
```

若下载浏览器不可用且安装了 Chrome，可用 `$env:PLAYWRIGHT_CHANNEL='chrome'` 运行界面测试。Desktop 执行镜像固定 Playwright 1.58.2 的完整 Chromium，本轮版本为 145.0.7632.6；宿主 Chrome 的界面回归不能替代该镜像的执行验证。两套界面测试各自启动独立内存数据库和测试服务，不复用本地预览或其持久数据。

| 入口                                  | API / 前端默认端口 | 可覆盖的环境变量                      | 结果目录             |
| ------------------------------------- | ------------------ | ------------------------------------- | -------------------- |
| `pnpm dev:local`，v1 开发预览         | 3100 / 5173        | `API_PORT`；前端配置另行保持一致      | 不生成浏览器测试结果 |
| `pnpm test:e2e`，历史 v1 交互回归     | 3310 / 5317        | `E2E_API_PORT` / `E2E_WEB_PORT`       | `test-results/v1`    |
| `pnpm test:e2e:v2`，v2 复核与发布交互 | 3311 / 5318        | `E2E_V2_API_PORT` / `E2E_V2_WEB_PORT` | `test-results/v2`    |

真实 PostgreSQL 验证另行运行，要求本机 Docker daemon 可用：

```powershell
pnpm test:postgres
```

该脚本创建独立的临时 PostgreSQL 17 容器、网络与随机本机端口，默认运行迁移、v2 生命周期、报告事务和 v2 worker 四个测试文件；2026-09-27 19:57:50 的回归分别 17、14、16、24 项，合计 71/71 通过，详见 [实施与验证状态](docs/IMPLEMENTATION_STATUS.md)。后续以各次实际输出为准。脚本结束时核对归属后清理本轮资源，不使用开发数据库，也不属于专用执行 VM 验收。普通 `pnpm test` 默认使用 PGlite；本轮为 282 通过、3 个 PostgreSQL 专属跳过，不能把跳过算成通过。

`build` 只构建网页。`verify:services` 另行验证 API/worker/runner 依赖加载与启动守卫，并在临时数据库和随机端口检查本地 API 的真实 HTTP 响应；它不代表 worker 取单或 Linux 执行通过。

使用外部 PostgreSQL 时，先在根 `.env` 配置 `DATABASE_URL`，再按需从仓库根运行 `pnpm db:migrate`、`pnpm db:seed`、`pnpm dev`。API 默认 3100，前端默认 5173。业务端与执行机分别使用各自的配置；`.env.example` 中的令牌是占位符，启动守卫会拒绝使用它。

`pnpm worker` 与 `pnpm runner` 保留为历史 v1 入口，不是当前 Desktop 验证命令。`pnpm runner:v2` 是 Linux HTTP runner 的底层入口，独立回收进程需另行管理；Desktop 统一使用 `runner:desktop` 提供的 supervisor。API 业务版本默认 1，未配置 `CODELAB_V2_RUNTIME_FILE` 时可信任务包目录仍为空，执行默认关闭。运行目录必须来自真实 `/v2/catalog` 和 `/v2/capabilities`，哈希或测量字段不一致时启动失败；只改业务版本或执行开关不能生成批准指纹。

`tests/e2e` 和 `tests/e2e-v2` 中的报告均为合成测试夹具；v2 明确标记 `ui_fixture`，仅验证复核、发布、权限等界面与 API 交互，不是项目执行证据。截图和失败 trace 分别保存在上表两个结果目录。

`pnpm fixtures` 生成 **7 份开发 ZIP**：`correct`、`filter-defect`、`build-error`、`create-missing`、`create-duplicate`、`filter-setup-blocked`、`fixed-with-regression`，并写入 [样本清单](fixtures/manifest.json)。它们属于同一模板衍生的 **1 个实现家族**；清单记录的预期结果不代表真实浏览器结论，也不能拆分成冻结评测集。具体范围见 [T02 契约与开发样本记录](docs/verification/2026-09-27/T02-contracts-samples.md)。

## 工程目录

| 路径                   | 责任                                                                 |
| ---------------------- | -------------------------------------------------------------------- |
| apps/web               | Vue 3 教师工作台、学生提交与报告                                     |
| apps/api               | Fastify、鉴权、版本、复核发布、持久队列、LangGraph Agent             |
| apps/runner            | v2 HTTP runner、实测环境、持久动作、精确资源回收；另保留历史 v1 入口 |
| packages/contracts     | Zod 工具、结果、反馈及复验契约                                       |
| templates/vue-board-v1 | 审核过的固定依赖和行为测试接口                                       |
| deploy/executor        | 构建/页面/浏览器镜像和受限探查                                       |
| tests                  | API、恶意输入、Agent 边界与浏览器回归                                |
| docs                   | 部署门槛、评价、实施状态与来源说明                                   |

采用 PostgreSQL SQL 迁移作为数据库结构的权威定义，Drizzle 映射用于类型化工具；业务查询当前使用参数化 SQL。运行结果按提交、规则和运行绑定；报告发布后不可改写。**真实模型接入排在 T08 基础可靠性之后**：T09 先验收一次性总结，T10 再接受控调查 Agent。旧代码中的 OpenAI-compatible `/chat/completions` 适配不代表 v2 模型链路已通过；无模型配置或模型失败时保留基础报告与教师发布路径。

## 开发与部署入口

- [工程启动蓝图 V1.0](output/知因CodeLab_工程启动蓝图_V1.0_2026-09-27.md)：首版范围、架构职责与现有实现差异。
- [四组关键契约](docs/engineering/CONTRACTS_V1.md)：数据、执行、证据、复核和状态规范；实现与验收进度另见状态记录。
- [实施顺序与框架验收](docs/engineering/IMPLEMENTATION_PLAN_V1.md)：T01—T12 开发任务与验收依据。
- [V3.0 综合参赛方案](output/知因CodeLab_最优参赛方案_V3.0_2026-09-27.md)
- [现有实现对应的产品基线](output/知因CodeLab-产品基线.md)
- [首周执行清单](output/首周执行清单.md)
- [实施与验证状态](docs/IMPLEMENTATION_STATUS.md)
- [部署及隔离验收](docs/DEPLOYMENT.md)
- [Runner v2 持久动作与独立回收说明](docs/engineering/RUNNER_DURABILITY_V2.md)
- [T03/T05 Runner 准备记录](docs/verification/2026-09-27/T03-runner-preparation.md)：2026-09-27 18:17 模块验证历史；当前接线与 Desktop 结果以新的带时间记录为准。
- [教师需求确认和对照评测](docs/EVALUATION.md)
- [开源来源与采用边界](THIRD_PARTY_NOTICES.md)

旧“编程实验诊断与陪练”方案已弃用。没有题库、自动修复、课程总分、抄袭检测或自动发布。原始学生代码、截图和日志不应放入公开演示或开源仓库。
