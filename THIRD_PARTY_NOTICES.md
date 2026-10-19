# 开源来源与采用边界

## 2026-09-29 内嵌V8声明补收

[当前许可核对](docs/verification/2026-09-29/LICENSE-INLINE-NOTICE-AUDIT.md)补收stackback 0.0.2中formatstack.js的完整V8 BSD三条款头注释，单独记录原源文件哈希与适用范围。新附件含167份去重文本，三项包级MIT全文缺口仍保留；文件内嵌声明不能替代整个包的许可。[当前交付索引](output/delivery-index/589d388d-37e9-494b-89ba-37a3bffffe86/README.md)已换入新附件。

## 2026-09-28 依赖许可实物清单

已针对当前 Windows 工作区的235个已安装依赖实例收集166份去重许可/通知文本，另登记81项模板锁文件元数据。[收集记录与缺口](docs/verification/2026-09-28/DEPENDENCY-LICENSES.md)链接实际清单、正文及可校验ZIP；使用 `pnpm licenses:collect` 可重新收集本地材料，追加 `--fetch-missing` 才请求公开上游。源码快照不内嵌该生成附件，需要按交接记录同时保留。

仍有 `abstract-logging@2.0.1`、`de-indent@1.0.2`、`stackback@0.0.2` 三项未取得可追溯到相应发布版本的完整许可正文。其MIT元数据不是完整许可文本；模板依赖全文、其他操作系统的可选依赖、镜像/浏览器及团队自身许可也不在此次完成范围内。不能将收集成功表述为完整分发审计通过。

2026-09-28 增量：`deploy/executor/seccomp-playwright-1.58.2.json` 取自 Microsoft Playwright v1.58.2 的 `utils/docker/seccomp_profile.json`（https://github.com/microsoft/playwright/blob/v1.58.2/utils/docker/seccomp_profile.json）。派生文件 `seccomp-chromium-userns.json` 仅新增无条件 chroot syscall 许可，供 Chromium 自有 user namespace 沙箱使用；容器仍非 root、cap-drop ALL、no-new-privileges。保留上游 Apache-2.0 许可于 `deploy/executor/LICENSE.playwright`。此项是实际采用的配置代码，区别于下方概念研究表。

此表沿用仓库现有 2026-09-08 GitHub 研究快照，不是今天重新查询的星数或最新版本。原始研究位于 `output/GitHub高质量Agent项目筛选与学习路线.md`。概念借鉴不等于复制源码或集成完整产品。

| 项目 | 当时研究提交 | 本项目使用 |
|---|---|---|
| [mini-swe-agent](https://github.com/SWE-agent/mini-swe-agent) | 04d809ceab9df28f9adaed044884180159172930 | 借鉴执行—观察循环与运行上限，领域实现自研 |
| [LangGraph.js](https://github.com/langchain-ai/langgraphjs) | bbbdb5aa8a50f7115bdfbb6e3cf020ee239e1842 | 实际依赖 langgraph 1.4.18、checkpoint-postgres 1.0.5；安装版本以锁文件为准，不声称对应快照SHA |
| [OpenHands](https://github.com/OpenHands/OpenHands) | f7fb0c4b21f5ed726edbba8a6309634ef434b004 | 借鉴模型、工具与环境职责，不 Fork 控制台 |
| [OpenMAIC](https://github.com/THU-MAIC/OpenMAIC) | 64621adfa047097f9594bb535e4a190c8d7a32eb | 借鉴生命周期事件和定向回归评价 |
| [Promptfoo](https://github.com/promptfoo/promptfoo) | 885da5f5e75de17acf4d92656c5c1bbcdb851ce4 | 预备评测配置，尚未安装/运行真实模型评价 |
| [Langfuse](https://github.com/langfuse/langfuse) | 8031801c204898c7b9e1a8fa55f5cbc7d18dfe4f | 仅借鉴调用与成本记录，当前用DB事件，不部署平台 |
| [DeepTutor](https://github.com/HKUDS/DeepTutor) | 7a96bba1ae03401644c17763a2411c28aff3dcc9 | 借鉴领域策略分离，不保留学生陪练流程 |

实际依赖还包括 Vue、Vite、Fastify、Zod、Drizzle、pg、yauzl、fflate、Playwright、PGlite、Vitest、lucide-vue-next。精确安装版本见 `pnpm-lock.yaml` 和模板 `package-lock.json`；发布分发时保留各依赖 LICENSE/NOTICE，不能把概念研究表替代完整依赖许可清单。Langfuse 包含不同许可范围，若后续引入源码或服务应重新核验具体目录许可。

目前未整体复制上述项目源码；平台业务、工具契约、检查和页面是本仓库独立实现。固定依赖不代表不存在漏洞；上线前执行依赖审计并在兼容性测试后升级。本项目自身许可证由团队与学校确认后选择，当前不擅自承诺开源授权。
