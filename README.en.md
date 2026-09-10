# TaskQuay

**Your familiar ChatGPT conversation, connected to the coding agents on your machine.**

[简体中文](README.md) · [English](README.en.md) · [GitHub](https://github.com/wrfgup/taskquay) · [Connection guide](docs/chatgpt-mcp-setup.zh-CN.md) · [MIT license](LICENSE)

TaskQuay is a self-hosted execution and project-management layer for MCP-capable AI hosts. Let ChatGPT or another host inspect your workspace directly, delegate bounded work to Codex when useful, and return a result backed by changes, checks, and a task-level usage receipt.

It is an **independent fork of [Waishnav/DevSpace](https://github.com/Waishnav/devspace)**, not an official OpenAI, Anthropic, or upstream DevSpace product. The upstream implementation and its MIT copyright notice are retained. This fork focuses on host-first context gathering, controlled agent concurrency, reusable sessions, observable work, and honest Codex usage reporting.

> **Early-stage, source-first project.** The public-facing name is TaskQuay. The CLI command, configuration directory, MCP identifiers, and existing UI labels remain `devspace` for compatibility. The upstream npm package does **not** necessarily include this fork's changes. The source repository is [wrfgup/taskquay](https://github.com/wrfgup/taskquay); no TaskQuay npm release is implied.

## Is this the workflow you have been missing?

### Stop carrying plans from ChatGPT to Codex by hand

You work out a detailed plan with the web GPT that knows the conversation, your requirements and preferences—then copy it into a local coding agent, explain the background again, and relay every follow-up question. TaskQuay connects those steps: the host inspects the project, prepares a bounded task, delegates when useful, and reviews the result in the original workflow.

It reduces repeated explanations and handoffs, not the safeguards around consequential actions. ChatGPT memory and personalization depend on the current product mode and settings; they are not automatically inherited by Codex. Required constraints belong in the task and applicable project instructions. See [app permissions and personalization](https://help.openai.com/en/articles/11487775-connectors-in-chatgpt).

### Reach your project through ChatGPT, rather than depending on Codex Remote

Trouble reaching your desktop's Codex from a phone need not make Codex Remote your only path. With an authorized MCP connection, the route becomes **ChatGPT → TaskQuay → local workspace / coding agent**. You can use a supported ChatGPT web conversation instead of opening a separate remote Codex session.

The local machine, TaskQuay and its network path must remain available. This is not a fix for an offline computer or sleeping laptop. The [current MCP Help Center FAQ](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt) says web-only; native phone-app support is not promised. A phone browser is usable only when it actually exposes and can invoke the custom connection for your account—desktop-site mode is not a guarantee.

### Coordinate parallel work instead of cleaning up competing writes and builds

Multiple coding conversations in one project can otherwise overwrite each other's changes or build into the same outputs. TaskQuay coordinates participating operations: bounded shared readers, an exclusive writer, explicit resource claims and model-free waiting. The defaults allow at most two active agents and two verified readers of the same source.

Use matching resource keys for shared build outputs, devices and databases. External terminals and editors that do not participate are outside this protection; unrelated worktrees still need resource isolation. This is conflict prevention within the managed workflow, not a guarantee that every concurrent operation is safe.

### Reuse the relevant conversation instead of guessing which context is cheapest

When several conversations already exist, the next related task should not automatically start a new one. Work-item identity and explicit problem/role affinity help select a compatible idle session; the host can also continue an exact agent ID. Busy sessions are not silently cloned. Unrelated work and independent acceptance can use fresh context.

This reduces avoidable rediscovery, but does not search all your private Codex chats, transfer all host memory, guarantee a cache hit, or mathematically minimize tokens. Check the actual task usage receipt rather than treating a high cache-hit rate as the goal.

## What TaskQuay adds

Remote coding is more than letting a model run a terminal command. A useful workflow should answer: Who started this task? Is something still writing or building? Which conversation already understands the problem? Did verification finish? How much Codex usage actually belongs to this run?

TaskQuay puts those questions into explicit tools and local state instead of leaving them entirely in a long chat transcript.

| Capability | What it does |
| --- | --- |
| **Host-first inspection** | `read` and `workspace_context` let the host inspect selected files, search text, and collect versioned references without starting a Codex inference request. |
| **Bounded delegation** | Verified read-only workers can share source access within configured limits. Writers and unknown-effect commands remain exclusive; shared build outputs and devices use resource claims. |
| **Session reuse** | Related work can continue an existing thread. Work-item identity, context affinity, and request idempotency are separate; independent review can deliberately use fresh context. |
| **Project console** | `/console/` groups tasks, origins, execution state, acceptance evidence, Codex sessions, usage, and unresolved claims by project. |
| **Usage receipts** | Work completion returns provider-reported Codex usage with a completeness label. Missing telemetry is not silently presented as zero. |
| **Scoped chat housekeeping** | Archive/restore workflows preview an exact project-scoped set, require confirmation, and skip conversations whose ownership or activity cannot be verified. |

The goal is to avoid unnecessary Codex contexts, repeated investigation, and conflicting work—not to maximize the number of agents running at once. No fixed token-saving percentage is promised.

## How it fits together

```text
You
  └─ MCP host: planning, direct inspection, decisions, acceptance
       └─ TaskQuay / compatible devspace tools
            ├─ Workspace reads, edits, commands and evidence
            ├─ Task ledger, concurrency and resource claims
            ├─ Bounded Codex sessions when delegation is needed
            └─ Project console and completion receipts
```

The host remains the orchestrator. TaskQuay is not an opaque autonomous manager, a replacement for Codex, or a hosted model service.

**Local execution does not mean that all data stays on your machine.** File contents returned over MCP go to your selected host; delegated prompts and tool results may go to the model provider. Choose authorized projects and follow the host/provider's current privacy settings and terms.

## Screenshots

### Coordinate local Codex work from ChatGPT on the web

![ChatGPT invoking local Codex and displaying code changes](docs/assets/调用本地codex截图.png)

### View Codex token usage receipts in chat responses

![A chat response showing Codex token usage and telemetry completeness](docs/assets/页面聊天显示token消耗.png)

### Track tasks and token usage in the local project console

![The local project console showing task status, acceptance results, and Codex token usage](docs/assets/console截图.png)

## Run from this source tree

Requirements are defined in `package.json`: Node.js `>=22.19 <27`, Git, and the pinned `pnpm@11.25.0`. Install and authenticate a supported Codex CLI separately when you need Codex delegation. Direct workspace tools do not require a Codex inference call.

Clone **this fork**, then run:

The package currently has `private: true` as a guard against accidental npm publication under the upstream namespace. This does not prevent publishing the reviewed source repository under MIT.

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

Use the initializer to choose permitted roots, provider configuration, and your connection settings. Keep the generated owner authorization secret private. To avoid modifying an existing installation, test in a separate environment and back up its configuration and state first.

**Do not run a clean/rebuild over a service that is actively executing work.** `pnpm build` replaces `dist`; upgrades need a controlled stop, build, restart, and host-tool refresh after active operations settle.

## Connect ChatGPT: server URL or OpenAI Secure MCP Tunnel

**Documentation checked: 2026-09-06.** In this guide, “plugin/app” means a developer-mode MCP connection, not a custom GPT's OpenAPI Actions. TaskQuay does not currently expose an Actions `openapi.json`. Account and workspace permissions determine whether the required tools are available.

OpenAI's developer guide currently points to **Settings → Security and login → Developer mode**, then [ChatGPT Plugins](https://chatgpt.com/plugins) → **+**. Some accounts still show **Settings → Apps → Advanced settings** or a workspace-managed create flow. The developer guide and Help Center differ on some plan details: check your actual account and administrator controls rather than assuming a subscription grants every capability. See [developer mode](https://developers.openai.com/api/docs/guides/developer-mode) and [connection instructions](https://developers.openai.com/plugins/deploy/connect-chatgpt).

| Connection | ChatGPT entry | Local prerequisites |
| --- | --- | --- |
| **Server URL** | Your controlled `https://host.example/mcp` | Public HTTPS reverse proxy plus reachable TaskQuay OAuth routes. |
| **Official Tunnel** | Select **Tunnel** and the actual `tunnel_id` | OpenAI tunnel permissions, a runtime key, a running `tunnel-client`, and a working OAuth plan. |

### A. Server URL: the straightforward TaskQuay setup

1. Run TaskQuay on the machine whose approved projects you want to access. Forward a controlled HTTPS origin to `http://127.0.0.1:7676`. Forward the required OAuth routes as well as `/mcp`; forwarding only `/mcp` is insufficient. The console remains local-only by default.
2. Configure the **origin without `/mcp`** with `node bin/devspace.js config set publicBaseUrl https://taskquay.example.com`, then start or safely restart `node bin/devspace.js serve`.
3. Create a developer-mode app named **TaskQuay**. Choose **Server URL**, enter `https://taskquay.example.com/mcp`, and choose **OAuth**. Use dynamic client registration when offered; do not put the owner password in Client ID/Client Secret or choose No Authentication.
4. Complete the TaskQuay owner-password approval screen. Review the discovered tools and enable the ones your workflow needs. In a new chat, select the app or mention it explicitly; begin with an authorized read-only check.

An HTTPS URL on a different server does not magically reach your laptop's `127.0.0.1`: the forwarding path must end at the machine/network where TaskQuay and the relevant project are accessible. See the [detailed setup and troubleshooting guide](docs/chatgpt-mcp-setup.zh-CN.md#server-url).

### B. OpenAI Secure MCP Tunnel: private MCP transport

Create or select a tunnel in [Platform tunnel settings](https://platform.openai.com/settings/organization/tunnels), associate the intended organization/workspace, and download the official [tunnel-client](https://github.com/openai/tunnel-client/releases/latest). Tunnel **Read + Manage** and **Read + Use** permissions serve different roles; ChatGPT developer-mode access is separate. Start with `tunnel-client help quickstart`.

Point an HTTP profile at `http://127.0.0.1:7676/mcp`, provide the tunnel ID and runtime key privately, run its preflight and keep the client running. ChatGPT's connection form then uses **Tunnel**, not a localhost Server URL. The [detailed guide](docs/chatgpt-mcp-setup.zh-CN.md#official-tunnel) includes an OAuth/DCR profile example, Windows/Linux environment handling, health checks and exact-resource configuration.

**Important for this project:** official tunnel transport does not automatically tunnel the browser authorization page. TaskQuay's embedded OAuth server still needs a reachable authorization flow and registration/token endpoints appropriate to the tunnel's supported routing. A tunnel API key is not a TaskQuay owner password or an MCP access token. Do not disable OAuth to make a probe pass. A fully private, end-to-end TaskQuay login via official Tunnel was not revalidated in this documentation change. [Official OAuth routing notes](https://github.com/openai/tunnel-client/blob/master/docs/connectors.md).

This tunnel is for private/developer-mode connections, not public plugin-directory submission. Neither transport makes Codex inference free or changes host/provider policies. [Official Secure MCP Tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels).

### Verify before relying on it

Ask the connected host to open only an approved project, list/read the relevant files without changing anything, and return a `work_task` receipt. Confirm the task in `/console/`; host-only work should not start Codex. After separate authorization, test a bounded implementation task and inspect its actual usage and verification evidence. Refresh the app metadata after tool/schema changes, and reopen or reselect it when a conversation needs new tool access. Do not use a browser GET to `/mcp` as proof of MCP initialization.

The same `/mcp` endpoint retains upstream support for the 2026-07-28 per-request protocol and stateless compatibility with older 2025-era clients. There is no separate protocol mode to configure.

### Open the project console

```text
http://127.0.0.1:7676/console/
```

The console uses the owner secret with its own authenticated browser session and is local-only by default. Remote console access is a separate explicit HTTPS opt-in, not a consequence of exposing `/mcp`. See the [console guide](docs/project-console.md) and [configuration reference](docs/configuration.md).

## A workflow worth keeping

Start one top-level work run with `work_task`, keep the returned `workRunId`, then pass it as `work_run_id` through inspection, edits, commands, and agent calls. Current MCP schemas use recursive `snake_case` property names such as `workspace_id`, `request_key`, `yield_time_ms`, and `session_id`. Refresh the connection metadata after upgrading the server; a host's cached schema does not learn renamed fields automatically.

The host should first gather relevant context directly. Delegate only work that benefits from a worker, give it clear boundaries and versioned evidence, and continue the relevant session for follow-up changes and tests. `exec_command` and `write_stdin` cap one `yield_time_ms` window at 12000 milliseconds; continue longer work with the returned `session_id`.

Use independent review when the risk justifies it. Finish only after child operations stop and actual acceptance evidence has been checked. A model's final message is not proof that a build, deployment, or GUI verification succeeded.

An example request to your connected host:

> Open my approved project. Begin a work record, inspect the relevant files directly, and propose the smallest safe fix. Use Codex only where useful; reuse its session for follow-ups. Run the appropriate checks, review the final diff, and return the task's Codex usage and completeness with the result. Do not deploy or publish without separate authorization.

See [host-first workflows](docs/host-first-readonly-workflows.md) for exact tool contracts and concurrency behavior.

## Understand the usage numbers

| Label | Meaning |
| --- | --- |
| **Complete** | The mapped execution boundary and provider usage observations are available. |
| **Partial** | Some usage is recorded, but the task still has measurement gaps. |
| **Unavailable** | Evidence is insufficient for an accurate number; this is not zero. |
| **Not used** | No managed Codex inference was started for the measured work. |

Cache input and reasoning output are breakdowns, not extra amounts to add to totals. Session history, manual Codex activity, and separate external model commands must not be assigned to a later task merely because they share a directory. Provider token observations are not your subscription balance or an invoice. Reusing a session does not guarantee a cache hit.

The runtime-pool callback fix and regression scope are documented in [usage accounting](docs/console-usage-callback-fix.md). Old records without reliable events may remain unavailable rather than being retrospectively invented.

## Safety and current limits

**Treat the connection as privileged local access.** File tools enforce workspace paths, but shell commands run with the local user's authority and are not a general filesystem sandbox. Source/resource claims coordinate participating processes; they cannot stop an unrelated editor or terminal.

Shell tools are advertised as potentially destructive by default. A trusted machine owner may set `tools.dangerouslySkipCommandReview` to `true` in `~/.devspace/config.jsonc` to advertise `exec_command`, `write_stdin`, or `bash` as preauthorized. The setting defaults to `false`; it changes MCP annotations only. It does not inspect commands, disable OAuth, broaden workspace roots, remove execution claims, or override mandatory host/OS/provider controls. Restart DevSpace and refresh MCP metadata after changing it.

Read-only analysis must not be confused with building, installing, writing to databases, operating a device, or publishing. Those operations need appropriate execution permissions and resource ownership. Interrupted claims require reconciliation; chat archival does not cancel processes.

The project is developed and locally exercised on Windows, with inherited cross-platform code and CI definitions. A CI matrix is not proof that every current fork feature was verified on every platform. Test your actual host/provider/OS combination. Inherited native artifact-download support also has platform-specific limits.

Automatic immutable snapshots, arbitrary-checkpoint forks, guaranteed cache affinity, and complete automatic orphan recovery are not claimed. Archive/restore safety fixtures exist, but the recorded zero-inference empty-thread experiment did not complete real restore/list verification. Validate a newly created, explicitly authorized test conversation in your own Codex instance before relying on batch archival; do not experiment on unrelated chats.

Never include owner secrets, provider credentials, private rollouts, task databases, personal paths, or unsanitized screenshots in public issues. See [publication checks](docs/open-source-checklist.md).

## Development

```sh
pnpm typecheck
pnpm test
pnpm build
```

Prefer focused changes, deterministic fixtures, and tests through the actual manager → pool → provider boundary. Run live-provider experiments only with explicit authorization and report their real cost. Keep source/candidate verification separate from activation of a running installation.

## Documentation

| Guide | Scope |
| --- | --- |
| [ChatGPT connection guide (Chinese)](docs/chatgpt-mcp-setup.zh-CN.md) | Server URL, official Tunnel, OAuth, first-call acceptance, mobile limitations and troubleshooting. |
| [Setup](docs/setup.md) | Existing compatible CLI and configuration flow; some upstream distribution references remain historical. |
| [Host workflow](docs/chatgpt-coding-workflow.md) | Workspaces, tools, review and task receipts. |
| [Configuration](docs/configuration.md) | Provider, concurrency, roots and console options. |
| [Console](docs/project-console.md) | Origins, accounting, acceptance and archive safeguards. |
| [Security](docs/security.md) | Authority and deployment boundaries. |
| [Third-party notices](THIRD_PARTY_NOTICES.md) | Dependency and branding caveats. |

## License and upstream credit

Project source is distributed under the [MIT license](LICENSE). The original `Copyright (c) 2026 Waishnav` notice and the MIT permission text are preserved. See [NOTICE](NOTICE) for fork attribution.

Dependencies and provider services retain their own licenses and terms. In particular, the Claude Agent SDK is not declared MIT by this repository; its package points to Anthropic's applicable terms. A binary/npm release requires an additional bundled-dependency notice review. TaskQuay has no official affiliation with its upstream or model providers.

## Community link

[LINUX DO - 新的理想型社区](https://linux.do/)

An independent community link, not a statement of sponsorship or endorsement.

## Reading and acknowledgements

The [webcodex community walkthrough by yyjeqhc](https://linux.do/t/topic/2544729) is a useful independent example of a browser-first local-tool workflow. The setup material here is rewritten for TaskQuay and checked against OpenAI's official documentation; webcodex's hosted endpoint, installation commands, GPT Actions interface and account guarantees are not TaskQuay features.
