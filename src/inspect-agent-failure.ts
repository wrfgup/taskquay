/** Inspect only a scoped managed thread's terminal errors; never print conversation items. */
import { loadConfig } from "./config.js";
import { LocalAgentClient } from "./local-agent-client.js";
import { localAgentProviderConfigRevision } from "./local-agent-config.js";
import { CodexAppServerRuntime, codexCommandEnvironment, resolveCodexCommand } from "./local-agent-codex.js";
import { summarizeCodexFailure } from "./codex-failure-summary.js";
import { assertAllowedPath } from "./roots.js";

const [agentId, workspaceId, root] = process.argv.slice(2);
if (!agentId?.match(/^agt_[a-z0-9]+$/) || !workspaceId?.match(/^ws_[a-z0-9]+$/) || !root) {
  throw new Error("Usage: inspect-agent-failure AGENT_ID WORKSPACE_ID AUTHORIZED_ROOT");
}
const config = loadConfig();
const workspaceRoot = assertAllowedPath(root, config.allowedRoots);
const client = new LocalAgentClient({ stateDir: config.stateDir, configDir: config.configDir,
  configRevision: localAgentProviderConfigRevision(config.subagents) });
const result = await client.get(agentId, { workspaceId, workspaceRoot });
if (result.isErr()) {
  console.log(JSON.stringify({ agentId, available: false, code: result.error.code, providerInvoked: false }));
  process.exitCode = 1;
} else {
  const record = result.value;
  if (!record.providerSessionId || ["queued", "starting", "running"].includes(record.status)) {
    console.log(JSON.stringify({ agentId, status: record.status, available: false,
      reason: "thread_missing_or_still_active", providerInvoked: false }));
  } else {
    const env = codexCommandEnvironment();
    const command = resolveCodexCommand(env);
    if (!command) throw new Error("Configured Codex executable unavailable");
    const runtime = new CodexAppServerRuntime({ command: command.executable, env, version: command.version });
    try {
      await runtime.initialize();
      const value = await runtime.control("thread/read", { threadId: record.providerSessionId, includeTurns: true }) as {
        thread?: { id?: string; cwd?: string; turns?: Array<{ id?: string; status?: string; error?: unknown }> } };
      const thread = value.thread;
      if (thread?.id !== record.providerSessionId) throw new Error("Provider thread identity mismatch");
      const failures = (thread.turns ?? []).filter((turn) => turn.error || turn.status === "failed").slice(-3)
        .map((turn) => ({ turnId: turn.id, status: turn.status, ...summarizeCodexFailure({ turn }) }));
      console.log(JSON.stringify({ agentId, threadId: thread.id, providerVersion: command.version,
        available: true, failures, providerInvoked: false }));
    } finally { await runtime.close(); }
  }
}
