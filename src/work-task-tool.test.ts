import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerWorkTaskTool, trackedWork } from "./tool-surfaces/work-task.js";
import type { ToolRegistrationContext } from "./tool-surfaces/types.js";
import { ProcessSessionManager } from "./process-sessions.js";
import { WorkLedger } from "./work-ledger.js";
import { ExecutionCoordinator, ExecutionConflictError } from "./execution-coordinator.js";
import { LocalAgentStore } from "./local-agent-store.js";

async function finishFixture(t: test.TestContext, nested = false) {
  const root = mkdtempSync(join(tmpdir(), "devspace-finish-scope-"));
  const project = join(root, "project"); const other = nested ? join(project, "nested") : project;
  mkdirSync(join(project, ".git"), { recursive: true });
  mkdirSync(join(other, ".git"), { recursive: true });
  const stateDir = join(root, "state"); const ledger = new WorkLedger(stateDir);
  const store = new LocalAgentStore(stateDir);
  const agent = (workspaceId: string, workspaceRoot = project) => store.create({ workspaceId, workspaceRoot, profileName: "fixture", provider: "codex" }).id;
  const coordinator = new ExecutionCoordinator(stateDir);
  const server = new McpServer({ name: "fixture", version: "1" });
  const client = new Client({ name: "fixture-host", version: "1" });
  // No provider/agent manager is installed: this is the actual MCP finish path.
  registerWorkTaskTool({ server, config: { stateDir }, processSessions: { executionCoordinator: coordinator },
    workspaces: { getWorkspace: (id: string) => ({ id, root: project }) } } as unknown as ToolRegistrationContext);
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
  t.after(async () => { await client.close(); await server.close(); coordinator.close(); ledger.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const begin = (key: string, path = project) => ledger.begin({ root: path, workspaceId: key, workItemId: key,
    runKey: "fixture", title: "private fixture prompt", origin: { entryPoint: "other_mcp", evidence: "server_entry" } });
  const runA = begin("a"); const runB = begin("b", other);
  const finishInput = { status: "completed" as const, acceptance: "not_applicable" as const, summary: "fixture", evidence: [] };
  const finish = async (workspaceId = "a") => {
    const response = await client.callTool({ name: "work_task", arguments: { workspace_id: workspaceId, action: "finish", work_run_id: runA.id, ...finishInput } });
    return { error: Boolean(response.isError), data: JSON.parse((response.content as { text: string }[])[0]!.text) };
  };
  return { project, other, ledger, coordinator, runA, runB, finish, finishInput, agent };
}

for (const nested of [false, true]) test(`finish ignores proven foreign agent claims/waiters, nested=${nested}`, async (t) => {
  const f = await finishFixture(t, nested);
  const done = f.ledger.beginExecution({ runId: f.runA.id, agentId: f.agent("a"), provider: "codex" });
  f.ledger.endExecution(done, "completed");
  const activeB = f.agent("b", f.other); const queuedB = f.agent("b", f.other);
  f.ledger.beginExecution({ runId: f.runB.id, agentId: activeB, provider: "codex" });
  const claim = f.coordinator.acquire({ workspaceRoot: f.other, kind: "agent", agentId: activeB });
  f.ledger.beginExecution({ runId: f.runB.id, agentId: queuedB, provider: "codex" });
  const ticket = f.coordinator.enqueue({ workspaceRoot: f.other, kind: "agent", agentId: queuedB }, 60000);
  assert.equal(ticket.tryAcquire(), undefined);
  const before = f.coordinator.inspect(f.project);
  assert.equal(before.length, 2, "legacy global inspect guard rejected both replay fixtures");
  const finished = await f.finish(); assert.equal(finished.error, false);
  assert.equal(f.ledger.run(f.runA.id).status, "completed");
  assert.deepEqual(f.coordinator.inspect(f.project), before, "finish never releases another owner's lock or waiter");
  assert.equal(f.ledger.run(f.runB.id).status, "running");
  assert.throws(() => f.coordinator.acquire({ workspaceRoot: f.project, kind: "mutation" }), ExecutionConflictError);
  assert.throws(() => f.coordinator.acquire({ workspaceRoot: f.project, kind: "read", access: "read" }), ExecutionConflictError);
  assert.equal((await f.finish()).error, false, "idempotent receipt while B remains active");
  ticket.cancel(); claim.release();
});

for (const scenario of ["own_execution", "own_operation", "own_terminal_claim", "unknown_command", "foreign_command", "orphan_agent",
  "unknown_waiter", "terminal_foreign", "old_completed_record", "closed_foreign_run", "project_mismatch", "older_claim", "workspace_mismatch"] as const) {
  test(`finish fails closed: ${scenario}`, async (t) => {
    const f = await finishFixture(t, scenario === "project_mismatch");
    const own = scenario === "own_execution" || scenario === "own_terminal_claim";
    const agentId = f.agent(own ? "a" : "b", own ? f.project : f.other);
    let execution: string | undefined;
    if (!["own_operation", "unknown_command", "orphan_agent", "unknown_waiter", "workspace_mismatch"].includes(scenario)) {
      execution = f.ledger.beginExecution({ runId: own ? f.runA.id : f.runB.id, agentId, provider: "codex" });
    }
    if (scenario === "own_operation") f.ledger.operation({ runId: f.runA.id, requestKey: "running", kind: "command", label: "private", status: "running" });
    if (["old_completed_record", "closed_foreign_run"].includes(scenario)) f.ledger.endExecution(execution!, "completed");
    if (scenario === "closed_foreign_run") f.ledger.finish(f.runB.id, f.finishInput);
    const claim = !["own_execution", "own_operation", "workspace_mismatch", "unknown_waiter"].includes(scenario)
      ? f.coordinator.acquire({ workspaceRoot: f.project, kind: ["unknown_command", "foreign_command"].includes(scenario) ? "command" : "agent", agentId, resources: ["private-resource"] }) : undefined;
    // Replay the real finally ordering: endExecution, then (later) release.
    if (["own_terminal_claim", "terminal_foreign"].includes(scenario)) f.ledger.endExecution(execution!, "completed");
    const ticket = scenario === "unknown_waiter" ? f.coordinator.enqueue({ workspaceRoot: f.project, kind: "agent", agentId: "orphan-waiter" }, 60000) : undefined;
    if (scenario === "older_claim") f.ledger.db.prepare("update console_executions set created_at=? where id=?").run("2999-01-01T00:00:00.000Z", execution!);
    const result = await f.finish(scenario === "workspace_mismatch" ? "b" : "a");
    assert.equal(result.error, true); assert.equal(f.ledger.run(f.runA.id).status, "running");
    if (scenario !== "workspace_mismatch") {
      assert.equal(typeof result.data.blocking, "string"); assert.match(result.data.nextAction, /retry finish/);
      assert(JSON.stringify(result.data).length < 800);
      for (const secret of [f.project, f.other, "private-resource", "private fixture prompt", agentId]) assert(!JSON.stringify(result.data).includes(secret));
      assert.throws(() => f.ledger.finish(f.runA.id, f.finishInput), "direct ledger callers retain transactional checks");
    }
    ticket?.cancel(); claim?.release();
    if (["own_terminal_claim", "terminal_foreign", "old_completed_record"].includes(scenario)) assert.equal((await f.finish()).error, false);
  });
}

test("actual MCP finish returns the same receipt as the dashboard and waits for yielded processes", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "devspace-work-tool-")); const project = join(root, "project");
  mkdirSync(join(project, ".git"), { recursive: true }); const stateDir = join(root, "state");
  writeFileSync(join(project, "wait.cjs"), "setTimeout(()=>process.exit(0),400)");
  const processes = new ProcessSessionManager({ stateDir }); const ledger = new WorkLedger(stateDir);
  const server = new McpServer({ name: "fixture", version: "1" }); const client = new Client({ name: "fixture-host", version: "1" });
  registerWorkTaskTool({ server, config: { stateDir }, processSessions: processes,
    workspaces: { getWorkspace: (key: string) => { assert.equal(key, "ws"); return { id: "ws", root: project }; } } } as unknown as ToolRegistrationContext);
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
  t.after(async () => { await client.close(); await server.close(); processes.shutdown(); ledger.close(); await delay(50); rmSync(root, { recursive: true, force: true }); });
  const call = async (args: Record<string, unknown>) => {
    const response = await client.callTool({ name: "work_task", arguments: { workspace_id: "ws", ...args } });
    const content = response.content as { type: string; text: string }[];
    return { error: Boolean(response.isError), data: JSON.parse(content[0]!.text) };
  };
  const begun = await call({ action: "begin", work_item_id: "host-implementation", run_key: "first", title: "Host-only verification", host_model_label: "User display label" });
  assert(!begun.error); assert.equal(begun.data.origin.evidence, "client_reported");
  assert.equal(begun.data.usageStatus, "not_used"); const workRunId = begun.data.workRunId;
  await trackedWork(stateDir, workRunId, { root: project, workspaceId: "ws" }, "read", async () => ({ isError: false }));
  let process = await processes.start({ workspaceId: "ws", workspaceRoot: project, cwd: project,
    command: `"${globalThis.process.execPath}" wait.cjs`, yieldTimeMs: 0, workRunId });
  const finish = { action: "finish", work_run_id: workRunId, status: "completed", acceptance: "passed", summary: "Verified the process and source",
    evidence: [{ label: "Process exit", reference: "test://isolated-wait-process", outcome: "passed" }] };
  assert(process.running); assert((await call(finish)).error, "A returned process handle is not completion");
  while (process.running) process = await processes.write({ workspaceId: "ws", sessionId: process.sessionId!, yieldTimeMs: 1000 });
  const revision = ledger.requireScope(workRunId, project, "ws").revision;
  for (let i = 0; i < 2; i++) assert.deepEqual(await processes.write({ workspaceId: "ws", sessionId: process.sessionId! }), { ...process, terminalReplay: true });
  assert.equal(ledger.requireScope(workRunId, project, "ws").revision, revision, "Terminal replay does not settle the ledger again");
  assert.equal(processes.executionCoordinator!.inspect(project).length, 0, "Claims released on close, not replay");
  const completed = await call(finish); assert(!completed.error);
  assert.deepEqual(completed.data, ledger.receipt(workRunId));
  assert.equal(completed.data.codexUsage?.totalTokens, 0); assert.equal(completed.data.acceptanceStatus, "passed");
  assert.equal(ledger.detail(completed.data.projectId, workRunId).operations.length, 2);
  assert.deepEqual((await call(finish)).data, completed.data);
});
