# Configuration Reference

## Codex reasoning ceilings

Provider `effort` and `readOnlyDefaults.effort` are defaults, not limits. Explicit
caller values take precedence. Add this to the Codex provider configuration to
cap the GPT-6 family after resolving caller/profile/default/session values:

```json
{
  "id": "codex",
  "enabled": true,
  "model": "gpt-6-astra",
  "effort": "medium",
  "readOnlyDefaults": { "effort": "low" },
  "reasoningLimits": [{ "model": "gpt-6", "maxEffort": "medium" }]
}
```

Rules match the exact model or its hyphen-delimited family (`gpt-6` matches
`gpt-6-astra`, not `gpt-60`). Requested models match case-insensitively; configured
rule names are lowercase. Overlapping rules use the strictest ceiling. Higher
effort is clamped without retrying; lower effort stays unchanged. Ordered labels
are `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`; this ordering
does not claim every model supports every label. Unknown effort on a capped model
or an unresolved model with configured limits fails before provider work. Missing
effort for a matched model is explicitly set to the ceiling to bound unknown
provider defaults. Unmatched models and unconfigured providers retain existing
behavior. Limits on non-Codex providers are currently rejected.

Both native MCP and CLI starts/continuations use this manager policy before
admission/runtime creation; context affinity uses the capped effort. Stored
sessions and receipts contain effective effort. `agent_reasoning_resolved` logs
requested/effective effort and its source without task text. Historical receipts
are not rewritten. This constrains DevSpace dispatch, not independent Codex clients
or provider-internal compute. Deploy and reload server/daemon configuration before
relying on new limits; already-running turns are unaffected.

Validation on 2026-09-08: 57 tests across 12 files passed serially, followed by
whole-project type checking and an isolated backend/UI build. After rollout,
the deployed manager with the operator's configured ceiling and an isolated fake
provider returned `medium`, `medium`, `low`, `medium` for high start, xhigh
continuation, default read-only continuation, and default write continuation;
persisted execution receipts matched. The local health/Console endpoints and
daemon handshake succeeded. No real model inference or remote host delivery was
used as rollout validation.

## WSL project paths from a Windows server

Add individual UNC project directories to `workspaces.allowedRoots`, for example
`\\wsl.localhost\Ubuntu\home\owner\project\OpenViking`. WSL filesystem components
are case-sensitive: `OpenViking` must not become `openviking`. DevSpace preserves
that spelling in canonical checkout identities and checks WSL allowed-root
containment case-sensitively. The `wsl$` and `wsl.localhost` host aliases and
distribution-name casing resolve to the same identity. Ordinary Windows path
identity behavior is unchanged. Execution claims remain conservative about
case-only overlap; this change does not release or rewrite existing claims.

Project display names can differ from directory names. Registration in the
DevSpace ledger does not import a Codex application's project/thread history.
UNC access does not switch command or provider execution to Linux: a Windows
server still uses its configured Windows provider and shell. Linux-specific
commands require an explicit WSL invocation. This is not a shell sandbox.

Regression coverage includes WSL aliases, extended UNC spelling, case-sensitive
allowed-root rejection, Windows identity compatibility, project-name persistence,
and existing checkout/resource cross-process coordination tests.

DevSpace stores durable settings in `~/.devspace/config.jsonc`. The file accepts
comments and trailing commas and is validated before the server starts. Editor
completion is provided by the versioned [JSON Schema](../schema/v1/devspace.schema.json),
also hosted at the URL in the file's `$schema` property.

Authentication stays separate because it contains a secret:

```text
~/.devspace/config.jsonc
~/.devspace/auth.json
```

Run `devspace init` to create both files. `devspace config set publicBaseUrl
<url|null>` updates the JSONC document without discarding its comments.

## Complete example

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/Waishnav/devspace/main/schema/v1/devspace.schema.json",
  "configVersion": 1,

  "server": {
    "host": "127.0.0.1",
    "port": 7676,
    // Use the public origin only; do not append /mcp.
    "publicBaseUrl": "https://devspace.example.com",
    "allowedHosts": [],
    "trustProxy": false,
  },
  "workspaces": {
    "allowedRoots": ["~/personal", "~/work"],
    "worktreeRoot": "~/.devspace/worktrees",
  },
  "storage": {
    "stateDir": "~/.local/share/devspace",
  },
  "tools": {
    "mode": "codex",
  },
  "ui": {
    "enabled": true,
  },
  "artifacts": {
    "enabled": false,
    "maxFileBytes": 104857600,
  },
  "skills": {
    "enabled": true,
    "paths": [],
    "agentDir": "~/.codex",
  },
  "subagents": {
    "enabled": false,
    "instructions": "on-demand",
    "providers": [],
  },
  "logging": {
    "level": "info",
    "format": "json",
    "requests": true,
    "assets": false,
    "toolCalls": true,
    "shellCommands": false,
  },
  "oauth": {
    "accessTokenTtlSeconds": 3600,
    "refreshTokenTtlSeconds": 2592000,
    "scopes": ["devspace"],
    "allowedResourceUrls": [],
    "allowedRedirectHosts": ["chatgpt.com", "localhost", "127.0.0.1"],
  },
}
```

Omitted sections and keys use the defaults shown above. An empty
`workspaces.allowedRoots` uses the current working directory. Unknown keys are
rejected so spelling mistakes cannot silently alter behavior.

`oauth.allowedResourceUrls` accepts exact alternate MCP resource URLs for
clients that connect through a resource alias, such as a secure MCP tunnel.
The normal `server.publicBaseUrl` `/mcp` resource remains allowed automatically.
Configure the complete alias URL, not a hostname or origin; aliases do not
change OAuth discovery URLs or proxy routing.
Resource URLs must use HTTPS; HTTP is allowed only for `localhost`, `127.0.0.1`,
or `[::1]`, with optional ports. Restart DevSpace after changing
`oauth.allowedResourceUrls`: the provider reads this policy at server creation.
After restarting, refresh tokens for removed aliases can no longer mint tokens.

## Tool modes and UI

`tools.mode` accepts two values:

| Value | Tool surface |
| --- | --- |
| `codex` | Default. `open_workspace`, `read`, `workspace_context`, `work_task`, `agent_task`, `apply_patch`, `exec_command`, `write_stdin`, and `show_changes`. |
| `claude` | `open_workspace`, `read`, `workspace_context`, `work_task`, `agent_task`, `write`, `edit`, `bash`, and `show_changes`. |

The dedicated tools `grep`, `glob`, and `ls` are not exposed. `workspace_context`
provides nonrecursive listing and literal search/capture over selected files without
a shell or model. Use the shell for more specialized operations; unknown shell effects
remain exclusive even when a command is intended only for inspection.

DevSpace attaches Apps UI metadata only to `open_workspace` and `show_changes`.
This avoids rendering an iframe for every read, edit, search, or command call.
Setting `ui.enabled` to `false` removes the metadata but does not remove the
`show_changes` tool.

## Skills and subagents

DevSpace discovers standard Agent Skills from `~/.agents/skills`, project
`.agents/skills`, and `~/.devspace/skills`. It also checks
`skills.agentDir/skills` and each path in `skills.paths`. Relative custom paths
are resolved from the active workspace.

When Subagents are enabled for MCP workspaces, DevSpace keeps its bundled
`subagents` skill synchronized at `~/.devspace/skills/subagents/SKILL.md`.
That managed copy is the authoritative `subagents` skill for DevSpace and is
refreshed when the packaged skill changes.

Subagent providers are explicit. Omitted providers are disabled:

```jsonc
{
  "configVersion": 1,
  "subagents": {
    "enabled": true,
    "instructions": "on-demand",
    "providers": [
      {
        "id": "codex",
        "enabled": true,
        "model": "gpt-5.4",
        "effort": "high",
        // Default is omitted/disabled. This is a new-thread handoff, not full history resume.
        "historyHandoff": "verified-unsupported",
        "command": "/opt/devspace/bin/codex-wrapper",
        "env": {
          "CODEX_HOME": "/home/alice/.codex-work",
          "OPENAI_BASE_URL": "https://api.example.com/v1",
        },
      },
      {
        "id": "claude",
        "enabled": true,
        "model": "sonnet",
      },
    ],
  },
}
```

`subagents.instructions` controls when ChatGPT receives the managed workflow:

| Value | Behavior |
| --- | --- |
| `on-demand` | Default. `open_workspace` advertises the `subagents` skill and the model reads it only when the task benefits from delegation. |
| `preload` | `open_workspace` includes the `subagents` workflow in its initial workspace instructions instead of advertising that skill for a separate read. |

Both modes only make the workflow available; neither tells the model to prefer
subagents for routine work.

Codex `historyHandoff` is owner-controlled and defaults to disabled. The only
enabled value is `verified-unsupported`: after an identity-matched, terminal,
same-workspace paginated thread is explicitly rejected by native `thread/resume`,
a continuation with an explicit new `requestKey` may create a traced empty thread.
It does not copy provider history or replay an earlier response. Quota,
authentication, transport/unknown errors, active turns, and scope mismatches never
fall back. See [approval and history recovery](approval-history-recovery-20260910.md).

Profiles are loaded from `~/.devspace/agents/*.md` and project
`.devspace/agents/*.md`. `devspace agents targets` prints the configured targets
available in the current workspace.

`command` names one executable. DevSpace does not split shell arguments, so use
a wrapper executable when startup needs fixed arguments. `env` maps environment
variable names to literal string values and preserves empty strings. DevSpace
does not expand `$NAME` references in these values.

All subagent providers accept `env`. The daemon inherits its startup
environment, then overlays the provider's `env` without mutating the daemon's
process environment. OpenCode receives that environment on its managed server
process; embedded Pi scopes it to its provider requests and command execution.

Codex, Claude, Cursor, Copilot, and Grok also accept `command`. OpenCode and Pi
do not expose a command override. For providers that support it, an explicit
`command` wins over both the inherited command override and a command override
placed in `env`.

Existing process-level overrides remain supported: `CODEX_COMMAND`,
`CODEX_HOME`, `CLAUDE_COMMAND`, `CURSOR_COMMAND`, `COPILOT_COMMAND`,
`GROK_COMMAND`, and `GROK_AGENT_PROFILE`. Provider configuration takes
precedence where the same value is set in both places.

DevSpace writes `config.jsonc` with mode `0600`, but provider environment values
are still plain text on disk. Keep the file out of version control. Leave
credentials in the process environment if you do not want DevSpace to persist
them.

### Project console and completion receipts

`console.enabled` defaults to true, `console.allowRemote` to false, and
`console.sessionTtlSeconds` to 3600 (300–86400). `/console/` uses its own owner login,
HttpOnly/SameSite session cookie, strict Origin/CSRF checks and project scopes.
Remote access requires explicit opt-in and the configured HTTPS publicBaseUrl.

Both surfaces expose `work_task`. Begin a run before host reads or delegation,
propagate workRunId, and finish after child operations stop with explicit acceptance
evidence. Receipts and the dashboard use the same complete mapped-execution query,
not a last-20 snapshot window. Unknown history is not zero and not assigned to a
later task. See [project-console.md](project-console.md) for protocol 6, metadata
ownership, archival safeguards, limits and actual verification boundaries.

### Codex efficiency and execution coordination

Prefer direct host inspection with `read`/`workspace_context`. These do not invoke a provider and do not occupy Codex slots. Delegate only work requiring additional reasoning or implementation; passing a host summary still consumes some worker input tokens, so keep it relevant and versioned rather than copying the entire host trajectory.

Defaults are **two active managed agents globally**, at most **two verified readers per checkout**, and **one exclusive writer**. `subagents.maxConcurrentAgents` accepts 1–16, `maxConcurrentReaders` 1–8, `queueWaitMs` 0–900000 (default 300000), and `maxNewSessionsPerWorkItem` 1–16 (default 3). Explicit `maxConcurrentAgents: 1` remains serial; `queueWaitMs: 0` restores immediate conflict responses. Slots count active model tasks, not idle persisted sessions or direct host reads. Compatible readers share one source claim; writes, unknown-effect commands and validation builds remain exclusive. Other providers without a certified shared-analysis adapter stay exclusive even when labeled read-only.

`subagents.sharedResources` optionally declares up to 16 exclusive resources for non-analysis turns. Pure analysis must not use build outputs/devices; explicit task `resources` are always exclusive. Managed `exec_command` accepts matching resources across worktrees. Every participant must use the same state directory and resource keys. This is cooperative admission, **not an OS sandbox**; external editors, terminals and independently daemonized children are outside its guarantee. Existing claims migrate as exclusive. Queued waiters expire or can be cancelled; active claims are never stolen by elapsed time or a missing PID.

Excess work waits locally without starting a provider; a queued writer blocks later readers of the same source. Each agent/thread has only one active or queued turn. Native start requires `taskKey` and `workItemId`; optional `contextKey` reuses an idle related session under matching model/effort/permissions/profile, while `freshContext` retains independent-review capability. Request replay and session affinity are distinct. Native continue requires `requestKey`; identical retries do not perform paid work again and changed payloads under the same key are rejected. The CLI adds `--work-item`, `--context-key`, `--fresh-context` and `--request-key`; its old no-key syntax remains compatible but cannot deduplicate a client retry. Native control avoids a parent shell holding the very source claim it wants to delegate.

`agent_task` provides start/continue/observe/list/claims/usage/cancelQueued. Observe locally waits up to 25 seconds with revision deduplication; full response expansion is explicit. Usage retains provider snapshots and unknowns, not a fabricated invoice. Queued tasks can be cancelled before invocation. Running-task cancellation, orphan reconciliation, automatic immutable snapshots, fork and cache-affinity experiments are not implemented by this phase.

`workspace_context` returns explicit file ranges, full-file hashes and refs. Pass host-selected facts and refs as `agent_task.context = {summary, files}`. At most 24 files, 512 KiB per file and 4 MiB in total are accepted; ranges are bounded to 500 output lines overall. The hash is for the whole referenced file, not just its displayed range. Ref validation occurs after queueing and again after read-only analysis. External edits invalidate covered results, but undeclared dependencies are not automatically tracked. Capture is not a persistent immutable snapshot.

The Codex shared-analysis adapter uses thread-local read-only/network restrictions, disables configured MCP/apps/plugins and native nested fanout, and checks the returned sandbox before turn/start. Null optional tables and Unicode/plugin@market names are supported; ambiguous dotted/quoted identifiers fail closed until their installed-provider semantics are supported. Profile rules use a stable developer-instruction slot while preserving configured global instructions, rather than being appended to every new user prompt. Applicable AGENTS.md rules are not removed. No global Codex configuration is rewritten and cache hits are not guaranteed.

Daemon protocol version **7** prevents an older daemon from ignoring queued states,
context/request fields, work-run ownership, persisted turns, event-driven waits,
provider launch environments, or provider-config revisions. Interrupted tasks are
marked for review, not automatically replayed; no prompt body is stored in waiter
metadata. Use the controlled upgrade/reconnect flow after active work has settled;
do not replace a running server's dist mid-task. See [console verification](project-console.md),
[phase-two history](host-first-readonly-workflows.md), and [phase-one history](codex-efficiency-implementation.md).

## Native artifact download

Set `artifacts.enabled` to `true` when a host needs to save a native attached or
generated file into an open workspace. `artifacts.maxFileBytes` limits one
streamed file. The secure publication path is currently available only on
Linux; the tool is not registered on macOS, Windows, or BSD.

## Environment boundary

Only two user-facing DevSpace environment variables remain:

| Variable | Purpose |
| --- | --- |
| `DEVSPACE_CONFIG_DIR` | Bootstrap location for `config.jsonc`, `auth.json`, skills, and profiles. |
| `DEVSPACE_OAUTH_OWNER_TOKEN` | Optional secret override for the owner token stored in `auth.json`. |

Durable environment settings were removed in v1.1. Move existing deployment
values to these JSONC keys:

| Removed setting | JSONC key |
| --- | --- |
| `HOST`, `PORT` | `server.host`, `server.port` |
| `DEVSPACE_PUBLIC_BASE_URL` | `server.publicBaseUrl` |
| `DEVSPACE_ALLOWED_HOSTS` | `server.allowedHosts` |
| `DEVSPACE_TRUST_PROXY` | `server.trustProxy` |
| `DEVSPACE_ALLOWED_ROOTS` | `workspaces.allowedRoots` |
| `DEVSPACE_WORKTREE_ROOT` | `workspaces.worktreeRoot` |
| `DEVSPACE_STATE_DIR` | `storage.stateDir` |
| `DEVSPACE_TOOL_MODE`, `DEVSPACE_MINIMAL_TOOLS` | `tools.mode` |
| `DEVSPACE_WIDGETS` | `ui.enabled` |
| `DEVSPACE_ARTIFACTS` | `artifacts.enabled` |
| `DEVSPACE_ARTIFACT_MAX_FILE_BYTES` | `artifacts.maxFileBytes` |
| `DEVSPACE_SKILLS` | `skills.enabled` |
| `DEVSPACE_SKILL_PATHS` | `skills.paths` |
| `DEVSPACE_AGENT_DIR` | `skills.agentDir` |
| `DEVSPACE_SUBAGENTS` | `subagents.enabled` |
| `DEVSPACE_LOG_LEVEL` | `logging.level` |
| `DEVSPACE_LOG_FORMAT` | `logging.format` |
| `DEVSPACE_LOG_REQUESTS` | `logging.requests` |
| `DEVSPACE_LOG_ASSETS` | `logging.assets` |
| `DEVSPACE_LOG_TOOL_CALLS` | `logging.toolCalls` |
| `DEVSPACE_LOG_SHELL_COMMANDS` | `logging.shellCommands` |
| `DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS` | `oauth.accessTokenTtlSeconds` |
| `DEVSPACE_OAUTH_REFRESH_TOKEN_TTL_SECONDS` | `oauth.refreshTokenTtlSeconds` |
| `DEVSPACE_OAUTH_SCOPES` | `oauth.scopes` |
| `DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS` | `oauth.allowedRedirectHosts` |

These environment values are not read or auto-imported in v1.1. Environment is
process state, so there is no reliable file DevSpace can migrate on the user's
behalf.

## v1.0 file migration

The first v1.1 load performs one migration when `config.jsonc` is missing and
`config.json` exists:

1. Validate the old JSON document.
2. Translate its known fields into the versioned JSONC structure.
3. Write and validate a temporary `config.jsonc`.
4. Atomically publish it.
5. Rename the old file to `config.json.v1.0.bak`.

If `config.jsonc` exists, DevSpace never reads `config.json`. Invalid JSONC also
never falls back to the old file. Unsupported legacy keys stop migration with an
actionable error instead of being silently discarded.

The persisted fields map as follows:

| v1.0 JSON field | v1.1 JSONC key |
| --- | --- |
| `host`, `port` | `server.host`, `server.port` |
| `publicBaseUrl`, `allowedHosts` | `server.publicBaseUrl`, `server.allowedHosts` |
| `allowedRoots`, `worktreeRoot` | `workspaces.allowedRoots`, `workspaces.worktreeRoot` |
| `stateDir` | `storage.stateDir` |
| `artifactsEnabled`, `artifactMaxFileBytes` | `artifacts.enabled`, `artifacts.maxFileBytes` |
| `agentDir` | `skills.agentDir` |
| `subagents` | `subagents` |
| `tools.mode`, `ui.enabled` | unchanged nested keys |

`auth.json` is unchanged.
