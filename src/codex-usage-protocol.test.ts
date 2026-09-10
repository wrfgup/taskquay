import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAppServerRuntime } from "./local-agent-codex.js";
import { LocalAgentStore } from "./local-agent-store.js";
import type { AgentUsageObservation } from "./agent-usage.js";
import type { AgentActivity } from "./agent-progress.js";

test("real JSON-RPC transport captures early usage, rejects stale turns and retains failure usage on Windows too", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "devspace-fake-codex-"));
  const script = join(root, "fake.cjs");
  writeFileSync(script, `const readline = require('node:readline');
let turn = 0;
const send = x => process.stdout.write(JSON.stringify(x)+'\\n');
readline.createInterface({input:process.stdin}).on('line', line => {
 const m = JSON.parse(line);
 if (m.method==='initialize') return send({id:m.id,result:{}});
 if (m.method==='account/rateLimits/read') return send({id:m.id,error:{code:-32601,message:'Optional quota metadata not supported by fixture'}});
 if (m.method==='thread/read') return send({id:m.id,result:{thread:{id:m.params.threadId}}});
 if (m.method==='thread/start' || m.method==='thread/resume') {
   if (m.params.config?.['features.multi_agent'] !== false) return send({id:m.id,error:{message:'nested fanout must be disabled'}});
   return send({id:m.id,result:{thread:{id:'thread-fixture'}}});
 }
 if (m.method==='turn/start') {
   const id='turn-'+(++turn);
   const notify = turnId => send({method:'thread/tokenUsage/updated',params:{threadId:'thread-fixture',turnId,
      tokenUsage:{total:{inputTokens:100*turn,outputTokens:20*turn,cachedInputTokens:40,reasoningOutputTokens:8,totalTokens:120*turn},
       last:{inputTokens:25,outputTokens:5,cachedInputTokens:0,reasoningOutputTokens:2,totalTokens:30}}}});
   notify('old-turn'); notify(id);
   send({method:'item/started',params:{threadId:'thread-fixture',turnId:'old-turn',item:{type:'fileChange'}}});
   send({method:'item/started',params:{threadId:'thread-fixture',turnId:id,
     item:{type:'commandExecution',command:'pnpm build synthetic-secret',aggregatedOutput:'synthetic-secret'}}});
   send({id:m.id,result:{turn:{id}}});
   setImmediate(()=>{
     notify(id); notify('old-turn');
     send({method:'item/completed',params:{threadId:'thread-fixture',turnId:id,
       item:{type:'commandExecution',aggregatedOutput:'synthetic-secret'}}});
     const fail = m.params.input[0].text==='fail';
     send({method:'turn/completed',params:{threadId:'thread-fixture',turn:{id,status:fail?'failed':'completed',
       ...(fail?{error:{message:'synthetic failure'}}:{items:[{type:'agentMessage',text:'verified'}]})}}});
   });
 }
 if (m.method==='thread/unsubscribe') send({id:m.id,result:{}});
});`);
  const command = join(root, process.platform === "win32" ? "fake-codex.cmd" : "fake-codex");
  writeFileSync(command, process.platform === "win32"
    ? `@echo off\r\n"${process.execPath}" "%~dp0fake.cjs"\r\n`
    : `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${script.replaceAll("'", "'\\''")}'\n`);
  if (process.platform !== "win32") chmodSync(command, 0o700);
  const runtime = new CodexAppServerRuntime({ command, env: process.env, version: "fixture" });
  const store = new LocalAgentStore(join(root, "state"));
  const agent = store.create({ workspaceRoot: root, provider: "codex", profileName: "codex" });
  t.after(async () => { await runtime.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const observations: AgentUsageObservation[] = [];
  const activities: AgentActivity[] = [];
  store.update(agent.id, { status: "running" });
  const onUsage = (event: AgentUsageObservation) => {
    observations.push(event);
    assert(store.recordUsageResult(agent.id, event).isOk());
  };
  await runtime.initialize();
  const first = await runtime.run({ workspaceRoot: root, prompt: "first" }, { onUsage,
    onActivity: (activity) => { activities.push(activity); assert(store.recordActivityResult(agent.id, activity).isOk()); } });
  assert(first.isOk());
  assert.deepEqual(activities, [{ phase: "tool", toolCategory: "build" }, { phase: "provider" }]);
  assert(!JSON.stringify(store.getById(agent.id)!.progress).includes("synthetic-secret"));
  const failed = await runtime.run({ workspaceRoot: root, prompt: "fail", providerSessionId: "thread-fixture" }, { onUsage });
  assert(failed.isErr());
  assert(observations.length >= 2);
  assert(observations.every((event) => event.turnId !== "old-turn"));
  assert(observations.filter((event) => event.turnId === "turn-1").every((event) => event.newThread));
  assert(observations.filter((event) => event.turnId === "turn-2").every((event) => !event.newThread));
  assert.equal(store.usage(agent.id).threads[0]?.totals.totalTokens, 240);
  assert.equal(store.usage(agent.id).observations.length, 2);
  const tolerated = await runtime.run({ workspaceRoot: root, prompt: "callback error", providerSessionId: "thread-fixture" },
    { onUsage: () => { throw new Error("telemetry store unavailable"); }, onActivity: () => { throw new Error("progress store unavailable"); } });
  assert(tolerated.isOk(), "telemetry failure must not retry or fail paid work");
});
