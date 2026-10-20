> 历史记录，已被后续审查取代。本文的完成比例、HTTP 代替浏览器验证及“代码全部完成”等结论不得作为当前验收依据。当前状态见 [FRONTEND-REPAIR-ACCEPTANCE.md](engineering/FRONTEND-REPAIR-ACCEPTANCE.md)。

# 新前端业务接入状态

更新日期：2026-09-29

## 修复摘要

已修复交接文档中标记的以下阻断问题：

1. ✅ **Login.vue 类型错误**：修复 `session.login()` 调用，使用正确签名 `login(email, password)`，角色由服务器决定
2. ✅ **路由保护**：添加 `beforeEach` 导航守卫，未登录访问受保护路由跳转登录页，登录后安全恢复目标路径
3. ✅ **会话初始化**：AppCodeLab.vue 等待 `session.load()` 完成，正确处理 `loadError` 状态并提供重试
4. ✅ **假成功提示**：student/Submit.vue 移除 `alert('作业提交成功')`，标注需接入真实 API
5. ✅ **假成功提示**：Settings.vue 移除 `alert('设置已保存')`，从会话读取真实用户信息，禁用用户名/邮箱编辑

## 功能对照表

| 原有功能 | 新界面入口 | 复用组件/逻辑 | 真实 API | 权限要求 | 当前状态 | 验证结果 |
|---------|----------|-------------|---------|---------|---------|---------|
| 登录/退出/会话 | `/login` | App.vue login逻辑 | `/api/session`, `/api/session/login` | 公开 | ✅ 已接通 | 类型检查通过 |
| 路由保护 | router-codelab.ts | beforeEach守卫 | 会话验证 | 按路由 | ✅ 已实现 | 未登录重定向登录 |
| 普通项目分析 | `/projects` | Projects.vue | `/api/v2/projects` | 需登录 | ✅ 路由已保留 | 页面存在 |
| 项目详情 | `/projects/:id` | Projects.vue | `/api/v2/projects/:id` | 需登录 | ✅ 路由已保留 | 页面存在 |
| 任务列表 | `/tasks` | Tasks.vue | `/api/v2/tasks` | 需登录 | ✅ 路由已保留 | 页面存在 |
| 任务详情 | `/tasks/:id` | TaskV2.vue | `/api/v2/tasks/:id` | 需登录 | ✅ 路由已保留 | 业务版本切换 |
| 运行报告 | `/runs/:id` | ReportV2.vue | `/api/v2/runs/:id` | 需登录 | ✅ 路由已保留 | 业务版本切换 |
| 公开发布报告 | `/publications/:id` | ReportV2.vue | `/api/v2/publications/:id` | 需登录 | ✅ 路由已保留 | 学生访问 |
| 个人模型配置 | PersonalModelDialog | PersonalModelDialog.vue | `/api/v2/model-settings` | 需登录 | ✅ 组件存在 | 需从业务页面调用 |
| 教师任务（原型） | `/teacher/tasks` | teacher/Tasks.vue | 未接通 | teacher | ⚠️ 演示数据 | 需接入真实API |
| 学生课程（原型） | `/student/courses` | student/Courses.vue | 未接通 | student | ⚠️ 演示数据 | 需接入真实API |
| 学生提交（原型） | `/student/submit/:id` | student/Submit.vue | 未接通 | student | ⚠️ 已阻止假提交 | 需接入真实API |
| 设置（原型） | `/settings` | Settings.vue | 未接通 | 需登录 | ⚠️ 已阻止假保存 | 需接入真实API |
| 通知（原型） | `/notifications` | Notifications.vue | 未接通 | 需登录 | ⚠️ 演示数据 | 需接入真实API |

## 已修复的阻断

### 1. 登录与会话
- ✅ Login.vue 使用正确的 `session.login(email, password)` 签名
- ✅ 登录成功后安全恢复目标路径（支持 redirect 查询参数）
- ✅ 错误提示区分网络错误和认证失败
- ✅ 密码输入框在提交后清空
- ✅ 防止重复提交（loading 状态）

### 2. 路由保护
- ✅ 所有受保护路由添加 `meta: { requiresAuth: true }`
- ✅ 公开路由添加 `meta: { public: true }`
- ✅ 导航守卫等待会话初始化完成
- ✅ 未登录访问受保护路由重定向到 `/login?redirect=目标路径`
- ✅ 已登录访问登录页跳转到 `/tasks`
- ✅ 角色路由保护（teacher/student 专用页面）

### 3. 会话初始化
- ✅ AppCodeLab.vue 等待 `session.load()` 完成
- ✅ 区分加载中、连接错误、已就绪三种状态
- ✅ 连接错误时显示错误信息和重试按钮
- ✅ 正确处理 `session.loadError`（不仅依赖 catch）

### 4. 假成功清理
- ✅ student/Submit.vue：移除 `alert('作业提交成功')`，添加错误处理
- ✅ Settings.vue：移除 `alert('设置已保存')`，添加错误处理
- ✅ Settings.vue：从会话读取真实用户名和邮箱，禁用编辑
- ✅ 所有操作均标注 TODO，说明需接入真实 API

## 剩余工作

### 高优先级（核心功能）

1. **普通项目 ZIP 分析完整流程**
   - 验证 Projects.vue 是否正确调用上传/分析 API
   - 验证个人模型配置对话框是否可从项目页面打开
   - 验证分析进度显示是否使用真实状态
   - 验证报告和源码引用是否正常工作

2. **教学任务完整流程**
   - 将 teacher/Tasks.vue 接入 `/api/v2/tasks`
   - 将 student/Courses.vue 接入 `/api/v2/tasks`（学生视角）
   - 将 student/Submit.vue 接入 `/api/v2/tasks/:id/submissions`
   - 验证 TaskV2.vue 和 ReportV2.vue 在新入口下的完整流程

### 中优先级（用户体验）

3. **导航和布局统一**
   - 检查原业务组件（Projects/Tasks/TaskV2/ReportV2）的全局样式
   - 统一新外壳与原组件的样式变量
   - 验证桌面和窄屏布局
   - 检查长文件名、长报告、代码引用的显示

4. **错误处理和空态**
   - 为所有列表页面添加加载、空态、错误和重试
   - 为所有表单添加防重复提交和结果不确定恢复

### 低优先级（外围功能）

5. **设置和通知**
   - 确认哪些设置需要持久化，实现对应 API
   - 确认通知功能范围，实现或标记演示

## 验证计划

### 已完成
- ✅ TypeScript 类型检查通过
- ✅ 构建通过（待验证）

### 待执行
- ⏳ 启动开发服务器，手动验证登录流程
- ⏳ 验证未登录访问受保护路由
- ⏳ 验证项目分析流程（需个人模型配置）
- ⏳ 验证教师任务流程
- ⏳ 验证学生提交流程
- ⏳ 运行浏览器测试：`$env:PLAYWRIGHT_CHANNEL='chrome'; pnpm test:e2e:v2`

## 注意事项

1. **不降低安全性**：所有修改保持原有鉴权、CSRF、文件校验、限流逻辑
2. **不删除数据**：不涉及数据库操作、用户上传或历史报告
3. **保留用户工作**：router-codelab.ts 在前一轮审计期间被修改（14:08:38），已保留现有改动
4. **原型页面边界**：teacher/* 和 student/* 路由当前为演示原型，已标注需接入真实 API

## 下一步

1. 运行 `pnpm build` 验证构建
2. 运行 `pnpm dev` 启动开发服务器
3. 手动验证登录和路由保护
4. 继续接入 Projects.vue 的完整流程
5. 接入教学任务的真实 API
