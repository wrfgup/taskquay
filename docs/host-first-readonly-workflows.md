# Host-first context and bounded read-only workflows

Implementation date: 2026-09-06. Starting source: `be280bb` with a clean checkout.
The optimization target is Codex usage, not host tokens. Host-side context preparation,
deterministic checks, explicit evidence and rigorous independent acceptance take priority.

## Implemented workflow

The host first reads the applicable instructions and uses `read` or `workspace_context`.
Listing, selected-file capture/hash and literal search contain no provider invocation.
Do not pay for a Codex overview merely to locate source. Decide whether a worker is
necessary, then provide a short task, facts, source refs, constraints and acceptance tests.
The worker may inspect additional relevant code and must not treat a host summary as
an instruction overriding project rules. This avoids needless broad rereading; it does
not imply that the summary or necessary source reads consume zero worker tokens.

Example native sequence (schema contracts, not a requirement to invoke a worker):

```json
{"action":"capture","workspace_id":"<workspace>","files":[{"path":"src/example.ts","start_line":1,"max_lines":80}]}
```

This is a `workspace_context` request. The host can answer directly from the result.
When further work is warranted, `agent_task` accepts:

```json
{
  "action":"start","workspace_id":"<workspace>","target":"codex",
  "task_key":"review-1","work_item_id":"example-fix","context_key":"example/reviewer",
  "read_only":true,"prompt":"Review the specified transition and adjacent tests.",
  "context":{"summary":"Host-verified facts and remaining questions.","files":[{"path":"src/example.ts","sha256":"<actual capture hash>"}]}
}
```

Use actual returned refs, never placeholder hashes. The whole referenced file is hashed,
even if only a small range was shown. Capture is bounded (24 files; 512 KiB each;
4 MiB combined; 500 output lines) and does not recursively gather unrelated files.
Refs are revalidated after queueing and, for shared analysis, after the turn. Changed
declared inputs prevent invocation or invalidate the conclusion. Undeclared dependencies,
external service state and arbitrary external edits are not fully observed.

## Admission and resource ownership

Default active agents: 2. Default verified readers per real checkout: 2. Writers: 1.
Legacy `maxConcurrentAgents: 1` remains serial; `queueWaitMs: 0` retains immediate conflicts.
Unspecified or unknown effects are exclusive. Builds/installs/database/device operations
are not pure analysis; switch to a normal execution turn with explicit resource ownership.
The same provider thread cannot have overlapping turns, even across coordinator clients.
Direct host reads share source access but do not consume provider execution slots.

SQLite transactions coordinate source/resource/thread claims across participating processes.
Aliases and subdirectories resolve to the same checkout; separate worktrees are distinct
sources but must declare shared build/device resources. Earlier waiting writers block later
readers of the same source. At most 64 waiting intents are retained; the default queue wait
is 300000 ms. Waiting uses local timers and does not start a model. `cancelQueued` only cancels
not-yet-started work. Switching read to write requires a new turn/claim, not an in-place upgrade.

The Codex adapter requests offline read-only permissions, disables configured external
MCP/apps/plugins and nested delegation for this thread, and checks returned sandbox/approval
settings before `turn/start`. Other adapters without a certified shared-analysis path remain
exclusive. Absent nullable configuration tables are supported. Unicode and plugin@market IDs
are supported as literal override segments; dotted/quoted ambiguous IDs fail before inference.
These are thread-local settings, not changes to the user's global configuration.

## Context affinity is not idempotency

`work_item_id` identifies one coherent objective and its acceptance cycle. Native MCP starts require
it and a stable initial `task_key`. A new task under the same explicit `context_key` resumes an
idle related provider thread only when workspace/scope, work item, target, requested effective
model/effort, permissions and profile match. The source commit is deliberately not the affinity
key: provide the changed evidence and continue instead of creating a new thread per commit.

An occupied matching session is not silently cloned. Observe it before continuing. A separate
independent acceptance context uses `fresh_context`. Default new-session budget per work item
is 3 (configurable), distinct from active concurrency. Do not vary the work item merely to evade
the budget. A request key replays one exact request; it is not a topic or session name.

Native MCP continuation requires `request_key`. Replaying that key does not invoke a model twice;
different instructions with the same key are rejected. Legacy CLI continuation without a key
still gets atomic busy-session reservation, but cannot deduplicate a network retry. An admission
failure persists a terminal result rather than leaving the session permanently `starting`.
CLI flags are `--work-item`, `--context-key`, `--fresh-context`, `--task-key`, and `--request-key`.

For Codex, profile text occupies a stable developer-instruction slot, preserving configured
global developer instructions instead of appending the profile to every new user prompt.
Other adapters retain their existing instruction behavior. No claim is made that resume,
instruction stability or process reuse guarantees a provider cache hit. No warm-up model
requests or speculative worker pool is created.

## Recovery, migration and rollout boundaries

Database migration 10 adds read modes, waiters, affinity and continuation keys. Old claims
are migrated as exclusive. Protocol 5 makes old daemons reject unsupported semantics rather
than silently ignoring them. An interrupted queued task is marked for review on restart;
the waiter table stores only bounded scheduling metadata, not prompts or private source.
Active claims are never stolen by PID/timeout alone; a child or external effect may survive.
Neither task replay after a crash nor active-provider cancellation is added by this phase.

Source locks are cooperative, not an OS sandbox for arbitrary terminals. Automatic immutable
snapshots, arbitrary-checkpoint forks, cache-affinity overrides, full workflow-cost aggregation
and real cost A/B remain deferred. The existing usage snapshot window is not a whole-workflow
invoice. The effective read-only provider handshake is a narrower check than running every
possible sandbox/tool action. Existing independent quality gates must remain intact.

Build candidate output in `node_modules/.cache/devspace-phase2/dist`, not the live service's
dist. Activating requires the normal controlled deployment/reconnect after active work is
finished; this implementation task does not restart the service or publish a package.

## Verification evidence

Targeted tests cover concurrent readers, third-reader queueing, writer fairness, shared-resource
and provider-thread exclusion, unknown-adapter fallback, queue expiry/cancellation, session reuse,
fresh review, new-session budgets, continuation replay and denied reservation cleanup, stale input
before/after analysis, path containment and direct host MCP capture/search with zero provider calls.
JSON-RPC fixtures also check external-tool restrictions, profile-slot preservation and refusal of
unconfirmed permissions before any turn starts.

The installed Codex 0.135.0 configuration/permission probe passed without a model turn:
`read_only_confirmed=true`, `network_restricted=true`, `inference_turns_started=0`.
It used an ephemeral thread and closed its owned process, did not modify global configuration,
and retained only non-secret booleans/counts. A first probe found nullable absent tool tables;
a second found valid non-ASCII/plugin identities; both failed closed and were covered by fixes.
Final full-suite and isolated-build evidence is recorded below after execution.

### Final acceptance

- `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`: exit 0.
- Full serial suite: **134 tests, 131 passed, 0 failed, 3 skipped**. A Pi sandbox
  integration file also reports its dependency-based internal skip; this is not
  evidence that the unavailable sandbox integration ran. Log:
  `node_modules/.cache/devspace-phase2/tests-final.log`.
- TypeScript application output and Vite UI built successfully into the isolated
  candidate. The existing large-chunk warning remains nonfatal; this phase did not
  change UI behavior. CLI help displays the new work-item/affinity/request flags.
- Compiled JavaScript admission and actual in-memory MCP host capture both passed:
  two read claims coexist, further admission is bounded, mutation waits, and the
  host captures a versioned file without any provider. Receipt reports
  `compiled_admission=true`, `compiled_mcp_host_capture=true`, `model_invocations=0`.
- The installed-provider permission handshake and all mock-provider tests sent
  no paid inference turn. No real token-cost A/B, arbitrary-tool sandbox exercise,
  production provider workflow, or refreshed ChatGPT tool-list test is claimed.
- `git diff --check` passed. No live dist replacement, service restart, global
  Codex configuration modification, package publication or Git push was performed.

The live connector can still expose the older tool list until an explicit controlled
rollout. Source/candidate verification above must not be mistaken for activation of
the current server. The approved priority work is implemented; conditional fork/cache
experiments and the larger recovery/log-store roadmap remain separate future work.
