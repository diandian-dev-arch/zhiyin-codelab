# Runner v2 持久动作、执行接线与独立回收

v2 已接入真实 HTTP runner、业务 worker、固定 NEW-01 浏览器检查器、持久操作查询和独立心跳，并于 2026-09-27 20:03:50—20:04:34（Asia/Shanghai）完成一轮获准的 Docker Desktop 团队样本开发验证。原始证据见 [results.json](../verification/2026-09-27/desktop-v2-1d4413b7-474/results.json)。博物馆容器已由用户停止；`server.ts` 和 `worker.ts` 保留为历史 v1 入口，不用于当前 Desktop 流程。T03 完整系统隔离与 G1 尚未通过，下一步仍是 T07 筛选与复提验收。

2026-09-27 18:17:52 的 15 项模块测试使用临时目录、模拟 Docker 与真实子进程退出，当时 HTTP/worker 尚未接线；该记录作为历史保留。现在的接线进展不能反向改变当时的证据性质，也不自动完成 T03 系统隔离或 G1；G1 还需要 T07 筛选与复提验收。

## 文件与职责

| 文件                                                                | 职责                                                                             |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `apps/runner/src/durable-store.ts`                                  | 单 owner 接纳、操作身份、唯一 dispatch、结果摘要与响应、资源意图、期限和回收凭证 |
| `apps/runner/src/app-v2.ts` / `server-v2.ts`                        | 受信 HTTP 入口、认证、状态查询、心跳、操作分派与启动守卫                         |
| `apps/runner/src/environment-v2.ts`                                 | 测量真实镜像、模板、锁文件、检查器与浏览器环境，发布可信任务包目录               |
| `apps/runner/src/engine-v2.ts`                                      | 按既定资源计划进行真实构建、静态页面与 NEW-01 浏览器检查，构造有证据的基础响应   |
| `apps/runner/src/resource-reaper.ts`                                | 只读资源就绪检查、所有权撤销、已登记资源精确清理和再次观察                       |
| `apps/runner/src/docker-resources.ts`                               | 受限 Docker CLI 适配器，连接可信 Linux 控制容器内的本机 socket；按精确 ID 操作   |
| `apps/runner/src/reaper-cli.ts`                                     | 可独立于 HTTP runner 运行的一次回收入口                                          |
| `apps/runner/src/reaper-loop.ts` / `deploy/executor/supervisor.mjs` | Desktop 中独立回收进程与 HTTP 进程的监督、重启                                   |
| `apps/api/src/worker-v2.ts` / `runner-client-v2.ts`                 | 数据库取单、独立心跳、原 operation 查询、证据归档、基础报告及回收回执处理        |
| `apps/api/src/runtime-catalog-v2.ts`                                | 校验可信运行目录，并从保存的规则快照生成批准指纹；不把批准值当作环境实测         |
| `scripts/desktop-runner.ts`                                         | 创建/复用受控 Linux 协调器与持久卷，导出私有凭据和实测运行目录                   |
| `deploy/executor/codelab-reaper.service` / `.timer`                 | 后续 Linux 主机的系统服务模板；不是 Desktop 当前使用的进程入口，目标部署尚未验收 |
| `tests/runner-durability.test.ts`                                   | 并发、崩溃、重放、未知结果、残留和路径边界验证                                   |

## 当前 Desktop 运行边界

`pnpm runner:desktop up` 启动 `codelab-desktop-control`，发布 `127.0.0.1:13200`，挂载 `codelab-desktop-runner-v2` 到 `/var/lib/codelab-runner`。可信控制容器持有 Docker socket，构建、页面和浏览器子容器仅得到本 owner 所需的 volume 子目录；journal、持久响应、上级工作目录与控制凭据不挂载给子容器。

控制镜像的 supervisor 分别启动 `server-v2.ts` 与 `reaper-loop.ts`。HTTP runner 进程退出时，回收进程仍可观察旧生产者退出并处理到期 owner；supervisor 会重启退出的子进程。两者仍在同一个控制容器里，整个容器停止时两者都会停止；持久卷保留记录，恢复后重新检查实际资源，不凭空宣告 clean。这个进程分离不等同于主机隔离，也不是 systemd 安装验收。

`pnpm runner:desktop status` 只读取当前能力状态；只有 `ready` 才允许新执行。`recreate` 对运行中的协调器先要求 `ready`，再按确认过归属的精确容器 ID 重建，保留卷。未知资源、损坏元数据或仍活动的 owner 应使就绪检查失败，不能删除卷跳过恢复。四个镜像构建及 API/worker 的完整命令见 [部署说明](../DEPLOYMENT.md)。

本轮实测包为 `vue-board-dev-new@desktop-new01-v1`，内容哈希 `f38c5b71eb1e490ff1fd3cb0652dbf53eea453d571edfc50ebdb3aba7f50e5ae`。Playwright 1.58.2 通过 `channel: "chromium"` 启动完整 Chromium 145.0.7632.6；启动测量在路由直接提供的可信空页上确认固定 origin 的 secure context 和原生随机 UUID 能力，再允许 NEW-01 执行。四个真实镜像 ID 在结果文件和部署说明中完整登记，批准指纹不能替代这些实际观测。

## 2026-09-27 20:03 实测覆盖

`correct`、`create-missing`、`create-duplicate` 分别得到 `passed`、`failed`、`failed`，各记录全部 4 个真实步骤；`build-error` 得到 `not_run` 和 `build_error`，步骤数为 0。共归档 11 份证据，4 份基础报告完成示例教师账号的真实 HTTP 修改/确认/发布和学生读取，各报告下载 1 份公开证据核对大小与哈希。账号由脚本生成，人工可读性条目保持待判断，没有真实教师评阅或模型参与。

每个样本的 worker 仅分派一次 execute，同一 operation 的响应重放一致。首个样本在客户端已收到回复后主动丢弃，再查询原 operation 恢复；该结果只证明这一故障注入下的恢复行为，真实网络中断仍需另验。

恢复验证包括 1.2 秒工作期限/10 秒租约，以及 HTTP runner `SIGKILL`。两者原 operation 均保留 `unknown` 且无基础响应，最终 cleanup 为 `clean`、capabilities 恢复 `ready`。SIGKILL 前后 reaper PID 均为 14，runner 从 PID 15 重启为 2448，且原运行资源消失、旧动作没有重新 dispatch。它证明了本轮 Docker Desktop 中 HTTP 进程退出后的独立回收，不代表整个控制容器/daemon 退出、回收进程本身崩溃、所有迟到 Docker 请求或生产 systemd 行为都已经实测。

## 执行顺序

20:16:43—20:17:33 的[最终复验](../verification/2026-09-27/desktop-v2-b1e16939-cf5/results.json)保持上述四样本和两项恢复结论，runner PID 2448 → 5789，reaper 仍为 14；新增[验收脚本清理凭证](../verification/2026-09-27/desktop-v2-b1e16939-cf5/cleanup.json)。此次只补强测试脚本的临时资源清理和配置断言，执行器镜像未变。

1. 由可信服务验证 C2 请求、请求哈希、源码、包及实际镜像。`DurableRunnerStore.open()` 只接受专用、绝对、无符号链接的规范化本地根目录。不要把仓库根、用户主目录或卷根作为目标。
2. 接单前调用 `inspectReadiness(store, docker)`；只有 `ready` 可以开始新 owner。它同时读取落盘记录、实际 Docker 资源及工作目录。未知旧资源只报告并阻止接单，不根据一个通用标签直接删除。
3. `registerOwner({owner,startedAt,workDeadlineAt,hardDeadlineAt,leaseUntil,remainingWorkMs})` 原子登记一位资源所有者。`owner={runId,ownerKind:'execution'|'analysis',ownerId,ownerToken}`。执行 owner 上限 300 秒、独立分析 90 秒，预留至少 30 秒回收；重复登记不刷新旧期限。初始分析复用 execution owner，不另注册 analysis owner。
4. `reserveOperation(owner,{operationId,requestHash,kind})` 返回 `{created,operation}`。重放只读取既有状态；不同载荷冲突。每个 owner 的 execute、prepare_probe、probe 各至多一项，避免对 unknown 自动换 ID 重跑。
5. `beginOperation(owner,operationId)` 返回 `{started,dispatchToken,operation}`。**只有 started=true 的调用可以发出外部动作。** 接受后但尚未 dispatch 的动作也不能由查询接口执行；恢复只结束和回收，不重新启动学生代码。
6. 持有 dispatchToken 后调用 `ensureWorkspace(owner,operationId,dispatchToken)`。任何 Docker 创建之前先调用 `planResource(...)`，使用返回的精确名称与完整 labels；容器角色为 build/web/check/probe，网络角色为 network。真正发送一次 create 前再调用 `markResourceCreateStarted(...)`，持久登记 `creationStartedAt`；同一资源不能重复获得 create 许可。拿到 Docker 的不可变 ID 后调用 `recordResourceCreated(...)` 保存 `createdResourceId`。不得自行接受容器名称、宿主目录、标签或任意命令参数。
7. 外部调用确实结束后调用 `finishOperation(owner,operationId,dispatchToken,outcome,result?)`。即使结果已失租，函数也记录 Node 生产者已结束，但拒绝接纳迟到结果；它不会消除已发出却未确认的 Docker 创建请求。不要在调用仍悬挂时提前结束动作。成功结果必须提供响应，最大 16 MiB，按 SHA-256 持久保存。
8. `queryOperation(owner,operationId)` 只读持久状态和校验后的原响应；不执行、续租、重启或分配新 dispatch。未知结果继续是 unknown，并撤销该 owner 的后续工作资格。unknown 不自动表示生产者已停止：仍保留进程屏障，直到真实迟到完成证明调用已结束，或独立回收器观察到生产者进程已消失。进程屏障解除后，未确认创建的持久屏障仍需单独处理，不能因 CLI/Node 退出推断 Docker daemon 不会迟到创建资源。
9. 心跳通过 `heartbeat(owner,leaseUntil)` 续租，单次租约最多当前时刻后 30 秒，不能改变绝对工作/硬期限。HTTP 请求和长时间 Docker 调用不能阻塞心跳。

心跳已经通过共享 C2 契约和 `/v2/heartbeat` 接线：worker 每约 10 秒独立发起业务数据库 heartbeat，仅在事务成功后向受信 runner 发送完整 owner 身份与数据库确认的 leaseUntil；数据库 heartbeat 失败时停止 runner 续租。runner 校验 token、owner 尚未撤销、旧 lease 尚未到期、新 lease 不超过当前时刻后 30 秒和 hardDeadline。新 owner 的接受请求携带初始有效 leaseUntil/startedAt，并绑定工作预算。长 execute 请求与心跳独立调度；`/v2/operations/query` 和动作重放都不续租。跨主机时钟偏差仍需在目标部署环境验证，不能从本地连接成功推导为通过。

API 与 worker 从同一 `CODELAB_V2_RUNTIME_FILE` 读取 `{packs,actualEnvironment}`。只有真实 runner 所测运行字段才进入批准环境；启动测量仅缺少规则与参数两个哈希，由不可变 RuleSnapshot 补齐。API 在用户授权通过后解析提交保存的 rule_id，不采用任务最新规则或客户端提供的指纹。worker 在分派前比较当前批准值与入队记录，任何缺失或不一致都停止执行；runner 再独立比较请求批准值与自己观测的环境。没有配置仍保持空包目录/默认执行关闭，无效配置拒绝启动，不自动回退。

当前只执行任务包登记的 NEW-01 自动检查及人工条目，保持无模型模式。响应丢失后 worker 查询原 operation；即使查询暂时未找到，也不自动用新 ID 重跑。真实证据必须校验字节哈希、大小和归属，先归档到业务 `ARTIFACT_ROOT` 再封存数据库基础结果，创建无模型复核草稿，然后发起回收。API 的 `DATA_DIR/evidence-v2` 必须和 worker 的 `ARTIFACT_ROOT` 是同一个目录。

HTTP 错误转换应区分权限、状态冲突与基础设施错误。`RunnerStoreError` 带 `code/statusCode`；共享契约的载荷冲突也必须映射为 409。不要把协议问题转换成学生功能失败。`inspect()` 包含内部资源/进程元数据，仅供可信 runner 与回收器，不直接作为浏览器接口。

## 回收与关闭

显式回收先 `reserveOperation(owner,{kind:'cleanup',operationId,requestHash})`，这会撤销工作资格；再调用 `reapOwner(store,docker,owner)`。不对 cleanup 调用 `beginOperation` 或普通 `finishOperation`。资源有残留时 cleanup 操作保留 running，owner 保留 cleanup_pending；实测资源全部不存在后，它变成 completed，查询返回符合 C2 的不可变回收响应。相同动作重放返回同一已完成凭证。

独立入口调用 `reapExpired()`，只处理过期或已请求清理的 owner。回收器逐项核对 run/owner/operation/requestHash/deadline/store 标签，按 Docker 不可变 ID 删除，再次检查容器、网络和工作目录。没有元数据、标签不完整、同名资源属于其他 owner、daemon 不可用、目录为符号链接等情况均保持阻塞。

回收器还检查曾发出外部动作的宿主进程。Linux 使用 boot ID 和 `/proc/<pid>/stat` 启动时刻识别进程，避免 PID 复用误判；进程状态不明时按仍存活处理。旧生产者仍可发出外部动作时，即便当前容器看起来已消失，也不能签发 clean。Windows 只用于保守的开发测试，不替代此 Linux 行为验收。

每个已发出 create 的资源还有独立持久屏障：`creationStartedAt` 已有值但 `createdResourceId` 为空时，就绪检查和回收凭证保留 `unconfirmed-create:<container|network>:<精确名称>`，owner 维持 `cleanup_pending`。即使原 Node 生产者死亡、当前看不到该名称、服务多次重启或已经过了很久，都不能据此签发 clean，也不能删除对应工作目录；Docker daemon 可能仍在处理先前收到的请求。

消除此不确定性的正常路径有两种：原 CLI 的迟到响应携带不可变 ID，保存该事实但不恢复 owner 工作资格；或者 reaper 后来观察到匹配资源，逐项核对 kind、name、store、run、owner、operation、requestHash、deadline 和角色标签，通过 `recordObservedResourceCreated(...)` 先持久记录 ID，再重新按该 ID 检查、删除并确认不存在。确认先于删除，避免 reaper 在删除之后崩溃而永远丢失创建事实。标签不匹配的同名资源不能用来解除屏障，也不会被误删。

始终没有可信创建确认时，会保守阻塞。管理员需要保留 journal、请求身份和 Docker 日志，定向排查原请求与精确资源；不能把超时、进程退出或几次空列表当作“从未创建”的证明。当前没有自动猜测超时后放行的路径，也不应手改 journal、清卷、换 operation ID 或重新执行学生代码来绕过这个状态。

`recordCleanup()` 是回收器内部写接口，其 `stoppedOperationIds` 必须来自真实进程观察，不提供给 HTTP 用户或模型。只有回执 clean 且业务端核验 owner 身份后，业务数据库才可以关闭 owner。Run 基础检查完成本身不会释放资源槽位。

Desktop 的 `reaper-loop` 在独立进程中循环，完成一轮后约 2 秒再次检查；HTTP 服务失败不会自行终止它。默认每次回收 Docker 动作预算 25 秒，再以 5 秒预算读取就绪状态；超限保持 pending/unavailable，不能缩写成没有残留。

后续主机式部署的 systemd 模板要求管理员配置 `codelab-runner` 用户、Docker 权限、`/opt/codelab`、`/etc/codelab/runner.env` 和可写数据根；timer 每次完成后约 10 秒再次检查。模板仍需在目标环境安装并实测进程退出、回收失败和服务重启。Desktop 独立进程的真实结果应单独留证，不能把它或模板存在写成 systemd 已安装通过。

## 文件耐久性与范围

动作与所有者记录使用 fsync 后的不可变 JSON 快照，通过 hard link 的原子 create-if-absent 发布递增版本，实现跨进程竞争。先持久化资源意图和 dispatch，再进行外部副作用。崩溃留下的临时快照不被当作当前状态；最新正式快照损坏时拒绝开放执行，不退回旧版本继续写。

journal 与 responses 不挂载进学生容器；工作目录的父目录也不暴露。工作目录是临时材料，**不是**学生证据的持久存储。业务 worker 必须先校验、存档证据并完成数据库引用，再请求回收。回收器不访问或修改业务数据库，也不重新生成基础结果。

该实现面向当前受控样本阶段，完整快照随 owner/operation 数量增长，历史快照及未引用响应暂不自动裁剪。单份元数据上限 64 MiB，达到时拒绝新写；部署前要登记磁盘空间和留存策略。需要扩展到长期课堂流量时，应实现经过验证的离线归档/索引维护，不能在服务运行时手工删除 journal 的旧编号文件。只有本地支持 hard link 与目录 fsync 的 Linux 文件系统可以作为部署候选；网络盘和 Windows 的掉电耐久性未得到本轮测试证明。

T03 尚未完成的范围包括宿主防火墙/宿主网关阻断、浏览器当前 `--no-sandbox` 的加固、输出目录硬配额、资源攻击以及干净环境复现。`--internal` 网络、route 拦截、容器只读根目录和单次成功运行不能替代这些系统验证。当前 Desktop 足以继续已经获准的构造样本开发；它不扩大为任意学生代码运行或真实课堂使用许可。
