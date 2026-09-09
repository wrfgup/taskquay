import { collectTrajectories, collectDiagnosticMetrics, AUDIT_SINCE, AUDIT_UNTIL } from "../src/trajectory-audit.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
const args = process.argv.slice(2);
const value = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const database = value("--db");
if (!database) throw new Error("Explicit --db required; no config discovery or live ledger initialization.");
const selection = value("--selection") ?? "overlap";
if (selection !== "overlap" && selection !== "created") throw new Error("Invalid selection.");
const result = collectTrajectories(database, { since: value("--since") ?? AUDIT_SINCE, until: value("--until") ?? AUDIT_UNTIL, selection });
const diagnostics = [value("--diagnostics"), value("--diagnostics-rotated")].filter((x): x is string => !!x)
  .map((path) => collectDiagnosticMetrics(path, result.window.since, result.window.until));
result.coverage.diagnostics = diagnostics.length ? "explicit_bounded_file_metrics_separate_from_ledger" : "not_read";
const summary = { runStates: {} as Record<string, number>, acceptance: {} as Record<string, number>,
  operationsByKind: {} as Record<string, Record<string, number>>, selectedOperations: 0, selectedExecutions: 0, knownDeltaTokens: 0, missingDeltaExecutions: 0 };
for (const g of result.conversations) {
  for (const [key, n] of Object.entries(g.runStates)) summary.runStates[key] = (summary.runStates[key] ?? 0) + n;
  for (const [key, n] of Object.entries(g.acceptance)) summary.acceptance[key] = (summary.acceptance[key] ?? 0) + n;
  for (const [kind, states] of Object.entries(g.operationsByKind)) for (const [state, n] of Object.entries(states)) {
    const target = summary.operationsByKind[kind] ??= {}; target[state] = (target[state] ?? 0) + n; summary.selectedOperations += n;
  }
  summary.selectedExecutions += Object.values(g.executionStates).reduce((a, b) => a + b, 0);
  summary.knownDeltaTokens += g.knownDeltaTokens; summary.missingDeltaExecutions += g.missingDeltaExecutions;
}
const directory = resolve(value("--out-dir") ?? "releases/trajectory-two-day-20260908");
mkdirSync(directory, { recursive: true });
const path = resolve(directory, `audit-${selection}.json`), body = JSON.stringify({ ...result, summary, diagnostics }, null, 2);
if (Buffer.byteLength(body) > 16 * 1024 * 1024) throw new Error("Bounded artifact size exceeded; no output written.");
writeFileSync(path, body, { mode: 0o600 });
console.log(JSON.stringify({ path, sha256: createHash("sha256").update(body).digest("hex"), coverage: result.coverage, conversations: result.conversations.length, summary }));
