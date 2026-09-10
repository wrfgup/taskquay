import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Result } from "better-result";
import { registerWorkspaceContextTool } from "./tool-surfaces/workspace-context.js";
import { registerWorkTaskTool } from "./tool-surfaces/work-task.js";
import { registerCodexTools } from "./tool-surfaces/codex.js";
import { registerAgentTaskTool } from "./tool-surfaces/agent-task.js";
import type { ToolRegistrationContext } from "./tool-surfaces/types.js";
import { ProcessSessionManager } from "./process-sessions.js";
import { WorkLedger } from "./work-ledger.js";
import { LocalAgentStore } from "./local-agent-store.js";
import { traceMcpRequest, argumentFingerprint } from "./mcp-request-diagnostics.js";
import { REPLY_BYTES } from "./bounded-reply.js";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

test("SDK HTTP recovery: bounded Unicode capture, exact reconstruction, command/patch receipts, restart, old get and failed followup", { timeout: 60000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "devspace-receipt-http-")), stateDir = join(root, "state");
  const project = join(root, "project"); mkdirSync(project);
  const source = ["中文😀\\\"".repeat(15000) + "\r\n", "第二行\n".repeat(270) + "末尾😀"];
  source.forEach((s, i) => writeFileSync(join(project, `source${i}.txt`), s));
  let processes = new ProcessSessionManager({ stateDir, completedSessionTtlMs: 1 });
  const ledger = new WorkLedger(stateDir), agents = new LocalAgentStore(stateDir);
  const events: Record<string, any>[] = [];
  const run = ledger.begin({ root: project, workspaceId: "ws_abcdef", workItemId: "recovery", runKey: "once", title: "Fixture", origin: { entryPoint: "other_mcp", evidence: "server_entry" } });
  const record = agents.create({ workspaceId: "ws_abcdef", workspaceRoot: project, provider: "codex", profileName: "codex" });
  const first = ledger.beginExecution({ runId: run.id, agentId: record.id, provider: "codex" });
  const response = "完成的真实响应😀".repeat(8000);
  ledger.saveResponse(first, response); ledger.endExecution(first, "completed");
  const failed = ledger.beginExecution({ runId: run.id, agentId: record.id, provider: "codex" });
  ledger.providerDispatchStarted(failed); ledger.providerNotRequested(failed); ledger.endExecution(failed, "failed");
  agents.update(record.id, { status: "error", errorCode: "PROVIDER_UNAVAILABLE", error: "PAGINATED_HISTORY_UNSUPPORTED", providerSessionId: "original-thread" });
  let server!: McpServer, client!: Client, http!: ReturnType<ReturnType<typeof express>["listen"]>;
  async function connect() {
    server = new McpServer({ name: "recovery-fixture", version: "1" });
    const workspace = { id: "ws_abcdef", root: project };
    const context = { server, config: { stateDir, logging: { toolCalls: false }, subagents: { enabled: false, providers: [] } }, processSessions: processes,
      workspaces: { getWorkspace: (id: string) => ({ ...workspace, id }),
        resolvePath: (_: unknown, path: string) => resolve(project, path),
        resolveWorkingDirectory: () => project,
        resolveReadPath: (_: unknown, path: string) => ({ absolutePath: resolve(project, path), readRoots: [project] }) } } as unknown as ToolRegistrationContext;
    registerWorkspaceContextTool(context); registerWorkTaskTool(context);
    // Production registrations for commands and patches; only the provider client is a fixture.
    registerCodexTools({ ...context, server: { registerResource: server.registerResource.bind(server),
      registerTool: ((name: string, ...args: any[]) => name === "agent_task" ? undefined : (server.registerTool as any)(name, ...args)) as any } });
    registerAgentTaskTool(context, { get: async () => Result.ok(agents.getById(record.id)!),
      list: async () => Result.ok([]), start: async () => { throw new Error("Must not invoke provider"); }, continue: async () => { throw new Error("Must not resume provider"); } });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, enableJsonResponse: true });
    await server.connect(transport);
    const app = express(); app.use(express.json()); app.all("/mcp", (req, res) => {
      traceMcpRequest(req, res, randomUUID(), (event, fields) => { events.push({ event, ...fields }); throw new Error("logger unavailable"); });
      return transport.handleRequest(req, res, req.body);
    });
    http = app.listen(0, "127.0.0.1"); await once(http, "listening");
    const address = http.address(); assert(address && typeof address === "object");
    client = new Client({ name: "fixture", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`)));
  }
  async function disconnect() { await client.close(); await server.close(); await new Promise<void>((r) => http.close(() => r())); }
  await connect();
  t.after(async () => { await disconnect(); processes.shutdown(); agents.close(); ledger.close(); rmSync(root, { recursive: true, force: true }); });
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: { workspace_id: "ws_abcdef", work_run_id: run.id, ...args }, _meta: { "openai/session": "private-conversation-secret" } });
    assert(!result.isError, JSON.stringify(result));
    assert(Buffer.byteLength(JSON.stringify(result)) <= REPLY_BYTES + 512);
    return (result.structuredContent ?? JSON.parse((result.content as { text: string }[])[0]!.text)) as any;
  };
  const listed = (await client.listTools()).tools;
  assert(listed.find((x) => x.name === "workspace_context")!.inputSchema.properties!.line_offset);
  const files = [{ path: "source0.txt", max_lines: 250 }, { path: "source1.txt", max_lines: 250 }];
  let next: any = { selectionIndex: 0, startLine: 1, lineOffset: 0 }, pages = 0;
  const rebuilt = ["", ""];
  while (next) {
    const selections = files.map((s, i) => ({ ...s, start_line: i === next.selectionIndex ? next.startLine : 1 }));
    const page = await call("workspace_context", { action: "capture", files: selections, selection_index: next.selectionIndex, line_offset: next.lineOffset });
    assert.match(page.operationId, /^op_/); assert.equal(page.workRunId, run.id);
    for (const line of page.entries[0].lines) { assert(!line.text.includes("�")); rebuilt[next.selectionIndex] += line.text + line.eol; }
    assert.equal(page.entries[0].sha256, sha(source[next.selectionIndex]!));
    next = page.nextSelection; assert(++pages < 100);
  }
  assert.deepEqual(rebuilt, source); assert(pages > 3);
  const a = await call("workspace_context", { action: "capture", files: [{ path: "source1.txt", start_line: 1 }] });
  const b = await call("workspace_context", { action: "capture", files: [{ path: "source1.txt", start_line: 2 }] });
  const c = await call("workspace_context", { action: "search", files: [{ path: "source1.txt" }], query: "private-query-secret" });
  assert.notEqual(a.contextId, b.contextId); assert.notEqual(a.contextId, c.contextId);
  const terminal = await call("exec_command", { cmd: `"${process.execPath}" -e "process.stdout.write('command-once')"`, yield_time_ms: 2000, request_key: "command-once" });
  assert.equal(terminal.exit_code, 0);
  const nonzero = await call("exec_command", { cmd: `"${process.execPath}" -e "process.exit(7)"`, yield_time_ms: 2000 });
  assert.equal(nonzero.exit_code, 7);
  const patch = await call("apply_patch", { patch: "*** Begin Patch\n*** Add File: changed.txt\n+changed once\n*** End Patch", request_key: "patch-once" });
  assert(patch.operation_id);
  // Drop the connection and reconstruct both client/server and process manager.
  await disconnect(); processes.shutdown(); processes = new ProcessSessionManager({ stateDir }); await connect();
  for (const [name, args] of [["exec_command", { request_key: "command-once", cmd: "echo must-not-replay" }],
    ["apply_patch", { request_key: "patch-once", patch: "*** Begin Patch\n*** Delete File: changed.txt\n*** End Patch" }]] as const) {
    const replay = await client.callTool({ name, arguments: { workspace_id: "ws_abcdef", work_run_id: run.id, ...args } });
    assert(replay.isError); assert.match(JSON.stringify(replay.content), /RECORDED_OPERATION/);
  }
  for (let i = 0; i < 2; i++) {
    const recovered = await call("work_task", { action: "get" }); // old advertised schema only
    const snapshot = recovered.completionSnapshot;
    assert.equal(snapshot.acceptanceStatus, "pending"); assert.equal(snapshot.hostAcknowledgment, "unknown");
    assert.equal(snapshot.latestSuccessfulCommand.evidence.outputSha256, sha("command-once"));
    assert.equal(snapshot.mutationCounts[0].count, 1); assert.equal(snapshot.commandCounts.reduce((n: number, x: any) => n + x.count, 0), 2);
    assert.equal(readFileSync(join(project, "changed.txt"), "utf8"), "changed once\n");
    const observed = await call("agent_task", { action: "observe", agent_id: record.id, wait_ms: 0 });
    assert.equal(observed.executionId, failed); assert.equal(observed.latestSuccessfulExecution.executionId, first);
    assert.equal(observed.responseAvailable, true); assert.equal(observed.status, "failed");
  }
  let responseOffset = 0, restored = "";
  for (;;) {
    const observed = await call("agent_task", { action: "observe", agent_id: record.id, wait_ms: 0, include_response: true, response_offset: responseOffset });
    restored += observed.response;
    if (observed.responsePage.nextOffset === null) break;
    responseOffset = observed.responsePage.nextOffset;
  }
  assert.equal(restored, response); assert.equal(agents.getById(record.id)!.providerSessionId, "original-thread");
  const anotherSuccess = ledger.beginExecution({ runId: run.id, agentId: record.id, provider: "codex" });
  ledger.saveResponse(anotherSuccess, response); ledger.endExecution(anotherSuccess, "completed");
  agents.update(record.id, { status: "idle", latestResponse: response, error: undefined, errorCode: undefined });
  const largeSuccess = await call("agent_task", { action: "observe", agent_id: record.id, wait_ms: 0, include_response: true });
  assert.equal(largeSuccess.status, "completed"); assert(largeSuccess.responsePage.nextOffset > 0);
  const foreign = await client.callTool({ name: "work_task", arguments: { action: "get", workspace_id: "ws_foreign", work_run_id: run.id } }); assert(foreign.isError);
  const foreignObserve = await client.callTool({ name: "agent_task", arguments: { action: "observe", workspace_id: "ws_abcdef", work_run_id: "run_foreign", agent_id: record.id, wait_ms: 0 } }); assert(foreignObserve.isError);
  const expired = await client.callTool({ name: "write_stdin", arguments: { workspace_id: "ws_abcdef", session_id: terminal.session_id } }); assert(expired.isError);
  assert(!JSON.stringify(events).includes("private-")); assert(!JSON.stringify(events).includes(project));
  const completed = events.filter((e) => e.event === "mcp_exchange_finished");
  assert(completed.some((e) => e.operationId === patch.operation_id));
  assert(completed.every((e) => e.hostAcknowledgment === "unknown"));
});

test("normalized selection fingerprints and positive pre-inference evidence preserve prior token accounting", () => {
  assert.equal(argumentFingerprint({ files: [{ path: "a\\b" }] }), argumentFingerprint({ files: [{ maxLines: 80, startLine: 1, path: "a/b" }] }));
  assert.notEqual(argumentFingerprint({ files: [{ path: "a", startLine: 1 }] }), argumentFingerprint({ files: [{ path: "a", startLine: 2 }] }));
});
