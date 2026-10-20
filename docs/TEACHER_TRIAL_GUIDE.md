# 教师局域网试用

这是独立演示环境，只用于检查“阅读要求 → 核对固定源码 → 人工点评 → 发布 → 学生读取”的流程是否易懂。内置内容是有意保留缺陷的非敏感合成样例，不是真实学生作业，也不是 AI 或独立教师的评测结果。

## 使用边界

- 试用地址和独立演示账号由负责人另行提供；请连接负责人指定的校园局域网。
- HTTP 仅限演示账号和非敏感样本，传输不具备 HTTPS 的保密保障。不要输入真实账号密码、个人信息、课程成绩、仓库令牌、模型密钥或未授权学生代码。
- 本环境关闭模型调用与项目执行，不需要配置模型或仓库授权。人工评价不依赖 AI。
- 不对公网开放。结束时退出账号，并由负责人停止临时服务。
- 本轮只收集可用性反馈，不宣称已经证明减负、教学效果或生产环境安全。

## 建议路线（约10分钟）

1. 使用演示教师账号登录，打开“课程作业”，找到“[非敏感合成样例] 搜索函数人工评阅”。
2. 阅读任务目标，打开“[有意缺陷样例] 搜索函数”，进入已有的学生 V1 固定提交。
3. 在“固定成果与提交回执”打开 `README.md` 和 `src/search.ts`。判断实际匹配条件是否符合要求，并记下引用位置；本环境没有运行结果可作为依据。
4. 在“教师评价与发布历史”填写简短反馈，例如指出一个确定缺陷、影响和可验证的修改建议；选择“需要修改”，保存新评价草稿。本轮只开放人工评价，没有模型配置或 AI 报告选择。
5. 核对草稿内容后点击“确认发布此评价”。保存草稿不等于发布。
6. 退出教师账号，使用另行提供的演示学生账号进入同一提交，确认能读到已发布反馈，而不是教师未发布的草稿。

可以额外尝试：搜索作业、返回任务、打开源码后关闭、比较说明与源码位置；只用非敏感合成内容新增一条反馈或提交改进版本。重启环境不会清空已经保存的教师反馈，也不会重新创建一套样例。

## 遇到错误

- “保存结果待核对”：不要立即再次创建或发布。先点击“读取最新记录核对”，检查作业、提交版本或发布状态；列表尚未出现记录不代表原操作失败。只有确认风险后再恢复写入。
- 无法连接：记录当时地址是否可访问，联系负责人检查临时服务与局域网，不要尝试绕过浏览器安全提示。
- 登录失败：联系负责人核对独立演示账号；不要改用真实教学账号或把密码写进反馈。
- 不清楚下一步：先记录停在哪个页面、期望做什么，不要求自行绕过问题。

反馈请包含：页面名称、准备完成的动作、实际看到的提示、能否继续、复现步骤；截图避免带入密码或其他个人信息。负责人应区分“流程不清楚”“操作失败”和“教学建议”，不把本次操作记录当成教学效果证明。

## 样例原文

目标：去除查询词首尾空格，忽略大小写，返回包含查询词的标题；空查询返回全部，且不修改原数组。以下函数有意不满足目标，供人工阅读和点评。

`src/search.ts`：

```ts
// Synthetic, non-sensitive sample. Contains deliberate search defects.
export function searchItems(items: readonly string[], query: string): string[] {
  return items.filter(item => !item.includes(query));
}
```

`README.md`：

```md
# Non-sensitive synthetic teacher-trial sample

This is a deliberately defective search function, not a real student's work.
Goal: match titles case-insensitively after trimming the query; an empty query returns all items.
Example: searchItems(['Vue Basics', 'TypeScript'], ' vue ') should return ['Vue Basics'].
The supplied function does not meet this goal. The teacher may inspect it and publish manual feedback.
No project execution, model call, AI report or real teacher outcome is included.
```

说明中的预期值属于任务要求，不是已执行测试结果。初始环境只包含固定源码和提交回执，没有预先填好的教师评价、AI 报告或发布结果。
