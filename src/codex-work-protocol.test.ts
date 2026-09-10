import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CodexAppServerRuntime, codexInstanceIdentity, type CodexControlMethod } from "./local-agent-codex.js";
import type { LocalAgentRunCallbacks } from "./local-agent-runtime.js";
import { LocalAgentStore } from "./local-agent-store.js";
import { WorkLedger } from "./work-ledger.js";
import { LocalAgentRuntimePool } from "./local-agent-runtime-pool.js";
import { Result } from "better-result";
import { LocalAgentManager } from "./local-agent-manager.js";
import type { LocalAgentDriver } from "./local-agent-runtime.js";

test("real JSON-RPC path registers origin, names once, binds turns and includes late failed-turn usage", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "devspace-work-rpc-")); const project = join(root, "project"); mkdirSync(project);
  const script = join(root, "fake.cjs"); const log = join(root, "methods.jsonl");
  writeFileSync(script, `const fs=require('node:fs'), rl=require('node:readline');let turns=[],total=0;
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
rl.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({method:m.method,params:m.method==='turn/start'?undefined:m.params})+'\\n');
 if(m.method==='initialize')return send({id:m.id,result:{}});
 if(m.method==='account/read')return send({id:m.id,result:{account:{type:'chatgpt',email:'fixture@example.invalid'}}});
 if(m.method==='account/rateLimits/read')return send({id:m.id,error:{code:-32601,message:'Optional metadata unavailable in this lifecycle fixture'}});
 if(m.method==='thread/resume'&&turns.length>=3)return send({id:m.id,error:{code:-32000,message:'PAGINATED_HISTORY_UNSUPPORTED: paginated history cannot be resumed'}});
 if(m.method==='thread/start'||m.method==='thread/resume')return send({id:m.id,result:{thread:{id:'thread',turns}}});
 if(m.method==='thread/read')return send({id:m.id,result:{thread:{id:'thread',turns,historyMode:turns.length>=3?'paginated':'inline'}}});
 if(m.method==='thread/name/set'||m.method==='thread/unsubscribe')return send({id:m.id,result:{}});
 if(m.method==='turn/start'){const id='t'+(turns.length+1),failed=m.params.input[0].text==='fail';total+=100;
 const usage=()=>({method:'thread/tokenUsage/updated',params:{threadId:'thread',turnId:id,tokenUsage:{total:{inputTokens:total*.8,outputTokens:total*.2,totalTokens:total,cachedInputTokens:total*.4,reasoningOutputTokens:total*.1}}}});
 send(usage());send({id:m.id,result:{turn:{id}}});
 setImmediate(()=>{const turn={id,status:failed?'failed':'completed',items:[{type:'agentMessage',text:'fixture response'}],...(failed?{error:{message:'fixture failure'}}:{})};turns.push(turn);send({method:'turn/completed',params:{threadId:'thread',turn}});
 if(failed)setTimeout(()=>{total+=100;send(usage())},220);});
 }
});`);
  const command = join(root, process.platform === "win32" ? "fake.cmd" : "fake");
  writeFileSync(command, process.platform === "win32" ? `@echo off\r\n"${process.execPath}" "%~dp0fake.cjs"\r\n`
    : `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${script.replaceAll("'", "'\\''")}'\n`);
  if (process.platform !== "win32") chmodSync(command, 0o700);
  const state = join(root, "state"); const store = new LocalAgentStore(state); const ledger = new WorkLedger(state);
  const agent = store.create({ workspaceRoot: project, profileName: "codex", provider: "codex" });
  const run = ledger.begin({ root: project, title: "Protocol fixture", workItemId: "fixture", runKey: "one", origin: { entryPoint: "other_mcp", evidence: "server_entry" } });
  const runtime = new CodexAppServerRuntime({ command, env: process.env, version: "0.153.4" });
  const pool = new LocalAgentRuntimePool();
  let manager: LocalAgentManager | undefined;
  const driver: LocalAgentDriver = { provider: "codex", runtimeKey: () => "fixture-pooled-runtime",
    reportsWorkLifecycle: true, createRuntime: async () => Result.ok(runtime) };
  t.after(async () => { await manager?.close(); await pool.close(); await runtime.close(); ledger.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  await runtime.initialize();
  const execute = async (prompt: string, resume = false) => {
    const execution = ledger.beginExecution({ runId: run.id, agentId: agent.id, provider: "codex" });
    const callbacks: LocalAgentRunCallbacks = {
      onThreadInfo: (info) => { ledger.attachThread(execution, info); }, onNameResult: (ok) => ledger.nameResult(execution, ok),
      onRequest: () => ledger.requestStarted(execution), onTurnStarted: (turnId) => ledger.turnStarted(execution, turnId),
      onUsage: (usage) => ledger.usage(execution, usage), onProviderFinished: () => ledger.providerFinished(execution),
    };
    // Production does not invoke runtime.run directly: lifecycle callbacks cross
    // the pooled-runtime wrapper. Losing them there used to report paid work as zero.
    const result = await pool.run(driver,
      { provider: "codex", agentId: agent.id, workspaceRoot: project },
      { prompt, workspaceRoot: project, sessionLabel: "[DevSpace][fixture] Test only", ...(resume ? { providerSessionId: "thread" } : {}) }, callbacks);
    ledger.endExecution(execution, result.isOk() ? "completed" : "failed"); return result;
  };
  assert((await execute("first")).isOk()); assert.equal(ledger.receipt(run.id).codexUsage?.totalTokens, 100);
  assert((await execute("fail", true)).isErr()); await delay(200);
  assert.equal(ledger.receipt(run.id).codexUsage?.totalTokens, 300);
  assert.equal(ledger.threads(run.project_id)[0]!.created_here, 1);
  const methods = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(methods.filter((entry) => entry.method === "thread/name/set").length, 1);
  assert.equal(methods.filter((entry) => entry.method === "turn/start").length, 2);
  await assert.rejects(runtime.control("turn/start" as CodexControlMethod, {}), /Unsupported/);
  const identity = codexInstanceIdentity(command, { CODEX_HOME: root }, { account: { type: "chatgpt", email: "fixture@example.invalid" } });
  assert(identity.identityVerified); assert(!identity.instanceId.includes("fixture@"));
  assert.notEqual(identity.instanceId, codexInstanceIdentity(command, { CODEX_HOME: join(root, "other") }, { account: { type: "chatgpt", email: "fixture@example.invalid" } }).instanceId);

  // Cross the COMPLETE production path too: manager -> pool -> real JSON-RPC
  // adapter -> callbacks -> both ledgers. All provider responses remain synthetic.
  store.update(agent.id, { status: "idle", providerSessionId: "thread" });
  manager = new LocalAgentManager({ store: new LocalAgentStore(state), drivers: [driver], pool,
    loadProfiles: async () => [], allowedRoots: [root],
    subagents: { enabled: true, instructions: "on-demand", providers: [{ id: "codex", enabled: true }] } });
  const next = await manager.continue(agent.id, "manager round trip",
    { requestKey: "manager-round-trip", workRunId: run.id }, { workspaceRoot: project });
  assert(next.isOk());
  const deadline = Date.now() + 5000;
  while (manager.activeTurnCount && Date.now() < deadline) await delay(10);
  assert.equal(manager.activeTurnCount, 0);
  const managed = ledger.latestExecution(agent.id)!;
  assert.equal(managed.status, "completed");
  assert.equal(managed.requested, 1);
  assert.equal(managed.provider_finished, 1);
  assert.equal(managed.provider_turn_id, "t3");
  assert.equal(managed.usage_quality, "complete");
  assert.equal(JSON.parse(managed.delta!).totalTokens, 100);
  assert.equal(ledger.receipt(run.id).codexUsage?.totalTokens, 400);
  const usageRows = ledger.db.prepare("select turn_id,totals from agent_usage_snapshots where agent_id=?").all(agent.id) as { turn_id: string; totals: string }[];
  assert.equal(usageRows.length, 1);
  assert.equal(usageRows[0]!.turn_id, "t3");
  assert.equal(JSON.parse(usageRows[0]!.totals).totalTokens, 400);
  const successful = ledger.successfulExecution(agent.id, run.id)!;
  assert.equal(successful.executionId, managed.id); assert.equal(successful.responseAvailable, 1);
  const refused = await manager.continue(agent.id, "guard must preserve previous success",
    { requestKey: "paginated-followup", workRunId: run.id }, { workspaceRoot: project });
  assert(refused.isOk());
  while (manager.activeTurnCount) await delay(10);
  const failed = ledger.latestExecution(agent.id)!;
  assert.equal(failed.status, "failed"); assert.equal(failed.usage_quality, "not_used");
  assert.equal(failed.boundary_reason, "confirmed_before_inference");
  assert.equal(ledger.receipt(run.id).codexUsage?.totalTokens, 400);
  assert.equal(ledger.receipt(run.id).usageStatus, "complete");
  assert.equal(ledger.successfulExecution(agent.id, run.id)!.executionId, managed.id);
  assert.equal(store.getById(agent.id)!.latestResponse, "fixture response");
  assert.equal(store.getById(agent.id)!.providerSessionId, "thread");
  assert.match(store.getById(agent.id)!.error!, /PAGINATED_HISTORY_UNSUPPORTED/);
  const after = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(after.filter((m) => m.method === "turn/start").length, 3);
  assert.equal(after.filter((m) => m.method === "thread/start").length, 1);
});
