# CodeLab 应用说明

## 概述

CodeLab 是一个完整的前端应用，已集成到 Vue 3 项目中。所有页面都已从独立的 HTML 文件转换为 Vue 组件，并使用了自定义设计的 SVG 图标（替代了原有的 emoji）。

## 项目结构

```
apps/web/src/
├── AppCodeLab.vue          # 主应用组件（带交互式背景）
├── main-codelab.ts         # CodeLab 应用入口
├── router-codelab.ts       # 路由配置
└── views/
    ├── Landing.vue         # 首页/着陆页
    ├── Login.vue           # 登录页（带角色选择）
    ├── Settings.vue        # 设置页
    ├── Notifications.vue   # 通知页
    ├── teacher/
    │   └── Tasks.vue       # 教师任务列表页
    └── student/
        ├── Courses.vue     # 学生课程列表页
        └── Submit.vue      # 学生提交作业页
```

## 已实现的功能

### ✅ 核心页面
1. **Landing (/)** - 着陆页，展示 CodeLab 特性
2. **Login (/login)** - 登录页，支持教师/学生角色选择
3. **Teacher Tasks (/teacher/tasks)** - 教师任务管理页
4. **Student Courses (/student/courses)** - 学生课程列表页
5. **Student Submit (/student/submit/:id)** - 学生作业提交页
6. **Settings (/settings)** - 设置页
7. **Notifications (/notifications)** - 通知页

### ✅ 设计特性
- **SVG 图标系统**：所有 emoji 已替换为精美的自定义 SVG 图标
- **Paper-fold 美学**：折角效果、纸张质感背景
- **交互式背景**：鼠标移动时背景动态响应
- **响应式设计**：支持桌面和移动端
- **统一配色**：使用 CSS 变量管理颜色主题
- **流畅动画**：卡片悬停、页面切换等动画效果

### ✅ 技术栈
- Vue 3 (Composition API)
- TypeScript
- Vue Router (Hash 模式)
- Pinia (状态管理)
- Vite (构建工具)

## 如何启动

### 方式 1：直接访问（如果服务器已运行）
访问：http://127.0.0.1:5174/

### 方式 2：手动启动
```bash
cd apps/web
WEB_PORT=5174 pnpm dev
```

## 路由结构

```
/                           -> Landing 页面
/login                      -> 登录页
/teacher/tasks              -> 教师任务列表
/student/courses            -> 学生课程列表
/student/submit/:id         -> 提交作业
/settings                   -> 设置
/notifications              -> 通知
```

## 待完成的页面

以下页面需要继续创建（已有设计文件可参考）：

1. **Teacher Review** (`/teacher/review/:id`) - 教师审阅作业
2. **Teacher Students** (`/teacher/students`) - 学生管理
3. **Teacher Analytics** (`/teacher/analytics`) - 数据分析
4. **Student Report** (`/student/report/:id`) - 学生查看报告

对应的设计文件位于 `design-proposals/` 目录：
- `page-teacher-review.html`
- `page-teacher-students.html`
- `page-analytics.html`
- `page-student-report.html`

## 图标系统

所有图标都是内联 SVG，便于自定义颜色和大小。主要图标类型：

### 教育类
- 毕业帽（教师标识）
- 学生头像
- 课程/书籍

### 操作类
- 上传（带虚线边框）
- 提交/确认（勾选标记）
- 编辑（代码括号）

### 状态类
- 时钟（截止时间）
- 用户组（学生数量）
- 星星（评分）

### 导航类
- 返回箭头
- 设置齿轮
- 通知铃铛

## 样式规范

### 颜色变量
```css
--bg-primary: #fdfbf7;      /* 主背景 */
--bg-card: #fffcf5;         /* 卡片背景 */
--text-primary: #1a1a1a;    /* 主文字 */
--text-secondary: #5a5a5a;  /* 次要文字 */
--accent-blue: #4682b4;     /* 蓝色强调 */
--accent-green: #4caf50;    /* 绿色强调 */
--accent-orange: #ff9800;   /* 橙色强调 */
--accent-gold: #daa520;     /* 金色强调 */
```

### 折角效果
使用 `.fold-corner` 类实现纸张折角：
- `.fold-corner-tl` - 左上角
- `.fold-corner-tr` - 右上角
- `.fold-corner-br` - 右下角
- `.fold-corner-bl` - 左下角

### 字体
- **正文**：Inter, -apple-system, sans-serif
- **标题**：Noto Serif SC（中文衬线）
- **代码**：JetBrains Mono

## 下一步建议

1. **完成剩余页面**：按照设计文件创建 4 个待完成的 Vue 组件
2. **API 集成**：替换 mock 数据为真实 API 调用
3. **状态管理**：使用 Pinia 管理全局状态（用户信息、课程列表等）
4. **权限控制**：添加路由守卫，确保角色权限正确
5. **性能优化**：路由懒加载、图片优化
6. **测试**：添加单元测试和 E2E 测试

## 注意事项

- 当前使用 Hash 模式路由（`createWebHashHistory`），URL 带 `#`
- 如需切换回原有应用，修改 `apps/web/index.html` 中的入口文件为 `main.ts`
- 所有图标都是 SVG，可通过 CSS `color` 属性改变颜色
- 背景动画依赖鼠标事件，移动端会降级为静态背景

## 浏览器兼容性

- Chrome/Edge 90+
- Firefox 88+
- Safari 14+
- 移动端浏览器

---

**当前状态**：✅ 核心功能已完成，可以直接访问 http://127.0.0.1:5174/ 查看效果
