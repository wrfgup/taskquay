import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerWorkTaskTool } from "./tool-surfaces/work-task.js";
import type { ToolRegistrationContext } from "./tool-surfaces/types.js";
import { ProcessSessionManager } from "./process-sessions.js";
import { digest, WorkLedger } from "./work-ledger.js";
import { LocalAgentStore } from "./local-agent-store.js";

async function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "devspace-delivery-")), project = join(root, "project"), stateDir = join(root, "state");
  mkdirSync(join(project, ".git"), { recursive: true });
  const ledger = new WorkLedger(stateDir), store = new LocalAgentStore(stateDir), processes = new ProcessSessionManager({ stateDir });
  const pairs: { client: Client; server: McpServer }[] = [];
  async function connect() {
    const server = new McpServer({ name: "fixture", version: "1" }), client = new Client({ name: "fixture-host", version: "1" });
    registerWorkTaskTool({ server, config: { stateDir }, processSessions: processes,
      workspaces: { getWorkspace: (id: string) => ({ id, root: project }) } } as unknown as ToolRegistrationContext);
    const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
    pairs.push({ client, server });
    return { client, call: async (input: Record<string, unknown>) => {
      const result = await client.callTool({ name: "work_task", arguments: { workspaceId: "ws", ...input } });
      const text = (result.content as { text: string }[])[0]!.text;
      let data;
      try { data = JSON.parse(text); } catch { assert(result.isError); data = { message: text }; }
      return { error: Boolean(result.isError), data };
    } };
  }
  t.after(async () => { for (const pair of pairs) { await pair.client.close(); await pair.server.close(); }
    processes.shutdown(); ledger.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const api = await connect();
  const result = await api.call({ action: "begin", workItemId: "audit", runKey: "one", title: "secret-title-must-not-leak" });
  const runId: string = result.data.workRunId;
  const sources = [{ path: "source.ts", sha256: createHash("sha256").update("source").digest("hex") }];
  const artifacts = [{ path: "delivery.apk", sha256: createHash("sha256").update("synthetic-binary").digest("hex") }];
  writeFileSync(join(project, sources[0]!.path), "source"); writeFileSync(join(project, artifacts[0]!.path), "synthetic-binary");
  const delivery = { schema: "devspace.delivery", version: 1, status: "passed", sources, artifacts, sourceHash: digest(sources) };
  return { ...api, connect, root, project, stateDir, ledger, store, processes, runId, delivery,
    record: (overrides: Record<string, unknown> = {}) => api.call({ action: "record", workRunId: runId, requestKey: "publish", delivery, ...overrides }) };
}

test("real MCP publishes typed delivery, recovers same revision after disconnect and keeps APK after failed acceptance", async (t) => {
  const f = await fixture(t);
  const tools = await f.client.listTools();
  assert(JSON.stringify(tools).includes("snapshot")); assert(JSON.stringify(tools).includes("expectedSourceHash"));
  const published = await f.record(); assert(!published.error);
  const revision = published.data.snapshot.revision;
  assert.equal((await f.record()).data.snapshot.revision, revision, "idempotency never refreshes revision");
  await f.client.close(); const recovered = await f.connect();
  const read = await recovered.call({ action: "snapshot", workRunId: f.runId, knownRevision: revision, expectedSourceHash: f.delivery.sourceHash });
  assert.equal(read.data.unchanged, true); assert.equal(read.data.deliveryCompatibility, "matched");
  assert.deepEqual(read.data.latestVerifiedDelivery, published.data.snapshot.latestVerifiedDelivery);
  assert(!JSON.stringify(read.data).includes("secret-title"));
  const stage = await recovered.call({ action: "record", workRunId: f.runId, requestKey: "later-check",
    delivery: { ...f.delivery, artifacts: [] } });
  assert(!stage.error); assert.deepEqual(stage.data.snapshot.latestVerifiedDelivery.receipt.artifacts, f.delivery.artifacts);
  const failed = await recovered.call({ action: "finish", workRunId: f.runId, status: "failed", acceptance: "failed",
    summary: "secret-summary", evidence: [{ label: "secret-label", reference: "secret-reference", outcome: "failed" }] });
  assert(!failed.error);
  const summary = (await recovered.call({ action: "snapshot", workRunId: f.runId })).data;
  assert.equal(summary.acceptanceStatus, "failed"); assert.equal(summary.executionStatus, "failed");
  assert.deepEqual(summary.latestVerifiedDelivery.receipt.artifacts, f.delivery.artifacts);
  assert.equal(summary.nextAction, "repair_failed_acceptance_preserve_verified_artifacts");
  assert(!JSON.stringify(summary).includes("secret-"));
  const legacy = (await recovered.call({ action: "get", workRunId: f.runId })).data;
  assert.equal(legacy.summary, "secret-summary"); assert.equal(legacy.operations.length, 2);
});

test("MCP snapshot reads published ledger under concurrent writer without touching checkout or stealing claim", async (t) => {
  const f = await fixture(t); assert(!(await f.record()).error);
  const claim = f.processes.executionCoordinator!.acquire({ workspaceRoot: f.project, kind: "agent", agentId: "writer", access: "write" });
  try {
    rmSync(join(f.project, "source.ts")); rmSync(join(f.project, "delivery.apk"));
    const snapshot = await f.call({ action: "snapshot", workRunId: f.runId });
    assert(!snapshot.error); assert.equal(snapshot.data.latestVerifiedDelivery.receipt.artifacts.length, 1);
    const denied = await f.record({ requestKey: "writer-active" });
    assert(denied.error); assert.match(denied.data.message, /claim|occupied|active|exclusive/i);
    assert.equal(f.processes.executionCoordinator!.inspect(f.project).length, 1);
    assert.equal((await f.call({ action: "snapshot", workspaceId: "different", workRunId: f.runId })).error, true);
  } finally { claim.release(); }
});

test("MCP rejects stale schema/hash, unknown state, secret fields and paths, scope escapes before publication", async (t) => {
  const f = await fixture(t);
  for (const delivery of [
    { ...f.delivery, version: 0 }, { ...f.delivery, status: "unknown" }, { ...f.delivery, sourceHash: "0".repeat(64) },
    { ...f.delivery, secret: "never-persist" },
    { ...f.delivery, artifacts: [{ path: "../outside.apk", sha256: "0".repeat(64) }] },
    { ...f.delivery, artifacts: [{ path: ".env", sha256: "0".repeat(64) }] },
    { ...f.delivery, artifacts: [{ path: "delivery.apk", sha256: "0".repeat(64) }] },
    { ...f.delivery, status: "failed" },
  ]) assert((await f.record({ delivery })).error);
  const rejected = (await f.call({ action: "snapshot", workRunId: f.runId })).data;
  assert.equal(rejected.operationCount, 0); assert.equal(rejected.latestVerifiedDelivery, null);
  assert(!(await f.record()).error);
  const stale = await f.call({ action: "snapshot", workRunId: f.runId, expectedSourceHash: "0".repeat(64) });
  assert.equal(stale.data.deliveryCompatibility, "stale_source"); assert.equal(stale.data.nextAction, "validate_checkpoint_before_use");
  assert((await f.call({ action: "record", workRunId: f.runId, requestKey: "forged", kind: "delivery.v1", label: "forged" })).error);
  // Simulate a future/obsolete on-disk schema: never silently reinterpret it as passing.
  f.ledger.operation({ runId: f.runId, requestKey: "future", kind: "delivery.v1", label: "ignored", status: "completed",
    evidence: [{ label: "ignored", reference: JSON.stringify({ ...f.delivery, version: 2 }), outcome: "passed" }] });
  const future = (await f.call({ action: "snapshot", workRunId: f.runId })).data;
  assert.equal(future.deliveryCompatibility, "invalid_publication"); assert(future.latestVerifiedDelivery);
});

test("publication rejects a junction outside original scope even though selected filename looks valid", async (t) => {
  const f = await fixture(t), outside = join(f.root, "outside"); mkdirSync(outside);
  writeFileSync(join(outside, "delivery.apk"), "synthetic-binary");
  symlinkSync(outside, join(f.project, "linked"), process.platform === "win32" ? "junction" : "dir");
  const result = await f.record({ delivery: { ...f.delivery, artifacts: [{ ...f.delivery.artifacts[0], path: "linked/delivery.apk" }] } });
  assert(result.error); assert.match(result.data.message, /scope/);
});

test("ten thousand operations and turns page without loss; stable tiny snapshot and stale cursor are explicit", async (t) => {
  const f = await fixture(t); const agent = f.store.create({ workspaceRoot: f.project, workspaceId: "ws", profileName: "fixture", provider: "codex" });
  f.ledger.db.transaction(() => {
    const op = f.ledger.db.prepare("insert into console_operations(id,run_id,request_key,kind,label,status,evidence,created_at) values(?,?,?,?,?,?,?,?)");
    const execution = f.ledger.db.prepare("insert into console_executions(id,run_id,agent_id,provider,status,created_at) values(?,?,?,?,?,?)");
    for (let i = 0; i < 10000; i++) {
      op.run(`op_${i}`, f.runId, `key_${i}`, "read", "secret-".repeat(100), "completed", "[]", "2026-09-07T00:00:00Z");
      execution.run(`exec_${i}`, f.runId, agent.id, "codex", "failed", "2026-09-07T00:00:00Z");
    }
    f.ledger.touch(f.runId);
  })();
  const snapshot = await f.call({ action: "snapshot", workRunId: f.runId });
  assert.equal(snapshot.data.operationCount, 10000); assert.equal(snapshot.data.executionCount, 10000);
  assert(JSON.stringify(snapshot.data).length < 1500); assert(!JSON.stringify(snapshot.data).includes("secret-"));
  const operations = new Set<string>(), turns = new Set<string>(); let cursor: string | null = null, firstCursor = "";
  do {
    const result = await f.call({ action: "history", workRunId: f.runId, limit: 100, ...(cursor ? { cursor } : {}) });
    assert(!result.error); assert(result.data.operations.length <= 100); assert(result.data.turns.length <= 100);
    for (const row of result.data.operations) { assert(!operations.has(row.id)); operations.add(row.id); }
    for (const row of result.data.turns) { assert(!turns.has(row.executionId)); turns.add(row.executionId); }
    cursor = result.data.nextCursor; firstCursor ||= cursor ?? "";
  } while (cursor);
  assert.equal(operations.size, 10000); assert.equal(turns.size, 10000);
  const second = f.ledger.begin({ root: f.project, workspaceId: "ws", workItemId: "other", runKey: "one", title: "other", origin: { entryPoint: "other_mcp", evidence: "server_entry" } });
  assert((await f.call({ action: "history", workRunId: second.id, cursor: firstCursor })).error);
  f.ledger.operation({ runId: f.runId, requestKey: "late", kind: "read", label: "read", status: "completed" });
  const stale = await f.call({ action: "history", workRunId: f.runId, cursor: firstCursor });
  assert(stale.error); assert.match(stale.data.message, /STALE_CURSOR/);
  const compatible = await f.call({ action: "get", workRunId: f.runId });
  assert.equal(compatible.data.operations.length, 5);
  assert.equal(compatible.data.completionSnapshot.operationCount, 10001);
  assert(compatible.data.nextCursor);
  assert(Buffer.byteLength(JSON.stringify(compatible.data)) < 24 * 1024);
});
