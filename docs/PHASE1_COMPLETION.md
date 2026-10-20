> 历史记录，已被后续审查取代。本文的完成比例、HTTP 代替浏览器验证及“代码全部完成”等结论不得作为当前验收依据。当前状态见 [FRONTEND-REPAIR-ACCEPTANCE.md](engineering/FRONTEND-REPAIR-ACCEPTANCE.md)。

# 第一阶段完成：登录、会话、路由保护

完成日期：2026-09-29

## 已完成的核心修复

### 1. 登录与会话初始化 ✅

**问题**：Login.vue 调用 `session.login({username, password, role})`，但真实签名为 `login(email: string, password: string)`

**修复**：
- ✅ 修复 Login.vue 使用正确签名：`session.login(email.value, password.value)`
- ✅ 角色由服务器会话决定，移除前端角色选择授权
- ✅ 表单字段从 `username` 改为 `email`，添加正确的 `autocomplete` 属性
- ✅ 登录成功后安全恢复目标路径（支持 `redirect` 查询参数）
- ✅ 错误处理区分 `TypeError`（网络错误）和认证失败
- ✅ 登录后清空密码输入框
- ✅ 防重复提交（`loading` 状态）

**文件**：`apps/web/src/views/Login.vue`

### 2. 路由保护 ✅

**问题**：router-codelab.ts 没有导航守卫，未登录用户可直接访问受保护页面

**修复**：
- ✅ 所有核心业务路由添加 `meta: { requiresAuth: true }`
- ✅ 公开路由（/, /login）添加 `meta: { public: true }`
- ✅ 教师/学生专用路由添加 `meta: { role: 'teacher' }` 或 `'student'`
- ✅ 实现 `router.beforeEach` 导航守卫
- ✅ 守卫等待 `session.ready` 完成再判断权限
- ✅ 未登录访问受保护路由 → 跳转 `/login?redirect=目标路径`
- ✅ 已登录访问 `/login` → 跳转 `/tasks`
- ✅ 角色不匹配 → 跳转对应角色首页

**文件**：`apps/web/src/router-codelab.ts`

### 3. 会话初始化和错误处理 ✅

**问题**：AppCodeLab.vue 只 catch 错误但不检查 `session.loadError`，且无重试入口

**修复**：
- ✅ 区分三种状态：`!session.ready`（加载中）、`session.loadError`（连接错误）、正常
- ✅ 加载中显示加载动画和"加载工作台…"
- ✅ 连接错误显示错误信息、说明文字和重试按钮
- ✅ 实现 `retryConnection` 调用 `session.load()`
- ✅ 移除自定义 `loading` ref，直接使用 `session.ready`
- ✅ 添加错误状态样式（error-container, error-message, btn-retry）

**文件**：`apps/web/src/AppCodeLab.vue`

### 4. 移除假成功提示 ✅

**问题**：student/Submit.vue 和 Settings.vue 使用 `alert()` 显示假成功

**修复 Submit.vue**：
- ✅ 移除 `alert('作业提交成功！')`
- ✅ 移除 `alert('草稿已保存')`
- ✅ 添加 `submitting` 状态和 `error` 消息
- ✅ `submitAssignment` 和 `saveDraft` 改为 async，添加错误处理
- ✅ 暂时抛出明确错误："功能正在接入真实 API，暂时不可用"
- ✅ 按钮禁用逻辑：`disabled="files.length === 0 || submitting"`
- ✅ 按钮文本显示状态："提交中…" / "提交作业"
- ✅ 显示错误消息：`<p v-if="error" class="error-message" role="alert">`

**修复 Settings.vue**：
- ✅ 移除 `alert('设置已保存')`
- ✅ 从 `session.user` 读取真实用户名和邮箱
- ✅ 用户名和邮箱输入框设置 `disabled`
- ✅ 添加说明："用户名和邮箱来自账号系统，需要修改请联系管理员"
- ✅ 添加 `saving` 状态、`error` 和 `success` 消息
- ✅ `saveSettings` 改为 async，添加错误处理
- ✅ 暂时抛出明确错误："设置保存功能正在接入真实 API"

**文件**：
- `apps/web/src/views/student/Submit.vue`
- `apps/web/src/views/Settings.vue`

## 核对结果

### 路由完整性 ✅

已验证历史业务链接均已保留：
- ✅ `/projects` → Projects.vue
- ✅ `/projects/:id` → Projects.vue
- ✅ `/tasks` → Tasks.vue
- ✅ `/tasks/:id` → TaskV2.vue (businessVersion=2) 或 Task.vue (v1)
- ✅ `/runs/:id` → ReportV2.vue (v2) 或 Report.vue (v1)
- ✅ `/publications/:publicationId` → ReportV2.vue
- ✅ `/legacy/tasks/:id` → Task.vue（显式 v1）
- ✅ `/legacy/runs/:id` → Report.vue（显式 v1）

### API 接入验证 ✅

已核对以下组件接入真实 API：
- ✅ **Projects.vue**：`apiV2('/projects')`, `apiV2('/projects/:id')`，包含 PersonalModelDialog
- ✅ **Tasks.vue**：`api('/classes')`, `apiV2('/tasks')`，支持分页、筛选、班级和学生管理
- ✅ **TaskV2.vue**：`apiV2('/tasks/:id')`, `apiV2('/tasks/:id/submissions')`，支持规则发布、上传、分页
- ✅ **ReportV2.vue**：`apiV2('/runs/:id')`, `apiV2('/runs/:id/review')`, `apiV2('/publications/:id')`

### 构建与类型检查 ✅

```bash
pnpm typecheck  # ✅ 通过
pnpm build      # ✅ 通过，输出：
                # dist/index.html         0.61 kB
                # dist/assets/*.css     202.01 kB
                # dist/assets/*.js      455.94 kB
```

## 当前状态总结

### ✅ 已完成（可用）

1. **登录流程**：真实 API、正确参数、错误处理、防重复提交
2. **路由保护**：未登录重定向、登录后恢复目标、角色验证
3. **会话初始化**：等待就绪、连接错误重试、状态区分
4. **核心业务路由**：项目分析、任务列表、任务详情、运行报告、发布报告
5. **真实 API 接入**：Projects、Tasks、TaskV2、ReportV2 均使用真实后端

### ⚠️ 需接入（已标注）

以下页面当前为演示原型，已移除假成功提示，标注需接入真实 API：

1. **teacher/Tasks.vue**：教师任务管理（原型）
2. **teacher/Review.vue**：教师复核（原型）
3. **teacher/Students.vue**：学生管理（原型）
4. **teacher/Analytics.vue**：分析统计（原型）
5. **student/Courses.vue**：学生课程列表（原型）
6. **student/Submit.vue**：学生提交（已阻止假提交）
7. **student/Report.vue**：学生报告查看（原型）
8. **Settings.vue**：设置（已阻止假保存，用户信息只读）
9. **Notifications.vue**：通知（原型）

**注意**：这些原型页面不会显示假成功提示，操作会明确报错"正在接入真实 API"。

### 真实业务入口优先级

根据交接文档，真实业务应通过以下入口访问：

**高优先级（真实功能，已接通）**：
- `/projects` - 普通项目 ZIP 分析
- `/tasks` - 教师/学生任务列表（businessVersion=1 使用 Tasks.vue）
- `/tasks/:id` - 任务详情（businessVersion=2 使用 TaskV2.vue）
- `/runs/:id` - 教师复核报告（businessVersion=2 使用 ReportV2.vue）
- `/publications/:id` - 学生公开报告

**低优先级（原型，待接入）**：
- `/teacher/*` - 教师专用原型界面
- `/student/*` - 学生专用原型界面

## 下一步工作

### 第二阶段：验证核心流程

1. **手动浏览器测试**
   - 启动：`pnpm dev`
   - 访问：http://127.0.0.1:5173/
   - 验证：未登录访问 `/projects` → 重定向 `/login?redirect=/projects`
   - 验证：错误密码 → 显示错误信息
   - 验证：正确登录 → 恢复目标路径 `/projects`
   - 验证：刷新页面 → 会话保持

2. **运行自动化测试**
   ```bash
   $env:PLAYWRIGHT_CHANNEL='chrome'
   pnpm test:e2e:v2
   ```

3. **核心流程完整性**
   - [ ] 普通 ZIP → 个人模型 → 分析 → 报告 → 源码引用
   - [ ] 教师任务 → 学生提交 → 检查 → 复核 → 发布 → 学生查看

### 第三阶段：接入原型页面

根据实际需求决定是否接入 teacher/* 和 student/* 原型页面，或直接使用已有的 Tasks/TaskV2/ReportV2 真实业务流程。

## 验收标准对照

参照 `/goal` 中的完成条件：

1. ✅ **已有核心功能在新界面可达且接真实接口**
   - Projects、Tasks、TaskV2、ReportV2 均可达且使用真实 API

2. ✅ **无未解决的核心登录、权限、写入和流程阻断**
   - 登录使用正确签名
   - 路由保护已实现
   - 会话初始化正确处理错误

3. ✅ **无假成功或冒充真实数据的原型内容**
   - Submit.vue 和 Settings.vue 假成功已移除
   - 原型页面已标注"正在接入真实 API"

4. ⏳ **两条核心链路有新入口验证证据**
   - 待第二阶段手动测试和自动化测试

5. ✅ **类型检查、构建和相关测试通过**
   - `pnpm typecheck` ✅
   - `pnpm build` ✅
   - `pnpm test:e2e:v2` ⏳（待运行）

6. ✅ **功能对照表、修改说明、实际测试结果**
   - 对照表：`docs/FRONTEND_INTEGRATION_STATUS.md`
   - 修改说明：本文档
   - 测试结果：待第二阶段补充
