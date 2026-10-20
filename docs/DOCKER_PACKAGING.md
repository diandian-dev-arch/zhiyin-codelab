# 知因 CodeLab：Docker 名称、打包与运行说明

整理日期：2026-10-01（Asia/Shanghai）。依据当前仓库配置与启动脚本整理。

## 1. 先记住这三个结论

1. 项目中文名是 **知因 CodeLab**，根目录 `package.json` 和 Docker Compose 的项目名都是 `zhiyin-codelab`。
2. 当前日常使用的 v2 工作台采用 **本机运行前端、API 和后台任务，Docker 运行 PostgreSQL 数据库及代码执行环境** 的方式，网页入口是 `http://127.0.0.1:5174/`。
3. 仓库另有前后端 Docker 打包配置，但 `deploy/compose.yaml` 仍属于 **历史 v1 部署入口**，不能直接当作当前 v2 的一键部署方案。

本次只核对文件和配置。读取 Docker 容器列表时，连接 `dockerDesktopLinuxEngine` 失败，因此没有确认当前正在运行的容器、已安装镜像或服务健康状态，也没有执行构建、启动或部署。

## 2. Docker 里的名称分别指什么

| 概念 | 大白话解释 | 本项目例子 |
| --- | --- | --- |
| Project（项目） | Compose 管理的一组服务的总名称 | `zhiyin-codelab` |
| Image（镜像） | 装好代码、依赖和启动命令的运行模板 | `codelab-build:v2-desktop` |
| Container（容器） | 用镜像创建的程序实例，可以启动和停止 | `codelab-desktop-control` |
| Volume（持久卷） | 独立保存数据的地方，可以在容器重建后继续使用 | `codelab-desktop-runner-v2` |

`codelab-build:v2-desktop` 中，`codelab-build` 是镜像名称，冒号后的 `v2-desktop` 是 Tag（标签），用于区分版本或用途。当前启动脚本进一步读取镜像 ID 来启动执行环境；同一个标签重新构建后，镜像 ID 可能变化。

### 当前 v2 工作台的容器和持久卷

| 对象 | 名称 | 职责或说明 |
| --- | --- | --- |
| 执行协调器容器 | `codelab-desktop-control` | 接收执行请求、协调构建和浏览器检查，并运行独立资源回收进程 |
| 执行器持久卷 | `codelab-desktop-runner-v2` | 保存执行器的持久状态与相关资料 |
| 默认数据库容器 | `codelab-workspace-postgres-v2` | 新环境没有恢复选择配置时使用的数据库容器名称 |
| 默认数据库持久卷 | `codelab-workspace-postgres-v2` | 新建默认数据库时使用，挂载到 `/var/lib/postgresql/data` |
| 本机当前配置选中的数据库容器 | `codelab-recovered-48fc352d-c99d-4c7e-bcce-d3040d6657d6` | 来自本机 `.data/workspace-database.json`，表示选择了恢复后的数据库；未核实当前运行状态 |

恢复数据库的实际挂载卷需要对该容器执行 `docker inspect` 才能确认，不能根据默认卷名推断。新成员复现时按 [REPRODUCE.md](REPRODUCE.md) 操作，不复制本机私有数据库选择配置。

### 当前 v2 的四类执行镜像

| 镜像标签 | Dockerfile | 作用 |
| --- | --- | --- |
| `codelab-build:v2-desktop` | `deploy/executor/Dockerfile.build` | 提供固定 Vue 模板依赖及 Vite 构建环境，构建提交内容 |
| `codelab-web:v2-desktop` | `deploy/executor/Dockerfile.web` | 启动被检查项目的静态网页服务 |
| `codelab-browser:v2-desktop` | `deploy/executor/Dockerfile.browser-v2` | 提供 Playwright 浏览器与检查脚本，执行检查并采集证据 |
| `codelab-control:v2-desktop` | `deploy/executor/Dockerfile.control` | 提供 runner、Docker CLI 和 supervisor，协调其他执行容器 |

这里的 `codelab-web:v2-desktop` 服务于被检查的学生项目。平台自身网页的打包配置是另一个文件：`deploy/Dockerfile.web`。

## 3. 当前 v2 工作台怎么运行

```text
本机：知因 CodeLab 工作台
  浏览器 → Vite 前端（5174）→ API（3102）
                              ↕
                           后台 worker
                              ├─ 读写 Docker 中的 PostgreSQL
                              └─ 请求执行器（本机入口 13200）
                                   ↓
Docker：codelab-desktop-control
  协调创建执行容器：构建 → 启动被检查网页 → 浏览器检查
  返回检查结果与证据，并回收执行资源
```

前端、API 和 worker 由 `scripts/workspace-v2.ts` 启动，不是三个业务 Docker 容器。数据库和执行协调器在 Docker 中运行，构建、网页服务和浏览器检查由执行器按任务创建相应执行容器。

| 入口 | 地址或端口 | 用途 |
| --- | --- | --- |
| 工作台网页 | `http://127.0.0.1:5174/` | 教师与学生日常操作 |
| 工作台 API | `127.0.0.1:3102` | 前端请求的业务接口 |
| 执行器宿主入口 | `127.0.0.1:13200` | 映射到协调器容器的 `3200` 端口 |
| PostgreSQL | 随机本机回环端口 | 工作台通过启动时读取的端口连接数据库 |

本机证据目录是 `.data/business-v2/evidence-v2`。执行器私有凭据和运行目录位于 `.data/desktop-runner`。账号密码、数据库口令和令牌不写入本文。

## 4. 当前 v2 执行环境怎么打包和启动

以下是操作说明，本次整理没有运行这些命令。已有工作台可用时，不需要为了阅读本文重新构建镜像。

### 4.1 准备环境

需要可连接的 Docker Desktop Linux amd64 引擎，以及项目要求的 Node.js 和 pnpm。Windows 工作台推荐使用复现说明中已验证的 Node.js 24.19.0，pnpm 为 11.21.0。

从包含 `package.json` 的项目根目录执行：

```powershell
Set-Location 'C:\Users\Jie\Documents\ChatGPT\competition'
docker info --format '{{.OSType}} {{.Architecture}}'
pnpm install --frozen-lockfile
pnpm workspace:runtime
```

`--frozen-lockfile` 表示按锁文件安装依赖，不在安装过程中重新改写依赖版本选择。新机器的完整准备流程见 [REPRODUCE.md](REPRODUCE.md)。

### 4.2 构建四个执行镜像

```powershell
docker build -f deploy/executor/Dockerfile.build -t codelab-build:v2-desktop .
docker build -f deploy/executor/Dockerfile.web -t codelab-web:v2-desktop .
docker build -f deploy/executor/Dockerfile.browser-v2 -t codelab-browser:v2-desktop .
docker build -f deploy/executor/Dockerfile.control -t codelab-control:v2-desktop .
```

以第一条命令为例：

- `docker build`：按照 Dockerfile 构建镜像。
- `-f deploy/executor/Dockerfile.build`：指定打包配方文件。
- `-t codelab-build:v2-desktop`：给生成的镜像指定名称和标签。
- 最后的 `.`：以当前项目根目录作为 Build Context（构建上下文），Dockerfile 从这里取得所需文件。

四个镜像的打包内容不同：构建镜像预装固定模板依赖；网页镜像带静态服务脚本；浏览器镜像带 Playwright 和检查脚本；协调器镜像带 runner、Docker CLI 和 supervisor。

### 4.3 启动执行器，再启动工作台

```powershell
pnpm runner:desktop up
pnpm runner:desktop status
```

确认执行器状态为 `ready` 后，在保持运行的终端启动工作台：

```powershell
pnpm dev:workspace
```

打开 `http://127.0.0.1:5174/`。也可使用仓库提供的守护入口 `pnpm dev:workspace:supervised`，两种工作台入口选一种，不同时启动。

构建完成只表示生成了镜像；确认执行器 `ready`、网页可访问和实际业务流程可用，才分别证明对应运行环节成功。当前执行范围仍以获准团队样本和现有验收记录为准。

## 5. 平台前后端的 Docker 打包方式

这一节解释仓库已有的业务镜像配方。当前 Compose 仍是历史 v1 入口，与上一节的 v2 日常启动方式不同。

### 5.1 前端：Vue → Vite 构建 → Nginx

配方文件：[Dockerfile.web](../deploy/Dockerfile.web)。采用 Multi-stage Build（多阶段构建）：

```text
构建阶段：Node.js 22.14.0 + pnpm 11.21.0
  复制项目 → 安装依赖 → pnpm build
  → vue-tsc 类型检查 → Vite 构建 → apps/web/dist

运行阶段：Nginx 1.28 Alpine
  复制 dist 与 nginx.conf → 提供网页服务
```

前端最终镜像只从构建阶段取得网页产物，不携带该阶段完整的 Node.js 构建环境。`deploy/nginx.conf` 将 `/api/` 请求转发给 Compose 内部的 `api:3100`，并配置单页应用路由回退。

根目录的 `pnpm build` 只构建前端，不构建后端、执行器或数据库。

### 5.2 后端：TypeScript 代码和依赖 → Node.js 镜像

配方文件：[Dockerfile.api](../deploy/Dockerfile.api)。

```text
Node.js 22.14.0 + pnpm 11.21.0
  → 复制项目代码
  → pnpm install --frozen-lockfile
  → 创建数据目录，切换到 node 用户
  → pnpm exec tsx apps/api/src/main.ts
```

后端是 Node.js / TypeScript / Fastify 服务。当前配方使用 `tsx` 直接运行 TypeScript 入口，没有先把后端编译成独立 JavaScript 发布目录，也不是 Java JAR 打包方式。

### 5.3 数据库、初始化与后台任务

| Compose 服务 | 来源或构建方式 | 启动职责 |
| --- | --- | --- |
| `db` | 官方镜像 `postgres:17.4-bookworm` | 运行 PostgreSQL，用 `postgres` 持久卷保存数据库 |
| `init` | 使用 `deploy/Dockerfile.api` | 运行 `apps/api/src/seed.ts`，初始化业务数据后退出 |
| `api` | 使用 `deploy/Dockerfile.api` | 运行后端 API，等待 `init` 成功完成 |
| `web` | 使用 `deploy/Dockerfile.web` | 提供平台网页，映射本机 `8080` 到容器 `80` |
| `worker` | 使用 `deploy/Dockerfile.api` | 可选 `execution` profile，运行旧版 `apps/api/src/worker.ts` |

数据库与 evidence 都有持久卷配置。镜像保存程序和环境，持久卷保存运行数据，两者承担不同职责。

### 5.4 Compose 名称与当前适用范围

`deploy/compose.yaml` 明确设置 `name: zhiyin-codelab`。在没有命令行或环境覆盖时，Compose 默认生成的名称通常如下；表内是命名规则推导，不是本次容器列表实测：

| 对象 | 默认名称示例 |
| --- | --- |
| 前端容器 | `zhiyin-codelab-web-1` |
| API 容器 | `zhiyin-codelab-api-1` |
| 数据库容器 | `zhiyin-codelab-db-1` |
| 初始化容器 | `zhiyin-codelab-init-1` |
| 前端构建镜像 | `zhiyin-codelab-web` |
| API 构建镜像 | `zhiyin-codelab-api` |

历史业务端启动方式是先配置 `deploy/.env`，再执行：

```powershell
docker compose --env-file deploy/.env -f deploy/compose.yaml up --build -d db init api web
```

该入口配置的网页地址是 `http://localhost:8080`。当前 Compose 未透传 `BUSINESS_API_VERSION` 和 `CODELAB_V2_RUNTIME_FILE`，业务默认 v1，execution profile 也仍使用旧版 worker。仅在环境文件里添加变量不能完成 v2 接线；当前 v2 应使用第 4 节的工作台入口。详细边界见 [DEPLOYMENT.md](DEPLOYMENT.md)。

## 6. 镜像打包与源码 ZIP 打包有什么区别

| 方式 | 命令或入口 | 产物 | 主要用途 |
| --- | --- | --- | --- |
| 前端构建 | `pnpm build` | `apps/web/dist` | 生成平台静态网页 |
| Docker 镜像构建 | `docker build ...` 或 Compose build | Docker 镜像 | 封装程序及其运行环境 |
| 源码复现包 | `pnpm reproduction:package` | 源码 ZIP、文件清单与哈希 | 让其他成员取得源码，在独立环境安装和复现 |

源码复现包不包含 Docker 镜像、已安装依赖、私有账号资料、证据或数据库。拿到源码 ZIP 后仍要准备运行环境并构建镜像。

Docker 的构建上下文由 `.dockerignore` 过滤，当前规则包括 `node_modules`、`dist`、`.data`、`.env`、`.git`、`output`、`fixtures` 等。源码复现包采用自己的筛选规则，不等同于 Docker 构建上下文。

## 7. 怎么查看名称与状态

在 Docker 引擎可连接时，可从项目根目录执行以下只读命令：

```powershell
# 列出容器，包括已经停止的容器
docker ps -a --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'

# 查看本项目执行镜像
docker image ls --filter 'reference=codelab-*'

# 查看持久卷名称
docker volume ls

# 查看执行器是否就绪
pnpm runner:desktop status
```

如果 Docker 报无法连接 `dockerDesktopLinuxEngine`，先打开 Docker Desktop 并确认 Linux 引擎就绪，再重试。看到容器 Running 只能确认容器进程在运行，执行器是否能接单还要看 `runner:desktop status`，业务可用还要检查实际网页和接口。

## 8. 答辩时可以直接使用的表述

### 约 30 秒版本

> 我们的项目叫知因 CodeLab，工程名是 zhiyin-codelab。当前开发工作台在本机运行前端、API 和后台任务，数据库和代码执行环境放在 Docker 中。执行环境分成构建、网页服务、浏览器检查和协调器四类镜像，分别负责把提交的项目构建出来、启动网页、检查功能并生成证据。仓库也提供平台前后端的 Docker 打包配方：前端通过 Vite 构建后交给 Nginx，后端封装到 Node.js 镜像，数据库使用 PostgreSQL 官方镜像。

### 被问“整个系统都已经容器化了吗”

> 当前 v2 日常工作台采用混合运行方式，业务进程在本机，数据库与执行环境在 Docker 中。仓库有历史 v1 的 Compose 配置；当前 v2 的全容器部署接线还需要另外设计和验证。

### 被问“Docker 给项目带来什么”

> Docker 让构建和浏览器检查使用预先准备的环境，减少不同电脑之间的依赖差异，也方便按任务创建和回收执行容器。镜像与环境信息可以记录下来，帮助追踪检查结果产生时使用的运行环境。完整生产隔离与稳定性仍要通过专门验收。

## 9. 配置依据

- [根目录 package.json](../package.json)：工程名称、构建和启动脚本。
- [README.md](../README.md)：日常工作台与执行镜像构建入口。
- [deploy/compose.yaml](../deploy/compose.yaml)：Compose 项目名、服务、端口和持久卷。
- [deploy/Dockerfile.web](../deploy/Dockerfile.web) 与 [deploy/Dockerfile.api](../deploy/Dockerfile.api)：业务镜像构建方式。
- [deploy/executor](../deploy/executor/)：执行镜像、静态网页服务与浏览器检查脚本。
- [scripts/desktop-runner.ts](../scripts/desktop-runner.ts)：协调器容器、镜像标签与执行卷名称。
- [scripts/workspace-v2.ts](../scripts/workspace-v2.ts)：v2 工作台业务进程、数据库与端口。
- [scripts/workspace-database-target.ts](../scripts/workspace-database-target.ts)：默认数据库名称和恢复选择规则。
- [docs/REPRODUCE.md](REPRODUCE.md)：独立机器复现流程。
- [docs/DEPLOYMENT.md](DEPLOYMENT.md)：历史 Compose 与 v2 部署边界。
