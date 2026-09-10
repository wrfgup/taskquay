import * as z from "zod/v4";
import { randomUUID } from "node:crypto";
import { digest, WorkLedger, WorkFinishBlockedError, type WorkOrigin } from "../work-ledger.js";
import type { ToolRegistrationContext } from "./types.js";
import { publishDelivery, WorkRunViews } from "../work-run-views.js";
import { diagnosticError } from "../server-diagnostics.js";
import { jsonReply, replyBytes, REPLY_BYTES, textPage } from "../bounded-reply.js";

/** Registration-only targets deliberately have no transport/server instance.
 * Legacy direct callers may expose a client label; otherwise leave it unknown
 * instead of accessing a server captured before the per-request handler exists. */
export function registeredClientLabel(target: ToolRegistrationContext["server"]): string | undefined {
  if (!("server" in target)) return undefined;
  const legacy = target.server as { getClientVersion?: () => { name?: unknown } | undefined } | undefined;
  const name = legacy?.getClientVersion?.()?.name;
  return typeof name === "string" ? name.slice(0, 120) : undefined;
}

export function hostOrigin(extra: { _meta?: Record<string, unknown>; authInfo?: { clientId?: string } }, clientLabel?: string, modelLabel?: string): WorkOrigin {
  const session = extra._meta?.["openai/session"];
  const reportedChatGPT = typeof session === "string" && session.length > 0;
  return { entryPoint: reportedChatGPT ? "chatgpt_mcp" : "other_mcp",
    evidence: reportedChatGPT || clientLabel ? "client_reported" : "server_entry",
    clientLabel: clientLabel?.slice(0, 120), modelLabel: modelLabel?.slice(0, 80),
    clientIdHash: extra.authInfo?.clientId ? digest(extra.authInfo.clientId).slice(0, 24) : undefined,
    conversationHash: reportedChatGPT ? digest(session).slice(0, 24) : undefined };
}
const key = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/);
const evidenceSchema = z.array(z.object({ label: z.string().max(200), reference: z.string().max(1200),
  outcome: z.enum(["passed", "failed", "not_run"]) }).strict()).max(40);
const modelDeliverySchema = z.object({
  schema: z.literal("devspace.delivery"),
  version: z.literal(1),
  source_hash: z.string().regex(/^[a-f0-9]{64}$/),
  sources: z.array(z.object({ path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).min(1).max(8),
  status: z.enum(["passed", "failed", "not_run"]),
  artifacts: z.array(z.object({ path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).max(4),
}).strict();

export function registerWorkTaskTool({ server, config, workspaces, processSessions }: ToolRegistrationContext): void {
  server.registerTool("work_task", {
    title: "Track work and return Codex token receipt",
    description: "Begin a top-level work run BEFORE direct host reads, commands or delegation. Use snapshot/history only when exposed by the host schema; otherwise use get and available observe tools. The server cannot force a host schema refresh. Get returns a bounded execution/acceptance summary, usage and first history page, including persisted command evidence; continue with cursor when supported. Get with operationId/evidenceOffset pages selected evidence. Record bounded verification evidence. Finish only after all child work stops and acceptance is explicit. Missing receipts do not prove non-execution. This tool never starts model inference.",
    inputSchema: {
      workspace_id: z.string(), action: z.enum(["begin", "record", "finish", "get", "list", "snapshot", "history"]),
      work_run_id: z.string().optional(), work_item_id: key.optional(), run_key: key.optional(),
      title: z.string().min(1).max(200).optional(), host_model_label: z.string().max(80).optional(),
      request_key: key.optional(), kind: z.string().max(64).optional(), label: z.string().max(200).optional(),
      status: z.enum(["completed", "failed", "cancelled"]).optional(),
      acceptance: z.enum(["passed", "failed", "not_applicable"]).optional(),
      summary: z.string().max(4000).optional(), evidence: evidenceSchema.optional(),
      delivery: modelDeliverySchema.optional().describe("Explicit host verification checkpoint. source_hash is SHA-256 of JSON.stringify(sources) in given order; files are checked only on publication, never on snapshot. No config/key files. Not deployment acceptance."),
      known_revision: z.string().optional(),
      expected_source_hash: z.string().regex(/^[a-f0-9]{64}$/).optional().describe("Compare publication with the consumer's expected source manifest, without reading the checkout."),
      cursor: z.string().max(2000).optional(), limit: z.number().int().min(1).max(100).optional(),
      operation_id: z.string().optional(), evidence_offset: z.number().int().nonnegative().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ workspace_id, work_run_id, work_item_id, run_key, host_model_label, request_key,
    delivery, known_revision, expected_source_hash, operation_id, evidence_offset, ...rest }, extra) => {
    const input = {
      ...rest,
      workspaceId: workspace_id,
      workRunId: work_run_id,
      workItemId: work_item_id,
      runKey: run_key,
      hostModelLabel: host_model_label,
      requestKey: request_key,
      delivery: delivery ? (() => {
        const { source_hash, ...value } = delivery;
        return { ...value, sourceHash: source_hash };
      })() : undefined,
      knownRevision: known_revision,
      expectedSourceHash: expected_source_hash,
      operationId: operation_id,
      evidenceOffset: evidence_offset,
    };
    const workspace = await workspaces.getWorkspace(input.workspaceId);
    const ledger = new WorkLedger(config.stateDir);
    const reply = (data: any, isError = false) => ({ ...jsonReply(data), isError });
    try {
      if (input.action === "begin") {
        if (!input.workItemId || !input.runKey || !input.title) throw new Error("begin requires workItemId, runKey and title.");
        const run = ledger.begin({ root: workspace.root, workspaceId: workspace.id, workItemId: input.workItemId,
          runKey: input.runKey, title: input.title, origin: hostOrigin(extra, registeredClientLabel(server), input.hostModelLabel) });
        return reply({ ...ledger.receipt(run.id), consolePath: `/console/?project=${run.project_id}&run=${run.id}` });
      }
      if (input.action === "list") return reply(ledger.listRuns(ledger.project(workspace.root).id));
      if (!input.workRunId) throw new Error("workRunId is required.");
      const run = ledger.requireScope(input.workRunId, workspace.root, workspace.id);
      const views = new WorkRunViews(ledger);
      if (input.action === "get" && input.operationId) {
        const operation = ledger.db.prepare("select evidence from console_operations where id=? and run_id=?").get(input.operationId, run.id) as { evidence: string } | undefined;
        if (!operation) throw new Error("Operation is outside this work run.");
        const { textPage } = await import("../bounded-reply.js");
        return reply({ workRunId: run.id, operationId: input.operationId, evidenceSha256: digest(operation.evidence),
          evidencePage: textPage(operation.evidence, input.evidenceOffset), hostAcknowledgment: "unknown" });
      }
      if (input.action === "snapshot") return reply(views.snapshot(run.id, input.knownRevision, input.expectedSourceHash));
      if (input.action === "history") return reply(views.history(run.id, input.cursor, input.limit));
      if (input.action === "record") {
        if (input.delivery) {
          if (!input.requestKey) throw new Error("Delivery record requires requestKey.");
          if (input.kind || input.label || input.evidence || input.status) throw new Error("Delivery uses typed fields only; omit legacy record fields.");
          const operationId = await processSessions.readWorkspace(workspace.root, async () =>
            publishDelivery(ledger, run.id, workspace.root, input.requestKey!, input.delivery!));
          return reply({ operationId, snapshot: views.snapshot(run.id) });
        }
        if (input.kind === "delivery.v1") throw new Error("Reserved delivery kind requires typed delivery publication.");
        if (!input.requestKey || !input.label) throw new Error("record requires requestKey and label.");
        const operationId = ledger.operation({ runId: run.id, requestKey: input.requestKey, kind: input.kind ?? "verification",
          label: input.label, status: input.status ?? "completed", evidence: input.evidence });
        return reply({ operationId, receipt: ledger.receipt(run.id) });
      }
      if (input.action === "finish") {
        if (!input.status || !input.acceptance || input.summary === undefined) throw new Error("finish requires status, acceptance and summary.");
        return reply(ledger.finish(run.id, { status: input.status, acceptance: input.acceptance,
          summary: input.summary, evidence: input.evidence ?? [] }));
      }
      const { evidence, ...receipt } = ledger.receipt(run.id);
      let limit = input.limit ?? 5;
      let value;
      do {
        value = { ...receipt, summary: textPage(run.summary, 0, 2000).text, completionSnapshot: views.snapshot(run.id), ...views.history(run.id, input.cursor, limit),
          evidenceCount: evidence.length, hostAcknowledgment: "unknown" };
        if (replyBytes(value) <= REPLY_BYTES) return reply(value);
      } while (--limit >= 1);
      throw new Error("Work summary exceeds response budget; use snapshot/history.");
    } catch (error) { return reply({ code: "WORK_STATE", message: error instanceof Error ? error.message : "Work operation failed.",
      ...(error instanceof WorkFinishBlockedError ? { blocking: error.blocking, nextAction: error.nextAction } : {}) }, true); }
    finally { ledger.close(); }
  });
}

/** A short-lived ledger handle; no raw command/source text is collected. */
export async function trackedWork<T>(stateDir: string, workRunId: string | undefined,
  scope: { root: string; workspaceId: string }, kind: string, action: (operationId?: string) => Promise<T>,
  metadata?: { argumentFingerprint: string; selectionCount: number; requestKey?: string }): Promise<T> {
  if (!workRunId) return action();
  const ledger = new WorkLedger(stateDir);
  let operationId: string | undefined;
  try {
    ledger.requireScope(workRunId, scope.root, scope.workspaceId);
    const requestKey = `${kind}:${metadata?.requestKey ?? randomUUID()}`;
    operationId = ledger.db.transaction(() => {
      if (metadata?.requestKey) {
        const previous = ledger.db.prepare("select id from console_operations where run_id=? and request_key=?").get(workRunId, requestKey) as { id: string } | undefined;
        if (previous) throw new Error(`RECORDED_OPERATION: ${previous.id}; use work_task get in this run. No mutation was replayed. A reused key cannot request new work.`);
      }
      return ledger.operation({ runId: workRunId, requestKey, kind, label: kind, status: "running" });
    }).immediate();
    const result = await action(operationId);
    const failed = result !== null && typeof result === "object" && "isError" in result && result.isError === true;
    ledger.endOperation(operationId, failed ? "failed" : "completed", failed ? [{
      label: "Tool returned isError; inspect state before retrying",
      reference: JSON.stringify({ version: 1, boundary: "tool_result", retry: "reconcile_before_replay" }), outcome: "failed",
    }] : [{ label: "Produced tool result; host acknowledgment unknown", outcome: "passed",
      reference: JSON.stringify({ version: 1, boundary: "tool_result", ...metadata, producedBytes: Buffer.byteLength(JSON.stringify(result ?? null)),
        producedSha256: digest(result ?? null), hostAcknowledgment: "unknown",
        ...(result && typeof result === "object" && "contextId" in result ? { contextId: result.contextId } : {}) }) }]); return result;
  } catch (error) {
    if (operationId) {
      try { ledger.endOperation(operationId, "failed", [{ label: "Tool threw; inspect state before retrying",
        reference: JSON.stringify({ version: 1, boundary: "tool_exception", ...diagnosticError(error), retry: "reconcile_before_replay" }), outcome: "failed" }]); }
      catch (accountingError) {
        try { console.error(JSON.stringify({ event: "work_operation_accounting_failed", operationId, workRunId,
          ...diagnosticError(accountingError) })); } catch {}
      }
    }
    throw error;
  }
  finally { ledger.close(); }
}
