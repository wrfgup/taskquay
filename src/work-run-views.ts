import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import * as z from "zod/v4";
import { isPathInsideRoot } from "./roots.js";
import { digest, executionUsage, WorkLedger, type ExecutionRow } from "./work-ledger.js";
import { replyBytes, REPLY_BYTES } from "./bounded-reply.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const path = z.string().min(1).max(240).refine((value) =>
  !isAbsolute(value) && !value.includes("\\") && !value.includes(":") &&
  value.split("/").every((part) => /^[A-Za-z0-9_.-]+$/.test(part) && part !== "." && part !== "..") &&
  !/(^|\/)(\.env[^/]*|\.ssh|\.aws|\.codex|\.git|credentials?[^/]*|secrets?[^/]*|config[^/]*)(\/|$)|\.(pem|key|p12|pfx)$/i.test(value));
const file = z.object({ path, sha256: hash }).strict();
/** Deliberately no free-form prose, command, environment or provider response. */
export const deliverySchema = z.object({
  schema: z.literal("devspace.delivery"), version: z.literal(1),
  sourceHash: hash, sources: z.array(file).min(1).max(8),
  status: z.enum(["passed", "failed", "not_run"]),
  artifacts: z.array(file).max(4),
}).strict();
export type Delivery = z.infer<typeof deliverySchema>;
const publicationKind = "delivery.v1";
const cursorSchema = z.object({ version: z.literal(1), runId: z.string(), revision: z.number().int().nonnegative(),
  operations: z.number().int().nonnegative(), turns: z.number().int().nonnegative() }).strict();

function checkedHash(root: string, selection: z.infer<typeof file>): void {
  const base = realpathSync(root), target = realpathSync(resolve(base, selection.path));
  if (!isPathInsideRoot(target, base)) throw new Error("Delivery file is outside the original workspace scope.");
  if (!path.safeParse(relative(base, target).replaceAll("\\", "/")).success) throw new Error("Delivery target is not an allowed public file selection.");
  // Only hash explicitly selected files, never follow references inside a file.
  const fd = openSync(target, "r");
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > 1024 * 1024 * 1024) throw new Error("Delivery file must be regular and at most 1 GiB.");
    const state = createHash("sha256"), buffer = Buffer.alloc(64 * 1024);
    for (let n; (n = readSync(fd, buffer, 0, buffer.length, null)) > 0;) state.update(buffer.subarray(0, n));
    const after = fstatSync(fd);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || state.digest("hex") !== selection.sha256) {
      throw new Error("STALE_DELIVERY: selected file hash changed; verify again before publishing.");
    }
    if (!isPathInsideRoot(realpathSync(resolve(base, selection.path)), base)) throw new Error("Delivery scope changed.");
  } finally { closeSync(fd); }
}

/** Caller MUST hold the ordinary cooperative read claim. This never adopts a writer's claim. */
export function publishDelivery(ledger: WorkLedger, runId: string, root: string, requestKey: string, input: Delivery): string {
  const parsed = deliverySchema.safeParse(input);
  if (!parsed.success) throw new Error("Invalid delivery schema/version/status or public file selection.");
  const value = parsed.data;
  if (new Set(value.sources.map((entry) => entry.path)).size !== value.sources.length ||
      new Set(value.artifacts.map((entry) => entry.path)).size !== value.artifacts.length ||
      digest(value.sources) !== value.sourceHash) throw new Error("STALE_DELIVERY: source manifest hash mismatch.");
  if (value.status !== "passed" && value.artifacts.length) throw new Error("Only passing verification may publish verified artifacts.");
  const reference = JSON.stringify(value);
  if (reference.length > 1200) throw new Error("Delivery exceeds the existing bounded evidence limit; narrow this checkpoint.");
  // Check an idempotent retry BEFORE touching the checkout: recovery must work
  // after disconnect even if a later writer is changing the source.
  const previous = ledger.db.prepare("select id,evidence from console_operations where run_id=? and request_key=?").get(runId, requestKey) as { id: string; evidence: string } | undefined;
  const evidence = [{ label: publicationKind, reference, outcome: value.status }];
  if (previous) {
    if (previous.evidence !== JSON.stringify(evidence)) throw new Error("Operation request key cannot be reused with different evidence.");
    return previous.id;
  }
  for (const selection of [...value.sources, ...value.artifacts]) checkedHash(root, selection);
  return ledger.operation({ runId, requestKey, kind: publicationKind, label: publicationKind, status: "completed", evidence });
}

/** Views read only the ledger. A publication describes verified-at-publication
 * bytes, not a claim that a mutable checkout or deployment is still current. */
export class WorkRunViews {
  constructor(private readonly ledger: WorkLedger) {}

  snapshot(runId: string, knownRevision?: string, expectedSourceHash?: string) {
    return this.ledger.db.transaction(() => {
      const run = this.ledger.run(runId);
      const count = (table: string) => (this.ledger.db.prepare(`select count(*) n from ${table} where run_id=?`).get(runId) as { n: number }).n;
      // Inspect bounded typed evidence, never arbitrary historical labels/text.
      const published = this.ledger.db.prepare("select id,evidence,created_at from console_operations where run_id=? and kind=? order by rowid desc").iterate(runId, publicationKind);
      type Published = { operationId: string; verifiedAt: string; receipt: Delivery };
      let latest: Published | null = null;
      let latestVerified: Published | null = null;
      let invalidPublications = false;
      for (const row of published as Iterable<{ id: string; evidence: string; created_at: string }>) {
        let receipt: Delivery | undefined;
        try {
          const evidence = JSON.parse(row.evidence);
          const result = deliverySchema.safeParse(JSON.parse(evidence[0]?.reference));
          if (evidence.length === 1 && result.success && digest(result.data.sources) === result.data.sourceHash &&
              evidence[0].outcome === result.data.status && (result.data.status === "passed" || !result.data.artifacts.length)) receipt = result.data;
        } catch { /* Historical malformed/unknown schemas cannot pass. */ }
        if (!receipt) { invalidPublications = true; continue; }
        const entry = { operationId: row.id, verifiedAt: row.created_at, receipt };
        latest ??= entry;
        if (receipt.status === "passed" && receipt.artifacts.length) { latestVerified = entry; break; }
      }
      const operationCount = count("console_operations"), executionCount = count("console_executions");
      const states = (table: string) => this.ledger.db.prepare(`select status,count(*) n from ${table} where run_id=? group by status order by status`).all(runId);
      const activeCount = (table: string) => (this.ledger.db.prepare(`select count(*) n from ${table} where run_id=? and status in ('starting','queued','running')`).get(runId) as { n: number }).n;
      const activeOperationCount = activeCount("console_operations"), activeExecutionCount = activeCount("console_executions");
      const operationCounts = this.ledger.db.prepare("select kind,status,count(*) count from console_operations where run_id=? group by kind,status order by kind,status").all(runId) as { kind: string; status: string; count: number }[];
      const commandCounts = operationCounts.filter((row) => row.kind === "command");
      const mutationCounts = operationCounts.filter((row) => ["apply_patch", "write", "edit"].includes(row.kind));
      const latestCommand = this.ledger.db.prepare("select id operationId,status,evidence from console_operations where run_id=? and kind='command' and status='completed' order by rowid desc limit 1").get(runId) as { operationId: string; status: string; evidence: string } | undefined;
      let commandEvidence: unknown;
      try { const value = JSON.parse(JSON.parse(latestCommand?.evidence ?? "[]")[0]?.reference);
        if (value.boundary === "process") commandEvidence = { sessionId: value.sessionId, exitCode: value.exitCode,
          outputBytes: value.outputBytes, outputSha256: value.outputSha256, logReference: value.logReference, outputRecovery: "metadata_only" };
      } catch { /* Old evidence remains unknown, never proof of non-execution. */ }
      // Ledger receipt revisions include usage updates; observation revisions must not.
      const revision = digest([run.id, run.status, run.acceptance, operationCount, executionCount,
        states("console_operations"), states("console_executions"), latest, latestVerified, invalidPublications]);
      return { schema: "devspace.work-snapshot", version: 1, workRunId: run.id,
        revision, unchanged: knownRevision === revision,
        executionStatus: run.status, acceptanceStatus: run.acceptance,
        operationCount, executionCount, activeOperationCount, activeExecutionCount,
        commandCounts, mutationCounts,
        latestSuccessfulCommand: latestCommand ? { operationId: latestCommand.operationId, evidence: commandEvidence } : null,
        hostAcknowledgment: "unknown", transportStatus: "not_observed_by_ledger",
        evidenceGuidance: "Completed mutations/commands are execution evidence, not acceptance. Missing receipts do not prove non-execution. Reconcile before replay.",
        latestDelivery: latest, latestVerifiedDelivery: latestVerified,
        deliveryCompatibility: invalidPublications ? "invalid_publication" : !latest ? "unknown"
          : expectedSourceHash && latest.receipt.sourceHash !== expectedSourceHash ? "stale_source"
          : latest.receipt.status !== "passed" ? latest.receipt.status : expectedSourceHash ? "matched" : "unchecked",
        verificationBasis: "explicit_host_verification_and_file_hashes_at_publication",
        nextAction: invalidPublications || (expectedSourceHash && latest?.receipt.sourceHash !== expectedSourceHash) ? "validate_checkpoint_before_use"
          : latest?.receipt.status === "failed" || run.acceptance === "failed" ? "repair_failed_acceptance_preserve_verified_artifacts"
          : run.status === "running" ? activeOperationCount + activeExecutionCount > 0 ? "observe_active_work" : "reconcile_and_finish_work" : "review_acceptance",
        history: { action: "history", compatibility: { action: "get" } },
        usage: { action: "get", basis: "managed_executions_of_this_run_only", included: false },
      };
    })();
  }

  history(runId: string, cursor?: string, limit = 50) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("History limit must be 1–100.");
    return this.ledger.db.transaction(() => {
      const run = this.ledger.run(runId);
      let position = { version: 1 as const, runId, revision: run.revision, operations: 0, turns: 0 };
      if (cursor) {
        try { position = cursorSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"))); }
        catch { throw new Error("Invalid history cursor."); }
        if (position.runId !== runId) throw new Error("History cursor is outside this work run.");
        if (position.revision !== run.revision) throw new Error("STALE_CURSOR: run changed; restart history without cursor. No events were acknowledged or discarded.");
      }
      const operations = this.ledger.db.prepare("select id,kind,label,status,evidence,created_at,finished_at from console_operations where run_id=? order by rowid limit ? offset ?")
        .all(runId, limit + 1, position.operations).map((row: any) => ({ ...row,
          // Full arbitrary evidence can contain 40 large strings. Expose bounded
          // references in history; never silently drop an operation.
          label: String(row.label).slice(0, 200),
          evidence: Buffer.byteLength(row.evidence) <= 2000 ? row.evidence : undefined,
          evidenceSha256: digest(row.evidence), evidenceBytes: Buffer.byteLength(row.evidence) }));
      const turns = (this.ledger.db.prepare("select * from console_executions where run_id=? order by rowid limit ? offset ?")
        .all(runId, limit + 1, position.turns) as ExecutionRow[]).map((row) => ({ executionId: row.id, agentId: row.agent_id,
          providerTurnId: row.provider_turn_id, managedThreadId: row.managed_thread_id, status: row.status, ...executionUsage(row),
          boundary: row.boundary_reason, requestedModel: row.requested_model, requestedEffort: row.requested_effort,
          createdAt: row.created_at, finishedAt: row.finished_at }));
      while (limit > 1 && replyBytes({ operations: operations.slice(0, limit), turns: turns.slice(0, limit) }) > REPLY_BYTES - 8192) limit--;
      const more = operations.length > limit || turns.length > limit;
      return { workRunId: runId, receiptRevision: run.revision, operations: operations.slice(0, limit), turns: turns.slice(0, limit),
        nextCursor: more ? Buffer.from(JSON.stringify({ ...position, operations: position.operations + Math.min(limit, operations.length),
          turns: position.turns + Math.min(limit, turns.length) })).toString("base64url") : null,
        consistency: "revision_bound_snapshot; restart on STALE_CURSOR", fullHistory: { action: "get" } };
    })();
  }
}
