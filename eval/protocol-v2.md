# CodeLab 四组记录协议 v2

本协议继承 [v1](protocol-v1.md) 的完整分组、计时、输入同一性、独立评价和隐私要求；v1 文件及旧账本不改写。新评测开始前将本协议文件的实际 SHA-256 固定在新账本中。账本格式保持 evaluation-ledger-v1，增加可选 probeOpportunity；旧记录缺少该字段时记 unknown，不补造历史。

## FILTER_ORDER_CHECK 新增调查机会

每条实际评测记录分别登记 ruleEnabled（规则启用）、filterFailed（基础筛选失败）、preparationPossible（混合状态准备可完成）、pathBCoveredByBase（基础检查已覆盖路径 B）。每个条件使用 value=true/false/null 与 evidence 引用数组；null 表示材料不能确定，不用 false 代替缺失。已知判断必须有材料，引用必须同时存在于该记录的 evidence，文件由 evaluation:check 核对实际哈希。规则条件绑定本次 ruleSha256，基础失败和路径覆盖条件绑定本次 baseEvidenceSha256；准备条件保留本次准备执行材料。

仅 true/true/true/false 计 eligible；任一条件已明确排除时计 ineligible；其余记 unknown。条件由评阅者依据该次规则、基础执行和准备记录填写，机器只核对声明、引用和文件一致性，不认证材料的语义或评阅独立性。不能以“Agent 调用了探查”替代机会条件。

汇总按 H/R/S/A 及 synthetic/reviewer-recorded 分开保留 eligible/ineligible/unknown；未开始计划仍在 missing，不加入已观察机会数量。eligible 只说明有进一步调查的条件，不说明探查执行成功、产生新事实、定位根因或改善教学质量。实际探查中的 blocked/inconclusive、无新增事实及失败材料仍按 v1 完整保留，不筛除不利结果。独立评阅、冻结样本和真实费用未完成时不得输出优越性结论。
