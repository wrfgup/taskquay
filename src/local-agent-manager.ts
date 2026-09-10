import { resolve } from "node:path";
import { ExecutionCoordinator, ExecutionConflictError, canonicalExecutionRoot, type ExecutionClaim, type ExecutionTicket } from "./execution-coordinator.js";
import { setTimeout as delay } from "node:timers/promises";
import { contextPrompt, validateContextShape, verifyHostContext, type HostPreparedContext } from "./workspace-context.js";
import { createHash, randomUUID } from "node:crypto";
import { WorkLedger } from "./work-ledger.js";
import { limitedReasoningEffort } from "./agent-reasoning-limit.js";
import { Result, type Result as BetterResult } from "better-result";
import {
  AgentConflictError,
  AgentScopeError,
  AgentStoreError,
  AgentTargetError,
  isLocalAgentError,
  isProgrammerDefect,
  type LocalAgentError,
} from "./local-agent-errors.js";
import {
  type LocalAgentProfile,
  type LocalAgentProvider,
  isLocalAgentProvider,
} from "./local-agent-profiles.js";
import {
  resolveLocalAgentTarget,
} from "./local-agent-targets.js";
import {
  type LocalAgentRecord,
  type LocalAgentStore,
  type LocalAgentTurnRecord,
  type LocalAgentWorkspaceScope,
} from "./local-agent-store.js";
import {
  type LocalAgentDriver,
  type LocalAgentRunCallbacks,
  type LocalAgentRunInput,
  type LocalAgentRuntimeContext,
  type LocalAgentWriteMode,
} from "./local-agent-runtime.js";
import { LocalAgentRuntimePool } from "./local-agent-runtime-pool.js";
import { assertAllowedPath } from "./roots.js";
import {
  isSubagentProviderEnabled,
  type SubagentsConfig,
} from "./local-agent-config.js";

export interface StartLocalAgentInput {
  target: string;
  prompt: string;
  workspaceRoot: string;
  workspaceId?: string;
  model?: string;
  effort?: string;
  writeMode?: LocalAgentWriteMode;
  taskKey?: string;
  workItemId?: string;
  contextKey?: string;
  freshContext?: boolean;
  context?: HostPreparedContext;
  resources?: string[];
  workRunId?: string;
}

export interface RunOverrides {
  model?: string;
  effort?: string;
  writeMode?: LocalAgentWriteMode;
  requestKey?: string;
  context?: HostPreparedContext;
  resources?: string[];
  workRunId?: string;
}

export interface LocalAgentManagerLogger {
  (level: "info" | "warn" | "error", event: string, fields: Record<string, unknown>): void;
}

export interface LocalAgentManagerOptions {
  store: LocalAgentStore;
  drivers: readonly LocalAgentDriver[];
  pool: LocalAgentRuntimePool;
  loadProfiles: (workspaceRoot: string) => Promise<LocalAgentProfile[]>;
  agentDir?: string;
  allowedRoots?: readonly string[];
  logger?: LocalAgentManagerLogger;
  subagents: SubagentsConfig;
}

export type AgentStartError = AgentTargetError | AgentScopeError | AgentConflictError | AgentStoreError;
export type AgentContinueError = AgentStartError;
export type AgentLookupError = AgentTargetError | AgentScopeError | AgentStoreError;
export type AgentListError = AgentScopeError | AgentStoreError;
export type AgentWaitError = AgentLookupError;

export type LocalAgentWaitResult =
  | { id: string; status: "running"; wait?: "timeout" }
  | { id: string; status: "completed"; response?: string }
  | { id: string; status: "failed"; error: { code: string; message: string; retryable: boolean } }
  | { id: string; status: "stopped"; error?: { code: string; message: string; retryable: boolean } };

interface ActiveLocalAgentTurn {
  turnId: number;
  completion: Promise<void>;
}

/**
 * Owns one durable DevSpace agent's turn lifecycle. Provider runtimes remain
 * below this seam; this class only translates records into provider inputs and
 * persists the result.
 */
export class LocalAgentManager {
  private readonly store: LocalAgentStore;
  private readonly drivers = new Map<LocalAgentProvider, LocalAgentDriver>();
  private readonly pool: LocalAgentRuntimePool;
  private readonly loadProfiles: (workspaceRoot: string) => Promise<LocalAgentProfile[]>;
  private readonly agentDir?: string;
  private readonly allowedRoots?: readonly string[];
  private readonly logger?: LocalAgentManagerLogger;
  private readonly subagents: SubagentsConfig;
  private readonly activeTurns = new Map<string, ActiveLocalAgentTurn>();
  private readonly queuedTurns = new Map<string, AbortController>();
  private readonly execution: ExecutionCoordinator;
  private readonly ledger: WorkLedger;
  private accepting = true;
  private closePromise?: Promise<void>;

  constructor(options: LocalAgentManagerOptions) {
    this.store = options.store;
    this.execution = new ExecutionCoordinator(options.store.stateDir);
    this.ledger = new WorkLedger(options.store.stateDir);
    for (const driver of options.drivers) this.drivers.set(driver.provider, driver);
    this.pool = options.pool;
    this.loadProfiles = options.loadProfiles;
    this.agentDir = options.agentDir;
    this.allowedRoots = options.allowedRoots;
    this.logger = options.logger;
    this.subagents = options.subagents;
  }

  reconcileActiveRuns(message?: string): BetterResult<number, AgentStoreError> {
    try { this.ledger.reconcileInterruptedExecutions(); }
    catch (error) { return Result.err(new AgentStoreError("reconcile_work_ledger", error)); }
    return this.store.reconcileActiveRunsResult(message);
  }

  async start(input: StartLocalAgentInput): Promise<BetterResult<LocalAgentRecord, AgentStartError>> {
    const manager = this;
    return Result.gen(async function* () {
      yield* manager.acceptingResult("start");
      const workspaceRoot = yield* manager.authorizeWorkspace(
        input.workspaceRoot,
        input.workspaceId,
        "start",
      );
      const profiles = yield* Result.await(manager.loadProfilesResult(workspaceRoot, input.target));
      const target = resolveLocalAgentTarget(
        input.target,
        profiles,
        input.model,
        input.effort,
        manager.subagents.providers,
      );
      if (!target) {
        return Result.err(new AgentTargetError({
          code: "UNKNOWN_TARGET",
          target: input.target,
          retryable: false,
          message: `Unknown subagent profile or provider: ${input.target}.`,
        }));
      }
      if (target.kind === "profile" && target.profile.disabled) {
        return Result.err(new AgentTargetError({
          code: "PROVIDER_DISABLED",
          target: target.name,
          provider: target.provider,
          retryable: false,
          message: `Subagent profile is disabled: ${target.name}.`,
        }));
      }
      yield* manager.providerEnabledResult(target.provider, target.name, "start");
      yield* manager.driverResult(target.provider, "start");
      try {
        validateContextShape(input.context);
        for (const key of [input.workItemId, input.contextKey]) {
          if (key !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(key)) throw new Error("Invalid context/work item key.");
        }
        if (input.contextKey && !input.workItemId) throw new Error("Context affinity requires a workItemId.");
      } catch (error) {
        return Result.err(new AgentTargetError({ code: "TARGET_RESOLUTION_FAILED", target: input.target,
          retryable: false, message: error instanceof Error ? error.message : "Invalid host context." }));
      }
      if (input.taskKey !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.taskKey)) {
        return Result.err(new AgentTargetError({ code: "TARGET_RESOLUTION_FAILED", target: input.target,
          retryable: false, message: "Invalid task key." }));
      }
      const task = input.taskKey ? { key: input.taskKey, canonicalRoot: canonicalExecutionRoot(workspaceRoot),
        hash: createHash("sha256").update(JSON.stringify([input.prompt, input.target, input.writeMode, input.model, input.effort,
          input.context, input.contextKey, input.workItemId, input.freshContext, input.resources, input.workRunId])).digest("hex") } : undefined;
      const provider = manager.subagents.providers.find((entry) => entry.id === target.provider);
      const mode = input.writeMode ?? provider?.writeMode ?? "allowed";
      const readDefaults = mode === "read_only" ? provider?.readOnlyDefaults : undefined;
      let effectiveEffort: string | undefined;
      try { effectiveEffort = limitedReasoningEffort(provider, input.model ?? readDefaults?.model ?? target.model,
        input.effort ?? readDefaults?.effort ?? target.effort); }
      catch (error) { return Result.err(new AgentTargetError({ code: "TARGET_RESOLUTION_FAILED", target: input.target,
        retryable: false, message: error instanceof Error ? error.message : "Reasoning policy rejected the request." })); }
      const signature = createHash("sha256").update(JSON.stringify([target.provider,
        input.model ?? readDefaults?.model ?? target.model, effectiveEffort,
        mode, target.kind === "profile" ? target.profile.body : "", "host-first-v1"])).digest("hex");
      const created = yield* manager.store.createTaskResult({
        workspaceId: input.workspaceId,
        workspaceRoot,
        profileName: target.name,
        provider: target.provider,
        model: target.model,
        effort: target.effort,
        contextKey: input.contextKey,
        contextSignature: signature,
        workItemId: input.workItemId,
      }, task, !input.freshContext, manager.subagents.maxNewSessionsPerWorkItem ?? 3);
      const record = created.record;
      if (created.reused) {
        yield* manager.agentWorkspaceResult(record, { workspaceId: input.workspaceId, workspaceRoot }, "start");
        return Result.ok(record);
      }
      const started = manager.begin(record, input.prompt, {
        model: input.model,
        effort: input.effort,
        writeMode: input.writeMode,
        context: input.context,
        resources: input.resources,
        workRunId: input.workRunId,
      }, input.workspaceId, target);
      if (started.isErr()) manager.store.updateResult(record.id, {
        status: "stopped", error: started.error.message,
        errorCode: started.error.code, errorRetryable: started.error.retryable,
      });
      return started;
    });
  }

  async continue(
    agentId: string,
    prompt: string,
    overrides: RunOverrides = {},
    scope: LocalAgentWorkspaceScope,
  ): Promise<BetterResult<LocalAgentRecord, AgentContinueError>> {
    const manager = this;
    return Result.gen(async function* () {
      yield* manager.acceptingResult("continue", agentId);
      const record = yield* manager.store.getByIdResult(agentId);
      if (!record) return Result.err(agentNotFound(agentId));
      yield* manager.agentWorkspaceResult(record, scope, "continue");
      const profiles = yield* Result.await(manager.loadProfilesResult(record.workspaceRoot, record.profileName));
      yield* manager.profileForRecordResult(record, profiles);
      yield* manager.providerEnabledResult(record.provider, record.profileName, "continue");
      yield* manager.driverResult(record.provider, "continue", agentId);
      const target = resolveLocalAgentTarget(
        record.profileName, profiles, undefined, undefined, manager.subagents.providers,
      );
      try { validateContextShape(overrides.context); } catch {
        return Result.err(new AgentTargetError({ code: "TARGET_RESOLUTION_FAILED", target: record.profileName,
          retryable: false, message: "Invalid host-prepared continuation context." }));
      }
      {
        // Even a legacy CLI continuation needs a cross-process reservation.
        // Without a caller key it is not replayable, but it still cannot race a thread.
        const key = overrides.requestKey ?? `legacy-${randomUUID()}`;
        if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(key)) return Result.err(new AgentTargetError({
          code: "TARGET_RESOLUTION_FAILED", target: record.profileName, retryable: false, message: "Invalid continuation request key." }));
        const hash = createHash("sha256").update(JSON.stringify([prompt, overrides])).digest("hex");
        const replay = yield* manager.store.reserveContinueResult(agentId, key, hash);
        if (replay) return manager.store.getByIdResult(agentId).map((value) => value!);
      }
      const begun = manager.begin(record, prompt, overrides, scope.workspaceId, target);
      if (begun.isErr()) manager.store.updateResult(agentId, { status: "stopped", error: begun.error.message,
        errorCode: begun.error.code, errorRetryable: begun.error.retryable });
      return begun;
    });
  }

  get(
    agentId: string,
    scope: LocalAgentWorkspaceScope,
  ): BetterResult<LocalAgentRecord, AgentLookupError> {
    const lookup = this.store.getByIdResult(agentId);
    if (lookup.isErr()) return lookup;
    const record = lookup.value;
    if (!record) return Result.err(agentNotFound(agentId));
    const scoped = this.agentWorkspaceResult(record, scope, "get");
    if (scoped.isErr()) return scoped;
    return Result.ok(record);
  }

  list(scope: LocalAgentWorkspaceScope): BetterResult<LocalAgentRecord[], AgentListError> {
    return this.authorizeWorkspace(scope.workspaceRoot, scope.workspaceId, "list").andThen((workspaceRoot) => (
      this.store.listResult({
        workspaceId: scope.workspaceId,
        workspaceRoot,
      })
    ));
  }

  async wait(
    agentIds: readonly string[],
    scope: LocalAgentWorkspaceScope,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<BetterResult<LocalAgentWaitResult[], AgentWaitError>> {
    const captures: Array<{ agent: LocalAgentRecord; turn?: LocalAgentTurnRecord }> = [];
    for (const agentId of unique(agentIds)) {
      const agent = this.get(agentId, scope);
      if (agent.isErr()) return agent;
      const turn = this.store.getLatestTurnResult(agentId);
      if (turn.isErr()) return turn;
      captures.push({ agent: agent.value, turn: turn.value });
    }

    const pending: Promise<void>[] = [];
    for (const capture of captures) {
      if (capture.turn?.status !== "running") continue;
      const active = this.activeTurns.get(capture.agent.id);
      if (active?.turnId !== capture.turn.id) {
        return Result.err(new AgentStoreError(
          "wait",
          new Error(`Turn ${capture.turn.id} is not active.`),
          `Running turn state is unavailable for subagent ${capture.agent.id}.`,
        ));
      }
      pending.push(active.completion);
    }

    const timedOut = pending.length > 0
      ? await waitForTurns(pending, timeoutMs, signal)
      : false;
    const results: LocalAgentWaitResult[] = [];
    for (const capture of captures) {
      if (!capture.turn) {
        results.push(waitResultFromAgent(capture.agent, timedOut));
        continue;
      }
      const turn = this.store.getTurnByIdResult(capture.turn.id);
      if (turn.isErr()) return turn;
      results.push(turn.value
        ? waitResultFromTurn(turn.value, timedOut)
        : waitResultFromAgent(capture.agent, timedOut));
    }
    return Result.ok(results);
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.accepting = false;
    for (const controller of this.queuedTurns.values()) controller.abort();
    const turns = Array.from(this.activeTurns.values(), (turn) => turn.completion);
    this.closePromise = (async () => {
      // Closing pooled runtimes is what interrupts provider turns. Waiting for
      // those turns first can strand a provider process indefinitely.
      await this.pool.close();
      const turnResults = await Promise.allSettled(turns);
      for (const result of turnResults) {
        if (result.status === "rejected") {
          this.log("warn", "local_agent_close_failed", { error: errorMessage(result.reason) });
        }
      }
      this.execution.close();
      this.ledger.close();
      this.store.close();
    })();
    return this.closePromise;
  }

  get activeTurnCount(): number {
    return this.activeTurns.size;
  }

  get runtimeCount(): number {
    return this.pool.size;
  }

  async evictIdle(now?: number): Promise<void> {
    await this.pool.evictIdle(now);
  }

  cancelQueued(agentId: string, scope: LocalAgentWorkspaceScope): BetterResult<LocalAgentRecord, AgentLookupError | AgentConflictError> {
    const found = this.get(agentId, scope);
    if (found.isErr()) return found;
    const controller = this.queuedTurns.get(agentId);
    if (!controller) return Result.err(new AgentConflictError({ code: "AGENT_CONFLICT", agentId,
      operation: "cancel_queued", retryable: false, message: "Only a queued, not-yet-started turn may be cancelled here." }));
    const active = this.activeTurns.get(agentId);
    if (!active) return Result.err(new AgentConflictError({ code: "AGENT_CONFLICT", agentId,
      operation: "cancel_queued", retryable: true, message: "Queued turn ownership is unavailable." }));
    controller.abort();
    return this.store.finishTurnResult(agentId, active.turnId, { status: "stopped",
      error: "Queued task cancelled before provider invocation.", errorCode: "PROVIDER_CANCELLED", errorRetryable: false });
  }

  private begin(
    record: LocalAgentRecord,
    prompt: string,
    overrides: RunOverrides,
    workspaceId?: string,
    defaults?: { model?: string; effort?: string },
  ): BetterResult<LocalAgentRecord, AgentConflictError | AgentStoreError | AgentTargetError> {
    if (this.activeTurns.has(record.id)) {
      return Result.err(new AgentConflictError({
        code: "AGENT_CONFLICT",
        agentId: record.id,
        operation: "continue",
        retryable: true,
        message: `Agent ${record.id} already has a running turn.`,
      }));
    }

    const providerConfig = this.subagents.providers.find((provider) => provider.id === record.provider);
    const effectiveMode = overrides.writeMode ?? providerConfig?.writeMode ?? "allowed";
    const readOnlyDefaults = effectiveMode === "read_only" ? providerConfig?.readOnlyDefaults : undefined;
    const resolvedModel = overrides.model ?? readOnlyDefaults?.model ?? defaults?.model;
    const model = resolvedModel ?? record.model;
    const resolvedEffort = overrides.effort ?? readOnlyDefaults?.effort ?? defaults?.effort;
    const requestedEffort = resolvedEffort ?? record.effort;
    let effort: string | undefined;
    try { effort = limitedReasoningEffort(providerConfig, model, requestedEffort); }
    catch (error) { return Result.err(new AgentTargetError({ code: "TARGET_RESOLUTION_FAILED", target: record.profileName,
      retryable: false, message: error instanceof Error ? error.message : "Reasoning policy rejected the request." })); }
    this.log("info", "agent_reasoning_resolved", { agentId: record.id, provider: record.provider, model,
      requestedEffort, effectiveEffort: effort, capped: effort !== requestedEffort,
      source: overrides.effort !== undefined ? "caller" : readOnlyDefaults?.effort !== undefined ? "read_only_default" : "target_or_session_default" });
    overrides = { ...overrides, model: resolvedModel, effort: effort === requestedEffort ? resolvedEffort : effort };
    let executionId: string;
    try {
      this.ledger.assertAgentUsable(record.id);
      const prior = this.ledger.latestExecution(record.id);
      const priorRun = prior ? this.ledger.run(prior.run_id) : undefined;
      const reusable = !overrides.workRunId && priorRun?.status === "running" && JSON.parse(priorRun.origin).entryPoint === "devspace_cli"
        ? priorRun.id : undefined;
      const work = overrides.workRunId || reusable
        ? this.ledger.requireScope(overrides.workRunId ?? reusable!, record.workspaceRoot, workspaceId)
        : this.ledger.begin({ root: record.workspaceRoot, workspaceId, workItemId: record.workItemId ?? `agent-${record.id}`,
          runKey: `cli-${randomUUID()}`, title: `DevSpace · ${record.workItemId ?? record.id}`.slice(0, 160),
          origin: { entryPoint: "devspace_cli", evidence: "server_entry" } });
      executionId = this.ledger.beginExecution({ runId: work.id, agentId: record.id, provider: record.provider,
        model: overrides.model ?? defaults?.model, effort: overrides.effort ?? defaults?.effort });
    } catch (error) { return Result.err(new AgentStoreError("work_accounting", error,
      "Unable to establish work ownership; inspect the task/thread state before provider invocation.")); }

    // Resolve effective capability BEFORE choosing the source lock, not after it.
    const analysisOnly = effectiveMode === "read_only" && this.drivers.get(record.provider as LocalAgentProvider)?.readOnlyConcurrency === true;
    overrides = { ...overrides, writeMode: effectiveMode };
    const requirement = { workspaceRoot: record.workspaceRoot, kind: "agent" as const, agentId: record.id,
      threadKey: record.providerSessionId ? `${record.provider}:${record.providerSessionId}` : undefined,
      access: analysisOnly ? "read" as const : "write" as const,
      resources: [...new Set([...(analysisOnly ? [] : this.subagents.sharedResources ?? []), ...overrides.resources ?? []])],
      maxConcurrentAgents: this.subagents.maxConcurrentAgents ?? 2,
      maxConcurrentReaders: this.subagents.maxConcurrentReaders ?? 2 };
    let claim: ExecutionClaim | undefined;
    let ticket: ExecutionTicket | undefined;
    const waitMs = this.subagents.queueWaitMs ?? 300_000;
    try {
      try { claim = this.execution.acquire(requirement); }
      catch (error) {
        if (!(error instanceof ExecutionConflictError) || waitMs === 0) throw error;
        ticket = this.execution.enqueue(requirement, waitMs);
      }
    } catch (error) {
      this.store.updateResult(record.id, { status: "error", errorCode: "AGENT_CONFLICT", errorRetryable: true,
        error: "Local admission failed before provider invocation; previous successful results remain recoverable." });
      this.ledger.providerNotRequested(executionId);
      this.ledger.endExecution(executionId, "failed");
      if (error instanceof ExecutionConflictError) return Result.err(new AgentConflictError({
        code: "AGENT_CONFLICT", agentId: error.agentId, operation: "admission", retryable: true, message: error.message,
      }));
      return Result.err(new AgentStoreError("admission", error,
        "Unable to establish an execution claim; provider was not invoked."));
    }

    // Resolve defaults for this turn, rather than inheriting a previous read-only turn.
    overrides = {
      ...overrides,
      model: overrides.model ?? readOnlyDefaults?.model ?? defaults?.model,
      effort: overrides.effort ?? readOnlyDefaults?.effort ?? defaults?.effort,
    };
    const begun = this.store.beginTurnResult(record.id, {
      prompt,
      model: overrides.model ?? record.model,
      effort: overrides.effort ?? record.effort,
    });
    if (begun.isErr()) { claim?.release(); ticket?.cancel(); this.ledger.endExecution(executionId, "failed"); return begun; }
    const updated = ticket
      ? this.store.updateResult(record.id, { status: "queued" })
      : Result.ok(begun.value.agent);
    if (updated.isErr()) {
      this.store.finishTurnResult(record.id, begun.value.turn.id, { status: "failed",
        error: updated.error.message, errorCode: updated.error.code, errorRetryable: updated.error.retryable });
      claim?.release(); ticket?.cancel(); this.ledger.endExecution(executionId, "failed"); return updated;
    }
    const controller = new AbortController();
    if (ticket) this.queuedTurns.set(record.id, controller);
    // Defer invocation until after the tracking entry is visible. This keeps
    // cleanup correct even if runTurn later gains a synchronous completion path.
    const turn = Promise.resolve().then(async () => {
      try {
        while (!claim && ticket) {
          if (controller.signal.aborted || !this.accepting) throw new Error("Queue cancelled before provider invocation.");
          claim = ticket.tryAcquire();
          if (!claim) await delay(100, undefined, { signal: controller.signal });
        }
        this.queuedTurns.delete(record.id);
        if (controller.signal.aborted || !this.accepting) throw new Error("Queue cancelled before provider invocation.");
        const running = this.store.updateResult(record.id, { status: "running" });
        if (running.isErr()) throw running.error;
        await this.runTurn(running.value, begun.value.turn.id, prompt, overrides, workspaceId, claim, analysisOnly, executionId);
      } catch (error) {
        const existing = this.store.getById(record.id);
        // runTurn already persisted its own error; don't relabel it a queue failure.
        const activeTurn = this.store.getTurnById(begun.value.turn.id);
        if (existing && activeTurn?.status === "running") this.store.finishTurnResult(record.id, begun.value.turn.id, {
          status: controller.signal.aborted ? "stopped" : "failed",
          error: controller.signal.aborted ? "Queued turn cancelled before provider invocation." : "Execution could not leave the local queue; inspect its claim.",
          errorCode: controller.signal.aborted ? "PROVIDER_CANCELLED" : "AGENT_CONFLICT", errorRetryable: true,
        });
        if (!ticket) throw error;
      }
    }).finally(() => {
      try {
        const terminal = this.store.getById(record.id)?.status;
        this.ledger.endExecution(executionId, terminal === "idle" ? "completed" : terminal === "stopped" ? "cancelled" : "failed");
      } finally {
        this.queuedTurns.delete(record.id);
        ticket?.cancel(); claim?.release(); this.activeTurns.delete(record.id);
      }
    });
    this.activeTurns.set(record.id, { turnId: begun.value.turn.id, completion: turn });
    void turn.catch(() => undefined);
    return Result.ok(updated.value);
  }

  private async runTurn(
    record: LocalAgentRecord,
    turnId: number,
    prompt: string,
    overrides: RunOverrides,
    workspaceId?: string,
    claim?: ExecutionClaim,
    analysisOnly = false,
    executionId?: string,
  ): Promise<void> {
    const startedAt = Date.now();
    this.log("info", "agent_run_started", {
      provider: record.provider,
      agentId: record.id,
      providerSessionIdPrefix: record.providerSessionId?.slice(0, 8),
    });
    try {
      const authorized = this.authorizeWorkspace(record.workspaceRoot, workspaceId, "run");
      if (authorized.isErr()) {
        this.persistRunError(record, turnId, authorized.error, startedAt);
        return;
      }
      const workspaceRoot = authorized.value;
      this.ledger.assertAgentUsable(record.id);
      try { verifyHostContext(workspaceRoot, overrides.context); }
      catch (error) {
        this.persistRunError(record, turnId, new AgentTargetError({ code: "TARGET_RESOLUTION_FAILED", target: record.profileName,
          retryable: false, message: error instanceof Error ? error.message : "Host context is no longer valid." }), startedAt);
        return;
      }
      const authorizedRecord = workspaceRoot === record.workspaceRoot
        ? record
        : { ...record, workspaceRoot };
      const profiles = await this.loadProfilesResult(workspaceRoot, record.profileName);
      if (profiles.isErr()) {
        this.persistRunError(record, turnId, profiles.error, startedAt);
        return;
      }
      const profile = this.profileForRecordResult(record, profiles.value);
      if (profile.isErr()) {
        this.persistRunError(record, turnId, profile.error, startedAt);
        return;
      }
      const input = this.buildRunInputResult(authorizedRecord, profile.value, prompt, overrides);
      if (input.isErr()) {
        this.persistRunError(record, turnId, input.error, startedAt);
        return;
      }
      const driver = this.driverResult(record.provider, "run", record.id);
      if (driver.isErr()) {
        this.persistRunError(record, turnId, driver.error, startedAt);
        return;
      }
      input.value.analysisOnly = analysisOnly;
      if (executionId) this.ledger.requestedConfiguration(executionId, input.value.model, input.value.effort);
      if (executionId) input.value.sessionLabel = this.ledger.sessionTitle(this.ledger.execution(executionId).run_id, record.id);
      const context: LocalAgentRuntimeContext = {
        agentId: record.id,
        provider: driver.value.provider,
        workspaceRoot,
        providerSessionId: record.providerSessionId,
        writeMode: input.value.writeMode,
        model: input.value.model,
        effort: input.value.effort,
        agentDir: this.agentDir,
      };
      const callbacks: LocalAgentRunCallbacks = {
        onNotRequested: executionId ? () => { this.ledger.providerNotRequested(executionId); } : undefined,
        onActivity: (activity) => {
          const saved = this.store.recordActivityResult(record.id, activity);
          if (saved.isErr()) this.log("warn", "agent_progress_persistence_failed", { agentId: record.id, errorCode: saved.error.code });
        },
        onThreadInfo: executionId ? (observation) => { this.ledger.attachThread(executionId, observation); } : undefined,
        onNameResult: executionId ? (success) => { this.ledger.nameResult(executionId, success); } : undefined,
        onRequest: executionId ? () => { this.ledger.requestStarted(executionId); } : undefined,
        onTurnStarted: executionId ? (turnId) => { this.ledger.turnStarted(executionId, turnId); } : undefined,
        onProviderFinished: executionId ? () => { this.ledger.providerFinished(executionId); } : undefined,
        onUsage: (usage) => {
          const saved = this.store.recordUsageResult(record.id, usage);
          if (saved.isErr()) this.log("warn", "agent_usage_persistence_failed", { agentId: record.id, errorCode: saved.error.code });
          if (executionId) this.ledger.usage(executionId, usage);
        },
        onSessionId: (providerSessionId) => {
          claim?.bindThread(`${record.provider}:${providerSessionId}`);
          const current = this.store.getByIdResult(record.id);
          if (current.isErr()) throw current.error;
          if (!current.value || current.value.providerSessionId === providerSessionId) return;
          const updated = this.store.updateResult(record.id, { providerSessionId });
          if (updated.isErr()) throw updated.error;
        },
        onHistoryHandoff: (handoff) => {
          claim?.bindThread(`${record.provider}:${handoff.threadId}`);
          const updated = this.store.updateResult(record.id, {
            providerSessionId: handoff.threadId,
            recoveryType: handoff.type,
            parentProviderSessionId: handoff.parentThreadId,
          });
          if (updated.isErr()) throw updated.error;
        },
      };
      // An older/uninstrumented Codex adapter must never turn unknown paid work into zero.
      if (executionId && record.provider === "codex") this.ledger.providerDispatchStarted(executionId);
      if (executionId && record.provider === "codex" && !driver.value.reportsWorkLifecycle) this.ledger.requestStarted(executionId);
      const result = await this.pool.run(driver.value, context, input.value, callbacks);
      if (result.isErr()) {
        this.persistRunError(record, turnId, result.error, startedAt);
        return;
      }
      const runResult = result.value;
      if (analysisOnly) {
        try { verifyHostContext(workspaceRoot, overrides.context); }
        catch {
          this.persistRunError(record, turnId, new AgentTargetError({ code: "TARGET_RESOLUTION_FAILED", target: record.profileName,
            retryable: false, message: "Input changed during analysis; this conclusion is not a verified result for the current source. Refresh the host context." }), startedAt);
          return;
        }
      }
      const current = this.store.getByIdResult(record.id);
      if (current.isErr()) throw current.error;
      if (!current.value) return;
      if (executionId) this.ledger.saveResponse(executionId, runResult.finalResponse);
      const updated = this.store.finishTurnResult(record.id, turnId, {
        providerSessionId: runResult.providerSessionId ?? current.value.providerSessionId,
        contextSignature: createHash("sha256").update(JSON.stringify([record.provider, input.value.model, input.value.effort,
          input.value.writeMode, profile.value?.body ?? "", "host-first-v1"])).digest("hex"),
        status: "completed",
        response: runResult.finalResponse,
      });
      if (updated.isErr()) throw updated.error;
      this.log("info", "agent_run_completed", {
        provider: updated.value.provider,
        agentId: updated.value.id,
        providerSessionIdPrefix: updated.value.providerSessionId?.slice(0, 8),
        durationMs: Math.max(0, Date.now() - startedAt),
      });
    } catch (error) {
      if (isLocalAgentError(error)) {
        this.persistRunError(record, turnId, error, startedAt);
        return;
      }
      const persisted = this.store.finishTurnResult(record.id, turnId, {
        status: "failed",
        error: "Unexpected internal subagent failure.",
        errorCode: "AGENT_INTERNAL_ERROR",
        errorRetryable: false,
      });
      this.log("error", "agent_run_failed", {
        provider: record.provider,
        agentId: record.id,
        providerSessionIdPrefix: record.providerSessionId?.slice(0, 8),
        durationMs: Math.max(0, Date.now() - startedAt),
        error: "Unexpected internal subagent failure.",
        errorType: error instanceof Error ? error.name : typeof error,
        persistenceFailed: persisted.isErr(),
      });
      throw error;
    }
  }

  private persistRunError(
    record: LocalAgentRecord,
    turnId: number,
    error: LocalAgentError,
    startedAt: number,
  ): void {
    const persisted = this.store.finishTurnResult(record.id, turnId, {
      status: "failed",
      error: error.message,
      errorCode: error.code,
      errorRetryable: error.retryable,
    });
    this.log("error", "agent_run_failed", {
      provider: record.provider,
      agentId: record.id,
      providerSessionIdPrefix: record.providerSessionId?.slice(0, 8),
      durationMs: Math.max(0, Date.now() - startedAt),
      errorCode: error.code,
      error: error.message,
      causeType: safeCauseType("cause" in error ? error.cause : undefined),
      persistenceFailed: persisted.isErr(),
    });
  }

  private buildRunInputResult(
    record: LocalAgentRecord,
    profile: LocalAgentProfile | undefined,
    prompt: string,
    overrides: RunOverrides,
  ): BetterResult<LocalAgentRunInput, AgentTargetError> {
    const isRawProvider = record.profileName === record.provider;
    if (!profile && !isRawProvider) {
      return Result.err(new AgentTargetError({
        code: "UNKNOWN_TARGET",
        target: record.profileName,
        provider: isLocalAgentProvider(record.provider) ? record.provider : undefined,
        retryable: false,
        message: `Subagent profile not found: ${record.profileName}.`,
      }));
    }
    const body = profile?.body.trim();
    const stableSlot = this.drivers.get(record.provider as LocalAgentProvider)?.persistentProfileInstructions === true;
    const taskPrompt = contextPrompt(prompt, overrides.context);
    const fullPrompt = body && !stableSlot ? `${body}\n\nTask:\n${taskPrompt}` : taskPrompt;
    return Result.ok({
      prompt: fullPrompt,
      profileInstructions: stableSlot ? body : undefined,
      workspaceRoot: record.workspaceRoot,
      providerSessionId: record.providerSessionId,
      writeMode: overrides.writeMode
        ?? this.subagents.providers.find((provider) => provider.id === record.provider)?.writeMode
        ?? "allowed",
      model: record.model ?? profile?.model,
      effort: record.effort ?? profile?.effort,
      modelOverrideRequested: overrides.model !== undefined,
      effortOverrideRequested: overrides.effort !== undefined,
      requestKey: overrides.requestKey,
      historyHandoff: this.subagents.providers.find((provider) => provider.id === record.provider)?.historyHandoff,
    });
  }

  private profileForRecordResult(
    record: LocalAgentRecord,
    profiles: readonly LocalAgentProfile[],
  ): BetterResult<LocalAgentProfile | undefined, AgentTargetError> {
    if (record.profileName === record.provider) return Result.ok(undefined);
    const profile = profiles.find((candidate) => candidate.name === record.profileName);
    if (!profile) {
      return Result.err(new AgentTargetError({
        code: "UNKNOWN_TARGET",
        target: record.profileName,
        provider: isLocalAgentProvider(record.provider) ? record.provider : undefined,
        retryable: false,
        message: `Subagent profile not found: ${record.profileName}.`,
      }));
    }
    if (profile.disabled) {
      return Result.err(new AgentTargetError({
        code: "PROVIDER_DISABLED",
        target: profile.name,
        provider: profile.provider,
        retryable: false,
        message: `Subagent profile is disabled: ${profile.name}.`,
      }));
    }
    return Result.ok(profile);
  }

  private driverResult(
    provider: string,
    operation: string,
    agentId?: string,
  ): BetterResult<LocalAgentDriver, AgentTargetError> {
    if (!isLocalAgentProvider(provider)) {
      return Result.err(new AgentTargetError({
        code: "PROVIDER_NOT_CONFIGURED",
        target: provider,
        operation,
        retryable: false,
        message: `No local agent driver is configured for provider: ${provider}.`,
      }));
    }
    const driver = this.drivers.get(provider);
    if (!driver) {
      return Result.err(new AgentTargetError({
        code: "PROVIDER_NOT_CONFIGURED",
        target: agentId ?? provider,
        provider,
        operation,
        retryable: false,
        message: `No local agent driver is configured for provider: ${provider}.`,
      }));
    }
    return Result.ok(driver);
  }

  private providerEnabledResult(
    provider: string,
    target: string,
    operation: string,
  ): BetterResult<void, AgentTargetError> {
    if (!isLocalAgentProvider(provider)) return Result.ok(undefined);
    if (isSubagentProviderEnabled(this.subagents, provider)) return Result.ok(undefined);
    return Result.err(new AgentTargetError({
      code: "PROVIDER_DISABLED",
      target,
      provider,
      operation,
      retryable: false,
      message: `Subagent provider is disabled: ${provider}.`,
    }));
  }

  private acceptingResult(
    operation: string,
    agentId?: string,
  ): BetterResult<void, AgentConflictError> {
    if (this.accepting) return Result.ok(undefined);
    return Result.err(new AgentConflictError({
      code: "AGENT_CONFLICT",
      agentId,
      operation,
      retryable: false,
      message: "Local agent manager is closed.",
    }));
  }

  private authorizeWorkspace(
    workspaceRoot: string,
    workspaceId: string | undefined,
    operation: string,
  ): BetterResult<string, AgentScopeError> {
    const normalized = resolve(workspaceRoot);
    if (!workspaceId || !this.allowedRoots) return Result.ok(normalized);
    try {
      return Result.ok(assertAllowedPath(normalized, [...this.allowedRoots]));
    } catch (cause) {
      return Result.err(new AgentScopeError({
        code: "WORKSPACE_NOT_ALLOWED",
        operation,
        retryable: false,
        cause,
        message: "Workspace root is outside configured allowed roots.",
      }));
    }
  }

  private agentWorkspaceResult(
    record: LocalAgentRecord,
    scope: LocalAgentWorkspaceScope,
    operation: string,
  ): BetterResult<void, AgentScopeError> {
    const workspaceRoot = this.authorizeWorkspace(scope.workspaceRoot, scope.workspaceId, operation);
    if (workspaceRoot.isErr()) return workspaceRoot;
    const idMismatch = scope.workspaceId !== undefined && record.workspaceId !== scope.workspaceId;
    if (workspaceRoot.value !== record.workspaceRoot || idMismatch) {
      return Result.err(new AgentScopeError({
        code: "WORKSPACE_MISMATCH",
        agentId: record.id,
        workspaceId: scope.workspaceId,
        operation,
        retryable: false,
        message: `Subagent ${record.id} belongs to a different workspace.`,
      }));
    }
    return Result.ok(undefined);
  }

  private async loadProfilesResult(
    workspaceRoot: string,
    target: string,
  ): Promise<BetterResult<LocalAgentProfile[], AgentTargetError>> {
    try {
      return Result.ok(await this.loadProfiles(workspaceRoot));
    } catch (cause) {
      if (isProgrammerDefect(cause)) throw cause;
      return Result.err(new AgentTargetError({
        code: "TARGET_RESOLUTION_FAILED",
        target,
        retryable: false,
        cause,
        message: "Unable to load subagent profiles.",
      }));
    }
  }

  private log(
    level: "info" | "warn" | "error",
    event: string,
    fields: Record<string, unknown>,
  ): void {
    this.logger?.(level, event, fields);
  }
}

export function createLocalAgentManager(options: LocalAgentManagerOptions): LocalAgentManager {
  return new LocalAgentManager(options);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeCauseType(cause: unknown): string | undefined {
  if (cause instanceof Error) return cause.name;
  if (cause && typeof cause === "object" && "error" in cause) {
    const nested = (cause as { error?: unknown }).error;
    if (nested instanceof Error) return nested.name;
  }
  return cause === undefined ? undefined : typeof cause;
}

function agentNotFound(agentId: string): AgentTargetError {
  return new AgentTargetError({
    code: "AGENT_NOT_FOUND",
    target: agentId,
    retryable: false,
    message: `Unknown subagent id: ${agentId}.`,
  });
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

async function waitForTurns(
  turns: readonly Promise<void>[],
  timeoutMs: number | undefined,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const timeout = timeoutMs === undefined
    ? undefined
    : new Promise<"timeout">((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout("timeout"), timeoutMs);
      });
  const aborted = signal
    ? new Promise<"aborted">((resolveAbort) => {
        onAbort = () => resolveAbort("aborted");
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      })
    : undefined;
  try {
    const result = await Promise.race([
      Promise.allSettled(turns).then(() => "completed" as const),
      ...(timeout ? [timeout] : []),
      ...(aborted ? [aborted] : []),
    ]);
    return result === "timeout";
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function waitResultFromTurn(turn: LocalAgentTurnRecord, timedOut: boolean): LocalAgentWaitResult {
  switch (turn.status) {
    case "running":
      return { id: turn.agentId, status: "running", ...(timedOut ? { wait: "timeout" } : {}) };
    case "completed":
      return {
        id: turn.agentId,
        status: "completed",
        ...(turn.response === undefined ? {} : { response: turn.response }),
      };
    case "failed":
      return { id: turn.agentId, status: "failed", error: turnFailure(turn) };
    case "stopped":
      return {
        id: turn.agentId,
        status: "stopped",
        ...(hasTurnFailure(turn) ? { error: turnFailure(turn) } : {}),
      };
  }
}

function waitResultFromAgent(agent: LocalAgentRecord, timedOut: boolean): LocalAgentWaitResult {
  switch (agent.status) {
    case "starting":
    case "queued":
    case "running":
      return { id: agent.id, status: "running", ...(timedOut ? { wait: "timeout" } : {}) };
    case "idle":
      return {
        id: agent.id,
        status: "completed",
        ...(agent.latestResponse === undefined ? {} : { response: agent.latestResponse }),
      };
    case "error":
      return {
        id: agent.id,
        status: "failed",
        error: {
          code: agent.errorCode ?? "AGENT_FAILED",
          message: agent.error ?? "Subagent failed without an error message.",
          retryable: agent.errorRetryable ?? false,
        },
      };
    case "stopped":
      return {
        id: agent.id,
        status: "stopped",
        ...(agent.error || agent.errorCode || agent.errorRetryable !== undefined
          ? { error: {
              code: agent.errorCode ?? "AGENT_STOPPED",
              message: agent.error ?? "Subagent stopped.",
              retryable: agent.errorRetryable ?? false,
            } }
          : {}),
      };
  }
}

function hasTurnFailure(turn: LocalAgentTurnRecord): boolean {
  return turn.error !== undefined || turn.errorCode !== undefined || turn.errorRetryable !== undefined;
}

function turnFailure(turn: LocalAgentTurnRecord): { code: string; message: string; retryable: boolean } {
  return {
    code: turn.errorCode ?? "AGENT_FAILED",
    message: turn.error ?? "Subagent failed without an error message.",
    retryable: turn.errorRetryable ?? false,
  };
}
