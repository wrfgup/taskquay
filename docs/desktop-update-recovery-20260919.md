# Codex Desktop 0.155 执行恢复（Market News前置）

2026-09-19核验：provider command仍指向已失效的bffc5354119c8421目录；当前安装文件是247581e40ee272fb/codex.exe，版本0.155.0-alpha.9.2。

通过既有setDevspaceConfigValue仅修正Codex command，先备份配置，解析后对比其他全部配置未变。没有修改审批、权限、并发、账号、Codex Home或历史线程。npm codex.cmd仍为0.135.0，不能拿它替代新版协议。

对当前二进制执行app-server generate-json-schema --experimental，原始schema位于.local/codex-schema-0155-20260919。核对Project/List/Create/Read、Thread/Read和Thread/MetadataUpdate的使用字段、ProjectRoot及对象身份字段。新增recencyAt等字段由既有passthrough容纳；不通配接受未来版本，不放宽运行时schema/归属核验。

增加仅针对0.155.0-alpha.9.2的版本允许和后续版本仍拒绝的测试。实际项目注册、模型启动与业务部署仍须分别验收。

主MCP进程缓存旧provider配置；沿20260912现有受管恢复设计，使用scripts/market-news-control-20260919.ts绑定原workspace/run/agent并通过正常认证daemon、scope、queue和ledger接续。该脚本只接受明确的推理前PROVIDER_UNAVAILABLE，不清锁、不改数据库、不跳过安全检查，不修改其他任务。完成前必须验证真实provider turn，不把running初始回执视为模型执行成功。
