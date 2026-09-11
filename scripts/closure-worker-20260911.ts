/** Invoke the existing authenticated daemon with the *current* provider config.
 * The long-running MCP server still caches its prior config revision. This
 * adapter preserves the same run/agent/queue/ledger and never edits history.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { LocalAgentClient } from "../src/local-agent-client.js";
import { LocalAgentStore } from "../src/local-agent-store.js";
import { localAgentProviderConfigRevision } from "../src/local-agent-config.js";
import { WorkLedger } from "../src/work-ledger.js";
import { assertAllowedPath } from "../src/roots.js";

const targets = {
  voice: { agent: "agt_9594907e", workspace: "ws_4355be9272", root: "D:\\project\\gpt-projects\\voice-memory",
    run: "run_2bb43c2dd2af4fd2a83a4ac1ef223f76", resources: ["android:emulator-5554", "cloud:139.199.12.80:voice-memory-test"] },
  cos: { agent: "agt_70a91427", workspace: "ws_fb59bebc1b", root: "\\\\wsl.localhost\\Ubuntu\\home\\wrfgup\\project\\OpenViking",
    run: "run_b682c26d4d88430c9d5913a4b1af0313", resources: ["cloud:106.55.253.138:cos-verification"] },
};
const [name, action, requestKey] = process.argv.slice(2);
if (!(name === "voice" || name === "cos") || !["continue", "observe", "start-handoff"].includes(action ?? "") ||
  (action !== "observe" && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(requestKey ?? ""))) throw new Error("Provide a fixed target, action and continuation request key.");
const target = { ...targets[name] };
const recoveryFile = join(process.cwd(), "releases", "closure-control-20260911", name + ".json");
if (existsSync(recoveryFile)) {
  const saved = JSON.parse(readFileSync(recoveryFile, "utf8"));
  if (saved.workRunId !== target.run || !/^agt_[a-f0-9]+$/.test(saved.agentId)) throw new Error("Recovery receipt identity differs.");
  target.agent = saved.agentId;
}
const config = loadConfig();
const root = assertAllowedPath(target.root, config.allowedRoots);
const scope = { workspaceId: target.workspace, workspaceRoot: root };
const ledger = new WorkLedger(config.stateDir);
try { ledger.requireScope(target.run, root, target.workspace); } finally { ledger.close(); }
const client = new LocalAgentClient({ stateDir: config.stateDir, configDir: config.configDir,
  configRevision: localAgentProviderConfigRevision(config.subagents), requestTimeoutMs: 15_000, startupTimeoutMs: 15_000 });
const existing = await client.get(target.agent, scope);
if (existing.isErr()) { console.log(JSON.stringify({ action, code: existing.error.code, message: existing.error.message })); process.exitCode = 1; }
else if (action === "observe") {
  const a = existing.value;
  console.log(JSON.stringify({ id: a.id, status: a.status, threadId: a.providerSessionId, updatedAt: a.updatedAt,
    errorCode: a.errorCode, error: a.error, progress: a.progress,
    response: a.status === "idle" ? a.latestResponse : undefined,
    preservedEarlierResponse: a.status === "error" ? a.latestResponse : undefined,
    modelInvokedByObservation: false }));
} else if (["running", "queued", "starting"].includes(existing.value.status)) {
  console.log(JSON.stringify({ id: target.agent, state: existing.value.status, continuationAccepted: false, reason: "existing_work_active" }));
  process.exitCode = 1;
} else {
  const store = new LocalAgentStore(config.stateDir);
  let prompt: string;
  try {
    const turns = store.listTurns(target.agent).sort((a, b) => b.id - a.id);
    const latest = turns[0];
    if (!latest || latest.status !== "failed" ||
      !(latest.errorCode === "PROVIDER_UNAVAILABLE" || (action === "start-handoff" && latest.errorCode === "PROVIDER_EXECUTION_ERROR"))) throw new Error("Only the proven terminal failed turn is eligible for this scoped recovery.");
    prompt = latest.prompt;
  } finally { store.close(); }
  const hash = createHash("sha256").update(prompt).digest("hex");
  const result = action === "start-handoff"
    ? await client.start({ target: "codex", prompt: "原会话恢复在执行前失败，保留其历史。以下是原任务原样交接，不重做已通过工作、不修改原线程；以当前项目代码和不可变收据继续验收。原线程=" + existing.value.providerSessionId + "\n\n" + prompt,
      workspaceRoot: root, workspaceId: target.workspace, taskKey: requestKey, workItemId: existing.value.workItemId,
      contextKey: "voice-memory/verified-closure-handoff", freshContext: true, resources: target.resources, workRunId: target.run })
    : await client.continue(target.agent, prompt, { workRunId: target.run, requestKey, resources: target.resources }, scope);
  if (action === "start-handoff" && result.isOk()) {
    mkdirSync(join(process.cwd(), "releases", "closure-control-20260911"), { recursive: true });
    writeFileSync(recoveryFile, JSON.stringify({ agentId: result.value.id, parentAgentId: target.agent,
      parentProviderThreadId: existing.value.providerSessionId, workRunId: target.run, promptSha256: hash,
      reason: "original_resume_terminal_failure", originalHistoryPreserved: true }), { flag: "wx", mode: 0o600 });
  }
  console.log(JSON.stringify(result.isOk() ? { id: result.value.id, status: result.value.status, threadId: result.value.providerSessionId,
    continuationAccepted: true, workRunId: target.run, samePromptSha256: hash, historyRewritten: false }
    : { continuationAccepted: false, code: result.error.code, message: result.error.message }));
  if (result.isErr()) process.exitCode = 1;
}
