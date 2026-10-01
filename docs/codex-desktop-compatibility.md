# Codex Desktop 协议兼容性

DevSpace 的项目适配器明确支持已核验的 Codex CLI 版本，而不是将所有更高版本无条件放行。当前增加 `0.159.2`，保留 `0.153.4`、`0.154.0-alpha.6.2`、`0.155.0-alpha.9.2`。

2026-10-01 从 Windows Desktop `26.928.2636.0` 实际内置的 `codex-cli 0.159.2` 生成实验协议。`.local/codex-0159-compat/schema` 中的 12 份项目请求/响应定义通过增强后的离线检查：初始化、项目列表/创建/读取、线程读取/归属更新/命名。请求检查使用适配器发送的代表性 payload；响应检查保留对所消费关键字段的结构核验。

请求校验复用现有 `@modelcontextprotocol/sdk/validation/ajv`，未增加依赖。payload 覆盖初始化的 `clientInfo` 和 `capabilities.experimentalApi`、首屏 `cursor: null` 与后续字符串 cursor、固定 `limit: 100`、单根/多根数组及 Windows/POSIX 路径、线程读取的布尔 `includeTurns`、项目归属和线程命名。AJV 检查字段类型、null、嵌套 required、数组 items、additionalProperties 和本地引用的 anyOf/allOf/oneOf；不会为请求补默认值或做类型转换。

检查范围明确限定为 draft-07 中允许的关键字、本地 JSON Pointer 引用和同构数组。未知校验关键字、外部/缺失引用、不支持的方言或 format 会拒绝；Codex 的 `uint32` 显式转为整数范围约束，保留 null 分支。对原始 schema 的准备操作在副本上完成。回归覆盖 `includeTurns: string`、`capabilities: string`、`clientInfo`/`capabilities`/`roots.items` 新增必填字段（包括带 default 或没有 properties 定义）、items 或 path 改型，以及组合 schema 的不兼容分支。

这些是代表性请求的离线校验，不证明任意路径、名称、ID、数组长度都满足未来新增的限制；请求 payload 变化时必须同步更新探针。响应检查只覆盖选定字段，不是整个响应的 JSON Schema 包含关系证明。此工具不自动修改运行时版本白名单，未知版本仍拒绝。

## 后续升级验收

先使用待适配的本机官方 binary：

```text
codex --version
codex app-server generate-json-schema --experimental --out .local/codex-schema
pnpm exec tsx scripts/verify-codex-project-schema.ts .local/codex-schema
```

该命令读取已有 schema，写出 `devspace-project-compatibility.json` 摘要并输出每份定义的 SHA256；不读取身份凭据，不创建项目、不启动模型，也不自动扩充支持版本。它是升级核查工具，不是完整兼容性证明，也不是未知版本的运行许可。

通过后，核对运行时响应验证、项目根路径、provider home、Desktop client 映射，补充准确版本测试。真实验收必须覆盖：创建或复用项目→线程绑定→原生 `agent_task` 启动→返回可读取结果与用量→显式验收。只通过 TypeScript 或脚本测试不能声称已恢复 MCP 调用；服务端新代码需在无活动任务时受控加载，并通过真实连接再次确认。

项目注册控制进程现完整发送 `initialize` / `initialized` 握手。已有授权目录、线程归属、命令审批、并发互斥与未知版本拒绝逻辑均不放宽。Desktop 与服务端项目登记分开核验，不编辑 Desktop JSON/SQLite 来伪造登记。

官方协议说明：https://developers.openai.com/codex/app-server 。运行时应以实际 binary 生成的定义为准。

## 本轮修复验证与实机边界（2026-10-01）

本轮执行 `pnpm exec tsx scripts/verify-codex-project-schema.ts .local/codex-0159-compat/schema`：12 份定义通过；`pnpm typecheck`：通过。相关测试命令为：

```text
pnpm exec tsx scripts/test-with-receipt.ts src/codex-project-schema.test.ts src/codex-projects.test.ts src/codex-desktop-version.test.ts src/codex-desktop-package.test.ts src/codex-desktop-open.test.ts src/codex-desktop-catalog.test.ts src/codex-project-runtime.test.ts
```

相关测试共 42 项，42 pass、0 fail、0 skip，receipt 为 `releases/test-receipts/2026-10-01T07-59-26-329Z-2ac135e0-eb57-4810-a35d-c1bdaa0fd19f.json`，`sourceUnchanged: true`。其中 schema 校验测试 20 项。

随后执行 `pnpm test`：94 个测试文件、352 tests、344 pass、8 skip、0 fail、0 cancelled，用时约 240.5 秒，退出码 0。receipt 为 `releases/test-receipts/2026-10-01T07-59-41-595Z-85cc4046-4007-4685-9a80-50e13fc5525c.json`，完整 footer 且 `sourceUnchanged: true`。`pnpm exec tsc -p tsconfig.build.json` 退出码 0，已更新 dist；未执行清理式完整 build。

本轮原生 `agent_task` 已实际承担只读审查、工程写入和测试执行；主控确认真实 provider 已返回可读取结果与完整用量。DevSpace 自己的 Desktop 映射也已用新源码实机回读。U15 新目录的 Desktop 客户端登记仍未完成，不能由 GUI launch、DevSpace 映射回读或本轮离线测试替代。仍需确认该目录的客户端登记和 GUI 可见结果，再完成相应项目/线程的端到端验收。本轮未重启 MCP/GUI；dist 编译成功也不证明当前运行服务已加载新代码。

完成测试和 dist 编译后进行有界只读诊断，未超过 8 次额外检查。目标 GUI 的返回 app 标识为 `OpenAI.Codex_2p2nqsd0c76g0!App`，窗口 591656。只截取该窗口，观察到“信任此文件夹吗？”弹窗，明确列出 `D:\project\gpt-projects\u15-visual-thinking`，并有“信任文件夹”和“取消”按钮；未点击、关闭或改变弹窗，也未继续读取背景聊天。

随后执行 `pnpm exec tsx scripts/inspect-codex-client-project-state.ts D:/project/gpt-projects/u15-visual-thinking`，退出码 0，`targetFieldPaths: []`；状态文件修改时间为 `2026-10-01T08:06:56.066Z`。这与客户端尚无 U15 根登记一致，且 GUI 证据表明目录信任步骤待处理。下一步由用户核对该目录和弹窗中读取、编辑、运行文件及可能自动运行目录代码的授权范围，再决定是否点击“信任文件夹”；之后重新回读 saved mapping 并检查 GUI 结果。当前仍报告 U15 缺失登记，没有将启动或授权弹窗当作成功。

08:12Z 补充：按用户对该实验目录读取、修改、运行与创建 Codex 项目的明确授权，重新核对唯一目录和正常“信任文件夹”按钮后尝试一次界面操作。计算机工具返回 `coordinate input geometry is unavailable`，不能确认点击生效；未通过修改数据库、全局信任策略或其他隐蔽方式替代该操作。此阻塞是 GUI 自动化可用性，不是 0.159.2 协议不兼容。该窗口仍需本机正常确认，之后回读真实 client/server 映射。

原生修复线程为 `01a0f670-4202-7642-af54-f4c2f2bcf4fb`，DevSpace agent 为 `agt_c45ea38a`。三个受管回合分别完成独立只读审查、修复与测试、上述受限 GUI 操作。完整回执累计 input=3,987,719、output=23,423、total=4,011,142；cached input=3,828,224 为 input 子项，不再次相加。这是本修复 run 的 provider token 观察值，不是订阅额度或账单。
