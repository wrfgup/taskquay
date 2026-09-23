/** Fixed-scope document migration worker, through the authenticated managed daemon. */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { createLocalAgentClient } from '../src/local-agent-client.js';
import { WorkLedger } from '../src/work-ledger.js';
import { assertAllowedPath } from '../src/roots.js';
const [action]=process.argv.slice(2);
if(!['start','observe'].includes(action??''))throw Error('Unsupported action');
const config=loadConfig();
const workspaceId='ws_736b82fd2b';
const workspaceRoot=assertAllowedPath('\\\\wsl.localhost\\Ubuntu\\home\\wrfgup\\project\\OpenViking',config.allowedRoots);
const workRunId='run_c7ac4d40b21d4700a7f333b3e6daa880';
const ledger=new WorkLedger(config.stateDir);
try{ledger.requireScope(workRunId,workspaceRoot,workspaceId);}finally{ledger.close();}
const client=createLocalAgentClient(config);
const dir=join(config.stateDir,'market-news-rollout-20260919');
const path=join(dir,'documents-agent.json');
if(action==='start'){
 const prompt=readFileSync(join(workspaceRoot,'docs/documents-organization-brief-20260919.md'),'utf8');
 const result=await client.start({target:'codex',workspaceId,workspaceRoot,workRunId,
  taskKey:'owner-documents-organize-20260919',workItemId:'work_0a9373746111426662ea4ddd',
  contextKey:'openviking/owner-documents-organization',resources:['cloud:106.55.253.138:openviking-documents'],
  prompt:'按以下明确授权任务完成代码与37份文档实体归类、回读验证。不要绕过权限或更改身份；无合法现有owner凭据则保留原文并准确报告。\n'+prompt});
 if(result.isErr())throw Error(`${result.error.code}: ${result.error.message}`);
 mkdirSync(dir,{recursive:true,mode:0o700});writeFileSync(path,JSON.stringify({id:result.value.id,workRunId,workspaceId}),{mode:0o600});
 console.log(JSON.stringify({id:result.value.id,status:result.value.status,workRunId}));
}else{
 const saved=JSON.parse(readFileSync(path,'utf8'));
 if(saved.workRunId!==workRunId||saved.workspaceId!==workspaceId)throw Error('Scope mismatch');
 const result=await client.get(saved.id,{workspaceId,workspaceRoot});
 if(result.isErr())throw Error(`${result.error.code}: ${result.error.message}`);
 const a=result.value;console.log(JSON.stringify({id:a.id,status:a.status,thread:a.providerSessionId,
  errorCode:a.errorCode,updatedAt:a.updatedAt,progress:a.progress,response:a.status==='idle'?a.latestResponse:undefined}));
}
