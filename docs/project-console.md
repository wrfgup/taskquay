# 项目任务台、任务用量回执与受管会话归档

实施日期：2026-09-06。源码起点 `914e9a1`。本批不替换当前服务的 dist、不重启连接、不发布 npm 包，也不归档用户现有会话。

## 入口与认证

正常更新并重启 DevSpace 后，在现有服务地址后加 `/console/`。本机默认端口的示例：

```text
http://127.0.0.1:7676/console/
```

使用已有 DevSpace 授权口令（owner token）登录。口令不进入 URL、localStorage 或数据库；浏览器会话使用 HttpOnly、SameSite=Strict cookie，HTTPS 时设置 Secure。POST 要求精确 Origin 和 CSRF token。会话在服务端内存中保存，重启后重新登录；MCP bearer 令牌不直接成为浏览器会话。

```json
{"console":{"enabled":true,"allowRemote":false,"sessionTtlSeconds":3600}}
```

默认只接受本机连接及本机 Host。远程访问必须明确开启 allowRemote，并使用与 server.publicBaseUrl 匹配的 HTTPS 入口。反向代理信任只按现有受控代理启用，不开放任意 Host 或明文远程入口。登录有速率和会话数量限制，全部管理数据和写操作独立鉴权。

## 页面与来源

项目页包含任务、Codex 会话、用量、需处理项。任务执行状态与独立验收状态分开，详情显示每轮执行、来源、版本化用量回执和证据引用。普通刷新仅读本地账本，不调用模型或启动 provider 元数据进程。

项目来自已登记的 DevSpace 工作目录；目录别名归并到真实 checkout，不按同名目录或 remote URL 合并项目。独立 worktree 当前保留为独立工作目录。历史会话只导入可证明的 DevSpace 关联，标为 historical_association 并默认保护，不伪造创建证明或完整用量。

来源分为 chatgpt_mcp、other_mcp、devspace_cli、console 和 legacy_unknown。客户端报告的会话信息、client name 与 model label 标为 client_reported，不冒充已认证的具体模型。标题包含 DevSpace、cwd 相同或 source=appServer 都不是归档授权证据。

新受管 Codex 线程在 turn/start 前登记项目、agent、实例、线程 ID 和创建事实。实例指纹使用本机、Codex home、执行程序及可核对账号信息，只保存摘要；不能确认身份时禁止自动归档。新线程通过 `thread/name/set` 设置 `[DevSpace][项目][工作短号] 标题`；命名失败不重跑推理，后续 resume 不覆盖用户后来改过的名字。

## 一项任务、一份回执

新增原生 `work_task`。主控直接阅读前开始工作，即使无需 Codex 也登记：

```json
{"action":"begin","workspace_id":"<workspace>","work_item_id":"console-feature","run_key":"run-1","title":"实现项目任务台","host_model_label":"GPT-6 Pro"}
```

保留返回的 `workRunId`，在 read、workspace_context、apply_patch、exec_command（Claude surface 对应 write/edit/bash）及 agent_task 的 MCP 入参中作为 `work_run_id` 传递。确定性工具登记种类和状态，不保存原始命令、源码或凭据。长命令首次 yield 不等于完成；单次 `yield_time_ms` 最大 12000，继续执行必须使用返回的 `session_id`。

子代理 observe 自动带当次工作回执。主控最终使用 finish 提交验收：

```json
{"action":"finish","workspace_id":"<workspace>","work_run_id":"<returned run>","status":"completed","acceptance":"passed","summary":"修改与回归验证完成","evidence":[{"label":"定向测试","reference":"<actual evidence reference>","outcome":"passed"}]}
```

系统检查子执行、长命令和占用是否已结束，验收通过须有明确证据且不能混有失败证据。证据由主控提交，系统不把任意字符串引用自动认证为测试真的执行；实际运行与检查仍由主控负责。模型 final response 不自动成为验收通过。重复 finish 不能静默改写已关闭结果。

完成回复与管理页计算同一回执，包含 workRunId、executionStatus、acceptanceStatus、codexUsage、usageStatus、missingExecutions、线程创建/复用数和 receiptRevision。主控最后直接使用该回执，注明完整性。旧客户端未传 workRunId 的原始 shell 行为不能自动归因，外部工具自行调用模型的费用不补进本账本。CLI 来源与 MCP 主控的工作运行分别登记。

## 用量边界

- WorkItem 是连贯目标，WorkRun 是一次可验收工作，AgentTurn 对应实际 provider turn。会话复用、请求幂等和累计计量是不同维度。
- 新受管线程可建立零基线。恢复线程时必须核对先前 turn IDs 全部已纳管、边界连续且前次完整累计已知；外部续写、缺失 turn、实例变更不归到本次任务。
- 失败、修正、重试的已知消耗仍计入。缓存输入和推理输出是明细，不在总量上重复相加。聚合不受旧“最近 20 条快照”展示窗口限制。
- 终态后有短暂收敛窗口；迟到通知更新原回执版本，必要时修正下一轮基线，防止重复计量。超出进程接收窗口或完全缺失的通知，不承诺自动恢复。
- 状态为完整、部分、未知、未调用；未知不显示为零。账本是受管 Codex 执行的 provider 数据，不等于订阅余额、API 金额或所有外部模型的账单。

## 项目归档与恢复

只调用 Codex lifecycle RPC，不移动、改写、删除 provider 的 SQLite 或 JSONL 文件。

预览冻结项目、登记会话 IDs、版本、快照、到期时间和确认哈希。每批最多 100 个，并有预览时间预算；预算耗尽的候选明确跳过，要求缩小选择。之后新建的会话不会加入原批次。

候选必须有创建证明与匹配实例、所有关联工作已关闭且验收明确、无活动执行、无用户保护或外部续写。不完整用量须用户明确接受保留部分回执。恢复只处理本系统已成功归档的会话。用户直接创建且未登记的聊天不在可变更范围。

确认要求登录会话、CSRF、原批次哈希，以及用户确认其他独立 Codex 客户端已暂停操作。DevSpace 不能锁住外部客户端，不能宣称全局互斥。每次 HTTP 请求处理一个条目，重新核查状态并先保存意图，再执行及回验。断线或回执缺失进入 reconciliation_required，只对账，不盲目重放。成功条目不重复执行，任务与用量历史保留。

安装版本的 thread/list 默认过滤非交互来源，因此后代检查显式包含全部支持的 sourceKinds 和所有 modelProviders，并处理完整分页。列表不完整、循环游标、未知父子关系或未归档后代都会阻止操作。当前保守跳过存在未归档后代的父会话，不实现递归树归档。元数据检查有时间与数量上限。

**归档不是取消任务、清理僵尸进程，也不是永久删除。** 页面不提供全局 kill、删除未纳管聊天或不经确认的自动归档。中断的受管执行被标记待核对，claim 不凭 PID 或超时自动抢占。

## 验收与发布边界

Node 24、Codex CLI 0.135.0；数据库迁移 11，daemon 协议 6。源码、工具 schema、配置、页面和协议适配需要一起更新，宿主工具列表可能需重新加载。候选位于 `node_modules/.cache/devspace-console/dist`，没有覆盖 live dist。

专项测试覆盖账本幂等、跨工作区限制、纯主控零用量、26 轮汇总、失败计量、外部续写、迟到基线修正；HTTP 鉴权、Origin/CSRF/Host/远程默认拒绝、过期；MCP 真实传输回执与 yield 后继续阻止结算；JSON-RPC 夹具的新线程命名、turn 归属和迟到用量；归档的范围、预览冻结、活跃/外部/后代保护及未知副作用不重放。

编译后的页面已在真实隔离浏览器以 1440×1000 和 390×844 检查。来源筛选、详情回执、移动端无整页横向溢出、XSS 转义、无口令 localStorage、归档确认与恢复（假 provider）通过。截图与日志仅在忽略的候选目录中。曾发现 `.cache` 父目录导致绝对 sendFile 路径被默认 dotfile 策略拒绝，已改为相对可信资源根目录提供固定页面并补回归。

最终全仓结果：**151 项，148 通过、0 失败、3 跳过**。Pi 沙箱集成另在文件内部报告依赖不足，不算已运行。类型检查及隔离 TypeScript/Vite 构建通过；原有大于 500 KiB 分块警告仍为非致命提示。最终编译后浏览器复验还覆盖任务回执深链接，以及真实 MCP 传输的 host-only 完成回执与页面账本一致。

验收证据（本机忽略目录，仅合成数据）：

```text
node_modules/.cache/devspace-console/tests-final.log
node_modules/.cache/devspace-console/build-final.log
node_modules/.cache/devspace-console/ui-acceptance.json
node_modules/.cache/devspace-console/provider-lifecycle.json
node_modules/.cache/devspace-console/console-desktop.png
node_modules/.cache/devspace-console/console-mobile.png
node_modules/.cache/devspace-console/console-detail.png
node_modules/.cache/devspace-console/console-archive-preview.png
```

**真实 provider 限制**：用全新隔离 CODEX_HOME、未发送任何 turn/start 的空线程探测，创建、命名、归档收到成功响应，thread/read 的路径确认已归档；但空线程未列入清单，恢复返回 -32603。它不是有内容会话的完整真实客户端归档/恢复验收。没有读取或操作现有用户聊天，隔离目录已清理。真实已授权账号中有内容的测试会话以及 Codex 桌面列表刷新，仍需正式启用前验证；不把 mock 或单个 ack 当作该项通过。

本批无 npm 发布、Git push、当前服务重启或 Codex 推理调用。正式启用归档前先用明确的新测试会话验证自己的实例；信息不足时应停在跳过/待核对，不强行操作。
