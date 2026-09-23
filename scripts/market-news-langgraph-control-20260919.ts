/** Current-config client for this authorized LangGraph rollout; normal daemon and ledger. */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { createLocalAgentClient } from '../src/local-agent-client.js';
import { WorkLedger } from '../src/work-ledger.js';
import { assertAllowedPath } from '../src/roots.js';

const [action, requestKey, promptPath] = process.argv.slice(2);
if (!['start','observe','continue','bundle-ready','wait','rollout-checkpoint'].includes(action ?? '')) throw new Error('Unsupported scoped action');
const config = loadConfig();
const workspaceId = 'ws_f59c943c9d';
const workspaceRoot = assertAllowedPath('\\\\wsl.localhost\\Ubuntu\\home\\wrfgup\\project\\langgraph_agent', config.allowedRoots);
const workRunId = 'run_30adbb24411348dd9f375d941599d47a';
const scope = { workspaceId, workspaceRoot };
const ledger = new WorkLedger(config.stateDir);
try { ledger.requireScope(workRunId, workspaceRoot, workspaceId); } finally { ledger.close(); }
const client = createLocalAgentClient(config);
const receiptDir = join(config.stateDir,'market-news-rollout-20260919');
const receiptPath = join(receiptDir,'langgraph-agent.json');
if(action==='start') {
 const prompt = readFileSync(join(workspaceRoot,'docs/market-news-rollout-brief-20260919.md'),'utf8');
 const result = await client.start({target:'codex',workspaceId,workspaceRoot,workRunId,
   taskKey:'market-news-langgraph-implementation-20260919',workItemId:'work_7133c5ee68fdf4c5d5b159b8',
   contextKey:'langgraph/market-news-daily',resources:['cloud:106.55.253.138:market-news'],
   prompt:'执行以下已核验主控任务书。实际代码与测试为目标，不重复进行全仓库调研。不要更改DevSpace配置；使用当前工作区规则。先完成代码/测试/只读生产preflight，尚不真实发送或启用timer，随后主控接续部署。\n'+prompt});
 if(result.isErr())throw new Error(`${result.error.code}: ${result.error.message}`);
 mkdirSync(receiptDir,{recursive:true,mode:0o700});
 writeFileSync(receiptPath,JSON.stringify({id:result.value.id,workRunId,workspaceId}),{mode:0o600});
 console.log(JSON.stringify({id:result.value.id,status:result.value.status,workRunId}));
} else {
 const saved=JSON.parse(readFileSync(receiptPath,'utf8'));
 if(saved.workRunId!==workRunId||saved.workspaceId!==workspaceId)throw new Error('Receipt scope mismatch');
 const current=await client.get(saved.id,scope);
 if(current.isErr())throw new Error(`${current.error.code}: ${current.error.message}`);
 if(action==='rollout-checkpoint'){
  if(current.value.status!=='running'||!current.value.providerTurnId)throw new Error('No exact active turn for checkpoint');
  const result=await client.control({agentId:saved.id,action:'steer',workRunId,
   requestKey:'lg-safe-rollout-checkpoint-20260920',expectedTurnId:current.value.providerTurnId,scope,
   prompt:'主控检查点：MNP当前完整98测试已在Windows和Linux分别通过；知识库37份实体迁移已主控生产REST再次独立核验37/37。请在当前安全步骤完成并保存真实回执后结束本turn，给主控已完成代码/测试/部署/渠道身份/网络/真实发送/timer的逐项状态和精确剩余阻塞，附可接续脚本命令及回执路径；不得中断已提交的发送/迁移，不盲重发，不清空outbox。若已进入最终验收可先完成当前验收再交接。不要为等主控起新agent，也不额外扩大权限或扫描无关私密内容。主控会在同一session继续剩余工作，不需要问用户确认。只输出脱敏状态，不输出凭据或原始staffId。'});
  console.log(JSON.stringify(result.isOk()?result.value:{code:result.error.code,message:result.error.message}));
 }else if(action==='wait'){
  const result=await client.wait([saved.id],scope,20000);
  console.log(JSON.stringify(result.isOk()?result.value:{code:result.error.code,message:result.error.message}));
 }else if(action==='bundle-ready'){
  if(current.value.status!=='running'||!current.value.providerTurnId)throw new Error('No exact active turn for steer');
  const result=await client.control({agentId:saved.id,action:'steer',workRunId,
   requestKey:'langgraph-bundle-ready-checkpoint-20260920',expectedTurnId:current.value.providerTurnId,scope,
   prompt:'主控新检查点：Market News worker已完成并idle，接口docs/daily_bundle_contract.md已读回，SHA256=74d16c9000a7150447b123ac833edb31d2285b084b9869204906ceeb1d9368d7；主控独立复跑90tests通过。可只读D:/project/gpt-projects/market-news-pipeline/docs/daily_bundle_contract.md和源代码。CLI python -m market_news --data-dir <root> daily-bundle --network --sources nbs,xinhuanet,baidu --limit 20；stdout JSON receipt含bundle_path/manifest_sha256/report_date/run_id/report_id/status，exit0 READY/1 DEGRADED已提交/2 failed无有效bundle。manifest.files恰为report.json/report.md/industry_scores.csv，每项sha256+bytes，report.daily_bundle含状态/日期/时区，score_policy=ABSTAIN_UNVALIDATED_METADATA_MODEL，dataset_kind=LIVE_PUBLIC_METADATA或OFFLINE_LOCAL_ARCHIVE。正式发送只接真实network报告，降级可发但明确标注。主控正在独立本机真实3源canary（不改MNP源码）。请立即使用实际接口完善你的集成测试和发布准备，不等另一个worker。仍先完成代码/测试/只读现场preflight，不真实发送或启用timer。'});
  console.log(JSON.stringify(result.isOk()?result.value:{code:result.error.code,message:result.error.message}));
 }else if(action==='observe'){
  const a=current.value;
  console.log(JSON.stringify({id:a.id,status:a.status,thread:a.providerSessionId,errorCode:a.errorCode,
   updatedAt:a.updatedAt,progress:a.progress,response:a.status==='idle'?a.latestResponse:undefined}));
 }else{
  if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(requestKey??'')||!promptPath)throw new Error('Explicit request key and prompt path required');
  if(['running','queued','starting'].includes(current.value.status))throw new Error('Observe active turn instead');
  const safe=assertAllowedPath(join(workspaceRoot,promptPath),[workspaceRoot]);
  const prompt=readFileSync(safe,'utf8');
  const result=await client.continue(saved.id,prompt,{requestKey,workRunId,resources:['cloud:106.55.253.138:market-news']},scope);
  console.log(JSON.stringify(result.isOk()?{id:result.value.id,status:result.value.status,workRunId}:{code:result.error.code,message:result.error.message}));
  if(result.isErr())process.exitCode=1;
 }
}
