/** Explicit metadata-only audit of the reported incident. No live ledger initialization. */
import Database from "better-sqlite3";
import { readFileSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
const [database, logDirectory] = process.argv.slice(2);
if (!database || !logDirectory) throw new Error("Explicit database and diagnostic directory required.");
const db = new Database(database, { readonly: true, fileMustExist: true });
const ids = ["run_908d031f7f394826a2518f0424d3039c", "run_bfe9d7508ef6475d92fd496588363534", "run_419513a7300244fca3171ab50f11addf"];
const runs = db.transaction(() => ids.map((id) => ({
  run: db.prepare(`select id,workspace_id,status,acceptance,created_at,finished_at,
    json_extract(origin,'$.conversationHash') conversationHash from console_work_runs where id=?`).get(id),
  executions: db.prepare(`select id,agent_id,status,requested,provider_finished,usage_quality,managed_thread_id,provider_turn_id,
    case when json_valid(delta) then json_extract(delta,'$.totalTokens') end totalTokens,created_at,finished_at
    from console_executions where run_id=? order by rowid`).all(id),
  operations: db.prepare("select kind,status,count(*) count from console_operations where run_id=? group by kind,status").all(id),
})))(); db.close();
const exchanges: Record<string, unknown>[] = [];
const coverage: Record<string, unknown>[] = [];
const since = "2026-09-08T16:55:00Z", until = "2026-09-08T17:40:00Z";
for (const name of ["server-diagnostics.jsonl", "server-diagnostics.jsonl.1"]) {
  const path = join(logDirectory, name);
  if (statSync(path).size > 8 * 1024 * 1024) throw new Error("Explicit log exceeds audit budget.");
  let selected = 0, malformed = 0;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line) continue;
    if (Buffer.byteLength(line) > 64 * 1024) { malformed++; continue; }
    let value: any; try { value = JSON.parse(line); } catch { malformed++; continue; }
    const time = value.ts ?? value.timestamp ?? value.time;
    if (typeof time !== "string" || !Number.isFinite(Date.parse(time)) || Date.parse(time) < Date.parse(since) || Date.parse(time) >= Date.parse(until)) continue;
    if (value.event !== "mcp_exchange_finished") continue;
    selected++;
    const row: Record<string, unknown> = { time, hostAcknowledgment: "unknown" };
    for (const key of ["responseBytes", "textBytes", "httpStatus", "aborted", "toolError", "structuredContentPresent"]) {
      if (["boolean", "number"].includes(typeof value[key])) row[key] = value[key];
    }
    for (const key of ["workspaceId", "workRunId", "operationId", "conversationHash", "responseSha256"]) {
      if (typeof value[key] === "string" && /^(?:(?:ws|run|op)_[a-f0-9]{6,64}|[a-f0-9]{24,64})$/.test(value[key])) row[key] = value[key];
    }
    for (const key of ["tool", "action"]) if (["read", "workspace_context", "apply_patch", "exec_command", "write_stdin", "agent_task", "work_task", "capture", "search", "observe", "continue", "start", "get", "record", "finish", "other"].includes(value[key])) row[key] = value[key];
    exchanges.push(row);
  }
  coverage.push({ file: name, selected, malformed });
}
const result = { window: { since, until }, runs, exchanges, coverage,
  limits: "metadata only; finished means server transport completed, not host acknowledgment; missing arguments cannot identify files" };
const body = JSON.stringify(result, null, 2);
const path = resolve("releases/receipt-recovery-20260909/incident-metadata.json"); mkdirSync(resolve(path, ".."), { recursive: true });
writeFileSync(path, body, { mode: 0o600 });
console.log(JSON.stringify({ path, sha256: createHash("sha256").update(body).digest("hex"), runs: runs.map((r) => ({ run: r.run, executions: r.executions, operations: r.operations })), coverage, exchanges: exchanges.length }));
