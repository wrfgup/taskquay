import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { Result } from "better-result";
import { LocalAgentManager } from "./local-agent-manager.js";
import { LocalAgentStore } from "./local-agent-store.js";
import { LocalAgentRuntimePool } from "./local-agent-runtime-pool.js";
import type { LocalAgentDriver, LocalAgentRuntime, LocalAgentRunInput } from "./local-agent-runtime.js";
import { ProcessSessionManager } from "./process-sessions.js";
import { ExecutionCoordinator, ExecutionConflictError } from "./execution-coordinator.js";
import { WorkLedger } from "./work-ledger.js";

function fixture(t: test.TestContext, maximum = 1) {
  const root = mkdtempSync(join(tmpdir(), "devspace-admission-"));
  const checkout = join(root, "checkout"); mkdirSync(join(checkout, ".git"), { recursive: true });
  const stateDir = join(root, "state");
  const scope = { workspaceId: "ws_fixture", workspaceRoot: checkout };
  const calls: LocalAgentRunInput[] = [];
  let finish = () => {};
  let blocked = true;
  const runtime: LocalAgentRuntime = {
    provider: "codex",
    run: async (input, callbacks) => {
      calls.push(input);
      await callbacks?.onSessionId?.("fixture-thread");
      if (blocked) await new Promise<void>((resolve) => { finish = resolve; });
      return Result.ok({ provider: "codex", providerSessionId: "fixture-thread", finalResponse: "verified fixture", items: [] });
    },
    releaseSession: async () => {}, isAlive: () => true,
    close: async () => { blocked = false; finish(); },
  };
  const driver: LocalAgentDriver = { provider: "codex", runtimeKey: () => "fixture", createRuntime: async () => Result.ok(runtime) };
  const manager = new LocalAgentManager({ store: new LocalAgentStore(stateDir), drivers: [driver],
    pool: new LocalAgentRuntimePool(), loadProfiles: async () => [], allowedRoots: [root],
    subagents: { enabled: true, instructions: "on-demand", maxConcurrentAgents: maximum, queueWaitMs: 0, providers: [{ id: "codex", enabled: true }] } });
  const processes = new ProcessSessionManager({ stateDir });
  t.after(async () => { await manager.close(); processes.shutdown(); await delay(20); rmSync(root, { recursive: true, force: true }); });
  const release = async () => {
    blocked = false; finish();
    for (let i = 0; manager.activeTurnCount && i < 100; i++) await delay(5);
    assert.equal(manager.activeTurnCount, 0);
  };
  return { root, checkout, stateDir, scope, calls, manager, processes, release };
}

async function settleCalls(calls: unknown[], count: number) {
  for (let i = 0; calls.length < count && i < 100; i++) await delay(5);
  assert.equal(calls.length, count);
}

test("explicit serial/no-queue policy admits one provider turn, including unverified read-only drivers", async (t) => {
  const f = fixture(t);
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => f.manager.start({ ...f.scope,
    target: "codex", prompt: `task ${i}`, writeMode: "read_only" })));
  assert.equal(results.filter((r) => r.isOk()).length, 1);
  assert.equal(results.filter((r) => r.isErr() && r.error.code === "AGENT_CONFLICT").length, 7);
  await settleCalls(f.calls, 1);
  await f.release();
});

test("same task key is durable idempotency; follow-up resumes the original thread", async (t) => {
  const f = fixture(t);
  const input = { ...f.scope, target: "codex", prompt: "one coherent task", taskKey: "issue-42" };
  const results = await Promise.all([f.manager.start(input), f.manager.start(input)]);
  assert(results[0]!.isOk() && results[1]!.isOk());
  const first = results[0]!; const second = results[1]!;
  if (first.isErr() || second.isErr()) throw new Error("fixture admission failed");
  assert.equal(first.value.id, second.value.id);
  await settleCalls(f.calls, 1);
  const different = await f.manager.start({ ...input, prompt: "different instructions" });
  assert(different.isErr());
  await f.release();
  const replay = await f.manager.start(input);
  assert(replay.isOk()); assert.equal(f.calls.length, 1);
  const continued = await f.manager.continue(first.value.id, "next acceptance phase", {}, f.scope);
  assert(continued.isOk());
  await settleCalls(f.calls, 2);
  assert.equal(f.calls[1]?.providerSessionId, "fixture-thread");
  await f.release();
});

test("host mutation and host build cannot race a managed agent", async (t) => {
  const f = fixture(t);
  assert((await f.manager.start({ ...f.scope, target: "codex", prompt: "hold checkout" })).isOk());
  await settleCalls(f.calls, 1);
  let mutated = false;
  await assert.rejects(f.processes.mutate(f.checkout, async () => { mutated = true; }), ExecutionConflictError);
  await assert.rejects(f.processes.start({ workspaceId: f.scope.workspaceId, workspaceRoot: f.checkout,
    cwd: f.checkout, command: "must-not-execute", yieldTimeMs: 0 }), ExecutionConflictError);
  assert.equal(mutated, false);
  await f.release();
  await f.processes.mutate(f.checkout, async () => { mutated = true; });
  assert.equal(mutated, true);
});

test("host operation prevents provider startup and close releases completed claims", async (t) => {
  const f = fixture(t);
  const owner = new ExecutionCoordinator(f.stateDir);
  const claim = owner.acquire({ workspaceRoot: f.checkout, kind: "command" });
  const denied = await f.manager.start({ ...f.scope, target: "codex", prompt: "no competing build" });
  assert(denied.isErr()); assert.equal(f.calls.length, 0);
  const ledger = new WorkLedger(f.stateDir);
  try {
    const execution = ledger.db.prepare("select status,usage_quality,boundary_reason from console_executions order by rowid desc limit 1").get() as any;
    assert.equal(execution.status, "failed"); assert.equal(execution.usage_quality, "not_used");
    assert.equal(execution.boundary_reason, "confirmed_before_inference");
  } finally { ledger.close(); }
  claim.release(); owner.close();
  assert((await f.manager.start({ ...f.scope, target: "codex", prompt: "held" })).isOk());
  await settleCalls(f.calls, 1);
  await f.manager.close();
  const verifier = new ExecutionCoordinator(f.stateDir);
  assert.equal(verifier.inspect(f.checkout).length, 0);
  verifier.close();
});
