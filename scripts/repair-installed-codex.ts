/** Repair only an unavailable auto-resolved provider command, preserving auth/history. */
import { copyFileSync, existsSync, readFileSync, constants } from "node:fs";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { loadConfig } from "../src/config.js";
import { loadDevspaceFiles, setDevspaceConfigValue } from "../src/user-config.js";
import { localAgentProviderEnvironment } from "../src/local-agent-config.js";
import { resolveCodexCommand } from "../src/local-agent-codex.js";

const path = process.argv[2];
const apply = process.argv.includes("--apply");
const allowed = join(process.env.LOCALAPPDATA ?? "", "OpenAI", "Codex", "bin");
if (!path || !process.env.LOCALAPPDATA || !resolve(path).startsWith(resolve(allowed) + "\\") || !/\\[a-f0-9]+\\codex\.exe$/i.test(resolve(path))) {
  throw new Error("Only an explicitly identified installed Desktop Codex executable is accepted.");
}
if (!existsSync(path)) throw new Error("The selected installed executable is absent.");
const probe = spawnSync(path, ["--version"], { encoding: "utf8", windowsHide: true, timeout: 5_000 });
const version = /^codex-cli (\d+\.\d+\.\d+)\s*$/.exec(probe.stdout ?? "")?.[1];
if (probe.error || probe.status !== 0 || !version) throw new Error("Installed Codex version probe failed.");
const config = loadConfig();
const current = resolveCodexCommand(localAgentProviderEnvironment(config.subagents, "codex"));
const provider = config.subagents.providers.find((item) => item.id === "codex");
if (!provider?.enabled) throw new Error("The existing owner configuration has not enabled Codex.");
if (current && resolve(current.executable) !== resolve(path)) throw new Error("Another working command is configured; do not override it.");
const loaded = loadDevspaceFiles();
const providers = loaded.config.subagents;
if (typeof providers === "boolean" || !providers) throw new Error("Explicit stored provider configuration required.");
const index = providers.providers.findIndex((item) => item.id === "codex");
if (index < 0) throw new Error("Stored Codex entry is absent.");
const before = JSON.stringify(loaded.config);
let backup: string | undefined;
if (apply && !current) {
  backup = loaded.configPath + `.before-codex-command-${Date.now()}.bak`;
  copyFileSync(loaded.configPath, backup, constants.COPYFILE_EXCL);
  setDevspaceConfigValue(["subagents", "providers", index, "command"], resolve(path));
  const after = loadDevspaceFiles().config;
  if (typeof after.subagents === "boolean" || !after.subagents) throw new Error("Unexpected configuration type after update.");
  const previous = providers.providers[index]!;
  const updated = after.subagents.providers[index]!;
  if ("command" in previous && previous.command !== undefined) Object.assign(updated, { command: previous.command });
  else delete (updated as { command?: string }).command;
  if (JSON.stringify(after) !== before) throw new Error("Unexpected non-command configuration change; inspect the retained backup.");
}
const resolved = resolveCodexCommand(localAgentProviderEnvironment(loadConfig().subagents, "codex"));
console.log(JSON.stringify({ apply, changed: Boolean(backup), backup, selectedExecutable: resolve(path), version,
  executableSha256: createHash("sha256").update(readFileSync(path)).digest("hex"), resolved: resolved ?? null,
  credentialsOrHistoryChanged: false, modelInvoked: false, daemonRestarted: false }));
if (apply && !resolved) process.exitCode = 1;
