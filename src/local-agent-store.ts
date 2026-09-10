import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Result, type Result as BetterResult } from "better-result";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import { AgentConflictError, AgentStoreError, isProgrammerDefect } from "./local-agent-errors.js";
import { recordAgentUsage, readAgentUsage, type AgentUsageObservation } from "./agent-usage.js";
import { decodeAgentProgress, type AgentActivity, type AgentProgress } from "./agent-progress.js";

export type LocalAgentStatus = "starting" | "queued" | "running" | "idle" | "error" | "stopped";
export type LocalAgentTurnStatus = "running" | "completed" | "failed" | "stopped";

export interface LocalAgentRecord {
  progress?: AgentProgress;
  id: string;
  workspaceId?: string;
  workspaceRoot: string;
  profileName: string;
  provider: string;
  model?: string;
  effort?: string;
  providerSessionId?: string;
  status: LocalAgentStatus;
  latestResponse?: string;
  error?: string;
  errorCode?: string;
  errorRetryable?: boolean;
  createdAt: string;
  updatedAt: string;
  contextKey?: string;
  contextSignature?: string;
  workItemId?: string;
  recoveryType?: "fresh_thread_handoff";
  parentProviderSessionId?: string;
}

export interface CreateLocalAgentRecordInput {
  workspaceId?: string;
  workspaceRoot: string;
  profileName: string;
  provider: string;
  model?: string;
  effort?: string;
  contextKey?: string;
  contextSignature?: string;
  workItemId?: string;
}

export interface LocalAgentTurnRecord {
  id: number;
  agentId: string;
  prompt: string;
  status: LocalAgentTurnStatus;
  response?: string;
  error?: string;
  errorCode?: string;
  errorRetryable?: boolean;
  createdAt: string;
  completedAt?: string;
}

export interface BeginLocalAgentTurnInput {
  prompt: string;
  model?: string;
  effort?: string;
}

export type FinishLocalAgentTurnInput =
  | { status: "completed"; response?: string; providerSessionId?: string; contextSignature?: string }
  | { status: "failed"; error: string; errorCode: string; errorRetryable: boolean }
  | { status: "stopped"; error?: string; errorCode?: string; errorRetryable?: boolean };

export interface BegunLocalAgentTurn {
  agent: LocalAgentRecord;
  turn: LocalAgentTurnRecord;
}

export interface LocalAgentWorkspaceScope {
  workspaceId?: string;
  workspaceRoot: string;
}

export interface LocalAgentListScope {
  workspaceId?: string;
  workspaceRoot?: string;
}

interface LocalAgentRow {
  progress: string | null;
  id: string;
  workspace_id: string | null;
  workspace_root: string;
  profile_name: string;
  provider: string;
  model: string | null;
  effort: string | null;
  provider_session_id: string | null;
  status: string;
  latest_response: string | null;
  error: string | null;
  error_code: string | null;
  error_retryable: string | null;
  created_at: string;
  updated_at: string;
  context_key: string | null;
  context_signature: string | null;
  work_item_id: string | null;
  recovery_type: string | null;
  parent_provider_session_id: string | null;
}

interface LocalAgentTurnRow {
  id: number;
  agent_id: string;
  prompt: string;
  status: string;
  response: string | null;
  error: string | null;
  error_code: string | null;
  error_retryable: string | null;
  created_at: string;
  completed_at: string | null;
}

export class LocalAgentStore {
  private readonly database: DatabaseHandle;

  constructor(readonly stateDir: string) {
    this.database = openDatabase(stateDir);
  }

  recordUsageResult(agentId: string, usage: AgentUsageObservation): BetterResult<void, AgentStoreError> {
    return storeResult("usage", () => recordAgentUsage(this.database.sqlite, agentId, usage));
  }

  usage(agentId: string) { return readAgentUsage(this.database.sqlite, agentId); }

  recordActivityResult(agentId: string, activity: AgentActivity): BetterResult<void, AgentStoreError> {
    return storeResult("activity", () => {
      const record = this.getById(agentId);
      if (!record || record.status !== "running" || !record.progress) return;
      const now = new Date().toISOString();
      const next = decodeAgentProgress({ ...record.progress, phase: activity.phase,
        toolCategory: activity.phase === "tool" ? activity.toolCategory : undefined, lastActivityAt: now });
      if (!next) return;
      // Coalesce identical activity to at most one persisted heartbeat per second.
      if (next.phase === record.progress.phase && next.toolCategory === record.progress.toolCategory &&
        Date.parse(now) - Date.parse(record.progress.lastActivityAt) < 1000) return;
      this.database.sqlite.prepare("update local_agent_sessions set progress=? where id=?").run(JSON.stringify(next), agentId);
    });
  }

  list(scope: LocalAgentListScope = {}): LocalAgentRecord[] {
    let rows: LocalAgentRow[];
    if (scope.workspaceId && scope.workspaceRoot) {
      rows = this.database.sqlite
        .prepare(
          `select * from local_agent_sessions
           where workspace_id = ? and workspace_root = ?
           order by updated_at desc`,
        )
        .all(scope.workspaceId, resolve(scope.workspaceRoot)) as LocalAgentRow[];
    } else if (scope.workspaceId) {
      rows = this.database.sqlite
        .prepare(
          `select * from local_agent_sessions
           where workspace_id = ?
           order by updated_at desc`,
        )
        .all(scope.workspaceId) as LocalAgentRow[];
    } else if (scope.workspaceRoot) {
      rows = this.database.sqlite
        .prepare(
          `select * from local_agent_sessions
           where workspace_root = ?
           order by updated_at desc`,
        )
        .all(resolve(scope.workspaceRoot)) as LocalAgentRow[];
    } else {
      rows = this.database.sqlite
        .prepare("select * from local_agent_sessions order by updated_at desc")
        .all() as LocalAgentRow[];
    }

    return rows.map(rowToLocalAgentRecord);
  }

  listResult(scope: LocalAgentListScope = {}): BetterResult<LocalAgentRecord[], AgentStoreError> {
    return storeResult("list", () => this.list(scope));
  }

  create(input: CreateLocalAgentRecordInput): LocalAgentRecord {
    const now = new Date().toISOString();
    const record: LocalAgentRecord = {
      id: `agt_${randomUUID().replaceAll("-", "").slice(0, 8)}`,
      workspaceId: input.workspaceId,
      workspaceRoot: resolve(input.workspaceRoot),
      profileName: input.profileName,
      provider: input.provider,
      model: input.model,
      effort: input.effort,
      status: "starting",
      createdAt: now,
      updatedAt: now,
    };

    this.database.sqlite
      .prepare(
        `insert into local_agent_sessions (
          id,
          workspace_id,
          workspace_root,
          profile_name,
          provider,
          model,
          effort,
          status,
          created_at,
          updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.workspaceId ?? null,
        record.workspaceRoot,
        record.profileName,
        record.provider,
        record.model ?? null,
        record.effort ?? null,
        record.status,
        record.createdAt,
        record.updatedAt,
      );

    return record;
  }

  createResult(input: CreateLocalAgentRecordInput): BetterResult<LocalAgentRecord, AgentStoreError> {
    return storeResult("create", () => this.create(input));
  }

  createTaskResult(input: CreateLocalAgentRecordInput, task?: { key: string; hash: string; canonicalRoot: string },
    reuseContext = true, maximumNewSessions = 3):
    BetterResult<{ record: LocalAgentRecord; reused: boolean; resumedContext?: boolean }, AgentStoreError | AgentConflictError> {
    try {
      return Result.ok(this.database.sqlite.transaction(() => {
        if (task) {
          const existing = this.database.sqlite.prepare(`select agent_id, request_hash from agent_task_keys
            where workspace_root = ? and workspace_scope = ? and target = ? and task_key = ?`)
            .get(task.canonicalRoot, input.workspaceId ?? "", input.profileName, task.key) as { agent_id: string; request_hash: string } | undefined;
          if (existing) {
            if (existing.request_hash !== task.hash) throw new AgentConflictError({ code: "AGENT_CONFLICT", agentId: existing.agent_id,
              operation: "task_identity", retryable: false,
              message: `Task key already belongs to ${existing.agent_id}. Use continue for related follow-up work; do not overwrite or replay the original request.` });
            const record = this.getById(existing.agent_id);
            if (!record) throw new Error("Task identity references a missing agent.");
            return { record, reused: true };
          }
        }
        let record: LocalAgentRecord | undefined;
        let resumedContext = false;
        if (reuseContext && input.contextKey && input.workItemId && input.contextSignature) {
          const found = this.database.sqlite.prepare(`select * from local_agent_sessions where workspace_root = ?
            and coalesce(workspace_id, '') = ? and profile_name = ? and work_item_id = ? and context_key = ?
            and context_signature = ? and status in ('starting', 'queued', 'running', 'idle', 'error', 'stopped')
            and not (status = 'error' and coalesce(error, '') like '%PAGINATED_HISTORY_UNSUPPORTED%')
            order by updated_at desc limit 1`)
            .get(resolve(input.workspaceRoot), input.workspaceId ?? "", input.profileName, input.workItemId,
              input.contextKey, input.contextSignature) as LocalAgentRow | undefined;
          if (found) {
            if (!["idle", "error", "stopped"].includes(found.status)) throw new AgentConflictError({ code: "AGENT_CONFLICT", agentId: found.id,
              operation: "context_affinity", retryable: true,
              message: "The related session is occupied. Observe it, then continue; do not create another copy of its context." });
            if (found.provider_session_id) {
              // An explicit new task may resume a terminal context even after a
              // provider failure. Keep its identity; never silently fork around
              // quota, history, or reconciliation checks in the normal run path.
              record = this.update(found.id, { status: "starting" });
              resumedContext = true;
            }
          }
        }
        if (!record) {
          if (input.workItemId) {
            const used = (this.database.sqlite.prepare(`select count(*) as n from local_agent_sessions where workspace_root = ?
              and coalesce(workspace_id, '') = ? and work_item_id = ? and (status != 'stopped' or provider_session_id is not null)`)
              .get(resolve(input.workspaceRoot), input.workspaceId ?? "", input.workItemId) as { n: number }).n;
            if (used >= maximumNewSessions) throw new AgentConflictError({ code: "AGENT_CONFLICT", operation: "session_budget", retryable: false,
              message: "New-session budget reached for this work item. Reuse a related session or explicitly adjust the configured budget." });
          }
          record = this.create(input);
          this.database.sqlite.prepare(`update local_agent_sessions set context_key = ?, context_signature = ?, work_item_id = ? where id = ?`)
            .run(input.contextKey ?? null, input.contextSignature ?? null, input.workItemId ?? null, record.id);
          record = this.getById(record.id)!;
        }
        if (task) this.database.sqlite.prepare(`insert into agent_task_keys
          (workspace_root, workspace_scope, target, task_key, request_hash, agent_id) values (?, ?, ?, ?, ?, ?)`)
          .run(task.canonicalRoot, input.workspaceId ?? "", input.profileName, task.key, task.hash, record.id);
        return { record, reused: false, resumedContext };
      }).immediate());
    } catch (error) {
      return Result.err(AgentConflictError.is(error) ? error : new AgentStoreError("task_identity", error));
    }
  }

  reserveContinueResult(agentId: string, key: string, hash: string): BetterResult<boolean, AgentConflictError | AgentStoreError> {
    try {
      return Result.ok(this.database.sqlite.transaction(() => {
        const old = this.database.sqlite.prepare("select request_hash from agent_continue_keys where agent_id = ? and request_key = ?")
          .get(agentId, key) as { request_hash: string } | undefined;
        if (old) {
          if (old.request_hash !== hash) throw new AgentConflictError({ code: "AGENT_CONFLICT", agentId, operation: "continue_identity",
            retryable: false, message: "Continuation key already belongs to a different request." });
          return true;
        }
        const record = this.getById(agentId);
        if (!record || ["starting", "queued", "running"].includes(record.status)) throw new AgentConflictError({ code: "AGENT_CONFLICT", agentId,
          operation: "continue", retryable: true, message: "This session already has pending work. Observe it before continuing." });
        this.database.sqlite.prepare("insert into agent_continue_keys(agent_id, request_key, request_hash) values (?, ?, ?)").run(agentId, key, hash);
        this.update(agentId, { status: "starting" });
        return false;
      }).immediate());
    } catch (error) { return Result.err(AgentConflictError.is(error) ? error : new AgentStoreError("continue_identity", error)); }
  }

  getById(id: string): LocalAgentRecord | undefined {
    const exact = this.database.sqlite
      .prepare(
        `select * from local_agent_sessions
         where id = ?
         limit 1`,
      )
      .get(id) as LocalAgentRow | undefined;
    return exact ? rowToLocalAgentRecord(exact) : undefined;
  }

  getByIdResult(id: string): BetterResult<LocalAgentRecord | undefined, AgentStoreError> {
    return storeResult("get", () => this.getById(id));
  }

  /**
   * Compatibility alias for callers that already use the store directly.
   * Identity lookup is exact and never falls back to provider session IDs.
   */
  get(id: string): LocalAgentRecord | undefined {
    return this.getById(id);
  }

  update(id: string, patch: Partial<Omit<LocalAgentRecord, "id" | "createdAt">>): LocalAgentRecord {
    const current = this.getById(id);
    if (!current) throw new Error(`Unknown subagent id: ${id}`);

    const updated: LocalAgentRecord = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    if (patch.status && (patch.status !== current.status || patch.status === "starting" || !current.progress)) {
      const reset = patch.status === "starting" || !current.progress || ["idle", "error", "stopped"].includes(current.status);
      const startedAt = reset ? updated.updatedAt : current.progress!.startedAt;
      updated.progress = { startedAt, lastActivityAt: updated.updatedAt,
        admittedAt: patch.status === "running" ? (reset ? updated.updatedAt : current.progress?.admittedAt ?? updated.updatedAt)
          : reset ? undefined : current.progress?.admittedAt,
        phase: patch.status === "queued" ? "queued" : patch.status === "starting" ? "preparing"
          : patch.status === "running" ? "provider" : "finished" };
    }

    this.database.sqlite
      .prepare(
        `update local_agent_sessions set
          workspace_id = ?,
          workspace_root = ?,
          profile_name = ?,
          provider = ?,
          model = ?,
          effort = ?,
          provider_session_id = ?,
          status = ?,
          latest_response = ?,
          error = ?,
          error_code = ?,
          error_retryable = ?,
          context_key = ?,
          context_signature = ?,
          work_item_id = ?,
          recovery_type = ?,
          parent_provider_session_id = ?,
          updated_at = ?,
          progress = ?
         where id = ?`,
      )
      .run(
        updated.workspaceId ?? null,
        resolve(updated.workspaceRoot),
        updated.profileName,
        updated.provider,
        updated.model ?? null,
        updated.effort ?? null,
        updated.providerSessionId ?? null,
        updated.status,
        updated.latestResponse ?? null,
        updated.error ?? null,
        updated.errorCode ?? null,
        updated.errorRetryable === undefined ? null : String(updated.errorRetryable),
        updated.contextKey ?? null,
        updated.contextSignature ?? null,
        updated.workItemId ?? null,
        updated.recoveryType ?? null,
        updated.parentProviderSessionId ?? null,
        updated.updatedAt,
        updated.progress ? JSON.stringify(decodeAgentProgress(updated.progress)) : null,
        updated.id,
      );

    return updated;
  }

  updateResult(
    id: string,
    patch: Partial<Omit<LocalAgentRecord, "id" | "createdAt">>,
  ): BetterResult<LocalAgentRecord, AgentStoreError> {
    return storeResult("update", () => this.update(id, patch));
  }

  beginTurn(agentId: string, input: BeginLocalAgentTurnInput): BegunLocalAgentTurn {
    return this.database.sqlite.transaction(() => {
      const current = this.getById(agentId);
      if (!current) throw new Error(`Unknown subagent id: ${agentId}`);
      if (current.status === "running") {
        throw new Error(`Subagent ${agentId} already has a running turn.`);
      }
      const agent = this.update(agentId, {
        status: "running",
        model: input.model,
        effort: input.effort,
        error: undefined,
        errorCode: undefined,
        errorRetryable: undefined,
      });
      const result = this.database.sqlite
        .prepare(
          `insert into local_agent_turns (
            agent_id,
            prompt,
            status,
            created_at
          ) values (?, ?, 'running', ?)`,
        )
        .run(agentId, input.prompt, agent.updatedAt);
      const turn = this.getTurnById(Number(result.lastInsertRowid));
      if (!turn) throw new Error(`Unable to load the new turn for subagent ${agentId}.`);
      return { agent, turn };
    }).immediate();
  }

  beginTurnResult(
    agentId: string,
    input: BeginLocalAgentTurnInput,
  ): BetterResult<BegunLocalAgentTurn, AgentStoreError> {
    return storeResult("begin_turn", () => this.beginTurn(agentId, input));
  }

  finishTurn(
    agentId: string,
    turnId: number,
    completion: FinishLocalAgentTurnInput,
  ): LocalAgentRecord {
    return this.database.sqlite.transaction(() => {
      const turn = this.getTurnById(turnId);
      if (!turn || turn.agentId !== agentId) {
        throw new Error(`Unknown turn ${turnId} for subagent ${agentId}.`);
      }
      if (turn.status !== "running") {
        throw new Error(`Turn ${turnId} for subagent ${agentId} is already ${turn.status}.`);
      }
      const currentAgent = this.getById(agentId);
      if (!currentAgent) throw new Error(`Unknown subagent id: ${agentId}`);

      const completedAt = new Date().toISOString();
      this.database.sqlite
        .prepare(
          `update local_agent_turns set
            status = ?,
            response = ?,
            error = ?,
            error_code = ?,
            error_retryable = ?,
            completed_at = ?
           where id = ? and agent_id = ?`,
        )
        .run(
          completion.status,
          completion.status === "completed" ? completion.response ?? null : null,
          completion.status === "completed" ? null : completion.error ?? null,
          completion.status === "completed" ? null : completion.errorCode ?? null,
          completion.status === "completed" || completion.errorRetryable === undefined
            ? null
            : String(completion.errorRetryable),
          completedAt,
          turnId,
          agentId,
        );

       if (completion.status === "completed") {
         return this.update(agentId, {
           providerSessionId: completion.providerSessionId ?? currentAgent.providerSessionId,
           contextSignature: completion.contextSignature ?? currentAgent.contextSignature,
          status: "idle",
          latestResponse: completion.response,
          error: undefined,
          errorCode: undefined,
          errorRetryable: undefined,
        });
      }
    return this.update(agentId, {
      status: completion.status === "failed" ? "error" : "stopped",
      error: completion.error,
        errorCode: completion.errorCode,
        errorRetryable: completion.errorRetryable,
      });
    }).immediate();
  }

  finishTurnResult(
    agentId: string,
    turnId: number,
    completion: FinishLocalAgentTurnInput,
  ): BetterResult<LocalAgentRecord, AgentStoreError> {
    return storeResult("finish_turn", () => this.finishTurn(agentId, turnId, completion));
  }

  getTurnById(turnId: number): LocalAgentTurnRecord | undefined {
    const row = this.database.sqlite
      .prepare("select * from local_agent_turns where id = ? limit 1")
      .get(turnId) as LocalAgentTurnRow | undefined;
    return row ? rowToLocalAgentTurnRecord(row) : undefined;
  }

  getTurnByIdResult(
    turnId: number,
  ): BetterResult<LocalAgentTurnRecord | undefined, AgentStoreError> {
    return storeResult("get_turn", () => this.getTurnById(turnId));
  }

  getLatestTurn(agentId: string): LocalAgentTurnRecord | undefined {
    const row = this.database.sqlite
      .prepare("select * from local_agent_turns where agent_id = ? order by id desc limit 1")
      .get(agentId) as LocalAgentTurnRow | undefined;
    return row ? rowToLocalAgentTurnRecord(row) : undefined;
  }

  getLatestTurnResult(
    agentId: string,
  ): BetterResult<LocalAgentTurnRecord | undefined, AgentStoreError> {
    return storeResult("get_latest_turn", () => this.getLatestTurn(agentId));
  }

  listTurns(agentId: string): LocalAgentTurnRecord[] {
    const rows = this.database.sqlite
      .prepare("select * from local_agent_turns where agent_id = ? order by id asc")
      .all(agentId) as LocalAgentTurnRow[];
    return rows.map(rowToLocalAgentTurnRecord);
  }

  reconcileActiveRuns(message = "DevSpace restarted while this agent turn was running."): number {
    return this.database.sqlite.transaction(() => {
      const now = new Date().toISOString();
      this.database.sqlite
        .prepare(
          `update local_agent_turns
           set status = 'failed', error = ?, error_code = 'DAEMON_UNAVAILABLE',
               error_retryable = 'true', completed_at = ?
           where status = 'running'`,
        )
        .run(message, now);
      const result = this.database.sqlite
        .prepare(
          `update local_agent_sessions
           set status = 'error', error = ?, error_code = 'DAEMON_UNAVAILABLE', error_retryable = 'true', updated_at = ?
            where status in ('starting', 'queued', 'running')`,
        )
        .run(message, now);
      return Number(result.changes);
    }).immediate();
  }

  reconcileActiveRunsResult(
    message = "DevSpace restarted while this agent turn was running.",
  ): BetterResult<number, AgentStoreError> {
    return storeResult("reconcile_active_runs", () => this.reconcileActiveRuns(message));
  }

  close(): void {
    this.database.close();
  }

}

export function createLocalAgentStore(stateDir: string): LocalAgentStore {
  return new LocalAgentStore(stateDir);
}

function rowToLocalAgentRecord(row: LocalAgentRow): LocalAgentRecord {
  return {
    progress: row.progress ? decodeAgentProgress(JSON.parse(row.progress)) : undefined,
    id: row.id,
    workspaceId: row.workspace_id ?? undefined,
    workspaceRoot: row.workspace_root,
    profileName: row.profile_name,
    provider: row.provider,
    model: row.model ?? undefined,
    effort: row.effort ?? undefined,
    providerSessionId: row.provider_session_id ?? undefined,
    status: readStatus(row.status),
    latestResponse: row.latest_response ?? undefined,
    error: row.error ?? undefined,
    errorCode: row.error_code ?? undefined,
    errorRetryable: readOptionalBoolean(row.error_retryable),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    contextKey: row.context_key ?? undefined,
    contextSignature: row.context_signature ?? undefined,
    workItemId: row.work_item_id ?? undefined,
    recoveryType: row.recovery_type === "fresh_thread_handoff" ? row.recovery_type : undefined,
    parentProviderSessionId: row.parent_provider_session_id ?? undefined,
  };
}

function rowToLocalAgentTurnRecord(row: LocalAgentTurnRow): LocalAgentTurnRecord {
  return {
    id: row.id,
    agentId: row.agent_id,
    prompt: row.prompt,
    status: readTurnStatus(row.status),
    response: row.response ?? undefined,
    error: row.error ?? undefined,
    errorCode: row.error_code ?? undefined,
    errorRetryable: readOptionalBoolean(row.error_retryable),
    createdAt: row.created_at,
    completedAt: row.completed_at ?? undefined,
  };
}

function readTurnStatus(status: string): LocalAgentTurnStatus {
  if (status === "running" || status === "completed" || status === "failed" || status === "stopped") {
    return status;
  }
  throw new Error(`Invalid stored local agent turn status: ${status}`);
}

function readOptionalBoolean(value: string | null): boolean | undefined {
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

function storeResult<T>(operation: string, run: () => T): BetterResult<T, AgentStoreError> {
  try {
    return Result.ok(run());
  } catch (cause) {
    if (isProgrammerDefect(cause)) throw cause;
    return Result.err(new AgentStoreError(operation, cause));
  }
}

function readStatus(status: string): LocalAgentStatus {
  if (
    status === "starting" ||
    status === "queued" ||
    status === "running" ||
    status === "idle" ||
    status === "error" ||
    status === "stopped"
  ) {
    return status;
  }
  return "error";
}
