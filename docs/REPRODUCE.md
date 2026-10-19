# 第二成员干净环境复现

此流程仅用于获准团队构造样本。完成源码包校验不等于运行成功；同一作者在原机器重跑也不等于第二成员复现。请由另一位成员在独立机器按本文操作并记录实际结果。

## 环境与资料

- Windows PowerShell、Node.js 22.14+、pnpm 11.21.0、Docker Desktop Linux amd64；推荐已验证的Node24.19.0，Windows工作台拒绝24.0—24.15。真实浏览器页面走查需要已安装 Google Chrome。
- 建议至少 4 CPU、8GiB 内存及 40GiB 可用空间，作为准备建议，不是已测性能下限。镜像安装需要网络；固定 lockfile 不等于基础镜像跨日期绝对不变。
- 使用单独目录及 Docker 环境，避免与其他 CodeLab 实例的同名卷/容器冲突。不要复制原机器 `.data`、`.env` 或账号文件。不要为了腾位置执行全局 Docker prune。
- `pnpm reproduction:package` 生成源码 ZIP 和独立 SHA-256 摘要，包含构造 ZIP/清单和源代码，不含镜像、已安装依赖、私有账号/证据或数据库。源码包含本地未提交工作，不能称为某个 Git 提交的发布包。
- 包内附操作、部署、保留、模型、评测和工程契约说明；历史验证目录与 `output` 原型不随包分发，文档指向它们的链接仅作为原工作区证据索引。请在目标机器生成自己的验证记录，不把未随包提供的历史证据当作本机结果。
- `scripts/record-source-demo.ts` 是原开发机博物馆演示录制辅助脚本，依赖该机器的项目编号、私有开发账号与授权源码包，不属于干净机器复现步骤。请在自己的环境导入获准源码，不复制原账号或博物馆资料。
- `scripts/record-course-demo.ts` 是已运行工作台的课程演示辅助脚本，会创建构造任务/提交并触发真实执行，agent配置下调用真实模型。`scripts/finalize-course-demo.ts <录制UUID>`只核验已有视频并生成播放器。二者均需Chrome，均不属于无环境准备的干净机器验收命令；录制产物不在源码包内。

## 先校验，再安装

恢复已有数据时，可在私有 `.data/workspace-database.json` 指定已验证容器的 `name`（以codelab-开头）与完整64位 `id`。工作台、只读数据库工具、容量检查和备份脚本使用同一选择；容器丢失或被替换会停止，不自动新建、不回退默认数据库。此配置不随源码包分发，新成员不应复制。恢复前先在独立容器验证备份、证据文件及模型凭据，不覆盖正在使用的数据库。

核对提供者通过可信渠道给出的 ZIP SHA-256，与同包自带的哈希相符只能发现误损，不能证明来源可信。解压到新目录后从根目录运行：

```powershell
Get-FileHash -Algorithm SHA256 .\codelab-source.zip
# 解压后切换到含 package.json 的目录：
node scripts/verify-source-bundle.mjs
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm build
node --import tsx scripts/register-evaluation.ts --check
pnpm evaluation:check eval/empty-ledger.json
```

校验脚本先于安装运行，不需要第三方依赖；逐文件验证清单尺寸和哈希、拒绝路径穿越与链接。包内构造 ZIP 已带入，不要先重新生成再验证哈希。`--check` 只核对 ZIP 和已登记内容，不改变登记时间和字节，保持评测账本绑定的哈希。无参数运行会重新登记并改变哈希，不适用于已有账本的复现。空账本检查只证明材料完整，不代表已开展评测。

## 构建执行环境

Node 22.22.2的原生崩溃报告可能包含工作线程环境变量。当前只在已验证的Node 24.19及其同主版本后续版本启用原生fatal报告；其他运行时保留最多60条数值资源采样，关闭自动原生报告。不要将数值采样可用误认为能取得原生OOM堆栈。

```powershell
docker info --format '{{.OSType}} {{.Architecture}}'
docker build -f deploy/executor/Dockerfile.build -t codelab-build:v2-desktop .
docker build -f deploy/executor/Dockerfile.web -t codelab-web:v2-desktop .
docker build -f deploy/executor/Dockerfile.browser-v2 -t codelab-browser:v2-desktop .
docker build -f deploy/executor/Dockerfile.control -t codelab-control:v2-desktop .
pnpm runner:desktop up
pnpm runner:desktop status
pnpm test:postgres
node --import tsx scripts/verify-desktop-v2.ts correct build-error --reanalysis
```

`--reanalysis` 的集成验收使用明确标记的合成模型，但执行器/浏览器/补查/数据库是真实运行。它不能代替真实模型质量评测。预期正确样本八项检查通过，构建失败样本为 not_run，发布读取与恢复清理通过；记录实际计数、镜像和规则哈希，不能直接抄原机器计数。重建镜像 ID 可能不同，应在新环境内比较，不能强行冒充相同指纹。

## 启动并走查

### 工作台运行时选择

先运行 `pnpm workspace:runtime`，它仅检查实际可执行文件、Node/libuv版本，不启动工作台、不调用模型。启动优先使用进程环境变量 `CODELAB_NODE_EXECUTABLE`，其次是本机私有 `.data/workspace-runtime.json` 中的 `executable` 绝对路径，最后才使用当前Node。配置损坏、文件不存在或版本被拒绝时明确退出，绝不静默回退。该设置不是模型配置，不从项目 `.env` 读取。

若需要与其他项目使用不同版本，在当前PowerShell终端指定已经安装的、受信任的Node：

```powershell
# 将示例替换为本机真实存在的Node绝对路径；这里只影响本终端和CodeLab。
$env:CODELAB_NODE_EXECUTABLE = 'C:\Tools\node-v24.19.0\node.exe'
pnpm workspace:runtime
pnpm dev:workspace:supervised
```

需要本项目持久记住路径时，可在本机 `.data/workspace-runtime.json` 写入 `{"executable":"C:/Tools/node-v24.19.0/node.exe"}`（替换为实际路径）。文件不随源码包分发，不修改系统PATH，也不会下载或安装Node。选定运行时同时用于守护与业务子进程；直接运行两份TS入口仍会执行版本检查。其他测试命令继续使用各自命令选择的Node，不要将项目入口设置误认为系统切换。

Windows Node24.16已包含官方OSVERSIONINFOW初始化修复；24.19是本机已验证版本。排除旧版是在避开已知缺陷，不表示已证实所有历史原生退出的原因或完成长期稳定性验证。

在终端 A：

```powershell
pnpm dev:workspace:supervised
```

打开 http://127.0.0.1:5174/。固定本地端口还有 API 3102、守护互斥3103、执行管理13200；PostgreSQL使用随机回环端口。账号 `teacher@codelab.local` / `student@codelab.local`，首次生成的口令在本机私有 `.data/business-v2/development-credentials.json` 中查看，不发到聊天/日志。无模型配置也能完成基础报告；真实模型另按 MODEL_SETUP.md 配置。

普通ZIP及课程AI均在当前账号的「模型设置」中配置个人密钥。课程创建检查默认不调用模型，主动选择AI总结/Agent才使用发起者的配置；教师重新分析使用教师账号配置。请用自己的服务商账户验证，不复制原开发者的密钥。环境中的MODEL_*配置仅供显式诊断/旧测试工具，不会替未配置个人模型的生产v2账号垫付。

守护入口只管理自己启动的一个子进程，就绪后异常退出最多重启3次（2/4/6秒延迟）；启动失败、正常退出、Ctrl+C主动停止不重启。启动超过60秒未就绪会停止子进程，退出宽限15秒后只强制终止该子进程。不要并行启动其他工作台入口，3103被占时先核对原实例。调试可使用 `pnpm dev:workspace` 手动入口。守护不是系统服务，不保证电脑重启、守护进程退出或所有在途故障自动恢复；不会自动重放状态不确定的付费请求。固定事件记录在本机私有 `supervisor.jsonl` 和 `lifecycle.jsonl`。

Windows 上需要关闭启动终端后继续使用时，可在仓库根运行 `powershell.exe -NoProfile -File scripts/start-workspace-background.ps1`。它由本机 WMI 创建隐藏后台宿主，再运行同一套运行时选择与守护入口；只传递固定路径和非敏感启动参数，不安装系统服务或开机项。独立日志和实例状态保存在 `.data/business-v2/background-<UUID>.*`，已有工作台占用端口时拒绝重复启动。维护期间可用 `-SchemaVersion 20` 固定已经部署的数据库版本；版本必须与现有数据库一致。启动观察超时表示尚未确认就绪，先检查实例状态和日志，不应直接重复启动。后台入口不保证电脑重启后自动恢复。

工作台启动后还在 `.data/business-v2/diagnostics/<实例UUID>/resources.json` 保存每15秒的数字资源采样，只保留最近60次；包括Node/V8/libuv版本、进程内存、可用内存和CPU计数，不含环境变量、请求或错误原文。支持排除环境与网络信息的Node会启用私有致命错误报告，应用异常不自动生成报告。Windows强制终止和部分原生fast-fail可能绕过Node，因此没有报告不能排除崩溃；报告仅供本机诊断，不随源码ZIP分发。诊断写入失败不阻止服务启动，固定错误码提示失败，不以诊断失败覆盖业务错误。

终端 B（工作台保持运行）：

```powershell
node --import tsx scripts/verify-workspace-ui.ts
pnpm storage:check
```

页面走查会创建标记为构造样本的任务和报告并保留，不是只读操作。验证教师建任务/规则、学生 ZIP、真实执行、反馈确认发布、学生证据、修复与回归、规则变化不可比、旧报告保留。保存 `output/workspace-verification/<本次时间>/result.json` 和截图；不要发送 private `.data`。

## 隔离与恢复专项（团队构造样本）

以下命令会创建独立临时容器、网络或测试数据库，并按身份核对后清理。保持Docker可用，不并发运行多项重型验证；每项记录实际退出码及新生成的证据目录。宿主网络检查会短暂监听随机端口，仅返回随机路径的无敏感测试内容，结束即关闭。

```powershell
pnpm exec vitest run tests/workspace-startup.test.ts tests/workspace-shutdown.test.ts
node --import tsx scripts/verify-filesystem-isolation.ts
node --import tsx scripts/verify-ipv6-isolation.ts
node --import tsx scripts/verify-browser-network.ts
node --import tsx scripts/verify-host-network.ts
node --import tsx scripts/verify-checker-interruption.ts
pnpm verify:reaper
pnpm retention:check --desktop
```

IPv6专项要求当前默认internal网络未启用IPv6，若环境变化必须重新评估，不能删除断言来制造通过。WebRTC专项观察TCP/TLS连接起始，不是完整TURN中继认证；宿主专项只覆盖测试服务地址，不代表所有宿主目的地。文件专项与真实`verify:desktop:v2 ... --probe --reanalysis`的owner挂载核验配合使用。保留检查是只读的，默认retain_all，不删除任何历史报告。

浏览器中断专项运行受控HTML正对照和按钮禁用故障，核对生产检查器/驱动与镜像哈希、真实点击超时、未执行步骤列表；不停止在线工作台，也不替代完整worker故障与发布流程。

启动/退出修复不能证明原开发机曾出现的Windows异常退出根因已解决。工作台运行期间若失联，先确认实际进程/端口/活动owner状态，再恢复；不能仅凭一次请求超时同时启动第二个实例。

## 复现回执（由实际操作人填写）

记录成员代号、日期、独立机器/系统、Node/pnpm/Docker 版本、收到的源码 ZIP 哈希、四个实际镜像 ID、任务包哈希、每条命令退出码、测试数量与跳过原因、业务结果/清理摘要路径、页面异常、实际耗时和偏离本文之处。失败也留原始记录，不删除失败再只报成功。

第二成员实际回执尚未获得。源码包自检、第一成员本机运行、独立操作者干净环境复现是三类不同证据。仅最后一类满足 T12 第二成员要求；全部通过也不自动证明宿主防火墙、真实模型或课程试点授权已经完成。

开发者在发送源码前可执行 `pnpm exec tsx scripts/verify-reproduction-package.ts <source-package-uuid>`。它核对既有包的独立哈希，在新私有目录逐文件解压核验，使用离线冻结依赖安装（不执行安装脚本），运行根/工作区类型、网页构建和个人模型/运行诊断专项。它不启动业务服务或外部模型。结果为源码包目录中的 `verification.json`；已有回执不覆盖，重新核验应产生新源码包。此命令仅补充本机可复现性，不能填写上面的第二成员回执。
