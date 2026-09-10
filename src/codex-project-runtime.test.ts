import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CodexAppServerRuntime } from "./local-agent-codex.js";
import type { ProjectReceipt } from "./codex-projects.js";

test("paginated history uses native resume regardless of old or unknown version", async (t) => {
  const root=await mkdtemp(join(tmpdir(),"devspace-history-preflight-"));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const source=join(root,"fake.cjs"),log=join(root,"requests.jsonl");
  await writeFile(source,`const fs=require('fs');require('readline').createInterface({input:process.stdin}).on('line',line=>{
    const m=JSON.parse(line);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(m)+'\\n');
    if(m.id==null)return; if(m.method==='thread/read')return process.stdout.write(JSON.stringify({id:m.id,result:{thread:{id:'original-thread',cwd:${JSON.stringify(root)},status:{type:'idle'},historyMode:'paginated'}}})+'\\n');
    if(m.method==='thread/resume')return process.stdout.write(JSON.stringify({id:m.id,result:{thread:{id:'original-thread'}}})+'\\n');
    if(m.method==='turn/start'){process.stdout.write(JSON.stringify({id:m.id,result:{turn:{id:'turn-1'}}})+'\\n');return setImmediate(()=>process.stdout.write(JSON.stringify({method:'turn/completed',params:{threadId:'original-thread',turn:{id:'turn-1',status:'completed',items:[{type:'agentMessage',text:'native'}]}}})+'\\n'));}
    const result={};
    process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');
  });`);
  const command=join(root,process.platform==='win32'?'fake.cmd':'fake');
  await writeFile(command,process.platform==='win32'?`@echo off\r\n"${process.execPath}" "${source}"\r\n`:`#!/bin/sh\nexec '${process.execPath}' '${source}'\n`);await chmod(command,0o700);
  let registrations=0;
  const runtime=new CodexAppServerRuntime({command,env:process.env,version:'0.153.4',registerProject:async(roots):Promise<ProjectReceipt>=>{registrations++;return{protocol:'fixture',status:'persisted_registration',roots,createdDirectories:[],uiStatus:'unverified'}}});
  try{
    await runtime.initialize();const result=await runtime.run({workspaceRoot:root,providerSessionId:'original-thread',prompt:'native resume'});
    assert(result.isOk()); if(result.isOk()) assert.equal(result.value.providerSessionId,'original-thread');
    assert.equal(registrations,2);const requests=(await readFile(log,'utf8')).trim().split('\n').map(x=>JSON.parse(x));
    assert.equal(requests.find(x=>x.method==='thread/read').params.includeTurns,false);
    assert(requests.some(x=>x.method==='thread/resume')); assert(requests.some(x=>x.method==='turn/start'));
    assert(!requests.some(x=>['thread/start','thread/fork'].includes(x.method)));
  }finally{await runtime.close()}
});

test("explicit paginated resume rejection only hands off with owner opt-in and safe terminal scope", async (t) => {
  const root=await mkdtemp(join(tmpdir(),"devspace-history-handoff-")); t.after(()=>rm(root,{recursive:true,force:true}));
  const source=join(root,"fake.cjs"),log=join(root,"requests.jsonl");
  await writeFile(source,`const fs=require('fs');require('readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(m)+'\\n');if(m.id==null)return;
   if(m.method==='thread/read')return process.stdout.write(JSON.stringify({id:m.id,result:{thread:{id:'parent',cwd:${JSON.stringify(root)},status:{type:'notLoaded'},historyMode:'paginated'}}})+'\\n');
   if(m.method==='thread/resume')return process.stdout.write(JSON.stringify({id:m.id,error:{code:-32603,message:'paginated history cannot be resumed by this provider'}})+'\\n');
   if(m.method==='thread/start')return process.stdout.write(JSON.stringify({id:m.id,result:{thread:{id:'handoff'}}})+'\\n');
   if(m.method==='turn/start'){process.stdout.write(JSON.stringify({id:m.id,result:{turn:{id:'new-turn'}}})+'\\n');return setImmediate(()=>process.stdout.write(JSON.stringify({method:'turn/completed',params:{threadId:'handoff',turn:{id:'new-turn',status:'completed',items:[{type:'agentMessage',text:'handoff result'}]}}})+'\\n'));}
   process.stdout.write(JSON.stringify({id:m.id,result:{}})+'\\n');});`);
  const command=join(root,process.platform==='win32'?'fake.cmd':'fake'); await writeFile(command,process.platform==='win32'?`@echo off\r\n"${process.execPath}" "${source}"\r\n`:`#!/bin/sh\nexec '${process.execPath}' '${source}'\n`);await chmod(command,0o700);
  const registerProject=async(roots:string[]):Promise<ProjectReceipt>=>({protocol:'fixture',status:'persisted_registration',roots,createdDirectories:[],uiStatus:'unverified'});
  const runtime=new CodexAppServerRuntime({command,env:process.env,version:'unknown-new-version',registerProject});
  try { await runtime.initialize();
    const disabled=await runtime.run({workspaceRoot:root,providerSessionId:'parent',prompt:'new request',requestKey:'request-1'});
    assert(disabled.isErr()); if(disabled.isErr()){assert.equal(disabled.error.operation,'history_resume');assert.match(disabled.error.message,/PAGINATED_HISTORY_UNSUPPORTED/);assert.match(disabled.error.message,/set_subagents_codex_historyHandoff/);}
    let lineage: unknown;
    const enabled=await runtime.run({workspaceRoot:root,providerSessionId:'parent',prompt:'only this new request',requestKey:'request-2',historyHandoff:'verified-unsupported'},
      {onHistoryHandoff:value=>{lineage=value;}});
    assert(enabled.isOk()); assert.deepEqual(lineage,{type:'fresh_thread_handoff',parentThreadId:'parent',threadId:'handoff'});
    const requests=(await readFile(log,'utf8')).trim().split('\n').map(x=>JSON.parse(x));
    assert.equal(requests.filter(x=>x.method==='thread/start').length,1);
    const turn=requests.find(x=>x.method==='turn/start'); assert.equal(turn.params.input[0].text,'only this new request'); assert.equal(turn.params.approvalPolicy,'never');
  } finally { await runtime.close(); }
});

test("explicit exhausted quota stops before project registration, thread creation or inference", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-quota-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "fake.cjs"), log = join(root, "requests.jsonl");
  await writeFile(source, `const fs=require('fs');require('readline').createInterface({input:process.stdin}).on('line',line=>{
    const m=JSON.parse(line);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({method:m.method})+'\\n');
    if(m.id==null)return;const result=m.method==='account/rateLimits/read'?{rateLimits:{rateLimitReachedType:'rate_limit_reached',primary:{usedPercent:100,windowDurationMins:10080}}}:{};
    process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');
  });`);
  const command = join(root, process.platform === "win32" ? "fake.cmd" : "fake");
  await writeFile(command, process.platform === "win32" ? `@echo off\r\n"${process.execPath}" "${source}"\r\n` : `#!/bin/sh\nexec '${process.execPath}' '${source}'\n`);
  await chmod(command, 0o700);
  let registrations = 0;
  const runtime = new CodexAppServerRuntime({ command, env: process.env,
    registerProject: async (roots): Promise<ProjectReceipt> => { registrations++; return {protocol:"fixture",status:"persisted_registration",roots,createdDirectories:[],uiStatus:"unverified"}; },
  });
  try {
    await runtime.initialize();
    const result = await runtime.run({workspaceRoot:root,prompt:"must not invoke a model"});
    assert(result.isErr());
    if(result.isErr()){assert.equal(result.error.operation,"quota_preflight");assert.equal(result.error.retryable,false);}
    assert.equal(registrations,0);
    const requests=await readFile(log,"utf8");
    assert.ok(requests.includes('account/rateLimits/read'));
    assert.ok(!requests.includes('thread/start')&&!requests.includes('thread/resume')&&!requests.includes('turn/start'));
  } finally { await runtime.close(); }
});

test("project partial blocks inference and preserves an already-created thread identity", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-project-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "fake.cjs"), log = join(root, "requests.jsonl");
  await writeFile(source, `const fs=require('fs');require('readline').createInterface({input:process.stdin}).on('line',line=>{
    const m=JSON.parse(line);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(m)+'\\n');
    if(m.id==null)return;const result=m.method==='thread/start'?{thread:{id:'preserved-thread'}}:{};
    process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');
  });`);
  const command = join(root, process.platform === "win32" ? "fake.cmd" : "fake");
  await writeFile(command, process.platform === "win32" ? `@echo off\r\n"${process.execPath}" "${source}"\r\n` : `#!/bin/sh\nexec '${process.execPath}' '${source}'\n`);
  await chmod(command, 0o700);
  let failBeforeOpen = true;
  const runtime = new CodexAppServerRuntime({ command, env: process.env,
    registerProject: async (roots, threads): Promise<ProjectReceipt> => ({ protocol: "fixture",
      status: failBeforeOpen || threads.length ? "partial" : "persisted_registration", roots, createdDirectories: [],
      uiStatus: "unverified", action: "Re-observe registration before retrying" }),
  });
  try {
    await runtime.initialize();
    const first = await runtime.run({ workspaceRoot: root, prompt: "never invoke a model" });
    assert(first.isErr());
    assert(!JSON.parse(`[${(await readFile(log, "utf8")).trim().split("\n").join(",")}]`).some((m: any) => m.method === "thread/start"));
    failBeforeOpen = false;
    let preserved: string | undefined;
    const second = await runtime.run({ workspaceRoot: root, prompt: "never invoke a model" }, { onSessionId: (id) => { preserved = id; } });
    assert(second.isErr());
    assert.equal(preserved, "preserved-thread");
    if (second.isErr()) assert.equal(second.error.retryable, false);
    assert(!(await readFile(log, "utf8")).includes('"turn/start"'));
  } finally { await runtime.close(); }
});

test("silent optional quota metadata is bounded and does not bypass project verification", { timeout: 15_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-quota-silent-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "fake.cjs"), log = join(root, "requests.jsonl");
  await writeFile(source, `const fs=require('fs');require('readline').createInterface({input:process.stdin}).on('line',line=>{
    const m=JSON.parse(line);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({method:m.method})+'\\n');
    if(m.id==null||m.method==='account/rateLimits/read')return;
    process.stdout.write(JSON.stringify({id:m.id,result:{}})+'\\n');
  });`);
  const command = join(root, process.platform === "win32" ? "fake.cmd" : "fake");
  await writeFile(command, process.platform === "win32" ? `@echo off\r\n"${process.execPath}" "${source}"\r\n` : `#!/bin/sh\nexec '${process.execPath}' '${source}'\n`);
  await chmod(command, 0o700);
  let registrations = 0;
  const runtime = new CodexAppServerRuntime({ command, env: process.env,
    registerProject: async (roots): Promise<ProjectReceipt> => {
      registrations++;
      return { protocol: "fixture", status: "partial", roots, createdDirectories: [], uiStatus: "unverified" };
    },
  });
  try {
    await runtime.initialize();
    const before = Date.now();
    const result = await runtime.run({ workspaceRoot: root, prompt: "fixture must not start inference" });
    assert(result.isErr());
    if (result.isErr()) assert.equal(result.error.operation, "register_project");
    assert.equal(registrations, 1);
    assert(Date.now() - before < 12_000, "optional probe must not wait the full 30-second lifecycle timeout");
    const requests = await readFile(log, "utf8");
    assert(!requests.includes('thread/start') && !requests.includes('thread/resume') && !requests.includes('turn/start'));
  } finally { await runtime.close(); }
});
