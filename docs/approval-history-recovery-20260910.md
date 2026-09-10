# 本地审批与分页历史恢复（2026-09-10）

## 实际根因与边界

此前 Codex 适配器把 `version === "0.153.4"` 和 `historyMode=paginated` 直接等同为永久不可恢复，并在原生 `thread/resume` 前返回 `PAGINATED_HISTORY_UNSUPPORTED`。这会把版本字符串误当能力事实，也会使上下文亲和逻辑再次选中同一条已知失败记录。宿主提供的现有事实表明分页摘要可读，但 full read/resume 仍可能不受支持；本实现不把删除 preflight 冒充为原生恢复成功。

现在每次接续先用受控 `thread/read(includeTurns=false)` 核对返回 thread id，然后实际调用原生 `thread/resume`。只有原生返回内容明确说明 paginated history 不支持，才分类为 `PAGINATED_HISTORY_UNSUPPORTED`；CLI 版本仅作为诊断字段，旧版、未知版都服从真实协议结果。原生 resume 返回不同 thread id 时，在发送 turn 前拒绝。

ChatGPT／OpenAI 宿主的安全判断、隧道、OAuth、根目录和全局 Codex 配置不属于 DevSpace 的可控审批层。本地受管 thread 与 turn 继续发送 `approvalPolicy: "never"`，也不删除权限与执行锁。后来新增的所有者开关 `tools.dangerouslySkipCommandReview` 只改变 MCP shell 工具的 `destructiveHint`，表示所有者已预授权远端命令；默认关闭，`readOnlyHint` 仍为 false，宿主可以继续强制确认。provider 意外请求交互审批时仍收到明确的不可交互、未批准错误；该开关不会自动放行 provider 的网络、提权或未知请求。

## 可选的显式 handoff

默认未启用。所有者审查后可在该工作区实际使用的 `config.jsonc` 中为 Codex provider 设置：

```jsonc
{
  "subagents": {
    "enabled": true,
    "providers": [
      {
        "id": "codex",
        "enabled": true,
        "historyHandoff": "verified-unsupported"
      }
    ]
  }
}
```

启用不代表任意失败都会开新线程。必须同时满足：原 thread id 已核对；其 `cwd` 与当前 workspace 相同；状态为 `idle` 或 `notLoaded`；`historyMode` 为 `paginated`；原生 resume 明确拒绝这种历史；当前 continuation 带新的 `requestKey`。工作项、workspace scope、并发锁和新会话预算仍由 manager 的既有检查约束。quota、认证、收费、传输/未知结果、活跃原 turn、跨 workspace 都不会 handoff。

handoff 创建新的空 thread，记录 `recoveryType=fresh_thread_handoff` 与 `parentProviderSessionId`，随后只发送主控本次明确 prompt 和经哈希复核的 host context。它不读取或复制原私人历史，不篡改 SQLite/rollout，不冒充 legacy resume，不自动重放旧成功响应中的发布命令。旧成功响应和 work ledger 回执继续保留；handoff 结果不等同完整上下文恢复。

失败结果的 `nextAction` 使用现有 schema 可执行的 `agent_task.continue` 路径：先 `observe` 确认终态，再以同一 `agentId`、同一 `workRunId`、新的 `requestKey` 和新的明确 prompt 调用 continue。自动 context 复用会跳过带已知 `PAGINATED_HISTORY_UNSUPPORTED` 错误的记录，避免反复自动选中；直接指定原 agent 仍可在升级 provider 后重新尝试原生 resume。

## 本阶段验收与未启用状态

本阶段只用内存/临时目录假 App Server 走真实 JSON-RPC pipe，不调用付费模型，不读取被拦线程历史，不查询 daemon，不重启服务。定向验收命令：

```powershell
pnpm exec tsx --test --test-concurrency=1 src/codex-project-runtime.test.ts src/codex-work-protocol.test.ts src/codex-read-policy.test.ts src/local-agent-config.test.ts src/readonly-workflow.test.ts src/receipt-recovery.test.ts
pnpm typecheck
pnpm exec tsc -p tsconfig.build.json --outDir .tmp/history-recovery-build
git diff --check
```

夹具覆盖原生 paginated resume 成功（含旧版本字符串）、明确不支持时默认拒绝与显式 handoff、未知版本、同 thread identity、quota 不 fallback、重复 `requestKey` 不重复 turn、旧成功回执保留、跨 scope、会话预算和本地 approval policy。源码构建成功不表示 live server 已加载；本提交不 push、不重启、不修改线上配置，因此 handoff 当前未启用。
