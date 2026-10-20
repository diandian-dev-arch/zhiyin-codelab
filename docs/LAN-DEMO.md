# 小组校园网演示

当前访问地址：<http://10.38.31.238:5174/>。仅适用于能与演示电脑互访的校园网设备，不是公网部署。

教师账号 `teacher@codelab.local`，学生账号 `student@codelab.local`，密码沿用本机已有账号。共享账号会看到同一份数据。不要向组员发送包含数据库密码的整个凭据文件；在项目根目录只读取登录密码：

```powershell
(Get-Content .data/business-v2/development-credentials.json -Raw | ConvertFrom-Json).loginPassword
```

演示电脑必须保持开机、不休眠，Docker Desktop 与工作台保持运行。已经运行时不要重复启动；关闭或重启电脑后，在项目根目录执行：

```powershell
pnpm runner:desktop up
pnpm dev:workspace:supervised
```

LAN 配置保存在私有 `.data/workspace-lan.json`，启用后前端监听 5174，API、数据库和执行器继续仅绑定本机。API 明确允许本机地址和配置的 LAN 来源，仍校验会话与 CSRF。普通 LAN HTTP 的 UUID 使用浏览器加密随机数兼容实现。

Windows 防火墙规则 `CodeLab-Team-LAN-5174` 仅允许通过当前以太网接口、访问本机 `10.38.31.238:5174` 的 `10.0.0.0/8` 来源。组员 IP 不属于此段或学校隔离设备时，不能据此断定软件故障。不要关闭整个防火墙。

校园网 IP 改变后，需要更新 LAN 配置与 `scripts/enable-lan-firewall.ps1` 中的地址，重新应用规则并重启工作台；配置中地址不属于本机时，启动会拒绝继续。

2026-09-30 本机验证：通过 LAN IP 的 HTTP 健康检查成功；Chrome 教师/学生真实表单登录、任务列表和任务链接导航通过；HTTP UUID 兼容检查通过；不受信任的来源及缺失 CSRF 的写请求返回 403；页面无 JS 异常。类型检查和前端构建通过。本轮未创建新的执行任务，也未验证另一台组员电脑的网络连通性。

可重复运行 `node --import tsx scripts/verify-lan-demo.ts`（使用项目认可的 Node 运行时）。脚本不打印密码、不调用模型，不创建任务。

结束共享时，把 `.data/workspace-lan.json` 的 `enabled` 改为 `false` 后重启工作台，并在管理员 PowerShell 中执行：

```powershell
Remove-NetFirewallRule -Name 'CodeLab-Team-LAN-5174'
```

HTTP 不加密传输，组内演示请使用演示账号与获准样本。
