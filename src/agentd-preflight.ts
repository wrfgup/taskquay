/** Bounded service preflight. Never invokes a provider or kills/deletes an owner. */
import { loadConfig } from "./config.js";
import { LocalAgentClient } from "./local-agent-client.js";
import { localAgentProviderConfigRevision } from "./local-agent-config.js";
import { isProcessAlive, localAgentDaemonPaths, readDaemonPid } from "./local-agent-daemon-lifecycle.js";

const config = loadConfig();
const client = new LocalAgentClient({ stateDir: config.stateDir, configDir: config.configDir,
  configRevision: localAgentProviderConfigRevision(config.subagents),
  requestTimeoutMs: 4000, startupTimeoutMs: 15000 });
let result = await client.status();
let started = false;
if (result.isErr() && process.argv.includes("--ensure")) {
  const paths = localAgentDaemonPaths(config.stateDir);
  const pid = readDaemonPid(paths.lockPath) ?? readDaemonPid(paths.pidPath);
  if (pid !== undefined && isProcessAlive(pid)) {
    console.log(JSON.stringify({ ready: false, ownerAlive: true, pid,
      nextAction: "reconcile_existing_daemon_no_second_process_started", providerInvoked: false }));
    process.exitCode = 1;
  } else {
    result = await client.ensureReady();
    started = result.isOk();
  }
}
if (process.exitCode !== 1) {
  console.log(JSON.stringify(result.isOk()
    ? { ready: true, started, status: result.value, providerInvoked: false }
    : { ready: false, started, code: result.error.code, providerInvoked: false }));
  if (result.isErr()) process.exitCode = 1;
}
