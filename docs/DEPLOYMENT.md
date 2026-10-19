# 部署与执行隔离验收

2026-09-29：[无网关执行网络](verification/2026-09-29/ISOLATED-NETWORK-DEPLOYMENT.md)已加载。v2基础执行与独立分析准备使用internal bridge的isolated网关模式、关闭IPv6，启动和每次网络创建后实际inspect校验，不支持时拒绝执行。当前实测Docker29.6.1；不对其他版本作未经验证的兼容承诺。环境指纹quota-v4i与旧quota-v3不同；升级须先确认空闲、更新runner及运行目录、再重载业务。此次11样本/发布/补查/回收复验不替代生产主机隔离与长期稳定性验收。

2026-09-29：[工作台运行时切换](verification/2026-09-29/WORKSPACE-RUNTIME-UPGRADE.md)已完成，守护与业务使用项目选定Node24.19.0，系统PATH不变。使用`pnpm workspace:runtime`核对，具体覆盖顺序见[复现说明](REPRODUCE.md#工作台运行时选择)。已有实例仍受3103独占保护；本次避开已知Windows网络缺陷，不等于历史退出根因已证实或生产稳定性已通过。

2026-09-29：[浏览器网络重定向修正](verification/2026-09-29/NETWORK-REDIRECT-ISOLATION.md)已加载开发执行器。允许项目源只读取单跳响应、拒绝3xx，防止Playwright后续重定向绕过路由校验；新镜像11样本实跑通过。固定静态文件服务器不需要HTTP重定向。检查器字节变更会更新任务包/实测指纹，旧规则与新环境不得混作同条件比较；部署时先确认任务空闲、更新runner运行目录，再重载业务工作台。原Windows原生退出问题仍待定位，不以本次维护判定已解决。

最新运维增量（2026-09-28）：运行 `pnpm storage:check` 检查项目历史资料和两个 CodeLab 持久卷的容量，结果保存到带日期的 verification 目录。告警阈值、退出码及保留策略见 [T12 容量说明](verification/2026-09-28/T12-storage-capacity.md)。只读检查不会删除历史数据或自动阻止提交。本文下方包含历史部署快照，最新业务/沙箱/产物配额状态以 [实施状态](IMPLEMENTATION_STATUS.md) 顶部为准。

随后容量准入已接入业务启动入口：`dev:workspace` 检查宿主资料和本机 PostgreSQL 卷，runner 检查执行卷；`apps/api/src/main.ts` 与 `worker:v2` 检查证据目录。低容量/未知时新任务返回 503 或暂不领取，清理、读取和幂等重放保留。通用部署的远程数据库磁盘及 Docker 虚拟磁盘后端仍需独立检查。这是余量预检，不是跨进程空间预留或全局硬配额。

**v2 API、worker、真实构建/浏览器 runner、持久操作查询、C2 心跳和独立回收进程已经接线，并完成一轮 Docker Desktop 团队构造样本的真实开发验证。** 本轮用户已停止博物馆容器并授权开发执行。业务执行默认关闭；T03 完整系统隔离门禁和 G1 尚未通过，下一步仍需 T07 筛选与复提验收，未开放真实学生运行。

`pnpm dev:local` 保留为历史 v1 本地预览。v2 Desktop 使用 `pnpm runner:desktop` 启动 Linux 协调器容器、`pnpm worker:v2` 启动业务 worker；不要在此 daemon 上启动历史 `pnpm runner`、`pnpm worker` 或 Compose 的 v1 execution profile。当前职责见 [Runner v2 持久动作与独立回收说明](engineering/RUNNER_DURABILITY_V2.md)；[18:17 的准备记录](verification/2026-09-27/T03-runner-preparation.md)保留当时尚未接线的历史状态。

## 本地验证入口

依赖版本、种子账号和本地预览步骤见 [README](../README.md)。在仓库根执行：

```powershell
pnpm fixtures
pnpm test:postgres
pnpm exec playwright install chromium
pnpm test:e2e
pnpm test:e2e:v2
```

`fixtures` 生成 7 份开发 ZIP 与 [manifest.json](../fixtures/manifest.json)：正确、筛选缺陷、构建错误、无法新增、重复新增、筛选准备受阻、修复伴随回归。它们属于 1 个开发实现家族；预期结果尚不是独立真值或真实浏览器结果，不能进入冻结评测集。

`test:postgres` 要求 Docker daemon 可用，使用临时 PostgreSQL 17 容器、独立网络、随机本机端口和 384 MiB 内存上限。默认验证迁移、v2 生命周期、报告事务和 v2 worker 四文件；2026-09-27 19:57:50 的回归为 17 + 14 + 16 + 24 项，即 71/71 通过，详见 [实施与验证状态](IMPLEMENTATION_STATUS.md)。后续各次结果按实际输出登记。脚本只清理经归属检查的本轮临时资源；该数据库验证不代表学生代码执行或专用 Linux 隔离通过。

| 浏览器回归入口                  | API / 前端端口 | 端口环境变量                          | 截图与失败 trace  |
| ------------------------------- | -------------- | ------------------------------------- | ----------------- |
| `pnpm test:e2e`，历史 v1        | 3310 / 5317    | `E2E_API_PORT` / `E2E_WEB_PORT`       | `test-results/v1` |
| `pnpm test:e2e:v2`，v2 复核发布 | 3311 / 5318    | `E2E_V2_API_PORT` / `E2E_V2_WEB_PORT` | `test-results/v2` |

两套测试各自启动独立内存数据库，不使用 `.data/local-postgres`。报告和证据是合成交互夹具，v2 来源标记为 `ui_fixture`，不是实际执行结果。若已安装 Chrome，可设置 `$env:PLAYWRIGHT_CHANNEL='chrome'` 做界面回归；不能据此宣称执行机固定 Chromium 的兼容性已验证。

## 业务端（历史 v1 部署步骤）

先安装 Linux Docker Engine + Compose。仓库根执行：

```sh
cp deploy/.env.example deploy/.env
# 修改数据库密码、种子密码、Origin；不要提交 .env
docker compose --env-file deploy/.env -f deploy/compose.yaml up --build -d db init api web
```

打开 `http://localhost:8080`。首次 init 执行 SQL 迁移与示例初始化；已有用户不重置。默认只绑定本机 8080，公网部署需 HTTPS 反向代理、真实 APP_ORIGIN 与 COOKIE_SECURE=true。不同域/端口的 Origin 会被拒绝。数据库不发布宿主端口；截图卷仅通过有权限的 API 读取。备份 PostgreSQL 与 evidence 卷必须同批次记录，并做恢复演练。用户数据删除还需经授权维护流程：不可直接绕过不可变触发器。

当前 Compose 未透传 `BUSINESS_API_VERSION` 和 `CODELAB_V2_RUNTIME_FILE`，业务默认 v1；仅在 `deploy/.env` 中增加变量不会完成 v2 切换，execution profile 也仍指向旧 worker。下方 v2 路径直接使用宿主 Node 业务进程和 Desktop Linux 协调器。API 的可信包注册表在没有运行目录文件时保持为空，执行默认关闭；生产 Compose 接线需另外设计并验证。

业务与 runner 通过受限私网或加密隧道通信。Runner 令牌不应发送到公网明文 HTTP；只允许业务服务器源地址访问其端口。Runner VM 不部署数据库、不放模型密钥、不运行其他用户业务。

## Docker Desktop 协调器（v2，团队样本开发验证）

需要可连接的 `linux/amd64` Docker daemon、Node.js 22.14+ 和 pnpm 11.21.0。本轮已经允许使用当前 Desktop；系统级安全验收继续单独记录。管理员镜像构建阶段可访问软件源，学生项目构建阶段使用固定离线依赖。

从仓库根执行：

```powershell
pnpm install --frozen-lockfile
pnpm fixtures
docker build -f deploy/executor/Dockerfile.build -t codelab-build:v2-desktop .
docker build -f deploy/executor/Dockerfile.web -t codelab-web:v2-desktop .
docker build -f deploy/executor/Dockerfile.browser-v2 -t codelab-browser:v2-desktop .
docker build -f deploy/executor/Dockerfile.control -t codelab-control:v2-desktop .
pnpm runner:desktop up
pnpm runner:desktop status
```

| 项目             | 实际配置与用途                                                                                       |
| ---------------- | ---------------------------------------------------------------------------------------------------- |
| 协调器           | `codelab-desktop-control`，可信 Linux 控制容器；发布 `127.0.0.1:13200 -> 3200`                       |
| 控制持久卷       | `codelab-desktop-runner-v2`，容器内 `/var/lib/codelab-runner`；保存 owner、操作、响应及临时工作目录  |
| 控制容器限制     | 768 MiB 内存、1 CPU、128 PIDs；它持有 Docker socket 管理权限，不是执行学生代码的容器                 |
| 构建/页面/浏览器 | 按真实不可变 image ID 创建，分别限制资源；子容器不获得 Docker socket、控制令牌、数据库密码或模型密钥 |
| 页面             | 内部网络别名 `project`、固定 `http://project:8080`，不向宿主发布学生页面端口                         |
| 私有配置目录     | `.data/desktop-runner/`，已被 Git 忽略；不要将凭据加入日志、报告或公开仓库                           |

脚本只复用具有 `codelab.desktop-control=v2` 标签的控制容器与卷；同名但不属本项目的资源会导致启动失败。启动时检查四个镜像的实际 ID，并从运行中的镜像测量模板、锁文件、检查器源码哈希、浏览器版本及环境策略。`status` 只读取状态。执行样本前必须看到 `ready`；`busy`、`cleanup_pending` 或 `unavailable` 均不能当作就绪。

代码或镜像更新后，执行 `pnpm runner:desktop recreate`。对于运行中的协调器，脚本要求它先处于 `ready`，再按已验证的精确容器 ID 停止并重建；持久卷保留。不得用删除卷或清空 journal 的方式跳过尚未处理的 owner。`pnpm runner:v2` 仅是 Linux HTTP 服务底层命令，不会自动附带回收进程；Desktop 使用控制容器内的 supervisor，同时维护 HTTP runner 和独立 `reaper-loop`。

若状态包含 `unconfirmed-create:...`，表示一次 Docker 创建已发出，但其不可变 ID 尚未得到确认。Node 进程退出或当前列表为空都不能证明 daemon 不会迟到创建资源；系统会保留 `cleanup_pending` 和工作目录，拒绝新执行。reaper 只有观察到完整标签匹配的资源并先持久保存 ID，或收到原创建的可信迟到 ID 后，才可按精确 ID 完成清理。长期无法确认时需要管理员检查本 owner 的 journal、操作身份与 Docker 日志，不能通过清卷或凭时间猜测自动解锁。详细流程见 [持久创建与回收屏障](engineering/RUNNER_DURABILITY_V2.md#回收与关闭)。

启动脚本生成三个文件：

- `credentials.json`：独立随机令牌和 loopback URL；令牌不打印。它的存在不代表其他系统门禁已通过。
- `measured-environment.json`：测量时间、镜像 ID、真实 capabilities 与任务包目录，供开发证据核对。
- `runtime-catalog.json`：API 与 worker 共用的可信启动输入，精确格式为 `{ "packs": [TaskPackManifest], "actualEnvironment": MeasuredEnvironment }`。它来自 `/v2/catalog` 与 `/v2/capabilities`，不是手工填造环境观测值。

运行目录验证所有任务包内容哈希；`actualEnvironment` 必须是 `partial`，且仅缺 `ruleHash` 和 `parametersHash`。它的包哈希、模板哈希、依赖锁哈希、初始化版本和聚合版本必须与登记包一致。API 先验证用户可访问该提交，再读取提交保存的不可变规则快照，补齐这两个规则哈希并写入运行记录。客户端不能提供批准指纹。单个实测环境只批准其对应包，目录中的其他包不会自动共享批准。

## API 与 worker 共用可信运行目录

先在私有根 `.env` 配置一个独立 PostgreSQL 业务库的 `DATABASE_URL`、至少 12 位的 `SEED_PASSWORD` 与正确 `APP_ORIGIN`。v2 worker 使用独立业务进程，不连接 `dev:local` 的 PGlite 数据目录。停止占用 3100/5173 的 v1 预览后，从仓库根在两个 PowerShell 终端分别执行以下相同配置；不要打印 `$runnerCredential`：

```powershell
$codelabRoot = (Get-Location).Path
$runnerCredential = Get-Content -LiteralPath '.data/desktop-runner/credentials.json' -Raw | ConvertFrom-Json
$env:RUNNER_URL = $runnerCredential.url
$env:RUNNER_TOKEN = $runnerCredential.token
$env:BUSINESS_API_VERSION = '2'
$env:CODELAB_V2_RUNTIME_FILE = Join-Path $codelabRoot '.data/desktop-runner/runtime-catalog.json'
$env:DATA_DIR = Join-Path $codelabRoot '.data/business-v2'
$env:ARTIFACT_ROOT = Join-Path $env:DATA_DIR 'evidence-v2'
$env:EXECUTION_APPROVED = 'true'
```

这里的 `EXECUTION_APPROVED=true` 只用于已授权团队样本开发运行；默认值仍为 false。API 与 worker 必须读取相同 runtime 文件，不能使用一份批准值冒充另一环境的实测值。`DATA_DIR/evidence-v2` 和 worker 的 `ARTIFACT_ROOT` 必须指向同一个绝对路径，否则 API 无法读取 worker 已归档的证据。它是业务证据存储，和 runner 的临时工作卷分开。

终端 A 初始化数据库并启动 API/前端：

```powershell
pnpm db:migrate
pnpm db:seed
pnpm dev
```

终端 B 启动 v2 worker：

```powershell
pnpm worker:v2
```

未提供运行目录时 API 的包目录保持为空；指定文件无效时启动失败，不回退到假指纹或默认环境。worker 对当前规则计算的批准值必须与 API 在入队时保存的值完全一致，缺失或不匹配时不向 runner 分派学生代码。重复幂等请求复用运行中已经保存的批准值，不借重放改写环境身份。更换镜像或运行目录后，旧规则/运行不保证还能执行，需要显式处理版本匹配，不能静默补造观测。

worker 仍兼容旧 `WORKER_V2_FINGERPRINT_FILE`，仅在没有设置 `CODELAB_V2_RUNTIME_FILE` 时使用；同时设置时以 runtime 为准，runtime 无效不会退回旧文件。当前 Desktop 配置统一使用上述 runtime 路径。

worker 的数据库心跳成功后才向 runner 续租，约 10 秒独立调度，租约最多 30 秒；长 execute HTTP 请求与心跳独立运行。请求丢失后查询原 operation，不重新执行学生代码。worker 先验证真实响应与证据字节、归档到 `ARTIFACT_ROOT`，再封存基础结果、创建无模型报告草稿和请求资源回收。当前不配置或调用真实模型；模型工作仍排在 T08 基础可靠性之后，T09 先验证一次性总结，T10 再引入受控调查 Agent。

## 受控真实执行验证与后续部署

在 `runner:desktop status` 显示 `ready` 后，可运行：

```powershell
pnpm verify:desktop:v2
```

脚本创建本轮专用临时 PostgreSQL 容器与网络，通过真实 API、worker 和 runner 跑构造样本，并检查回复丢弃后的查询、资源回收及进程退出恢复。业务证据写到 `.data/desktop-verification/<run-id>/`，摘要与故障信息写到 `docs/verification/2026-09-27/desktop-v2-<run-id>/`。脚本按精确 ID 和本轮标签清理自己的临时数据库资源，不使用 v1 预览库。

2026-09-27 **20:03:50—20:04:34（Asia/Shanghai）** 运行已完成，来源为 `constructed_execution`，原始结果见 [desktop-v2-1d4413b7-474/results.json](verification/2026-09-27/desktop-v2-1d4413b7-474/results.json)。本轮为 1 个实现家族中的 4 份构造 ZIP，结果如下：

| 样本 | NEW-01 结论 | 执行分类 | 实际步骤数 | 归档证据数 |
| --- | --- | --- | --- | --- |
| `correct` | `passed` | `complete` | 4 | 3 |
| `create-missing` | `failed` | `complete` | 4 | 3 |
| `create-duplicate` | `failed` | `complete` | 4 | 3 |
| `build-error` | `not_run` | `build_error` | 0 | 2 |

总计 11 份证据。4 份由真实执行产生的报告均完成真实 HTTP 修改、确认、发布和学生读取；未发布草稿对学生返回 404，发布后读取返回 200。每报告下载 1 份公开证据并核对实际字节数与 SHA-256，共 4 份。这里使用脚本生成的教师/学生账号，人工可读性条目保留待判断状态，没有真实教师参与评测；这些工程验证不等于 T07 全部验收。

每个样本的 worker 只分派一次 execute，同一 operation 的重放响应一致。`correct` 的首份回复在客户端已经收到后被主动丢弃，worker 查询原 operation 恢复；这是明确的故障注入，未声称真实网络断线已验收。另两项恢复验证分别设置 1.2 秒工作期限/10 秒租约，以及对 HTTP runner 执行 `SIGKILL`：旧 operation 保持 `unknown`、没有接纳迟到基础结果，回收回执均为 `clean`，最终 runner 为 `ready`。重启前后 reaper PID 都是 14，runner PID 从 15 变为 2448，证明这一轮回收进程独立于 HTTP 进程存活。

本轮登记包为 `vue-board-dev-new@desktop-new01-v1`，仅包含 NEW-01 自动检查和人工可读性条目；包内容哈希为 `f38c5b71eb1e490ff1fd3cb0652dbf53eea453d571edfc50ebdb3aba7f50e5ae`。实际镜像身份如下，均是本机 image ID，不能把 tag 或后续重建结果当作同一镜像：

| 角色 | 本轮实际 image ID |
| --- | --- |
| build | `sha256:0205f25f2dff71bc55279c26d618c7dab2cbe0dbbfa319a2d2addb886ebef2c2` |
| web | `sha256:d881473f176b851fa7e8fc097ec1872605356fa92d3455c97212a158b4fbdfb8` |
| browser | `sha256:fba734f6486e484850d1f838b66b92273aa36364d7d51abe3093cd9f8c716f83` |
| control | `sha256:2875950ea8f7558ebca8c98fb572959533cf37a7cbe813b55eef7a2a887099e4` |

浏览器为 Playwright 1.58.2 的完整 Chromium，启动参数使用 `channel: "chromium"`，实测版本 145.0.7632.6、视口 1200×800/1、`zh-CN`、`Asia/Shanghai`。启动测量在固定 `http://project:8080` origin 上由路由直接提供可信空页，不加载学生页面或外网；实际验证 `isSecureContext` 为 true，且原生 `crypto.randomUUID()` 产生两个不同的有效 v4 UUID。该检查绑定已登记页面策略，不用学生代码或自定义 UUID 替代浏览器观测。

Desktop 控制容器与学生子容器已经分离，但仍共用一个 Docker daemon；可信控制容器持有 socket，浏览器还使用 `--no-sandbox`。当前环境可推进获准的开发工作，尚不足以开放任意学生代码。T03 仍需验证宿主防火墙、浏览器沙箱、输出目录配额、资源攻击和干净环境复现等系统条件；G1 还需 T07 筛选与复提验收。

后续生产候选 Linux 环境需登记受维护内核、Docker、受限私网与真实镜像/浏览器身份。独立回收可使用提供的 systemd service/timer；模板目前没有在目标生产环境安装验收，不能把 Desktop supervisor 验证等同于 systemd 部署完成。网络、磁盘留存与进程恢复的约束见下表以及 [Runner 持久化说明](engineering/RUNNER_DURABILITY_V2.md)。

## 尚未整体通过的系统与产品门禁

2026-09-27 20:16:43—20:17:33，验收脚本补强异常清理和限额断言后完成[最终复验](verification/2026-09-27/desktop-v2-b1e16939-cf5/results.json)。[cleanup.json](verification/2026-09-27/desktop-v2-b1e16939-cf5/cleanup.json)保存逐项清理结果；脚本只有在业务验证与临时资源清理均通过后才输出成功。它仍只检查该次随机标记的资源，不清理其他项目。上述首次验收记录与镜像身份保留不变。

记录执行日期、系统/内核、Docker 版本、四个镜像 ID、测试提交哈希、命令、退出状态、日志、截图和检查人。表中项目仍需按各自证据单独判定；不能用某个开发样本成功替代整表验收。

| 检查                                                           | 预期                                                                                                                              |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 已登记开发 ZIP 与版本化案例                                    | 历史 v1 的 7 项条目不当作 v2 的 8 个自动案例；v2 按当前任务包启用案例逐项留证，明确失败、前置受阻与构建错误，不把开发预期冒充实测 |
| 空白页、控制台异常、多缺陷                                     | 有可阅读日志/页面证据，不能只返回模型文字                                                                                         |
| src 无限构建、超大日志、内存耗尽、输出目录配额                 | 限时/限量终止，磁盘写入也有实际边界，分类清楚、无残留容器；当前输出卷硬配额尚未验收                                               |
| 公网、DNS、宿主网关、云元数据、IPv6、重定向、WebSocket、WebRTC | 学生代码与浏览器均不能访问禁止目的地                                                                                              |
| 两次提交互读、浏览器容器读教师脚本、越界目录                   | 不泄漏前次数据；教师测试不暴露给项目页面                                                                                          |
| runner/worker 中途重启、超时、重复探查                         | 清理临时资源、租约恢复、晚到写入被拒绝                                                                                            |
| 页面/源码诱导越权、伪造引用                                    | 工具权限不扩大、不发布、不改基础结论                                                                                              |
| SSE断连与刷新、重复请求、旧草稿发布                            | 状态与持久结果一致                                                                                                                |
| 干净环境复现、控制器与回收器分别退出                           | 用记录的依赖和镜像可重复部署；真实进程屏障、持久卷恢复与精确回收有效                                                              |

`docker network --internal` 和浏览器 route 拦截不能单独证明宿主网关不可达。必须配置并验证 VM 防火墙 INPUT/转发/IPv6 策略：提交网络只允许本网络页面端口、拒绝宿主及其他网段；禁止不可信容器外联，禁止提交网络进入 runner 管理端口。防火墙接口、网段依实际 VM 确定，不提供未经本机验证的宽泛自动规则。

浏览器当前以容器外层隔离并传入 --no-sandbox；这是需要评估的剩余风险。正式接收学生提交前要验证 seccomp、内核补丁、资源限制与攻击用例，必要时加固浏览器沙箱或改用更强隔离运行时。不能只看到 Dockerfile 就宣称安全。

历史初版记录：当时本机 Docker daemon 不可用，因此本文命令与配置已编写，但 Linux 容器执行和网络门禁尚未实测。该段保留历史验收边界，当前环境以带日期的补充记录为准。

## 2026-09-27 环境复核补充

2026-09-27 约 17:13—17:20 的只读复核确认 Docker Desktop 4.81.0 / Engine 29.6.1 的 Linux daemon 已可连接，运行在 WSL2 后端。当时唯一 WSL 发行版为 docker-desktop，同一 daemon 正承载博物馆容器；没有发现项目专用 Linux VM 或已配置的远端 runner 入口。检查时三个 CodeLab 执行镜像尚不存在，本机 3200 端口未监听，系统隔离与独立回收门禁尚未实测。这是带时间的环境快照，不替代后续部署前复核。

2026-09-27 18:17:52 的模块测试随后验证了持久动作与回收逻辑，当时仍使用模拟 Docker，HTTP/worker 接线尚未完成。这两段属于历史快照，不能继续作为当前代码或授权状态的描述。

本轮后续已获用户授权：博物馆容器由用户停止，CodeLab 使用当前 Docker Desktop 构建独立 Linux 协调器，于 20:03:50—20:04:34 完成上述团队样本开发验证。当前开发验证已有实际执行与恢复证据；T03 完整系统门禁、G1 和真实学生开放范围仍保持未通过，下一步为 T07。新的带时间结果不覆盖旧记录。历史证据见 [T03 环境核实记录](verification/2026-09-27/T03-environment.md) 和 [T03/T05 准备记录](verification/2026-09-27/T03-runner-preparation.md)。
