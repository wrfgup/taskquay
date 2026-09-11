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

## 同一 thread 的实时控制补充（2026-09-11）

新增控制不改变上述恢复结论。DevSpace 仅在启动 active turn 的原 app-server 连接上保存不可序列化控制句柄；`steer` 要求精确 `expectedTurnId`，`interrupt` 收到 RPC 回执后仍等待 `turn/completed`。控制 request key、作用域、thread/turn 与单写者状态会持久记录，但 RPC 连接不会从 SQLite 重建。进程重启遗留的活动控制进入 `reconcile_required`，不得自动重发。

Codex Desktop 通过官方 `codex://threads/<thread-id>` 打开同一 thread。管理台是本实现保证的实时显示面；Desktop 原生聊天窗的自动刷新仍是宿主客户端行为，不等同于 DevSpace app-server 订阅。owner 可在管理台中断后显式接管；接管期间远端续写被拒绝。归还前只读核对同实例、同 workspace、终态和 idle/notLoaded，随后新的明确请求才允许走原生 resume；若原生明确拒绝分页历史，仍只使用前述已授权 handoff，不重放旧发布指令。

本补充不修改 approval policy、宿主安全检查、隧道、OAuth 或全局 Codex 配置。源码、daemon 协议 8、数据库迁移 17 和任务台必须一起发布；当前实现阶段未替换 live dist、未重启、未 push，因而线上仍未启用。

## 重新连接后的实际状态（2026-09-10）

前节记载的是实现阶段，不代表后续全部状态。13:38 UTC 后主控已核对：历史修复 `e06e3b8` 与命令 review 配置 `6f34228` 均已进入当前 `main` 和 `origin/main`；用户配置 `tools.dangerouslySkipCommandReview=true`，`historyHandoff` 仍未启用。宿主安全检查仍可能独立拒绝请求，不能把本地配置解释为宿主安全检查被关闭。

两条上午会话的实际剩余阻断为系统重启后遗留写锁。按操作系统启动时间与精确失败会话/最新执行证据恢复两把锁后，原 yaxian agent `agt_c8323c8a` 已通过原生 `continue` 成功继续：仍使用 provider thread `01a0898d-e297-7983-b699-666775889580`，请求 `gpt-5.6-sol / medium`，新执行 `exec_d1214eb201714a7abcf3cc335d8adf5b`。这次未启用 handoff、未新建线程、未报分页不支持；接续执行不等于 Test 发布已验收。维护实现和 12 项测试、审计见[前一次系统启动任务锁恢复](previous-boot-claim-recovery-20260910.md)，修复 `7fa4827` 已 push 并以 `ls-remote` 核实。

主控独立重跑历史相关 TypeScript 套件与类型检查的组合调用被宿主拒绝，没有执行；未改包装或委托代理绕过。已存在的 310 项测试回执（303 通过、7 平台跳过、0 失败）属于源码 `579290c`，与后续模型面 snake_case 合并存在差异，因此不能冒称是当前所有源码的全量回归。12 项前启动期恢复测试和同原线程接续是本轮独立取得的新证据。

用户已重启的 MCP 服务持续处理当前调用；正在运行的 Test 构建不得为再次重启而中断。新恢复器为显式独立维护脚本，不要求替换 live dist。宿主缓存 camelCase 参数而当前服务要求 snake_case 的契约差异已通过实际字段识别，不把参数校验错误误称为账号授权失败或工具审批。
