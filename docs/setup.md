# Setup Guide

This guide covers ChatGPT and Coding Agents using DevSpace with local projects.

For this fork, start with the [Chinese default README](../README.md),
[English README](../README.en.md), or the [ChatGPT Server URL / official Tunnel walkthrough](chatgpt-mcp-setup.zh-CN.md).
The commands below run this source checkout after installation/build, not an upstream npm distribution.

## Requirements

- Node `>=22.19 <27`
- npm
- Git
- Bash, including Git Bash or WSL on Windows
- a working ChatGPT MCP transport: your controlled HTTPS endpoint or an authorized
  OpenAI Secure MCP Tunnel, plus reachable OAuth endpoints for this server

DevSpace does not create a tunnel for you. For the Server URL route, ChatGPT users can use
Cloudflare Tunnel, ngrok, Pinggy, Tailscale Funnel, or their own HTTPS reverse
proxy. Official Tunnel is a separate transport with its own permissions and OAuth
constraints; follow the linked walkthrough rather than treating it as a public URL.

## Install And Configure

Run:

```bash
node bin/devspace.js init
```

The setup flow asks one question at a time.

First choose where you will use DevSpace: ChatGPT, Coding Agents, or both.
DevSpace uses that answer to skip setup that does not apply to you.
This selects where you invoke DevSpace from. It does not control which agents
DevSpace may run for delegated work.

### Project roots

If you selected ChatGPT, choose the project folders it may open through
DevSpace. Keep this narrow.

Examples:

```text
~/personal,~/work
```

```text
/Users/alice/dev,/Users/alice/work
```

```text
C:\Users\alice\dev,C:\Users\alice\work
```

A Coding Agents-only setup skips this question. Direct `devspace agents`
commands use the current Git project, or the current directory outside a
repository, with the authority of your local shell. MCP workspace operations
remain limited to the roots configured for ChatGPT.

### Subagents

Setup detects supported agents and asks which ones DevSpace may use as
subagents. ChatGPT or another coding agent can delegate work through DevSpace
to the agents selected here.
These choices are stored as provider objects under `subagents` in
`~/.devspace/config.jsonc`.

### Coding Agents

If you selected Coding Agents, setup prints:

```bash
npx skills add Waishnav/devspace --skill subagents --global
```

That printed command targets the upstream skill, not this fork's changed workflow.
For this fork, review the checked-in `skills/subagents/SKILL.md` and use an explicitly
authorized installation method for your chosen agent; do not overwrite existing skills
merely to follow an inherited example. The Skills CLI asks which installed Coding Agents should receive the skill.
The skill uses `devspace agents targets`, `run`, `continue`, `show`, `wait`, and `ls`.
These commands do not require `devspace serve`.

This Coding Agent installation is separate from ChatGPT MCP usage. For MCP
workspaces with Subagents enabled, DevSpace manages its own copy at
`~/.devspace/skills/subagents/SKILL.md`; users do not install that copy
manually.

### Connect ChatGPT

The initializer's public-URL question applies when you selected ChatGPT. For the Server URL path, start your tunnel or
reverse proxy first and point it at:

```text
http://127.0.0.1:7676
```

For Tailscale Funnel, proxy the whole DevSpace server from the root path:

```bash
tailscale funnel --bg 7676
```

Do not mount Funnel only at `/mcp` with `--set-path=/mcp`. DevSpace also serves
OAuth discovery and authorization routes outside `/mcp`, and a path mount can
strip `/mcp` before the request reaches DevSpace.

Enter the public origin without `/mcp`:

```text
https://your-tunnel-host.example.com
```

Configure the MCP client with the full MCP endpoint:

```text
https://your-tunnel-host.example.com/mcp
```

Protocol compatibility is automatic. DevSpace serves MCP 2026-07-28 requests
directly and handles older 2025-era clients statelessly on the same endpoint;
there is no client-protocol setting to maintain.

A Coding Agents-only setup skips this section.

## Start The Server

Run:

```bash
node bin/devspace.js serve
```

If your tunnel URL changes, update the persisted value before starting:

```bash
node bin/devspace.js config set publicBaseUrl https://taskquay.example.com
node bin/devspace.js serve
```

## Approve The Client

When ChatGPT, Claude, or another MCP client connects, DevSpace shows an Owner
password approval page. Enter the Owner password printed during setup.

The default config files are:

```text
~/.devspace/config.jsonc
~/.devspace/auth.json
```

Keep `auth.json` private.

## Check Your Setup

Run:

```bash
node bin/devspace.js doctor
```

The doctor command reports the resolved config, Node version, Node ABI, platform,
Git, Bash, public URL, allowed hosts, and SQLite native dependency status.

## Running From A Local Checkout

If you are developing DevSpace itself instead of using the published package:

Local checkout development additionally requires pnpm 11.25.0, the version
pinned in `package.json`. Install it with `npm install --global pnpm@11.25.0`.

```bash
pnpm install --frozen-lockfile
pnpm dev:seed
pnpm dev
```

The source server uses an ignored checkout-local fork of your normal DevSpace
configuration and SQLite state. See [Development and Manual QA](development.md)
for worktree switching, ChatGPT testing, and database migration workflows.
