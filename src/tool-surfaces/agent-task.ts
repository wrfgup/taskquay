import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import * as z from "zod/v4";
import { createLocalAgentClient, type LocalAgentClient } from "../local-agent-client.js";
import { agentControlState, presentAgentObservation, presentAgentReceipt, presentAgentSummary } from "../local-agent-presentation.js";
import { LocalAgentStore } from "../local-agent-store.js";
import type { ToolRegistrationContext } from "./types.js";
import { WorkLedger } from "../work-ledger.js";
import { WorkRunViews } from "../work-run-views.js";
import { hostOrigin, registeredClientLabel } from "./work-task.js";
import { jsonReply, textPage } from "../bounded-reply.js";
import { toAgentErrorPayload, type LocalAgentError } from "../local-agent-errors.js";

type AgentClient = Pick<LocalAgentClient, "start" | "continue" | "get" | "list"> & Partial<Pick<LocalAgentClient, "cancelQueued" | "control">>;

/** A control-plane call must not acquire the shell/checkout claim it is observing. */
export function registerAgentTaskTool(context: ToolRegistrationContext, client?: AgentClient): void {
  const { server, config, workspaces, processSessions } = context;
  const agents = client ?? createLocalAgentClient(config);
  server.registerTool("agent_task", {
    title: "Manage a bounded agent task",
    description: "Delegate only work that needs a Codex judgment or implementation. First inspect files directly with read/workspace_context; these do not invoke Codex. Pass a short host-prepared context, not the whole host history. Related work reuses sessions with workItemId/contextKey; use freshContext for independent review. At most two verified read-only agents share a source; writes/builds remain exclusive and excess work queues without invoking a model. Observe and usage never launch inference.",
    inputSchema: {
      workspace_id: z.string(),
      response_offset: z.number().int().nonnegative().optional(),
      response_execution_id: z.string().optional().describe("Retrieve a preserved successful execution in this agent's authorized run without inference."),
      action: z.enum(["start", "continue", "observe", "list", "claims", "usage", "cancelQueued", "steer", "interrupt"]),
      target: z.string().optional(),
      agent_id: z.string().optional(),
      prompt: z.string().min(1).optional(),
      task_key: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/).optional()
        .describe("Stable identity for one initial task. Repeating the same start returns its existing agent without a new model call; use continue for new instructions."),
      read_only: z.boolean().optional(),
      work_item_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/).optional(),
      work_run_id: z.string().optional().describe("Top-level run returned by work_task begin. Required on continue; bind all related Codex turns to this run for accurate completion receipts."),
      context_key: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/).optional()
        .describe("Stable problem-domain/role identity across related tasks, not a phase name or source SHA. Requires workItemId; a matching terminal thread (including error/stopped) is resumed with normal provider checks. Different contexts remain separate."),
      fresh_context: z.boolean().optional().describe("Use a separate context for unrelated work or independent acceptance review; do not prewarm idle workers."),
      request_key: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/).optional().describe("Idempotency identity for one continuation, distinct from the session/domain identity."),
      expected_turn_id: z.string().min(1).max(256).optional().describe("Exact provider turn id returned by observe. Required for steer and interrupt; stale ids fail without fallback."),
      context: z.object({ summary: z.string().max(12_000), files: z.array(z.object({
        path: z.string().min(1).max(1024), sha256: z.string().regex(/^[0-9a-f]{64}$/),
      }).strict()).max(24) }).strict().optional().describe("Host-prepared facts and versioned files from workspace_context. References are checked before invocation, and again after shared-read analysis. No automatic full-file copy."),
      resources: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/)).max(16).optional(),
      model: z.string().optional(),
      effort: z.string().optional().describe("Requested reasoning effort. Configured model-family reasoning limits may lower it; returned session/receipt effort is the effective value."),
      wait_ms: z.number().int().min(0).max(25_000).optional().describe("Bounded longpoll, default 20000 ms. Reuse revision; usage and elapsed time alone do not wake it."),
      known_revision: z.string().optional().describe("Task/progress change token, independent of cumulative usage. Observe never accepts or finishes a work run."),
      include_response: z.boolean().optional().describe("Explicitly retrieve terminal response and completion receipt, repeatable after disconnect even with the same revision."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async ({ workspace_id, response_offset, response_execution_id, agent_id, task_key, read_only,
    work_item_id, work_run_id, context_key, fresh_context, request_key, expected_turn_id, wait_ms, known_revision,
    include_response, ...rest }, extra) => {
    const input = {
      ...rest,
      workspaceId: workspace_id,
      responseOffset: response_offset,
      responseExecutionId: response_execution_id,
      agentId: agent_id,
      taskKey: task_key,
      readOnly: read_only,
      workItemId: work_item_id,
      workRunId: work_run_id,
      contextKey: context_key,
      freshContext: fresh_context,
      requestKey: request_key,
      expectedTurnId: expected_turn_id,
      waitMs: wait_ms,
      knownRevision: known_revision,
      includeResponse: include_response,
    };
    const workspace = await workspaces.getWorkspace(input.workspaceId);
    const scope = { workspaceId: workspace.id, workspaceRoot: workspace.root };
    const reply = (value: any, isError = false) => ({ ...jsonReply(value), isError });
    const failure = async (error: LocalAgentError) => {
      if (error.code !== "AGENT_CONFLICT") return reply({ code: error.code, message: error.message, retryable: error.retryable }, true);
      const payload = toAgentErrorPayload(error);
      const owner = payload.agentId ? await agents.get(payload.agentId, scope) : undefined;
      const owned = owner?.isOk() ? owner.value : undefined;
      return reply({ code: payload.code, message: "Execution or session is occupied; reconcile before submitting further work.",
        operation: payload.operation, retryable: payload.retryable, requestAccepted: false, providerInvoked: false,
        owner: owned ? { scope: "workspace", workspaceId: workspace.id, agentId: owned.id, status: presentAgentReceipt(owned).status }
          : { scope: "checkout_or_shared_limit", observableFromWorkspace: false },
        waiting: owned && ["queued", "running", "starting"].includes(owned.status) ? "owner_active" : "reconciliation_required",
        nextAction: owned ? { tool: "agent_task", action: "observe", workspaceId: workspace.id, agentId: owned.id, waitMs: 20_000 }
          : { tool: "agent_task", action: "claims", workspaceId: workspace.id },
        guidance: "Observe the owner first. Continue only related work after terminal; use a new requestKey for new instructions. Never steal an active claim or automatically replay writes." }, true);
    };
    if (input.action === "claims") return reply({ claims: processSessions.executionCoordinator?.inspect(workspace.root) ?? [],
      coordinationEnabled: Boolean(processSessions.executionCoordinator) });
    if (input.action === "list") {
      const records = await agents.list(scope);
      if (records.isErr()) return reply({ code: records.error.code, message: records.error.message }, true);
      return reply({ agents: records.value.map((record) => ({ ...presentAgentSummary(record), workItemId: record.workItemId, contextKey: record.contextKey })), policy: {
        maxConcurrentAgents: config.subagents.maxConcurrentAgents ?? 2, readersPerCheckout: config.subagents.maxConcurrentReaders ?? 2, writersPerCheckout: 1,
        queueWaitMs: config.subagents.queueWaitMs ?? 300_000,
        maxNewSessionsPerWorkItem: config.subagents.maxNewSessionsPerWorkItem ?? 3,
        sharedResources: config.subagents.sharedResources ?? [],
      } });
    }
    if (input.action === "cancelQueued") {
      if (!input.agentId || !agents.cancelQueued) return reply({ code: "INVALID_TASK", message: "Cancellation requires an owned queued agent." }, true);
      const result = await agents.cancelQueued(input.agentId, scope);
      return result.isErr() ? reply({ code: result.error.code, message: result.error.message }, true) : reply(presentAgentReceipt(result.value));
    }
    if (input.action === "usage") {
      if (!input.agentId) return reply({ code: "INVALID_TASK", message: "usage needs agentId." }, true);
      const authorized = await agents.get(input.agentId, scope);
      if (authorized.isErr()) return reply({ code: authorized.error.code, message: authorized.error.message }, true);
      const store = new LocalAgentStore(config.stateDir);
      try { return reply(store.usage(authorized.value.id)); } finally { store.close(); }
    }
    if (input.action === "steer" || input.action === "interrupt") {
      if (!input.agentId || !input.workRunId || !input.requestKey || !input.expectedTurnId
        || (input.action === "steer" && !input.prompt) || !agents.control) {
        return reply({ code: "INVALID_TASK", action: input.action, requestAccepted: false, providerInvoked: false,
          missingFields: [!input.agentId && "agentId", !input.workRunId && "workRunId", !input.requestKey && "requestKey",
            !input.expectedTurnId && "expectedTurnId", input.action === "steer" && !input.prompt && "prompt"].filter(Boolean),
          nextAction: { action: "correct_input" }, message: "Supply the exact active-turn control fields before submitting this request." }, true);
      }
      const result = await agents.control({ agentId: input.agentId, action: input.action, workRunId: input.workRunId,
        requestKey: input.requestKey, expectedTurnId: input.expectedTurnId, prompt: input.prompt, scope });
      if (result.isErr()) return failure(result.error);
      return reply({ ...result.value, nextAction: { tool: "agent_task", action: "observe", workspaceId: workspace.id,
        agentId: input.agentId, workRunId: input.workRunId, waitMs: 20_000 } });
    }
    const overrides = { model: input.model, effort: input.effort, writeMode: input.readOnly ? "read_only" as const : undefined,
      context: input.context, resources: input.resources, requestKey: input.requestKey, workRunId: input.workRunId };
    if (input.action === "start" || input.action === "continue") {
      if (!input.prompt || (input.action === "start" ? (!input.target || !input.taskKey || !input.workItemId) : (!input.agentId || !input.requestKey || !input.workRunId))) {
        const required = input.action === "start" ? ["target", "taskKey", "workItemId", "prompt"] as const : ["agentId", "requestKey", "workRunId", "prompt"] as const;
        return reply({ code: "INVALID_TASK", action: input.action, missingFields: required.filter((field) => !input[field]),
          requestAccepted: false, providerInvoked: false, nextAction: { action: "correct_input" },
          message: "Supply the missing fields before submitting this task." }, true);
      }
      const ledger = new WorkLedger(config.stateDir);
      try {
        if (input.workRunId) ledger.requireScope(input.workRunId, workspace.root, workspace.id);
        else overrides.workRunId = ledger.begin({ root: workspace.root, workspaceId: workspace.id, workItemId: input.workItemId!,
          runKey: `delegation:${input.taskKey!}`, title: `DevSpace · ${input.workItemId!}`.slice(0, 160),
          origin: hostOrigin(extra, registeredClientLabel(server)) }).id;
      } catch (error) { return reply({ code: "WORK_STATE", message: error instanceof Error ? error.message : "Cannot bind work run." }, true); }
      finally { ledger.close(); }
      const result = input.action === "start"
        ? await agents.start({ ...scope, ...overrides, target: input.target!, prompt: input.prompt, taskKey: input.taskKey,
            workItemId: input.workItemId, contextKey: input.contextKey, freshContext: input.freshContext })
        : await agents.continue(input.agentId!, input.prompt, overrides, scope);
      if (result.isErr()) return failure(result.error);
      return reply({ ...presentAgentReceipt(result.value), ...agentControlState(result.value, workspace.id), workRunId: overrides.workRunId, contextKey: result.value.contextKey, workItemId: result.value.workItemId,
        contextMode: result.value.providerSessionId ? "resume" : "new", hostContextProvided: Boolean(input.context) });
    }
    if (!input.agentId) return reply({ code: "INVALID_TASK", message: "observe needs agentId." }, true);
    const deadline = Date.now() + (input.waitMs ?? 20_000);
    for (;;) {
      const found = await agents.get(input.agentId, scope);
      if (found.isErr()) return reply({ code: found.error.code, message: found.error.message }, true);
      const record = found.value;
      const ledger = new WorkLedger(config.stateDir);
      let execution: ReturnType<WorkLedger["latestExecution"]>;
      let run: ReturnType<WorkLedger["run"]> | undefined;
      try {
        execution = ledger.latestExecution(record.id);
        if (execution) {
          run = ledger.requireScope(execution.run_id, workspace.root, workspace.id);
        }
        if (input.workRunId && input.workRunId !== run?.id) throw new Error("Agent is outside this work run.");
        const successful = run ? ledger.successfulExecution(record.id, run.id) : undefined;
        const preservedHistory = successful?.managedThreadId ? {
          threadId: ledger.thread(successful.managedThreadId).thread_id, providerTurnId: successful.providerTurnId,
          availability: "provider_owned_history_not_fetched", action: "Use verified provider history support; do not rewrite or fork the original thread automatically." } : undefined;
        const responseExecutionId = input.responseExecutionId ?? successful?.executionId;
        let responseText: string | undefined;
        if (input.includeResponse && responseExecutionId && run) {
          const selected = ledger.execution(responseExecutionId);
          if (selected.agent_id !== record.id || selected.run_id !== run.id) throw new Error("Response is outside this agent/work run.");
          responseText = (ledger.db.prepare("select response from execution_responses where execution_id=?").get(responseExecutionId) as { response: string } | undefined)?.response;
        }
        if (responseText === undefined && record.status === "idle") responseText = record.latestResponse;
        const responsePage = input.includeResponse && responseText !== undefined ? textPage(responseText, input.responseOffset) : undefined;
        const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
        const completionSnapshot = run ? new WorkRunViews(ledger).snapshot(run.id) : undefined;
        const taskRevision = hash([record.id, record.status, record.latestResponse, record.error, record.errorCode, record.errorRetryable,
          execution?.id, execution?.status, run?.id, run?.status, run?.acceptance, run?.evidence, run?.summary, completionSnapshot?.revision]);
        const progressRevision = hash([record.progress?.phase, record.progress?.toolCategory, record.controlState,
          record.providerTurnId, record.controlRevision]);
        const revision = hash([taskRevision, progressRevision]);
        const running = record.status === "queued" || record.status === "running" || record.status === "starting";
        if (!running || Date.now() >= deadline || (input.knownRevision && revision !== input.knownRevision)) {
          const observation = presentAgentObservation(input.includeResponse && !running ? { ...record, latestResponse: responsePage?.text,
            error: record.error ? textPage(record.error, 0, 2000).text : undefined } : { ...record, latestResponse: undefined,
            error: record.errorCode ? "Agent reported an error; explicitly retrieve the terminal result for details." : undefined });
          const completionReceipt = input.includeResponse && !running && run ? { ...ledger.receipt(run.id), evidence: [] } : undefined;
          return reply({ ...observation, ...agentControlState(record, workspace.id, revision), revision, taskRevision, progressRevision,
            unchanged: revision === input.knownRevision, responseAvailable: Boolean(successful?.responseAvailable || (!running && record.status === "idle" && record.latestResponse !== undefined)),
            latestSuccessfulExecution: successful, preservedHistory,
            response: responsePage?.text, responsePage: responsePage ? { ...responsePage, text: undefined } : undefined,
            responseExecutionId, hostAcknowledgment: "unknown",
            recoveryAction: successful ? "Read preserved response or original managed thread history; a failed continuation does not erase earlier success. Do not replay mutations." : "No successful receipt found; this does not prove no work executed.",
            workRunId: run?.id, executionId: execution?.id, executionStatus: execution?.status,
            acceptanceStatus: run?.acceptance ?? "unknown", completionReceipt,
            completionSnapshot,
            ...(input.includeResponse && !running ? { nextAction: { actor: "host", action: "review_result", workRunId: run?.id,
              guidance: "Review returned evidence, then explicitly finish acceptance or continue related work with a new requestKey. Do not infer acceptance from completion." } } : {}),
            admission: record.status === "queued" ? processSessions.executionCoordinator?.waitingState(workspace.root, record.id) : undefined });
        }
      } finally { ledger.close(); }
      await delay(Math.min(500, Math.max(0, deadline - Date.now())), undefined, { signal: extra.signal });
    }
  });
}
