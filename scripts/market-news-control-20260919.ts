/** Scoped current-config recovery; uses the normal authenticated daemon, claims and ledger. */
import { loadConfig } from '../src/config.js';
import { createLocalAgentClient } from '../src/local-agent-client.js';
import { LocalAgentStore } from '../src/local-agent-store.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WorkLedger } from '../src/work-ledger.js';
import { assertAllowedPath } from '../src/roots.js';

const [action, requestKey, promptPath] = process.argv.slice(2);
if (!['recover', 'observe', 'continue'].includes(action ?? '')) throw new Error('Unsupported action');
const config = loadConfig();
const workspaceId = 'ws_6b08338946';
const workspaceRoot = assertAllowedPath('D:\\project\\gpt-projects\\market-news-pipeline', config.allowedRoots);
const workRunId = 'run_3e01121a119c4260b9625121e8b53b67';
const agentId = 'agt_3ee3f40e';
const scope = { workspaceId, workspaceRoot };
const ledger = new WorkLedger(config.stateDir);
try { ledger.requireScope(workRunId, workspaceRoot, workspaceId); } finally { ledger.close(); }
const client = createLocalAgentClient(config);
const current = await client.get(agentId, scope);
if (current.isErr()) throw new Error(`${current.error.code}: ${current.error.message}`);
if (action === 'observe') {
  const a = current.value;
  console.log(JSON.stringify({ id: a.id, status: a.status, thread: a.providerSessionId,
    errorCode: a.errorCode, updatedAt: a.updatedAt, progress: a.progress, response: a.status === 'idle' ? a.latestResponse : undefined }));
} else {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(requestKey ?? '')) throw new Error('Explicit request key required');
  if (['running', 'queued', 'starting'].includes(current.value.status)) throw new Error('Existing turn active; observe instead');
  let prompt: string;
  if(action==='continue'){
    if(!promptPath)throw new Error('Explicit prompt path required');
    prompt=readFileSync(assertAllowedPath(join(workspaceRoot,promptPath),[workspaceRoot]),'utf8');
  }else{
    const store = new LocalAgentStore(config.stateDir);
    try {
      const last = store.listTurns(agentId).sort((a, b) => b.id - a.id)[0];
      if (!last || last.status !== 'failed' || last.errorCode !== 'PROVIDER_UNAVAILABLE') throw new Error('Not the confirmed pre-inference executable failure');
      prompt = last.prompt;
    } finally { store.close(); }
  }
  const result = await client.continue(agentId, prompt, { requestKey, workRunId }, scope);
  console.log(JSON.stringify(result.isOk() ? { ok: true, id: result.value.id, status: result.value.status,
    workRunId, historyChanged: false } : { ok: false, code: result.error.code, message: result.error.message }));
  if (result.isErr()) process.exitCode = 1;
}
