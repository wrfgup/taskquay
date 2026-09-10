# TaskQuay

**让懂你需求的网页 GPT，真正带着本地 Coding Agent 干活。**

[简体中文](README.md) · [English](README.en.md) · [GitHub](https://github.com/wrfgup/taskquay) · [接入教程](docs/chatgpt-mcp-setup.zh-CN.md) · [MIT 许可证](LICENSE)

[2026-09-08 轨迹复盘：两处有界修复与验证边界](docs/trajectory-review-20260908.md)

TaskQuay 是一个自托管的 MCP 本地执行与项目任务管理工具。你继续在熟悉的 ChatGPT 对话里讨论方案、下发任务、查看结果；主控直接读取工作区，在确有必要时调度本地 Codex，并带回变更、验收证据和 Token 回执。

本项目是 **[Waishnav/DevSpace](https://github.com/Waishnav/devspace) 的独立二开分支**。保留上游 MIT 版权声明，重点补齐主控直读、受控并行、会话复用、任务台与用量统计；不是 OpenAI、Anthropic 或上游 DevSpace 的官方产品。

> **早期项目，建议从本仓库源码运行。** 对外名称为 TaskQuay；CLI、配置目录、MCP 标识及部分界面继续保留 `devspace`，避免破坏现有安装。上游 npm 包不等于本分支，目前不宣称已经发布 TaskQuay npm 包。

## 你是否也遇到过这些烦恼？

### 1. 网页 GPT 已经理解了方案，本地 Codex 却还要从头解释

你在网页端和 GPT 讨论了很久，它已经了解这段对话里的目标、偏好和限制，也给出了满意的方案。但要落地时，还得把方案搬到 Codex，重新交代背景，再把 Codex 的追问搬回来。每次修改都在两个窗口之间当“传话筒”。

**TaskQuay 把讨论、执行和验收接在一起。** 主控先直接看项目，再将必要上下文与明确任务交给 Codex，跟进修正，最后把结果带回对话。你不用再手工搬运每一版方案。

它减少重复解释和无效确认，不取消必要授权。ChatGPT 的长期记忆、个性化是否可用取决于当前模式与账号设置，也不会自动完整继承给 Codex；重要约束应明确写进任务或项目规则。[官方设置说明](https://help.openai.com/en/articles/11487775-connectors-in-chatgpt)

### 2. 手机连不上本地 Codex？不必把 Remote 当作唯一入口

出门后想让家里电脑继续干活，却卡在 Codex Remote 的连接或切换会话上？TaskQuay 提供另一条路径：

```text
ChatGPT 网页对话 → 已授权的 TaskQuay MCP → 本地工作区 / Coding Agent
```

**接入完成后，直接在支持该连接的 GPT 网页对话里下发任务，不需要先建立一个单独的 Codex Remote 会话。** 本地电脑、TaskQuay 服务和网络入口仍须在线；它不能让关机、休眠或断网的电脑自动恢复。

手机使用也要分清客户端：[当前官方 MCP FAQ](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt) 仍标注 web-only，不能承诺原生手机 App 可用。手机浏览器只有在实际能看到、选择并调用自定义连接时才能使用；切换“桌面版网站”不等于保证支持。建议先在桌面网页完成配置和验收。

### 3. 多个任务抢着写代码、抢着编译？把协调交给工具

同一个项目开了多个 Coding Agent，对方还没改完接口，这边已经开始编译；两边覆盖同一文件，或者争抢同一个 APK 输出目录、模拟器和数据库——并行不仅没变快，还制造了返工。

**TaskQuay 将受管操作的并发变成明确规则：** 纯只读可以限量并行，写入独占，构建与设备按资源协调，超额任务在本地排队，不让模型一边消耗 Token 一边等待。

默认最多两个活跃代理，同一源码最多两个经过权限确认的读者。保护范围是接入同一协调机制的任务；外部编辑器、另开的未纳管终端不在锁内，跨 worktree 的共享输出也必须声明相同资源键。不是靠一句“只读”就放任所有任务同时运行，也不宣称一把锁能消灭所有并发问题。

### 4. 新任务来了，不知道该复用哪个对话、怎样少花 Token？

同一工程里已经有好几个 Codex 会话，有的熟悉后端，有的刚修过移动端。继续一个无关的长会话浪费上下文；每次新开又要从头理解。选择会话本身成了你的工作。

**TaskQuay 根据明确的工作项、问题域和角色匹配可复用的空闲会话，主控也可以直接继续指定代理。** 相关任务沿用上下文，繁忙会话不偷偷克隆；无关任务和独立验收仍可使用新上下文。

它帮助减少重复探索，不会扫描并接管你全部私人 Codex 聊天，也不承诺自动找到数学意义上“最省”的线程。会话复用不等于缓存必定命中，实际效果以任务用量回执和验收质量为准。

## 核心能力

| 能力 | 实际作用 |
| --- | --- |
| **主控先读** | `read`、`workspace_context` 直接查看指定文件、搜索文本、获取版本引用，不先调用 Codex 做全仓背景调查。 |
| **有界委派** | 只读共享、写入独占、资源锁和调用前排队，控制竞争与重复上下文。 |
| **会话复用** | 工作目标、上下文亲和与请求幂等分别管理，相关工作优先继续。 |
| **项目任务台** | `/console/` 查看来源、执行、验收、Codex 会话、用量及待核对占用。 |
| **完成回执** | 明确区分完整、部分、未知、未调用，缺少统计不能装成零。 |
| **项目级聊天整理** | 归档／恢复先预览、再确认；活动任务、外部续写和归属不足的会话跳过。 |

主控仍然负责统筹，TaskQuay 是执行与证据层，不是黑盒自主总管。本地运行也不等于内容不离开电脑：返回的文件会进入你选择的主控，委派材料可能发送给模型提供方。不要连接未经授权的项目。受信任的本机所有者可显式启用 `tools.dangerouslySkipCommandReview`，预授权远端命令以减少逐条审查；该高风险开关默认关闭，且不能关闭宿主自身的强制策略。

## 一些使用截图

### 网页 GPT 调用本地 Codex，统筹全局

![网页 GPT 调用本地 Codex 并展示代码变更](docs/assets/调用本地codex截图.png)

### 在回复中查看 Codex Token 用量回执

![聊天回复中的 Codex Token 用量及统计完整性说明](docs/assets/页面聊天显示token消耗.png)

### 在本地管理页面查看任务与 Token 消耗

![本地项目管理台中的任务状态、验收结果与 Codex Token 用量](docs/assets/console截图.png)

## 从源码安装

环境以 `package.json` 为准：Node.js `>=22.19 <27`、Git、`pnpm@11.25.0`。使用 Codex 委派时，另行安装并登录兼容的 Codex CLI；Windows 建议准备 Git Bash，并用 `doctor` 检查本机工具。直接读取工作区不需要发起 Codex 推理。

```sh
git clone https://github.com/wrfgup/taskquay.git
cd taskquay
npm install --global pnpm@11.25.0
pnpm install --frozen-lockfile
pnpm build
node bin/devspace.js init
node bin/devspace.js doctor
node bin/devspace.js serve
```

初始化时选择使用位置、授权项目目录、可用 provider 和接入地址。首次用户先阅读下面两种接法，再填写 `publicBaseUrl`。授权目录保持最小范围，owner 口令自行保管，不要贴入聊天、Issue 或截图。

`package.json` 的 `private: true` 用于阻止误用上游 namespace 发布 npm 包，不影响源码开源。已有安装先备份配置和状态；**不要在正在执行任务的服务上直接运行 `pnpm build`**，它会替换 `dist`。本 README 不要求修改当前运行实例来试验教程。

## 创建 ChatGPT 插件 / 应用并连接 MCP

**接入信息核对日期：2026-09-06。** 这里的“插件／应用”指开发者模式下的 MCP 连接，不是自定义 GPT 中的 OpenAPI Actions。

OpenAI 当前开发者文档的入口为 **设置 → Security and login（安全与登录）→ Developer mode**，然后进入 [ChatGPT Plugins](https://chatgpt.com/plugins)，点 **+** 创建。部分账号仍显示 **设置 → Apps／应用 → Advanced settings／高级设置**，组织账号还可能需要管理员开启权限。[官方创建步骤](https://developers.openai.com/plugins/deploy/connect-chatgpt)

不同官方页面对部分套餐能力的描述并不完全一致。请以账号实际显示的入口、管理员授权和真实工具调用结果为准，不能仅凭拥有 Plus／Pro 就保证所有读写功能都可用。[开发者指南](https://developers.openai.com/api/docs/guides/developer-mode) · [帮助中心](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt)

| 方式 | 在 ChatGPT 填什么 | 适用条件 |
| --- | --- | --- |
| **服务器 URL** | 自己控制的 `https://域名/mcp` | 有 HTTPS 入口，TaskQuay 的 MCP 与 OAuth 路由都可达。 |
| **OpenAI 官方 Tunnel** | 选择 Tunnel，并选择或填写实际 `tunnel_id` | 有隧道权限、runtime key、在线的 `tunnel-client`，并单独打通 OAuth。 |

### 方式 A：通过服务器 URL 接入

**第一步：让 HTTPS 入口转发到正确的电脑。** TaskQuay 默认监听 `http://127.0.0.1:7676`。可以使用自己控制的反向代理或 HTTPS 隧道；转发目标必须是项目实际所在、运行 TaskQuay 的机器。云服务器上的 `127.0.0.1` 不是你家里的电脑。

转发范围不能只有 `/mcp`：本项目还需要 OAuth 发现、注册、授权和令牌路由。建议按根路径正确代理 TaskQuay 服务，同时保留 `/console/` 的默认远程访问限制。[完整路由与网络说明](docs/chatgpt-mcp-setup.zh-CN.md#server-url)

**第二步：设置站点根地址并启动服务。** 将示例替换为你自己的 HTTPS 地址，`publicBaseUrl` 不带 `/mcp`：

```sh
node bin/devspace.js config set publicBaseUrl https://taskquay.example.com
node bin/devspace.js serve
```

**第三步：在 ChatGPT 创建连接。** 名称填写 `TaskQuay`，连接方式选择 **Server URL／服务器 URL**，填写 `https://taskquay.example.com/mcp`，身份验证选择 **OAuth**。本项目使用动态客户端注册；界面允许时不要手填固定 Client ID／Client Secret，更不要把 owner 口令填进这些字段。不要为了连通而选择“无身份验证”。

**第四步：完成 owner 授权并验收。** 在 TaskQuay 弹出的授权页面核对应用、范围和资源地址，再输入自己的 owner 口令。返回 ChatGPT 后检查工具列表；新对话中从工具／插件菜单选中 TaskQuay，先测试只读调用。后续需要新的工具操作时再次选择或明确提及它，不假设每条消息都会自动带上连接。

### 方式 B：通过 OpenAI 官方 Secure MCP Tunnel 接入

这种方式由本机客户端主动连接 OpenAI，将请求转发给私有 MCP，不需要为 MCP 开放公网入站端口。它不是 Codex Remote，也不是第三方临时 HTTPS 隧道。[官方说明](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)

1. 在 [Platform → Organization → Tunnels](https://platform.openai.com/settings/organization/tunnels) 创建或选择隧道，关联实际使用的 Platform organization 与 ChatGPT workspace。创建／管理需要 **Tunnels Read + Manage**；运行或选择使用需要 **Read + Use**。ChatGPT 开发者权限是另一项权限。
2. 从 [OpenAI 官方发布页](https://github.com/openai/tunnel-client/releases/latest) 或 Tunnels 页面下载匹配系统的 `tunnel-client`，先运行 `tunnel-client help quickstart`。准备真实 `tunnel_id` 和有权限的 runtime API key，保存在本机受控环境，不写进仓库。
3. 建立 HTTP 配置，将 MCP 目标指向 `http://127.0.0.1:7676/mcp`，选用适合 OAuth/DCR 的配置，执行 `doctor` 并保持 `run` 在线。[完整命令、凭据区分和 OAuth 配置](docs/chatgpt-mcp-setup.zh-CN.md#official-tunnel)
4. 在 ChatGPT 创建应用时，Connection 选择 **Tunnel**，选择已有隧道或填入该 `tunnel_id`，继续完成授权和工具发现。不是在 Server URL 中填写 localhost，也不是在这里填写 API key。

**本项目的重要条件：隧道只解决 MCP 传输，不自动代理浏览器 OAuth 登录页面。** TaskQuay 自带 OAuth 服务；授权页、注册和 token 交换仍须按调用方与官方隧道支持的路由打通。只启动 `tunnel-client` 不代表手机或云端就能访问电脑的 `/authorize`。没有独立打通 OAuth 时，优先使用方式 A，不要关闭鉴权。[官方 OAuth 路由说明](https://github.com/openai/tunnel-client/blob/master/docs/connectors.md)

本次文档修改没有重新验证“TaskQuay 全私网 OAuth + 官方 Tunnel”的真实完整流程；该方式应在自己的组织与账号中完成下方验收再投入使用。官方隧道用于私有／开发者模式连接，不替代公开插件商店要求的 HTTPS 服务，也不提供免费模型额度。

### 第一次调用怎么验收？

先在已启用 TaskQuay 的对话中发送：

> 使用 TaskQuay 打开我已授权的 `<项目绝对路径>`，先建立工作记录。直接读取项目说明并告诉我目录结构，不修改文件、不启动 Codex、不部署。完成后返回工作回执和 Codex 用量。

确认主控确实调用了工具、返回的路径正确，`/console/` 能看到对应任务；未调用 Codex 的这次检查应显示零。之后再明确授权一个小范围修改任务，验证变化、测试和真实 Codex 消耗。工具更新后刷新连接元数据；浏览器直接 GET `/mcp` 的响应不能替代 MCP 初始化、鉴权和工具调用测试。

本项目保留上游 MCP 2026-07-28 与旧版 2025-era 客户端的自动协议兼容，不需要手动配置“协议模式”。排错、持续运行和最小测试清单见[完整接入教程](docs/chatgpt-mcp-setup.zh-CN.md)。

## 日常任务怎么下达？

> 使用 TaskQuay 处理这个项目。先读取相关实现、确认目标与限制。主控能直接完成的调查不要重复委派；确实需要 Codex 时复用相关会话。对同一源码的写入和共享编译资源保持互斥。逐步实施、运行检查并审查最终 diff，返回结果、验收范围和本次 Codex Token 回执。部署、公开发布和破坏性操作需要另行确认。

主控用 `work_task` 建立工作，持续传递 `workRunId`；子操作结束、实际证据检查完毕后再结算。你不用每次手工挑一个新 Codex 窗口，更不必把每条构建日志来回复制。平台仍可能要求确认高风险工具动作；本项目不会绕过这些控制。

### 执行观察、断线取回与排队

`agent_task observe` 返回任务与进展 revision；主控携带上次的 `revision` 使用有界 longpoll（默认 20 秒，最大 25 秒）。累计 Token、更新时间和经过时长本身不触发提前返回。日常观察不附整份用量回执；用量查询仍走 `usage`，终态用 `includeResponse: true` 显式取回结果与完成回执。同一 revision 可反复取回，连接中断不会消费结果。

`progress` 仅包含固定阶段/工具类别、最后活动时间、时长和等待原因；构建/测试类别是 provider 事件提示，静默不等于卡死，未知数据保留未知。默认不输出命令、stdout 或模型思维。`nextAction` 指示继续观察、检查 claim 或由主控审核结果；任务完成不会自动通过验收，主控仍须显式结算 `work_task`。

队列和 busy continue 不启动额外推理、不抢写锁、不自动重放写入。收到冲突先按 `nextAction` 核对 owner/claim；相关续接在终态后使用新的 `requestKey`。广告中的 `~/…/SKILL.md` 与绝对路径可用于 `read` 和 `workspace_context capture`，仅允许已加载技能及其目录资源，并检查真实路径越界。外部技能 capture 作为阅读证据返回，不混入仅接受工作区源码的 delegation refs。

这些改进需主控在现有发布任务停稳后安全启用新的 server 与 agentd；源码修改或 staging 构建成功不代表线上已更新。实测数据、缺失证据和运行路径见[执行可靠性 trace 复盘](docs/execution-reliability-trace.zh-CN.md)。

## 项目任务台与用量

管理台默认地址是 `http://127.0.0.1:7676/console/`，使用 owner 口令建立独立浏览器会话。远程访问需要单独开启，不因 MCP 接通而自动开放。[任务台说明](docs/project-console.md)

| 统计状态 | 含义 |
| --- | --- |
| **完整** | 受管执行边界及 provider 用量事件齐全。 |
| **部分** | 有已记录用量，但仍存在缺口。 |
| **未知** | 证据不足，不能给准确总量；不是零。 |
| **未调用** | 对应工作没有启动受管 Codex 推理。 |

缓存输入、推理输出不能在总量上再次相加。历史线程消耗、手工续写和外部模型命令不应误归到新任务。只有主控直读／确定性执行而未发起 Codex 推理的部分，才能记作未调用；**真的委派 Codex 就会产生对应消耗**，MCP 或 Tunnel 不会把它变成免费。[统计与回调回归说明](docs/console-usage-callback-fix.md)

## 安全与当前限制

请把连接视为高权限本地访问。文件工具做工作区路径校验，但 shell 使用本机用户权限，不是通用沙箱。应用、隧道和本地 provider 的安全确认分别生效；即使显式预授权远端命令，也不要关闭鉴权、扩大到整块磁盘或开放未知服务。

当前主要在 Windows 上开发和本地验证；上游跨平台代码及 CI 矩阵不代表当前所有功能都在所有平台通过。自动不可变快照、任意节点 fork、保证缓存命中和完整自动中断恢复不属于已完成承诺。

受管 Codex 的本地 `approvalPolicy` 固定为 `never`，表示 DevSpace 不弹出本地审批框；它不会关闭 ChatGPT／OpenAI 宿主、操作系统或 provider 的安全判断，也不会自动批准网络、提权或未知请求。提供端若意外发起交互式 approval，DevSpace 会明确拒绝为“不可交互且未批准”。默认 MCP shell annotations 仍标记为可能破坏；只有本机所有者显式启用 `tools.dangerouslySkipCommandReview` 时，才改为发布已预授权的非破坏性审查提示，宿主仍可覆盖。

分页历史恢复不再按 `0.153.4` 版本字符串直接判死：DevSpace 先只读核对 thread identity，再以真实 `thread/resume` 结果为准。原生恢复明确拒绝分页历史时，默认仍停止并保留原线程与成功回执；可选 handoff 是带父线程引用的新空线程，并非完整上下文恢复，不会自动重放旧发布指令。根因、开关、验收命令和当前未启用状态见[审批与历史恢复说明](docs/approval-history-recovery-20260910.md)。

聊天归档不是停止后台进程。归档／恢复的安全夹具已覆盖多种边界，但此前零推理空线程实验没有完成真实恢复验证；使用前先验证明确授权的新测试会话，不要拿重要或未纳管聊天做实验。出现传输中断先核对任务和线上状态，不盲目重发写入或发布。

## 开发、文档与许可

开发与手动 QA 可使用 `pnpm dev:seed` 初始化隔离状态，再运行 `pnpm dev`。
它会将正常安装的配置和 SQLite 状态复制到被 Git 忽略的 `.devspace-dev/`，
其中可能包含敏感信息，请勿分享或提交。`pnpm dev:reset` 会丢弃该 QA 状态并重新复制。
详见 [开发与手动 QA](docs/development.md)。不要在正常服务占用相同端口时启动开发服务。

```sh
pnpm typecheck
pnpm test
pnpm build
```

| 文档 | 内容 |
| --- | --- |
| [ChatGPT MCP 接入教程](docs/chatgpt-mcp-setup.zh-CN.md) | Server URL、官方 Tunnel、OAuth、首次验收与排查。 |
| [基础安装](docs/setup.md) | 本分支源码初始化与网络配置。 |
| [主控工作流](docs/chatgpt-coding-workflow.md) | 工作区、工具、审查和回执。 |
| [并发与会话](docs/host-first-readonly-workflows.md) | 主控直读、只读共享与上下文亲和。 |
| [配置参考](docs/configuration.md) | Provider、授权目录、并发和任务台。 |
| [安全模型](docs/security.md) | 权限和部署边界。 |
| [审批与历史恢复](docs/approval-history-recovery-20260910.md) | 本地免交互边界、原生 resume 与显式 handoff。 |
| [第三方说明](THIRD_PARTY_NOTICES.md) | 依赖许可证与品牌使用边界。 |

源码采用 [MIT](LICENSE)，保留 `Copyright (c) 2026 Waishnav` 及完整上游授权文本，来源见 [NOTICE](NOTICE)。依赖和模型服务分别适用自身条款，Claude Agent SDK 不因本项目 MIT 而变成 MIT。源码验收、运行服务启用和 npm 发布是不同阶段。

## 参考与致谢

感谢 yyjeqhc 的 [webcodex 社区介绍与接入经验](https://linux.do/t/topic/2544729)。这里借鉴“网页端下发、本地执行、分步授权验收”的教程组织方式，结合 TaskQuay 实际实现和 OpenAI 官方资料重新编写；没有复制其专属命令、公共体验地址、图片、GPT Actions 接口或账号安全承诺。

## 友情链接

[LINUX DO - 新的理想型社区](https://linux.do/)

友情链接与兼容性描述不代表赞助或官方背书。公开问题反馈请使用脱敏日志，不要上传真实口令、私人会话或状态数据库。
