/** Compare a scoped historical binding with the current provider identity; no inference or writes to bindings. */
import { loadConfig } from "./config.js";
import { LocalAgentClient } from "./local-agent-client.js";
import { localAgentProviderConfigRevision } from "./local-agent-config.js";
import { WorkLedger } from "./work-ledger.js";
import { CodexAppServerRuntime, codexCommandEnvironment, resolveCodexCommand } from "./local-agent-codex.js";
import { assertAllowedPath } from "./roots.js";

const [agentId, workspaceId, root, runId] = process.argv.slice(2);
if (!/^agt_[a-z0-9]+$/.test(agentId ?? "") || !/^ws_[a-z0-9]+$/.test(workspaceId ?? "") || !root || !/^run_[a-z0-9]+$/.test(runId ?? "")) {
  throw new Error("Provide AGENT_ID WORKSPACE_ID AUTHORIZED_ROOT WORK_RUN_ID.");
}
const config = loadConfig();
const workspaceRoot = assertAllowedPath(root, config.allowedRoots);
const client = new LocalAgentClient({ stateDir: config.stateDir, configDir: config.configDir,
  configRevision: localAgentProviderConfigRevision(config.subagents) });
const found = await client.get(agentId!, { workspaceId, workspaceRoot });
if (found.isErr()) throw new Error("Scoped managed agent is unavailable.");
const agent = found.value;
if (["queued", "starting", "running"].includes(agent.status)) throw new Error("Inspect a terminal agent only.");
const logs = await client.logs(400);
const events = logs.isOk() ? logs.value.split(/\r?\n/).flatMap((line) => {
  try {
    const row = JSON.parse(line) as Record<string, unknown>;
    if (row.agentId !== agent.id) return [];
    const event = typeof row.event === "string" && /^[a-z_]{1,80}$/.test(row.event) ? row.event : undefined;
    const causeType = typeof row.causeType === "string" && /^[A-Za-z]{1,64}$/.test(row.causeType) ? row.causeType : undefined;
    return [{ event, causeType, durationMs: typeof row.durationMs === "number" ? row.durationMs : undefined }];
  } catch { return []; }
}).slice(-5) : [];
const ledger = new WorkLedger(config.stateDir);
try {
  const run = ledger.requireScope(runId!, workspaceRoot, workspaceId);
  const history = ledger.threads(run.project_id).filter((row) => row.agent_id === agent.id)
    .map((row) => ({ threadId: row.thread_id, instanceId: row.instance_id }));
  const env = codexCommandEnvironment();
  const command = resolveCodexCommand(env);
  if (!command) throw new Error("Configured provider command unavailable.");
  const runtime = new CodexAppServerRuntime({ command: command.executable, env, version: command.version });
  try {
    await runtime.initialize();
    const current = await runtime.identity(true);
    console.log(JSON.stringify({ agentId: agent.id, threadId: agent.providerSessionId, providerVersion: command.version,
      currentIdentityVerified: current.identityVerified, currentInstanceId: current.instanceId,
      historicalBindings: history.map((row) => ({ ...row, currentMatches: row.instanceId === current.instanceId })),
      recentLifecycle: events,
      providerInvoked: false, bindingsModified: false }));
  } finally { await runtime.close(); }
} finally { ledger.close(); }
