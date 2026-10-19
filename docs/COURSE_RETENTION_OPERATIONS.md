# 课程历史维护命令

仅供可信本机操作者使用，不是老师/学生网页权限接口。适用整个“任务＋学生”的课程历史；不得自动生成真实授权或根据年龄自动删除。真实课程必须先取得负责人确认的政策、授权及外部引用审核。

入口：`pnpm retention:course --desktop <action> <request.json>`。

命令只连接已运行、具有预期标签和本地端口的CodeLab桌面数据库；不迁移、不启动容器。所有动作要求迁移017已部署。[2026-09-29已完成部署](verification/2026-09-29/COURSE017-DEPLOYMENT.md)；低版本仍返回`RETENTION_MIGRATION_REQUIRED`。原`retention:course-plan`只读预览入口仍可用。部署不代表获得真实课程删除授权。

请求使用本地JSON文件（单文件、非链接、单硬链接、最大16KiB），建议保存在已忽略的`.data`私有目录，勿提交源码仓库。命令错误只输出固定代码，不输出SQL行或密钥。Windows实际访问权限仍由目录ACL管理。

| action | JSON内容 | 行为 |
| --- | --- | --- |
| plan | `taskId`、`studentId` | 只读影响清单，不授权 |
| freeze | `taskId`、`studentId` | 全局课程空闲时短暂锁定写入，返回当前完整历史指纹与影响清单 |
| authorize | 下方授权字段 | 登记操作者的授权声明，不自动删除 |
| revoke | `authorizationId`、新`requestId`、`reason` | 撤销未执行授权；活动课程任务期间也可用 |
| delete | 下方删除字段 | 单事务删除已授权范围并登记证据清理队列，不删文件 |
| status | `batchId` | 只读批次、各状态数量/尝试次数，无证据正文 |
| cleanup | `batchId`、`confirm: "CLEAN_COMMITTED_COURSE_EVIDENCE"` | 每次处理一个文件，或返回complete；不会递归删除目录 |

所有ID使用实际UUID。先查看plan，再在维护窗口运行freeze，人工核对影响范围及保留阻止项后使用最新fingerprint。freeze会短暂阻止全部课程写入，普通读取不受该表锁阻止；它不代表授权通过。

authorize字段：`taskId`、`studentId`、`fingerprint`、唯一`requestId`、`ttlSeconds`（1—86400）、`reason`、`policyReference`、`authorizationReference`、`externalReferencesReviewed: true`、`confirm: "AUTHORIZE_EXACT_COURSE_HISTORY"`。文本至少3字、最多300字。引用必须指向操作者实际核验的授权和政策，不得填夹具占位值用于真实资料。

delete字段：`taskId`、`studentId`、授权回执`authorizationId`、新`requestId`、相同`fingerprint`、`confirm: "DELETE_EXACT_COURSE_HISTORY"`。过期、撤销、范围变化、活动保留或外部引用阻止删除。成功回执包含batchId；相同请求重试重放同一批次。不同含义不可复用requestId。

保存命令回执。数据库删除成功后先status，再逐次cleanup直到complete；blocked时检查诊断后处理原因，不运行无限循环。数据库删除已经提交后，撤销或过期不会取消剩余文件清理。completed回执不可重开；文件损坏或路径不安全时原件保留。队列只含已核验清单文件，不清空目录、不删除未登记孤立材料。

删除成功是不可逆业务操作；事先完成可恢复备份与引用审核。CLI没有自动备份功能，也不能证明授权声明真实有效。可信数据库管理员边界、保留政策和生产隔离限制仍适用。

## 2026-09-29验证

`tests/course-retention-command.test.ts`真实PostgreSQL **2/2**、根TypeScript通过。覆盖迁移缺失拒绝、预览/冻结、授权/撤销、撤销后拒绝、错误确认拒绝、删除及幂等重放、空队列status/cleanup。此次入口服务测试使用无Run提交，未执行桌面CLI对真实库的写操作；非空证据消费者另有[实际子进程恢复证据](verification/2026-09-29/COURSE-CLEANUP-PROCESS-RECOVERY.md)。不能把空队列入口测试视作完整真实业务CLI验收。

首轮因脚本目录无zod依赖而无法加载；将命令服务放回API包后，最终类型与真实PG测试通过。临时数据库资源已清理，0模型请求、0真实资料删除。后续仍需部署前备份、迁移及受控桌面入口验收。
