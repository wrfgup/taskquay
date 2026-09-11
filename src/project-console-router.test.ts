import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import type { ServerConfig } from "./config.js";
import { Result } from "better-result";
import { LocalAgentStore } from "./local-agent-store.js";
import { WorkLedger } from "./work-ledger.js";
import { createProjectConsoleRouter } from "./project-console-router.js";

test("console authentication, source scopes, CSRF and session expiry protect all management operations", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "devspace-console-http-")); const project = join(root, "project");
  mkdirSync(join(project, ".git"), { recursive: true }); const state = join(root, "state");
  const assetDirectory = join(root, ".candidate", "ui"); mkdirSync(assetDirectory, { recursive: true });
  writeFileSync(join(assetDirectory, "console.html"), "<!doctype html><title>fixture console</title>");
  const ledger = new WorkLedger(state);
  const run = ledger.begin({ root: project, workspaceId: "ws", workItemId: "ui", runKey: "first", title: "<img src=x onerror=alert(1)>", origin: { entryPoint: "chatgpt_mcp", evidence: "client_reported" } });
  ledger.finish(run.id, { status: "completed", acceptance: "not_applicable", summary: "host only", evidence: [] });
  const outside = join(root, "outside"); mkdirSync(outside); const outsideProject = ledger.project(outside);
  let time = Date.now(); let providerCreated = 0;
  const config = { stateDir: state, allowedRoots: [project], publicBaseUrl: "https://controlled.example", oauth: { ownerToken: "fixture-owner-token-not-real" },
    console: { enabled: true, allowRemote: false, sessionTtlSeconds: 300 } } as ServerConfig;
  const consoleApi = createProjectConsoleRouter(config, { assetDirectory, clock: () => time,
    providerFactory: () => { providerCreated++; throw new Error("No provider needed for ordinary browsing"); } });
  const app = express(); app.use("/console", consoleApi.router); const http = app.listen(0, "127.0.0.1"); await once(http, "listening");
  const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  t.after(async () => { http.closeAllConnections(); await new Promise<void>((resolve) => http.close(() => resolve())); consoleApi.close(); ledger.close(); rmSync(root, { recursive: true, force: true }); });
  const request = (path: string, options: RequestInit = {}) => fetch(base + "/console" + path, { ...options, redirect: "manual" });
  // fetch normalizes Host on this Node version; use the real HTTP wire boundary.
  const rawStatus = (headers: Record<string, string>) => new Promise<number>((resolve, reject) => {
    const req = httpRequest(base + "/console/api/session", { headers }, (response) => { response.resume(); resolve(response.statusCode!); });
    req.on("error", reject); req.end();
  });
  const page = await request("/"); assert.equal(page.status, 200); assert.match(await page.text(), /fixture console/);
  assert.equal((await request("/api/projects")).status, 401);
  assert.equal((await request(`/api/projects/${run.project_id}/threads/managed/control`, { method: "POST", headers: { "Content-Type": "application/json", Origin: base }, body: "{}" })).status, 401);
  assert.equal((await request("/api/login", { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://evil.example" }, body: JSON.stringify({ password: "fixture-owner-token-not-real" }) })).status, 403);
  const login = await request("/api/login", { method: "POST", headers: { "Content-Type": "application/json", Origin: base }, body: JSON.stringify({ password: "fixture-owner-token-not-real" }) });
  assert.equal(login.status, 200); const body = await login.json() as { csrf: string };
  const header = login.headers.get("set-cookie")!; assert.match(header, /HttpOnly/); assert.match(header, /SameSite=Strict/);
  assert(!header.includes("fixture-owner-token")); const cookie = header.split(";")[0]!;
  const authenticated = { Cookie: cookie, Origin: base, "X-DevSpace-CSRF": body.csrf, "Content-Type": "application/json" };
  const projects = await request("/api/projects", { headers: { Cookie: cookie } }); assert.equal(projects.status, 200);
  const list = await projects.json() as { projects: { id: string }[] }; assert.equal(list.projects.length, 1); assert.equal(list.projects[0]!.id, run.project_id);
  assert.equal(providerCreated, 0, "Page refresh must not start a provider");
  assert.equal((await request(`/api/projects/${outsideProject.id}/runs`, { headers: { Cookie: cookie } })).status, 409);
  const runs = await request(`/api/projects/${run.project_id}/runs`, { headers: { Cookie: cookie } });
  const entries = await runs.json() as { entries: { usageStatus: string; codexUsage: { totalTokens: number } }[] };
  assert.equal(entries.entries[0]!.usageStatus, "not_used"); assert.equal(entries.entries[0]!.codexUsage.totalTokens, 0);
  assert.equal((await request("/api/logout", { method: "POST", headers: { Cookie: cookie, Origin: base }, body: "{}" })).status, 403);
  assert.equal((await request(`/api/projects/${run.project_id}/threads/managed/control`, { method: "POST", headers: { Cookie: cookie, Origin: base, "Content-Type": "application/json" }, body: "{}" })).status, 403);
  assert.equal(await rawStatus({ Cookie: cookie, Host: "evil.example" }), 403);
  assert.equal(await rawStatus({ Cookie: cookie, Host: "controlled.example", "X-Forwarded-Proto": "https" }), 403);
  time += 301000; assert.equal((await request("/api/session", { headers: { Cookie: cookie } })).status, 401);
  assert.equal((await request("/api/logout", { method: "POST", headers: authenticated, body: "{}" })).status, 401);
});

test("local console controls the exact managed turn without exposing steering text in its timeline", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "devspace-console-control-")); const project = join(root, "project");
  mkdirSync(join(project, ".git"), { recursive: true }); const state = join(root, "state");
  const assetDirectory = join(root, "ui"); mkdirSync(assetDirectory, { recursive: true });
  writeFileSync(join(assetDirectory, "console.html"), "<!doctype html><title>control fixture</title>");
  const ledger = new WorkLedger(state); const store = new LocalAgentStore(state);
  const run = ledger.begin({ root: project, workspaceId: "ws_control", workItemId: "control", runKey: "first",
    title: "Control fixture", origin: { entryPoint: "chatgpt_mcp", evidence: "server_entry" } });
  const agent = store.create({ workspaceId: "ws_control", workspaceRoot: project, profileName: "codex", provider: "codex" });
  store.update(agent.id, { status: "running", providerSessionId: "thread_control_123" });
  store.setControlState(agent.id, "devspace_active", "turn_control_123", "turn_control_ready");
  const executionId = ledger.beginExecution({ runId: run.id, agentId: agent.id, provider: "codex" });
  const managedThreadId = ledger.attachThread(executionId, { instanceId: "fixture-instance", identityVerified: true,
    threadId: "thread_control_123", createdHere: true, priorTurnIds: [], priorTurnsClosed: true });
  ledger.requestStarted(executionId); ledger.turnStarted(executionId, "turn_control_123");
  const calls: unknown[] = [];
  const config = { stateDir: state, allowedRoots: [project], publicBaseUrl: "https://controlled.example",
    oauth: { ownerToken: "fixture-owner-token-not-real" }, console: { enabled: true, allowRemote: false, sessionTtlSeconds: 300 } } as ServerConfig;
  const consoleApi = createProjectConsoleRouter(config, { assetDirectory, agentClient: {
    get: async () => Result.ok(store.getById(agent.id)!),
    control: async (input) => { calls.push(input); return Result.ok({ agentId: agent.id, action: input.action,
      accepted: true, providerThreadId: "thread_control_123", providerTurnId: "turn_control_123",
      controlState: "devspace_active", controlRevision: 2 }); },
  } });
  const app = express(); app.use("/console", consoleApi.router); const http = app.listen(0, "127.0.0.1"); await once(http, "listening");
  const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  t.after(async () => { http.closeAllConnections(); await new Promise<void>((resolve) => http.close(() => resolve()));
    consoleApi.close(); store.close(); ledger.close(); rmSync(root, { recursive: true, force: true }); });
  const request = (path: string, options: RequestInit = {}) => fetch(base + "/console" + path, { ...options, redirect: "manual" });
  const login = await request("/api/login", { method: "POST", headers: { "Content-Type": "application/json", Origin: base },
    body: JSON.stringify({ password: "fixture-owner-token-not-real" }) });
  const session = await login.json() as { csrf: string }; const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const headers = { Cookie: cookie, Origin: base, "X-DevSpace-CSRF": session.csrf, "Content-Type": "application/json" };
  const response = await request(`/api/projects/${run.project_id}/threads/${managedThreadId}/control`, { method: "POST", headers,
    body: JSON.stringify({ action: "steer", workRunId: run.id, requestKey: "console-steer-1",
      expectedTurnId: "turn_control_123", prompt: "sensitive revised direction" }) });
  assert.equal(response.status, 200); assert.equal(calls.length, 1);
  const call = calls[0] as { agentId: string; action: string; workRunId: string; requestKey: string;
    expectedTurnId: string; prompt: string; scope: { workspaceId: string; workspaceRoot: string } };
  assert.deepEqual({ ...call, scope: { ...call.scope, workspaceRoot: call.scope.workspaceRoot.toLowerCase() } },
    { agentId: agent.id, action: "steer", workRunId: run.id, requestKey: "console-steer-1",
      expectedTurnId: "turn_control_123", prompt: "sensitive revised direction",
      scope: { workspaceId: "ws_control", workspaceRoot: resolve(project).toLowerCase() } });
  const threads = await request(`/api/projects/${run.project_id}/threads`, { headers: { Cookie: cookie } });
  const serialized = await threads.text(); assert.match(serialized, /codex:\/\/threads\/thread_control_123/);
  assert.match(serialized, /turn_control_ready/); assert.doesNotMatch(serialized, /sensitive revised direction/);
});
