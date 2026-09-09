# DevSpace 回执恢复与错误总结防护（2026-09-09）

本轮在 `D:\project\devspace` 的 clean HEAD `4ba4283f8e585cefbf9245d84d57f11ce8721031` 上修复。开始时逐字节核验了用户指定的 workspace-context、mcp-request-diagnostics、local-agent-codex 三个 SHA-256，均匹配。Git blob 与 Windows 工作树换行字节不同，因此候选 manifest 另列 Git blob 哈希。

复用 run `run_5d09e6d2dd2047879acae1512040ebc2`、原 workspace `ws_d8f90d20b4`；没有新建顶层 run、启动额外 worker、改 OpenViking/teamEvolver、push、创建 PR、重启生产 MCP/agentd/tunnel 或修改 provider/GUI/权限。新 workspace 的 record 被 scope 检查拒绝后，回到原 workspace 记账，没有绕过 scope。

**已证明的历史事实**

审计时间窗为北京时间 2026-09-09 00:55–01:40，即 UTC `[2026-09-08T16:55:00Z, 2026-09-08T17:40:00Z)`。脚本用 SQLite readonly/fileMustExist 打开显式数据库，仅投影 ID、状态、时间、计数、token 数值及线程指针；没有初始化或迁移生产 DB，没有转储用户 prompt、源文件正文、provider response 或密钥。

`audit-receipt-window.ts` 核验了三个指定 run 和现存两份诊断日志，共 116 个窗内 MCP finish 事件。日志轮转后，相关事件位于 `.jsonl.1`；这不代表完整历史日志都仍存在。

| 北京时间 | workspace | textBytes | responseBytes | 结果 |
| --- | --- | ---: | ---: | --- |
| 00:59:07.929 | ws_f9228d0e8d | 32180 | 36394 | HTTP 200，toolError=false，aborted=false |
| 01:04:00.807 | ws_87f056fe26 | 17124 | 18556 | 同上 |
| 01:06:33.994 | ws_87f056fe26 | 16103 | 18241 | 同上 |

这与用户给出的文本字节数一致；文本字节与整个 HTTP 输出字节不能混用。日志不含 file arguments，不能按 workspace/run/时间猜测对应文件。finish 只证明服务端完成写出，host 是否收到、解析或展示仍为 unknown。

OV 的 `exec_29aa427af81f4f97a882aa0a058e5f02` 是 completed、usage complete、3,066,802 tokens；后续 `exec_44bdb37ceeb041f087680bba93cd327f` 是 failed，requested=0、usage unavailable。TE 指定 run 有 7 个 completed patch、4 个 completed command、2 个 failed command；部署 run 有 1 个 completed patch、2 个 completed command、1 个 failed command。它们证明实际发生了修改/执行，不能总结成“未进入修改阶段”；主控之前的总结错误不能全部归给 server。

部署 agent 的历史 admission 失败原本已经是 `not_used`，本轮没有把它误报为旧用量 bug。OV/TE 的旧 unavailable 行没有被事后改成零。TE 的 15 项测试及 teardown、OV 的 145 项测试是用户提供的业务上下文，本轮未重跑两仓，也不据 DevSpace 元数据重新宣称它们验收通过。

**已复现并修复的缺口**

从旧 HEAD 提取并实际执行 workspace_context handler，合成夹具产生 **1,304,038 字节 JSON**，复现不同 startLine 的相同 contextId、长行丢尾且无可用续读位置、UTF-16 代理对切断。新测试在真实 SDK HTTP 路径重组中文、emoji、反斜杠、引号、CRLF、多文件及跨页长行，并比较完整原文与 SHA-256。

capture 现在按 UTF-8 序列化后的整个 tool result（包括兼容 text 与 structuredContent 两份）计算 48 KiB 预算，而非 token/行数估算。每页返回选中文件的完整文件哈希、分段 offset、精确 EOL、逐文件 nextLine/nextOffset，以及 nextSelection。下一页复用原 files，按 nextSelection 设置 selectionIndex、该文件的 startLine、lineOffset；offset 为 Unicode code point。不同 action、规范选择、范围、查询摘要和文件版本参与 context identity。无效 UTF-8 明确拒绝，避免静默 replacement character。协作读锁不是不可变快照，跨页须复核文件哈希。

read 返回有界结果页、结果哈希、operationId/workRunId；保留上游 Pi reader 的截断提示，完整长源行用 capture。大型非文本 read 明确返回预算错误。命令响应额外受 JSON 文本字节预算约束并显式标记截断；这不声称保留了全部原始输出。

work_task get 的旧 action 无需 schema 刷新即可得到全 run 的 command/mutation 状态计数、当前状态、验收状态、最新成功 command/delivery 证据，以及默认 5 条历史。它不再无界返回所有历史。新 schema 可用 cursor 继续 get/history；大 evidence 用 get(operationId, evidenceOffset) 按原 run scope 分页。旧 schema 能取短摘要，不能凭空使用宿主尚未暴露的分页参数。record/finish 的显式验收语义保留。

命令结束时在既有 operation evidence 持久保存 exit code、signal、输出 UTF-8 字节数/SHA-256、事件定位（operation/session/server pid）。重建 client/server/ProcessSessionManager 或内存 TTL 过期后，get 仍可取这些元数据，且不重跑命令。正文仍不持久保存；旧 session 14 的已经丢失的内存输出不能被本补丁凭空还原，缺少回执也不是未执行证据。

agent 成功正文按 execution 保存在新增 migration 14 的 execution_responses 表；continue 不再清空上一份成功响应。observe 同时呈现最后一次执行与 latestSuccessfulExecution，失败的 follow-up 不再隐藏旧成功指针；includeResponse 的正文使用 responseOffset/responseExecutionId 分页，并返回明确的来源 execution。已有旧 execution 没有新正文副本时，仅保留真实 managed thread/turn history 指针，不伪造可恢复正文。所有读取都检查 workspace/run/agent scope，不改变 provider thread。

新增正向 onNotRequested 回执仅用于明确发生在 inference dispatch 之前的 adapter/pool/admission 边界；已有 request、turn、usage 或 provider-finished 证据不被覆盖。真实 JSON-RPC fixture 先在原线程成功累计 400 tokens，再触发 0.153.4 paginated guard，验证没有第四次 turn/start、没有第二个 thread/start、旧响应保留、总 tokens 不减少且新失败为 not_used。生产 provider 的原始历史与旧用量均未修改。

exec_command/apply_patch 新增可选 requestKey，绑定 workRunId。重复 key 返回原 operation 的 recovery 错误，不再执行命令或 patch；改变 payload 也不能借用已用 key 执行新工作。未暴露该参数的旧 host 必须先 get/observe 对账，不能把两次相同命令自动视为同一次授权。

诊断新增规范参数 fingerprint、selection count、operationId、produced bytes/hash，保留 workspace/run/conversation 关联。trace 单列 transport finished/aborted 与 hostAcknowledgment=unknown；HTTP 200 不等于 tool 成功，更不等于任务验收。普通 tool-call 日志改记 path/command/error 摘要哈希，日志写失败不改变实际 tool 结果。回归注入 logger 抛错并断言 synthetic secret 不出现在诊断中。

**推测、不可证明与未实现边界**

大输出、纯 text 回执、长行丢尾与不可恢复指针是可复现风险，**没有证据证明它们造成了历史 ChatGPT 丢包**。本轮无法追溯 host 接收/解析/UI 展示；没有把新 server finish 当作 host acknowledgment。无回执不代表无执行，进程 exit 0 也不代表部署或业务验收通过。

0.153.4 paginated resume guard 保留；没有修改 historyMode、删除线程、伪造新线程、绕过额度或切换全局 provider。没有实现自动 hand-off，也没有验证任何新版 provider 的原线程分页恢复支持。未来若实现 hand-off，仍须 host 显式选择并持久记录旧→新谱系；本轮没有可被误称为已完成的交接 API。

SDK loopback 验证真实 MCP schema/handler/HTTP/result 校验，provider 为隔离 fixture。另有编译候选的同组 HTTP 恢复断言。它们不是生产 OAuth、真实 ChatGPT/GUI 刷新或 npm/npx 安装验收。UI 仅在独立候选目录构建，没有 UI 行为修改或视觉验收。

**回归与构建**

最终 `pnpm test` 在 UTC 00:51:02.525–00:54:51.850 完成：88 个文件、301 项，**294 passed、0 failed、7 skipped、0 cancelled，exit 0**。运行前后源码指纹同为 `9a955afa2e8d8a6b5382208b84a4440bdf51972eb9d50e620334c47c6630034e`，sourceUnchanged=true。最终 `pnpm typecheck` 和候选 tsc 均 exit 0。

7 个 skip 均保留平台分类：Windows 不运行的符号链接/循环链接实例 5 项（managed worktree 替换、异常文件系统错误、global instruction、workspace instruction、allowed root）；POSIX inherited-stdio 实例在 Windows 跳过 1 项；macOS `/var` 路径别名实例在非 macOS 跳过 1 项。没有将它们计入通过项，也没有声称验证了 Windows inherited-stdio 悬挂。

首轮全量的 migration 清单两项失败及默认 250 ms 命令退出假设失败已修正，并保留失败收据。中间一轮 294 pass/0 fail/7 skip 因运行期间有最后的源码修正而被 runner 正确标记 source_changed；不作为最终验收，随后冻结源码重新跑出了上述完整通过结果。早期 HTTP 夹具还发现新增 structuredContent 字段未同步 outputSchema；修正后通过 SDK 的严格返回值校验。没有掩盖这些首次失败。

```powershell
pnpm typecheck
pnpm exec tsx scripts/reproduce-context-recovery.ts
pnpm exec tsx scripts/audit-session-trajectories.ts --db C:/Users/wrfgup/.local/share/devspace/devspace.sqlite --since 2026-09-08T16:55:00Z --until 2026-09-08T17:40:00Z --selection overlap --out-dir releases/receipt-recovery-20260909 --diagnostics C:/Users/wrfgup/.local/share/devspace/logs/server-diagnostics.jsonl --diagnostics-rotated C:/Users/wrfgup/.local/share/devspace/logs/server-diagnostics.jsonl.1
pnpm exec tsx scripts/audit-receipt-window.ts C:/Users/wrfgup/.local/share/devspace/devspace.sqlite C:/Users/wrfgup/.local/share/devspace/logs
pnpm exec tsx scripts/test-with-receipt.ts src/receipt-recovery.test.ts src/codex-work-protocol.test.ts src/agent-admission.test.ts src/work-task-tool.test.ts src/work-run-views.test.ts src/mcp-request-diagnostics.test.ts src/process-recovery.test.ts
pnpm test
pnpm exec tsx scripts/verify-trajectory-candidate.ts releases/receipt-recovery-20260909 4ba4283f8e585cefbf9245d84d57f11ce8721031
pnpm exec vite build --outDir D:/project/devspace/releases/receipt-recovery-20260909/candidate/ui --emptyOutDir false
pnpm exec tsx scripts/smoke-trajectory-candidate.ts releases/receipt-recovery-20260909/candidate
pnpm exec tsx scripts/smoke-receipt-candidate.ts releases/receipt-recovery-20260909/candidate
```

候选目录含 417 个构建文件；未运行会清理 live dist 的 pnpm build。候选 manifest 的 uiBuild 字段描述该脚本自身未运行 Vite，UI 是上面单独成功执行的 Vite 命令生成的。审计重跑会看到新的采集时状态或轮转覆盖，不承诺 artifact 哈希不变。

| 本地产物 | SHA-256 |
| --- | --- |
| baseline-reproduction.json | 24bda7fb2622e97357bec86ca670318873ef16b4f817eb2c965154b7d0702d61 |
| incident-metadata.json | ca82a384a77085f1aab09a1579ff278a76fb7ebfc8d82343eeca6e6ea985e193 |
| candidate-verification.json | 13ec37d7ad5021f0db94cd1ba4318ac86bfbe7903b2f9257cdb6e1da7e9ad116 |
| compiled-recovery.json | 079e203e84d49f447507604a79ed45def00ded6712176da5024a3b73c5568d74 |
| smoke.json | c4b1ef4a69799b40036bbb459221b270e9f366ac6f47d9fb30f00b3dbf26d91a |

以上文件位于 releases/receipt-recovery-20260909，保留在本地，未提交原日志。候选文件 manifest SHA-256：`a2875e4471fa640e875e42888c2ea40227e31e89abb6744b7d62de62b07f8364`。编译恢复测试 2 pass/0 fail，覆盖两个主测试内部的所有 HTTP 断言，不等于只有两次 MCP 调用。

最终全量收据为 `releases/test-receipts/2026-09-09T00-51-02-523Z-b6ca7830-80b5-4cff-b8c1-876215ed7475.json`，SHA-256 `8cf8d4fa74b7568bc796f53f3a65fe82de076ee41642bd3fe2c596bfbe278cc0`；原始测试日志 SHA-256 `7930866a79d0ccee35b72656c542c077aa2e0810c22d86cb045ff673313eff22`。首轮全量失败收据 ID 为 `2026-09-09T00-40-14-398Z-37df6a6b-1891-443e-aba8-11d86523e804`；source_changed 收据 ID 为 `2026-09-09T00-46-09-792Z-a609f33e-6e26-418f-900c-6578e97edd0f`。

**由主控在当前业务结束后激活**

本轮只读确认的生产监听为 PID 32628，启动脚本 `D:\project\devspace\dist\cli.js serve`，node 路径 `C:\Program Files\nodejs\node.exe`；其 daemon 当时为 PID 39400，脚本 `dist/local-agent-daemon-main.js`。PID 仅是当时观察值，不应复制为未来 kill 目标。

先让本轮和另外两个业务仓的所有 active turns/commands 结束，保持原启动环境与 tunnel/config。主控可先只读查看 daemon：

```powershell
& 'C:\Program Files\nodejs\node.exe' 'D:\project\devspace\dist\cli.js' agents daemon status --json
```

确认 idle 后，由原启动者结束旧 serve，并使用现有 CLI 请求 daemon 停止（本轮未执行）：

```powershell
& 'C:\Program Files\nodejs\node.exe' 'D:\project\devspace\dist\cli.js' agents daemon stop --json
```

旧监听释放后，使用独立候选直接启动；不需要覆盖或删除 dist：

```powershell
& 'C:\Program Files\nodejs\node.exe' 'D:\project\devspace\releases\receipt-recovery-20260909\candidate\cli.js' serve
```

新 server 后续按正常路径启动同目录的新 daemon，避免只换 server 却继续使用旧 manager。首次启动会执行 additive migration 14；保留旧表与历史线程，不回填或重写旧 usage。生产激活和随后真实 host 的 get/observe 验收由主控执行，本轮不把候选通过当作已经上线。
