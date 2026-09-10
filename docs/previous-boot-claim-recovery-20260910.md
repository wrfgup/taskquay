# 系统重启后遗留任务锁的定向恢复

2026-09-10 重新连接后，MCP 可读取两个原任务的失败回执，但源码读取仍被它们的旧写锁阻止。原任务分别于 04:20:25 UTC、04:22:48 UTC 获得 claim，拥有者 PID 35512；Windows 的实际 LastBootUpTime 为同日 04:34:51 UTC。原执行已由原生生命周期标记为 `reconciliation_required`，session 错误为 `DAEMON_UNAVAILABLE`。系统级重启与普通 DevSpace 重启不同：它能证明前一启动期的进程及其子进程已不存在。

新增显式维护脚本 `scripts/recover-previous-boot-claims.mjs`。缺省只 dry-run；必须逐项指定已回读的 claim ID，显式 `--apply` 才操作。脚本从 Windows CIM 获取真实启动时间，不允许命令行伪造。仅匹配早于启动至少五秒的 agent claim，验证同 workspace 的失败 session、最新执行仍待核对、无新队列，再在 SQLite 即时事务中比较完整归属删除精确旧锁。所有候选必须同时通过；当前启动期、活跃/未知任务、其他 workspace、普通 command、换账号/新执行等均拒绝。删除前保存完整但不含提示词的生命周期审计，完成后保存提交回执。

这不是按超时抢锁，不会放宽后续互斥，不启动模型、不重放发布、不改变历史结果或补造用量。仅 DevSpace 服务重启而 OS 未重启的遗留锁不符合条件，必须走更强的进程/子进程核对。相同操作再次执行发现 claim 缺失会拒绝并要求核对原审计，不暗示重复执行成功。

测试：`node --test test/previous-boot-claims.test.mjs`，覆盖 dry-run、唯一指定删除、活跃/跨域/新执行/新队列/格式错误、混合候选原子拒绝与幂等重试边界。使用独立内存数据库和临时目录，不触及用户状态。

首轮真实 dry-run 拒绝且无副作用：模型面显示 `failed`，实际 session 存储使用 `error`。精确只读这两个 session 的状态、根路径与最新执行元数据后，按实际存储契约修正测试和判断，不扩大允许状态集合。

运行示例：`node scripts/recover-previous-boot-claims.mjs --state-dir <实际DevSpace状态目录> --claim <已确认ID>`。先审核 dry-run，再加 `--apply`。恢复仅解除无执行者的锁，随后仍须核对源代码和目标环境的实际副作用、重新测试，再决定是否继续任务。

另已确认宿主缓存 camelCase 工具目录而新服务使用 snake_case。相同值的显式新字段可恢复调用；这属于参数契约差异，不是 OpenAI 安全审批。没有篡改工具只读声明、关闭宿主检查或隐藏实际操作。

## 现场执行与回验

2026-09-10 13:48:49 UTC，12 项隔离测试全通过后，真实 dry-run 按 CIM 确认启动时间 `04:34:51.500Z`，再次匹配两个明确 ID 后执行成功：仅释放 DevSpace 的 `claim_8d9a4509318845369e3a0780c4401226` 和 yaxian 的 `claim_f2b18d2f37ae451f9d89f4743796742c`。原来的执行状态继续为待核对，计量历史没有改写，也没有发送任何模型或部署请求。

审计位于实际状态目录 `recovery/1789048129548-da8373b4-321c-4542-86cd-58de1bc7fe41.prepared.json` 及同名前缀 `.completed.json`；受管操作 `op_d933129ae6e34f078b247143b0978e43` 退出 0。随后通过原生 MCP 读取 yaxian AGENTS 并核对 Git 成功，确认保留了上午未提交的 5GiB 实现，而不是重新创建功能。没有解除任何本次启动期的 claim。
