import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { WorkspaceRegistry } from "./workspaces.js";
import { loadConfig } from "./config.js";
import { writeTestDevspaceConfig } from "./test-support/config.test.js";
import { readFileTool } from "./pi-tools.js";
import { ProcessSessionManager } from "./process-sessions.js";
import { registerWorkspaceContextTool } from "./tool-surfaces/workspace-context.js";

test("advertised skill tilde/absolute read and capture agree; unadvertised and symlink escapes fail", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "devspace-skill-contract-"));
  const oldHome = process.env.HOME; const oldProfile = process.env.USERPROFILE;
  process.env.HOME = root; process.env.USERPROFILE = root;
  const project = join(root, "project"); const skill = join(root, ".codex", "skills", "advertised");
  const outside = join(root, "private");
  for (const dir of [project, skill, outside]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), "---\nname: advertised\ndescription: Fixture skill\n---\nfixture skill\n");
  writeFileSync(join(outside, "SKILL.md"), "synthetic secret");
  symlinkSync(outside, join(skill, "escape"), process.platform === "win32" ? "junction" : "dir");
  const config = loadConfig(writeTestDevspaceConfig(join(root, "config"), {
    workspaces: { allowedRoots: [project] }, storage: { stateDir: join(root, "state") },
    skills: { agentDir: join(root, ".codex") }, subagents: { enabled: false, instructions: "on-demand", providers: [] },
  }));
  const workspaces = new WorkspaceRegistry(config); const opened = await workspaces.openWorkspace(project);
  const processSessions = new ProcessSessionManager({ stateDir: config.stateDir });
  const server = new McpServer({ name: "fixture", version: "1" });
  registerWorkspaceContextTool({ server, config, workspaces, processSessions });
  const client = new Client({ name: "fixture", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
  t.after(async () => {
    await client.close(); await server.close(); processSessions.shutdown();
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    if (oldProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = oldProfile;
    rmSync(root, { recursive: true, force: true });
  });
  const read = async (path: string) => {
    const resolved = workspaces.resolveReadPath(opened.workspace, path);
    return readFileTool({ path: resolved.absolutePath }, { root: project, cwd: project, readRoots: resolved.readRoots });
  };
  const capture = async (path: string) => client.callTool({ name: "workspace_context", arguments: {
    workspace_id: opened.workspace.id, action: "capture", files: [{ path }],
  } });
  const tilde = "~/.codex/skills/advertised/SKILL.md"; const absolute = join(skill, "SKILL.md");
  assert.deepEqual(await read(tilde), await read(absolute));
  const short = await capture(tilde); const full = await capture(absolute);
  assert(!short.isError); assert.deepEqual(short.content, full.content);
  const data = JSON.parse((short.content as Array<{ text: string }>)[0]!.text);
  assert.equal(data.entries.length, 1); assert.equal(data.refs.length, 0, "External skill evidence is not a workspace delegation ref");
  for (const path of ["~/private/SKILL.md", join(outside, "SKILL.md"), "~/.codex/skills/advertised/../../../private/SKILL.md",
    "~/.codex/skills/advertised/escape/SKILL.md"]) {
    await assert.rejects(read(path));
    const result = await capture(path); assert(result.isError); assert(!JSON.stringify(result).includes("synthetic secret"));
  }
});
