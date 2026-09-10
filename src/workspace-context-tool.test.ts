import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerWorkspaceContextTool } from "./tool-surfaces/workspace-context.js";
import type { ToolRegistrationContext } from "./tool-surfaces/types.js";
import { ProcessSessionManager } from "./process-sessions.js";
import { ExecutionCoordinator } from "./execution-coordinator.js";
import { parseLocalAgentRunArgs, parseLocalAgentContinueArgs } from "./local-agent-targets.js";
import { decodeLocalAgentDaemonRequest } from "./local-agent-daemon-protocol.js";

test("host can capture, search and version exact source through MCP without any provider", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "devspace-host-context-"));
  const project = join(root, "project"); mkdirSync(join(project, ".git"), { recursive: true });
  writeFileSync(join(project, "source.ts"), "// 主控直接读取\nexport const value = 1;\n");
  const processSessions = new ProcessSessionManager({ stateDir: join(root, "state") });
  const server = new McpServer({ name: "fixture", version: "1" });
  registerWorkspaceContextTool({ server, processSessions,
    workspaces: { getWorkspace: () => ({ id: "ws", root: project }), resolvePath: (_workspace: unknown, path: string) => resolve(project, path),
      resolveReadPath: (_workspace: unknown, path: string) => ({ absolutePath: resolve(project, path), readRoots: [project] }) },
  } as unknown as ToolRegistrationContext);
  const client = new Client({ name: "host", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
  t.after(async () => { await client.close(); await server.close(); processSessions.shutdown(); rmSync(root, { recursive: true, force: true }); });
  const call = async (args: Record<string, unknown>) => {
    const response = await client.callTool({ name: "workspace_context", arguments: { workspace_id: "ws", ...args } });
    const text = (response.content as Array<{ type: string; text: string }>).find((item) => item.type === "text")!.text;
    return { error: response.isError, value: response.isError ? text : JSON.parse(text) };
  };
  const listed = await call({ action: "list" });
  assert.equal(listed.value.providerInvoked, false); assert(listed.value.entries.some((entry: { name: string }) => entry.name === "source.ts"));
  const captured = await call({ action: "capture", files: [{ path: "source.ts", max_lines: 1 }] });
  assert(!captured.error); assert.equal(captured.value.entries[0].lines[0].text, "// 主控直接读取");
  assert.equal(captured.value.entries[0].nextLine, 2); assert.match(captured.value.refs[0].sha256, /^[0-9a-f]{64}$/);
  const searched = await call({ action: "search", query: "value", files: [{ path: "source.ts" }] });
  assert.equal(searched.value.entries[0].lines[0].line, 2); assert.equal(searched.value.refs[0].sha256, captured.value.refs[0].sha256);
  writeFileSync(join(project, "source.ts"), "changed\n");
  const changed = await call({ action: "capture", files: [{ path: "source.ts" }] });
  assert.notEqual(changed.value.contextId, captured.value.contextId);
  assert((await call({ action: "capture", files: [{ path: "../outside" }] })).error);
  const owner = new ExecutionCoordinator(join(root, "state"));
  const claim = owner.acquire({ workspaceRoot: project, kind: "mutation" });
  assert((await call({ action: "capture", files: [{ path: "source.ts" }] })).error);
  claim.release(); owner.close();
});

test("CLI and daemon preserve affinity, fresh context, continuation keys and host evidence", () => {
  const parsed = parseLocalAgentRunArgs(["codex", "--task-key", "one", "--work-item", "fix", "--context-key", "module/reviewer", "--fresh-context", "inspect"]);
  assert.equal(parsed.contextKey, "module/reviewer"); assert.equal(parsed.freshContext, true);
  assert.equal(parseLocalAgentContinueArgs(["agt_x", "--request-key", "phase2", "review"]).requestKey, "phase2");
  assert.throws(() => parseLocalAgentRunArgs(["codex", "--request-key", "wrong", "inspect"]));
  const decoded = decodeLocalAgentDaemonRequest({ requestId: "fixture", protocolVersion: 5, authToken: "fixture", method: "agent.start", params: {
    ...parsed, workspaceRoot: process.cwd(), context: { summary: "already inspected", files: [{ path: "source.ts", sha256: "0".repeat(64) }] }, resources: ["build:shared"],
  } });
  assert.equal(decoded.method, "agent.start");
  if (decoded.method !== "agent.start") throw new Error("wrong method");
  assert.equal(decoded.params.context?.summary, "already inspected"); assert.equal(decoded.params.contextKey, parsed.contextKey);
  assert.deepEqual(decoded.params.resources, ["build:shared"]);
});
