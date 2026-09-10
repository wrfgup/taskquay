import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Result } from "better-result";
import { LocalAgentStore } from "./local-agent-store.js";
import { LocalAgentManager } from "./local-agent-manager.js";
import { LocalAgentRuntimePool } from "./local-agent-runtime-pool.js";
import type { LocalAgentDriver, LocalAgentRunInput, LocalAgentRunCallbacks } from "./local-agent-runtime.js";
import { ProcessSessionManager } from "./process-sessions.js";
import { ExecutionCoordinator, ExecutionConflictError } from "./execution-coordinator.js";
import { readContextFile, verifyHostContext, validateContextShape } from "./workspace-context.js";
import { registerAgentTaskTool } from "./tool-surfaces/agent-task.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ToolRegistrationContext } from "./tool-surfaces/types.js";
import { WorkLedger } from "./work-ledger.js";

async function until(check: () => boolean) {
  for (let i = 0; i < 400 && !check(); i++) await delay(5);
  assert(check(), "Expected state transition did not occur");
}

function fixture(t: test.TestContext, options: { readSafe?: boolean; queueWaitMs?: number; budget?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "devspace-read-workflow-"));
  const project = join(root, "project"); mkdirSync(join(project, ".git"), { recursive: true });
  writeFileSync(join(project, "source.ts"), "export const value = 1;\n");
  const stateDir = join(root, "state");
  const scope = { workspaceRoot: project, workspaceId: "ws_analysis" };
  const calls: Array<{ id: string; input: LocalAgentRunInput }> = [];
  const waiting = new Map<string, () => void>();
  const store = new LocalAgentStore(stateDir);
  const driver: LocalAgentDriver = {
    provider: "codex", readOnlyConcurrency: options.readSafe !== false, persistentProfileInstructions: true,
    runtimeKey: (context) => context.agentId,
    createRuntime: async (context) => Result.ok({
      provider: "codex", isAlive: () => true, releaseSession: async () => {},
      run: async (input: LocalAgentRunInput, callbacks?: LocalAgentRunCallbacks) => {
        await callbacks?.onSessionId?.(`thread-${context.agentId}`);
        calls.push({ id: context.agentId, input });
        await new Promise<void>((resolve) => waiting.set(context.agentId, resolve));
        return Result.ok({ provider: "codex", providerSessionId: `thread-${context.agentId}`, finalResponse: "fixture analysis", items: [] });
      },
      close: async () => { waiting.get(context.agentId)?.(); },
    }),
  };
  const manager = new LocalAgentManager({ store, drivers: [driver], pool: new LocalAgentRuntimePool(),
    allowedRoots: [root], loadProfiles: async () => [], subagents: { enabled: true, instructions: "on-demand",
      maxNewSessionsPerWorkItem: options.budget, queueWaitMs: options.queueWaitMs ?? 5000,
      providers: [{ id: "codex", enabled: true }] } });
  const host = new ProcessSessionManager({ stateDir });
  t.after(async () => { await manager.close(); host.shutdown(); await delay(20); rmSync(root, { recursive: true, force: true }); });
  const start = async (prompt: string, readOnly = true, extra: Record<string, unknown> = {}) => {
    const result = await manager.start({ ...scope, target: "codex", prompt,
      writeMode: readOnly ? "read_only" : "allowed", ...extra });
    if (result.isErr()) throw result.error;
    return result.value;
  };
  const finish = async (id: string) => {
    await until(() => waiting.has(id));
    waiting.get(id)!(); waiting.delete(id);
    await until(() => !["running", "queued", "starting"].includes(store.getById(id)!.status));
    await delay(5);
  };
  return { root, project, stateDir, scope, calls, store, manager, host, start, finish };
}

test("two verified readers run; a third queues locally, then resumes without a prestarted model", async (t) => {
  const f = fixture(t);
  const a = await f.start("read A"); const b = await f.start("read B"); const c = await f.start("read C");
  await until(() => f.calls.length === 2);
  assert.equal(f.store.getById(c.id)!.status, "queued");
  assert(f.calls.every((call) => call.input.analysisOnly && call.input.writeMode === "read_only"));
  await f.finish(a.id); await until(() => f.calls.length === 3);
  await f.finish(b.id); await f.finish(c.id);
});

test("queued writer has priority over later readers; shared reads never upgrade in place", async (t) => {
  const f = fixture(t);
  const a = await f.start("reader A"); const b = await f.start("reader B");
  const writer = await f.start("writer", false); const later = await f.start("later reader");
  await until(() => f.calls.length === 2);
  await f.finish(a.id); await delay(120); assert.equal(f.calls.length, 2);
  await f.finish(b.id); await until(() => f.calls.length === 3);
  assert.equal(f.calls[2]!.id, writer.id);
  assert.equal(f.store.getById(later.id)!.status, "queued");
  await f.finish(writer.id); await until(() => f.calls.length === 4); await f.finish(later.id);
});

test("host reads need no provider and share with readers; host writes/builds remain excluded", async (t) => {
  const f = fixture(t); const a = await f.start("read");
  await until(() => f.calls.length === 1);
  const ref = await f.host.readWorkspace(f.project, async () => readContextFile(f.project, "source.ts"));
  assert.equal(ref.path, "source.ts"); assert.equal(f.calls.length, 1);
  await assert.rejects(f.host.mutate(f.project, async () => {}), ExecutionConflictError);
  await assert.rejects(f.host.start({ workspaceId: f.scope.workspaceId, workspaceRoot: f.project, cwd: f.project,
    command: "this-command-must-not-run", yieldTimeMs: 0 }), ExecutionConflictError);
  await f.finish(a.id);
});

test("uncertified read-only drivers are exclusive, not promoted by a prompt or boolean", async (t) => {
  const f = fixture(t, { readSafe: false });
  const a = await f.start("read A"); const b = await f.start("read B");
  await until(() => f.calls.length === 1); assert.equal(f.store.getById(b.id)!.status, "queued");
  assert.equal(f.calls[0]!.input.analysisOnly, false);
  await f.finish(a.id); await until(() => f.calls.length === 2); await f.finish(b.id);
});

test("queued cancellation and timeout never invoke a provider and release waiter metadata", async (t) => {
  const f = fixture(t, { queueWaitMs: 150 });
  const a = await f.start("writer", false); const b = await f.start("cancel me");
  assert(f.manager.cancelQueued(b.id, f.scope).isOk());
  await until(() => f.store.getById(b.id)!.status === "stopped");
  const c = await f.start("expire me"); await until(() => f.store.getById(c.id)!.status === "error");
  assert.equal(f.calls.length, 1); await f.finish(a.id);
  const observer = new ExecutionCoordinator(f.stateDir);
  assert.equal(observer.inspect(f.project).length, 0); observer.close();
});

test("MCP queue conflict and busy continue expose scoped next actions with zero provider calls", async (t) => {
  const f = fixture(t, { queueWaitMs: 150 });
  const external = new ExecutionCoordinator(f.stateDir);
  const claim = external.acquire({ workspaceRoot: f.project, kind: "mutation" });
  const server = new McpServer({ name: "fixture", version: "1" });
  registerAgentTaskTool({ server, config: { stateDir: f.stateDir, subagents: {} }, processSessions: f.host,
    workspaces: { getWorkspace: (id: string) => ({ id, root: f.project }) },
  } as unknown as ToolRegistrationContext, {
    start: (input) => f.manager.start(input), continue: (...args) => f.manager.continue(...args),
    get: async (...args) => f.manager.get(...args), list: async (...args) => f.manager.list(...args),
  });
  const client = new Client({ name: "fixture", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
  const call = async (args: Record<string, unknown>) => {
    const result = await client.callTool({ name: "agent_task", arguments: { workspace_id: f.scope.workspaceId, ...args } });
    return { ...JSON.parse((result.content as Array<{ text: string }>)[0]!.text), isError: result.isError };
  };
  try {
  const started = await call({ action: "start", target: "codex", prompt: "fixture", task_key: "fixture", work_item_id: "fixture" });
  assert.equal(started.status, "queued"); assert.equal(started.nextAction.action, "observe");
  const queued = await call({ action: "observe", agent_id: started.id, wait_ms: 0 });
  assert.equal(queued.progress.waitingReason, "execution_admission");
  assert.equal(queued.admission.owners[0].claimId, claim.id); assert.equal(queued.admission.owners[0].scope, "checkout");
  const busy = await call({ action: "continue", agent_id: started.id, prompt: "next", request_key: "next", work_run_id: started.workRunId });
  assert.equal(busy.isError, true); assert.equal(busy.providerInvoked, false); assert.equal(busy.requestAccepted, false);
  assert.equal(busy.nextAction.action, "observe"); assert.equal(busy.owner.workspaceId, f.scope.workspaceId);
  for (const action of ["observe", "usage"])
    assert.equal((await call({ action, agent_id: started.id, workspace_id: "other-workspace", wait_ms: 0, include_response: true })).isError, true);
  await until(() => f.store.getById(started.id)!.status === "error");
  const terminal = await call({ action: "observe", agent_id: started.id, wait_ms: 0 });
  assert.equal(terminal.nextAction.action, "claims"); assert.equal(terminal.error.code, "AGENT_CONFLICT");
  assert.equal(f.calls.length, 0);
  const ledger = new WorkLedger(f.stateDir);
  try { const receipt = ledger.receipt(started.workRunId); assert.equal(receipt.usageStatus, "not_used"); assert.equal(receipt.codexUsage?.totalTokens, 0); }
  finally { ledger.close(); }
  assert.equal(external.inspect(f.project)[0]?.id, claim.id, "Waiting/observe never steal an active claim");
  } finally { await client.close(); await server.close(); claim.release(); external.close(); }
});

test("context affinity resumes a relevant thread, while fresh review gets an independent one", async (t) => {
  const f = fixture(t);
  const common = { workItemId: "fix-records", contextKey: "backend/records/reviewer" };
  const first = await f.start("first", true, { ...common, taskKey: "first" }); await f.finish(first.id);
  const second = await f.start("follow-up", true, { ...common, taskKey: "second" });
  assert.equal(second.id, first.id); await until(() => f.calls.length === 2);
  assert.equal(f.calls[1]!.input.providerSessionId, `thread-${first.id}`); await f.finish(second.id);
  const replay = await f.start("follow-up", true, { ...common, taskKey: "second" });
  assert.equal(replay.id, second.id); assert.equal(f.calls.length, 2);
  const independent = await f.start("independent acceptance", true, { ...common, taskKey: "review", freshContext: true });
  assert.notEqual(independent.id, first.id); await f.finish(independent.id);
});

for (const status of ["error", "stopped"] as const) test(`context affinity retains the provider thread after ${status}`, async (t) => {
  const f = fixture(t, { budget: 1 });
  const common = { workItemId: "work", contextKey: "implementation" };
  const first = await f.start("first", true, { ...common, taskKey: "first" }); await f.finish(first.id);
  f.store.update(first.id, { status, errorCode: "PROVIDER_UNAVAILABLE" });
  const resumed = await f.start("explicit follow-up", true, { ...common, taskKey: "next" });
  assert.equal(resumed.id, first.id);
  await until(() => f.calls.length === 2);
  assert.equal(f.calls[1]!.input.providerSessionId, `thread-${first.id}`);
  await f.finish(resumed.id);
  await f.start("explicit follow-up", true, { ...common, taskKey: "next" });
  assert.equal(f.calls.length, 2, "A repeated start remains an idempotent receipt read");
});

test("independent contexts in one work run receive distinct session labels and related work keeps its identity", async (t) => {
  const f = fixture(t);
  const run = (() => {
    const ledger = new WorkLedger(f.stateDir);
    try { return ledger.begin({ root: f.project, workspaceId: f.scope.workspaceId, workItemId: "work", runKey: "run",
      title: "Shared task title", origin: { entryPoint: "other_mcp", evidence: "server_entry" } }); }
    finally { ledger.close(); }
  })();
  const common = { workRunId: run.id, workItemId: "work" };
  const a = await f.start("implementation", true, { ...common, taskKey: "a", contextKey: "implementation" }); await f.finish(a.id);
  const b = await f.start("review", true, { ...common, taskKey: "b", contextKey: "review" }); await f.finish(b.id);
  assert.notEqual(f.calls[0]!.input.sessionLabel, f.calls[1]!.input.sessionLabel);
  assert.match(f.calls[0]!.input.sessionLabel!, /Shared task title/);
  const continued = await f.start("next implementation step", true, { ...common, taskKey: "c", contextKey: "implementation" });
  assert.equal(continued.id, a.id); await until(() => f.calls.length === 3);
  assert.equal(f.calls[2]!.input.sessionLabel, f.calls[0]!.input.sessionLabel);
  assert.equal(f.calls[2]!.input.providerSessionId, `thread-${a.id}`); await f.finish(a.id);
});

test("continuation idempotency is distinct from the reusable session and rejects changed payloads", async (t) => {
  const f = fixture(t); const first = await f.start("first"); await f.finish(first.id);
  const options = { writeMode: "read_only" as const, requestKey: "next-phase" };
  const a = await f.manager.continue(first.id, "next", options, f.scope);
  const b = await f.manager.continue(first.id, "next", options, f.scope);
  assert(a.isOk() && b.isOk()); await until(() => f.calls.length === 2);
  assert((await f.manager.continue(first.id, "changed", options, f.scope)).isErr());
  await f.finish(first.id);
  assert((await f.manager.continue(first.id, "next", options, f.scope)).isOk());
  assert.equal(f.calls.length, 2);
});

test("a work-item new-session budget limits serial context proliferation, not just concurrent tasks", async (t) => {
  const f = fixture(t, { budget: 2 });
  for (const taskKey of ["one", "two"]) {
    const record = await f.start(taskKey, true, { taskKey, workItemId: "work", freshContext: true }); await f.finish(record.id);
  }
  const rejected = await f.manager.start({ ...f.scope, target: "codex", prompt: "third", workItemId: "work", taskKey: "third" });
  assert(rejected.isErr()); assert.equal(f.calls.length, 2);
});

test("failed continuation admission is terminal, and a different manager cannot reserve the busy session", async (t) => {
  const f = fixture(t, { queueWaitMs: 0 });
  const first = await f.start("first"); await f.finish(first.id);
  const external = new ExecutionCoordinator(f.stateDir);
  const held = external.acquire({ workspaceRoot: f.project, kind: "mutation" });
  const denied = await f.manager.continue(first.id, "cannot enter", { requestKey: "denied" }, f.scope);
  assert(denied.isErr()); assert.equal(f.store.getById(first.id)!.status, "stopped");
  const replay = await f.manager.continue(first.id, "cannot enter", { requestKey: "denied" }, f.scope);
  assert(replay.isOk()); assert.equal(f.calls.length, 1);
  held.release(); external.close();
  assert((await f.manager.continue(first.id, "legacy next", {}, f.scope)).isOk());
  await until(() => f.calls.length === 2);
  const otherStore = new LocalAgentStore(f.stateDir);
  const result = otherStore.reserveContinueResult(first.id, "other", "hash");
  assert(result.isErr()); otherStore.close();
  await f.finish(first.id);
});

test("host evidence is checked after queueing and invalidated if it changes during analysis", async (t) => {
  const f = fixture(t);
  const old = readContextFile(f.project, "source.ts");
  const context = { summary: "The host inspected this file; check only the affected invariant.", files: [{ path: old.path, sha256: old.sha256 }] };
  const writer = await f.start("writer", false);
  const pending = await f.start("must reject stale", true, { context });
  writeFileSync(join(f.project, "source.ts"), "export const value = 2;\n");
  await f.finish(writer.id); await until(() => f.store.getById(pending.id)!.status === "error");
  assert.equal(f.calls.length, 1); assert.match(f.store.getById(pending.id)!.error!, /STALE_CONTEXT/);
  const fresh = readContextFile(f.project, "source.ts");
  const running = await f.start("analyze current", true, { context: { ...context, files: [{ path: fresh.path, sha256: fresh.sha256 }] } });
  await until(() => f.calls.length === 2);
  assert.match(f.calls[1]!.input.prompt, /Host-prepared context/);
  assert(!f.calls[1]!.input.prompt.includes("export const value"), "Full source must not be copied automatically");
  writeFileSync(join(f.project, "source.ts"), "export const value = 3;\n");
  await f.finish(running.id); assert.equal(f.store.getById(running.id)!.status, "error");
});

test("context input validation does not escape the workspace or accept binary/unbounded evidence", async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.root, "outside.txt"), "outside");
  assert.throws(() => readContextFile(f.project, "../outside.txt"));
  writeFileSync(join(f.project, "binary"), Buffer.from([0, 1]));
  assert.throws(() => readContextFile(f.project, "binary"));
  assert.throws(() => validateContextShape({ summary: "x".repeat(12001), files: [] }));
  assert.throws(() => verifyHostContext(f.project, { summary: "", files: [{ path: "source.ts", sha256: "0".repeat(64) }] }), /STALE_CONTEXT/);
  // Directory junction is supported on Windows without developer-mode symlink privileges.
  symlinkSync(f.root, join(f.project, "alias"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => readContextFile(f.project, "alias/outside.txt"));
});
