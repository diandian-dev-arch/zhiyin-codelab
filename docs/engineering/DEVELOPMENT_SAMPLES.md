# 开发样本登记与使用边界

2026-09-28 增量：新增第二实现家族 `vue-board-options-reducer-family-002`。源码在 `fixtures/independent-source`，生成命令为 `pnpm exec tsx scripts/fixtures-independent.ts`，登记在 `fixtures/independent-manifest.json` 与 `fixtures/independent-defects-manifest.json`。正确实现采用 Options API 父组件、子组件事件、不可变 reducer 和显式持久化，与下述模板的 Composition API、原地修改、deep watch 不同。另有空字符串、纯空格、反向状态切换三个缺陷变体；所有文件仍仅供团队开发，不是学生作品、教师独立标注或冻结评测材料。

第二份正确实现和原七份样本的八案例实跑记录：[2026-09-28 验证](../verification/2026-09-28/desktop-v2-7cf528fb-402/results.json)。以下矩阵保留第一家族的预先登记，实际结果另存，不覆盖预期来源。

这些输入来自同一 `vue-board-v1-development-family-001` 开发家族。生成器保留既有 `correct`、`filter-defect`、`build-error` 的样本名称与源码构造方式，并增加四个缺陷或修复变体。它们是团队控制的构造源码，不包含真实学生提交，不能拆分进开发集和冻结评测集，也不构成独立实现数量。

入口为 [scripts/fixtures.ts](../../scripts/fixtures.ts)，机器可读登记为 [fixtures/manifest.json](../../fixtures/manifest.json)。执行 `pnpm fixtures` 会生成七份 ZIP 并更新登记；执行 `pnpm exec vitest run tests/fixtures-v2.test.ts` 验证样本准入、身份和源代码层的缺陷结构。模板变化导致替换锚点不唯一时，生成器在写文件前停止，不会静默产出没有预期缺陷的负例。

## 预期结果矩阵

下表是源码构造与公开要求推导出的预期，全部登记为 `expected-only`。它不记录真实浏览器结果，不是教师独立标注的冻结真值。`P/F/N` 分别表示预期通过、预期明确失败、预期未执行。

| 样本                  | NEW-01 | VALID-01/02 | STATE-01 | FILTER-01 | FILTER-02/03 | SAVE-01 | 关键构造与用途                                                     |
| --------------------- | ------ | ----------- | -------- | --------- | ------------ | ------- | ------------------------------------------------------------------ |
| correct               | P      | P/P         | P        | P         | P/P          | P       | 原始参考模板；名称不能代替实际验收                                 |
| filter-defect         | P      | P/P         | P        | P         | F/F          | P       | 筛选谓词恒真，仍可正常准备混合状态                                 |
| build-error           | N      | N/N         | N        | N         | N/N          | N       | 未闭合 SFC；预期 Run 为 build_error，功能均未执行                  |
| create-missing        | F      | P/P         | N        | N         | N/N          | N       | 新增处理不入列；其他案例自己的准备应独立发现缺少目标               |
| create-duplicate      | F      | P/P         | N        | N         | N/N          | N       | 一次新增两个不同 ID、相同标题的目标；准备无法确认唯一身份          |
| filter-setup-blocked  | P      | P/P         | F        | N         | N/N          | N       | 状态控件 disabled，筛选无法准备完成/未完成混合数据；不得判筛选失败 |
| fixed-with-regression | P      | P/P         | P        | P         | P/P          | F       | 从 filter-defect 修复筛选，同时移除持久化 watch，引入刷新丢失回归  |

每个筛选案例都在自己的浏览器上下文准备数据。上表中的 `N` 必须由该案例真实尝试准备后记录，不能看到另一个案例失败就直接复制 `not_run`。`filter-setup-blocked` 的 STATE-01 预期失败是“已创建目标、可靠观察到承诺的交互被禁用”；如果真实执行无法确定页面和定位约定，仍应按契约转为人工判断或平台故障，不能强迫结果符合本表。

## 开发包使用顺序

1. T05 的 NEW-01 开发包使用 `correct`、`create-missing`、`create-duplicate` 与 `build-error`。
2. T07 的 NEW-01＋FILTER-03 开发包使用 `filter-defect → correct` 验证修复，使用 `filter-setup-blocked` 验证前置受阻。另以 `correct → create-missing/create-duplicate` 验证新增回归及筛选受阻可以同时保留。
3. `filter-defect → fixed-with-regression` 的“筛选修复与持久化回归同时出现”需要 T08 启用 SAVE-01 的完整八案例包；不能在只有 NEW-01＋FILTER-03 的包中声称已经验证持久化回归。

每次比较必须使用相同包、规则和完整实际测量指纹，并重跑全部启用案例。以上箭头只表达源码关系和预期比较场景，不表示已经存在两次真实运行。内部结构独立的 `correct-independent` 属于 T08 待实现项，不能用这七个变体替代。

## 身份、授权和结果登记

每份样本保存稳定 sampleId、实现家族、用途分区、源码派生关系、授权使用范围、原 ZIP SHA-256、ZIP 字节数、源码清单与源码清单 SHA-256，以及逐案例预期及其行为依据。派生关系记录父样本源码清单哈希，防止只保留一个无法追溯的文件名。

原 ZIP 哈希对应实际生成的全部 ZIP 字节。源码清单复用共享 v2 契约的 `source-manifest-v1`，只包含准入后的 `src/**`、`public/**` 的规范化路径、原始字节长度及内容哈希，不转换换行或编码；清单规范化、排序及哈希由共享契约完成。模板配置和依赖锁保留在 ZIP 中，执行时仍需绑定任务包规定的模板及依赖身份，源码哈希不能替代它们。

ZIP 使用固定时间元数据、固定压缩参数和排序后的条目，因而在相同文件输入及生成器版本下可以稳定重建。原有三个样本的文件内容保持原构造，ZIP 容器字节会因确定性元数据而更新，必须使用新登记的 ZIP 哈希。

生成清单中 `verification` 的 `browserExecution=not_run`、`actualRunId=null`、`observedCaseResults=[]` 表示该生成动作没有执行浏览器，也未把一次运行绑定到可重复生成的输入登记。准入与源逻辑单元测试通过后不修改这些字段。真实 Linux/Chromium 执行记录按 [实施计划](IMPLEMENTATION_PLAN_V1.md) 的证据包规范独立保存，通过输入哈希和下列索引关联，包含实际环境、案例轨迹、证据、回收结果及检查人；不得把本清单中的预期字段直接作为执行输出。

测试中的 Vue 源逻辑检查使用现有 Web 工作区的 Vue 响应式实现和受控存储替身，只检查生成缺陷是否确实改变了新增、筛选与持久化逻辑，以及公开控件是否被禁用。它不挂载 DOM、不启动浏览器、不运行构建容器，也不证明点击、定位、刷新、截图或 Linux 隔离已经通过。

## 2026-09-27 独立实际执行索引

20:03:50—20:04:34，Docker Desktop 内真实 Linux 构建/Chromium 执行通过。来源为 `constructed_execution`；仅验证 `vue-board-dev-new@desktop-new01-v1` 的 NEW-01，其余案例的预期没有因此转为实测。

| 输入 | 实际 runId | 实际 NEW-01 | 实际观察 |
| --- | --- | --- | --- |
| correct | 69f65fd8-10bf-471a-93e5-14fb61e3edc2 | passed | 数量 0 → 1，唯一标题匹配 1 项 |
| create-missing | 1b64ae25-070c-4ac3-bd9b-637afb3dde57 | failed | 数量 0 → 0，唯一标题匹配 0 项 |
| create-duplicate | 28106ba8-cc0a-4873-bf70-94618b33650a | failed | 数量 0 → 2，唯一标题匹配 2 项 |
| build-error | d1bb76d3-cc95-44c9-9887-8e14e0ee78f3 | not_run | Vue SFC 构建失败，实际案例步骤为 0 |

[机器记录](../verification/2026-09-27/desktop-v2-1d4413b7-474/results.json) 保存本次四份上传的原 ZIP/源码清单哈希与发布/回收身份；[验收说明](../verification/2026-09-27/T03-T06-desktop-v2.md) 链接 11 份实际证据和环境指纹。检查人为 Codex 工程执行与复核，没有真实教师或独立冻结真值参与。仍然是 7 份输入、1 个实现家族；4 份执行不能换算为 4 个独立实现或准确率分母。

`filter-defect`、`filter-setup-blocked` 的实际筛选链路留待 T07；`fixed-with-regression` 的 SAVE-01 回归留待 T08。生成器再次运行不会删除或覆盖这里独立保存的历史运行证据。
