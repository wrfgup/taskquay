# 2026-09-12 主控独立核对

本轮主任务是复用本地新增的 Voice Memory 发布和 COS 候选，完成正式存储切换。这里仅记录 DevSpace 当前工程与观察路径的检查，不混入业务验收结论。

当前 HEAD 为 `c7394fe`（managed Codex turn ownership）。原有 `repair-installed-codex.ts`、`codex-projects.ts` 等未提交修改保留；没有为主任务 reset/stash、重新绑定项目或改写原线程。

主控重新枚举源码、测试运行器、package/lock/TypeScript 配置，计算的源指纹为：

```text
0f020708bb08bd7320ea295bfd26276bc14cc09916b23ee339810fc856862a77
```

与最新完整测试收据 `releases/test-receipts/2026-09-12T01-19-48-930Z-9f52e371-c493-4d99-8f87-87ea746ea963.json` 前后指纹一致。该收据为318 tests / 311 pass / 0 fail / 7平台skip。因此没有为未改变的源再次跑相同全量测试，也没有将skip算成通过。

本次直接工作区读写、命令执行、持久快照均已实际使用。普通 `agent_task list` 曾返回 daemon startup failure；现有 `cos-closure-control-20260912.ts observe` 使用当前有效配置的同一认证daemon，成功读出原失败线程的元数据，未发起推理。原线程的 protocol error 是历史恢复失败，不等于新的COS复制失败或没有产物。

没有通过本记录宣称所有常驻MCP组件都已热更新，也没有在正式迁移期间重启MCP、清理锁或重启正在执行的业务服务。COS由既有受审查原生引擎执行，长时观察命令持有两机资源声明，避免并行部署误入；用户完成的候选和测试被复用。

本轮没有新建Codex推理执行。实际业务模型调用由后续独立端到端测试记录，不能把“没有新Codex推理”扩大成“没有模型调用”。
