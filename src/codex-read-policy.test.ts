import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAppServerRuntime, restrictedAnalysisConfig } from "./local-agent-codex.js";

test("analysis config disables external tools from all effective layers without copying secrets", () => {
  const config = restrictedAnalysisConfig({ config: { mcp_servers: { remote: { token: "private" } },
    apps: { drive: { enabled: true } } }, layers: [{ config: { mcp_servers: { local: {} }, plugins: { sample: {} } } }] });
  for (const key of ["mcp_servers.remote.enabled", "mcp_servers.local.enabled", "apps.drive.enabled", "plugins.sample.enabled", "features.multi_agent"]) {
    assert.equal(config[key], false);
  }
  assert(!JSON.stringify(config).includes("private"));
  assert.equal(restrictedAnalysisConfig({ config: { apps: null, mcp_servers: null, plugins: null }, layers: [] })["features.apps"], false);
  const named = restrictedAnalysisConfig({ config: { mcp_servers: { "本地工具": {} }, plugins: { "sample@test": {} } }, layers: [] });
  assert.equal(named["mcp_servers.本地工具.enabled"], false);
  assert.equal(named["plugins.sample@test.enabled"], false);
  assert.throws(() => restrictedAnalysisConfig({}), /unavailable/);
  assert.throws(() => restrictedAnalysisConfig({ config: { mcp_servers: { "ambiguous.name": {} } } }), /identifier/);
});

test("real RPC uses a stable instruction slot and rejects non-read-only confirmation before turn/start", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "devspace-read-policy-"));
  const script = join(root, "fake.cjs"); const log = join(root, "requests.jsonl");
  writeFileSync(script, `const rl=require('node:readline'); const fs=require('node:fs'); let turn=0,lastThread,lastTurn;
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
rl.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line); fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(m)+'\\n');
 if(!m.method&&Number(m.id)>=1001) return send({method:'turn/completed',params:{threadId:lastThread,turn:{id:lastTurn,status:'completed',items:[{type:'agentMessage',text:'done'}]}}});
 if(m.method==='initialize') return send({id:m.id,result:{}});
 if(m.method==='config/read') return send({id:m.id,result:{config:{developer_instructions:'Existing rules.',mcp_servers:{remote:{enabled:true}}},layers:[]}});
 if(m.method==='thread/read') return send({id:m.id,result:{thread:{id:m.params.threadId}}});
 if(m.method==='thread/start'||m.method==='thread/resume') return send({id:m.id,result:{thread:{id:m.params.threadId||'seed'},approvalPolicy:'never',sandbox:{type:m.params.threadId==='unsafe'?'workspaceWrite':'readOnly',networkAccess:false}}});
 if(m.method==='turn/start') { const id='turn-'+(++turn); lastThread=m.params.threadId;lastTurn=id;send({id:m.id,result:{turn:{id}}});
  setImmediate(()=>send({id:1000+turn,method:'item/commandExecution/requestApproval',params:{threadId:m.params.threadId,turnId:id}})); }
 if(m.method==='thread/unsubscribe') return send({id:m.id,result:{}});
});`);
  const command = join(root, process.platform === "win32" ? "fake.cmd" : "fake");
  writeFileSync(command, process.platform === "win32" ? `@echo off\r\n"${process.execPath}" "%~dp0fake.cjs"\r\n`
    : `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${script.replaceAll("'", "'\\''")}'\n`);
  if (process.platform !== "win32") chmodSync(command, 0o700);
  const runtime = new CodexAppServerRuntime({ command, env: process.env, version: "fixture" });
  t.after(async () => { await runtime.close(); rmSync(root, { recursive: true, force: true }); });
  await runtime.initialize();
  const input = { workspaceRoot: root, analysisOnly: true, writeMode: "read_only" as const, profileInstructions: "Stable profile.", prompt: "first" };
  assert((await runtime.run(input)).isOk());
  assert((await runtime.run({ ...input, prompt: "follow-up", providerSessionId: "seed" })).isOk());
  assert((await runtime.run({ ...input, providerSessionId: "unsafe" })).isErr());
  const requests = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const turns = requests.filter((request) => request.method === "turn/start");
  assert.equal(turns.length, 2, "Refused sandbox must not invoke the model");
  assert.deepEqual(turns.map((request) => request.params.input[0].text), ["first", "follow-up"]);
  assert(turns.every((request) => request.params.sandboxPolicy.type === "readOnly" && request.params.sandboxPolicy.networkAccess === false));
  const approvalReplies = requests.filter((request) => Number(request.id) >= 1001 && request.error);
  assert.equal(approvalReplies.length, 2);
  assert(approvalReplies.every((reply) => reply.error.code === -32001 && /not approved/.test(reply.error.message)));
  for (const request of requests.filter((request) => /^thread\/(start|resume)$/.test(request.method))) {
    assert.equal(request.params.developerInstructions, "Existing rules.\n\nStable profile.");
    assert.equal(request.params.config["mcp_servers.remote.enabled"], false);
  }
});
