/** Use the authenticated daemon's current configuration without restarting the host MCP. */
import { createHash } from "node:crypto";
import { loadConfig } from "../src/config.js";
import { createLocalAgentClient } from "../src/local-agent-client.js";
import { LocalAgentStore } from "../src/local-agent-store.js";
import { WorkLedger } from "../src/work-ledger.js";
import { assertAllowedPath } from "../src/roots.js";

const [action, requestKey] = process.argv.slice(2);
if (!['observe', 'recover-unavailable', 'handoff-resume-rejected'].includes(action ?? '') ||
  (action !== 'observe' && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(requestKey ?? ''))) throw new Error('Select a bounded observation or explicitly keyed failed-start recovery.');
const config = loadConfig();
const workspaceId = 'ws_fb59bebc1b';
const workspaceRoot = assertAllowedPath('\\\\wsl.localhost\\Ubuntu\\home\\wrfgup\\project\\OpenViking', config.allowedRoots);
const run = 'run_15148b31afaf483790254c86360d1b11';
const id = 'agt_70a91427';
const scope = {workspaceId, workspaceRoot};
const ledger = new WorkLedger(config.stateDir);
try { ledger.requireScope(run, workspaceRoot, workspaceId); } finally { ledger.close(); }
const client = createLocalAgentClient(config);
const existing = await client.get(id, scope);
if (existing.isErr()) { console.log(JSON.stringify({ok:false,code:existing.error.code,message:existing.error.message})); process.exitCode=1; }
else if(action === 'observe') {
  const a=existing.value;
  // Observation output is metadata only. Raw provider errors/responses may
  // contain project content; inspect an explicit, reviewed report separately.
  console.log(JSON.stringify({id:a.id,status:a.status,thread:a.providerSessionId,updatedAt:a.updatedAt,errorCode:a.errorCode,
    phase:a.progress?.phase,lastActivityAt:a.progress?.lastActivityAt,modelInvoked:false,providerTextOmitted:true}));
} else {
  if(['running','queued','starting'].includes(existing.value.status)) throw new Error('The original task is active; observe it instead of replaying.');
  const store=new LocalAgentStore(config.stateDir); let prompt:string;
  try {
    const last=store.listTurns(id).sort((a,b)=>b.id-a.id)[0];
    const rejectedResume=last?.errorCode==='PROVIDER_PROTOCOL_ERROR' && /control request failed: thread\/resume;/.test(last.error??'');
    if(!last||last.status!=='failed'||(action==='handoff-resume-rejected'?!rejectedResume:last.errorCode!=='PROVIDER_UNAVAILABLE')) throw new Error('Recovery requires the confirmed matching pre-inference failure boundary.');
    prompt=last.prompt;
  } finally {store.close();}
  const resumed=action==='handoff-resume-rejected'
    ?await client.start({target:'codex',workspaceId,workspaceRoot,workRunId:run,
      taskKey:requestKey,workItemId:'openviking-cos-final-acceptance',contextKey:'openviking/cos-reviewed-release',freshContext:true,
      resources:['cloud:106.55.253.138:cos-verification'],
      prompt:'原持久线程 '+existing.value.providerSessionId+' 的原生 thread/resume 已被当前安装版拒绝，任务在推理前失败。保留原线程不改历史，本次是显式交接，不是重跑旧任务。\n最新主控已完成：code14的31份证据/60个来源/公网APK与模型共111项全通过，无并行VM E2E；COS安全proof六项通过；在scripts/wsl/cos-candidate-business.py修复root-only身份误用，采用新隔离实例正式admin bootstrap取得普通cosuser密钥，实际已初始化/Session commit/查询4记忆，前述403已解除。最近新收据.runtime/cos-migration/20260912-controller-business/cos-business-1804a88bb4.json末尾在删除后立即查询的断言失败，所有测试资源已清理、production_unchanged=true。主控已再次修改脚本，DELETE wait=true/timeout60并有界轮询+stat404，尚未复跑。脚本用 /home/wrfgup/project/langgraph_agent/.runtime/cloud-migration/venv/bin/python；项目.venv缺paramiko，不必安装依赖。固定candidate receipt .runtime/cos-migration/20260911T165042Z/candidate-receipt.json可复用。\n请从上述精确检查点完成后续，不重新大模型调研整库、候选构建或模型下载。若删除后真实索引仍不收敛，准确诊断及最小修复，不用关闭验证/过滤假阴性。使用独立run子目录保存每次不变收据，不复活历史来源。先完成真实业务校验、Linux正式adapter的隔离replay/增量回滚演练和完整生产plan，提供主控审核命令与hash。不能自行停止生产或签署controller批准，本turn到可执行准备完成即可。\n原任务的其余授权与范围保持：\n'+prompt})
    :await client.continue(id,prompt,{requestKey,workRunId:run,resources:['cloud:106.55.253.138:cos-verification']},scope);
  console.log(JSON.stringify(resumed.isOk()?{ok:true,id:resumed.value.id,status:resumed.value.status,thread:resumed.value.providerSessionId,
    workRunId:run,promptSha256:createHash('sha256').update(prompt).digest('hex'),historyChanged:false}:
    {ok:false,code:resumed.error.code,message:resumed.error.message}));
  if(resumed.isErr())process.exitCode=1;
}
