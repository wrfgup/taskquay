import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const workspaceSessions = sqliteTable(
  "workspace_sessions",
  {
    id: text("id").primaryKey(),
    root: text("root").notNull(),
    status: text("status").notNull().default("active"),
    mode: text("mode").notNull().default("checkout"),
    sourceRoot: text("source_root"),
    baseRef: text("base_ref"),
    baseSha: text("base_sha"),
    managed: text("managed").notNull().default("false"),
    recoveryKind: text("recovery_kind"),
    createdAt: text("created_at").notNull(),
    lastUsedAt: text("last_used_at").notNull(),
  },
  (table) => [
    index("workspace_sessions_root_idx").on(table.root, table.lastUsedAt),
    index("workspace_sessions_status_idx").on(table.status, table.lastUsedAt),
  ],
);

export const loadedAgentFiles = sqliteTable(
  "loaded_agent_files",
  {
    workspaceSessionId: text("workspace_session_id")
      .notNull()
      .references(() => workspaceSessions.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    contentHash: text("content_hash").notNull(),
    content: text("content").notNull(),
    loadedAt: text("loaded_at").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceSessionId, table.path] }),
    index("loaded_agent_files_path_idx").on(table.path),
  ],
);

export const workspaceConversationBindings = sqliteTable(
  "workspace_conversation_bindings",
  {
    conversationScopeId: text("conversation_scope_id").notNull(),
    targetKey: text("target_key").notNull(),
    workspaceSessionId: text("workspace_session_id")
      .notNull()
      .references(() => workspaceSessions.id, { onDelete: "cascade" }),
    createdAt: text("created_at").notNull(),
    lastUsedAt: text("last_used_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.conversationScopeId, table.targetKey] }),
    index("workspace_conversation_bindings_workspace_idx").on(table.workspaceSessionId),
  ],
);

export const oauthClients = sqliteTable(
  "oauth_clients",
  {
    clientId: text("client_id").primaryKey(),
    clientJson: text("client_json").notNull(),
    issuedAt: integer("issued_at").notNull(),
  },
);

export const oauthAccessTokens = sqliteTable(
  "oauth_access_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    scopesJson: text("scopes_json").notNull(),
    expiresAt: integer("expires_at").notNull(),
    resource: text("resource"),
  },
);

export const oauthRefreshTokens = sqliteTable(
  "oauth_refresh_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    scopesJson: text("scopes_json").notNull(),
    expiresAt: integer("expires_at").notNull(),
    resource: text("resource"),
  },
);

export const localAgentSessions = sqliteTable(
  "local_agent_sessions",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id"),
    workspaceRoot: text("workspace_root").notNull(),
    profileName: text("profile_name").notNull(),
    provider: text("provider").notNull(),
    model: text("model"),
    effort: text("effort"),
    providerSessionId: text("provider_session_id"),
    contextKey: text("context_key"),
    contextSignature: text("context_signature"),
    workItemId: text("work_item_id"),
    recoveryType: text("recovery_type"),
    parentProviderSessionId: text("parent_provider_session_id"),
    controlState: text("control_state").notNull().default("terminal"),
    providerTurnId: text("provider_turn_id"),
    controlRevision: integer("control_revision").notNull().default(0),
    status: text("status").notNull(),
    latestResponse: text("latest_response"),
    error: text("error"),
    errorCode: text("error_code"),
    errorRetryable: text("error_retryable"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("local_agent_sessions_workspace_id_idx").on(table.workspaceId, table.updatedAt),
    index("local_agent_sessions_workspace_root_idx").on(table.workspaceRoot, table.updatedAt),
    index("local_agent_sessions_provider_session_id_idx").on(table.providerSessionId),
    index("agent_context_affinity").on(table.workspaceRoot, table.workspaceId, table.profileName, table.workItemId, table.contextKey, table.contextSignature),
  ],
);

export type WorkspaceSessionRow = typeof workspaceSessions.$inferSelect;
export type NewWorkspaceSessionRow = typeof workspaceSessions.$inferInsert;
export type LoadedAgentFileRow = typeof loadedAgentFiles.$inferSelect;
export type NewLoadedAgentFileRow = typeof loadedAgentFiles.$inferInsert;
export type WorkspaceConversationBindingRow = typeof workspaceConversationBindings.$inferSelect;
export type NewWorkspaceConversationBindingRow = typeof workspaceConversationBindings.$inferInsert;
export type LocalAgentSessionRow = typeof localAgentSessions.$inferSelect;
export type NewLocalAgentSessionRow = typeof localAgentSessions.$inferInsert;

export const executionClaims = sqliteTable("execution_claims", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  ownerPid: integer("owner_pid").notNull(),
  kind: text("kind").notNull(),
  checkoutRoot: text("checkout_root").notNull(),
  agentId: text("agent_id"),
  accessMode: text("access_mode").notNull().default("write"),
  threadKey: text("thread_key"),
  resources: text("resources").notNull(),
  acquiredAt: text("acquired_at").notNull(),
});

export const executionWaiters = sqliteTable("execution_waiters", {
  sequence: integer("sequence").primaryKey({ autoIncrement: true }),
  id: text("id").notNull().unique(), ownerId: text("owner_id").notNull(), ownerPid: integer("owner_pid").notNull(),
  kind: text("kind").notNull(), checkoutRoot: text("checkout_root").notNull(), agentId: text("agent_id"),
  threadKey: text("thread_key"), accessMode: text("access_mode").notNull(), resources: text("resources").notNull(),
  expiresAtMs: integer("expires_at_ms").notNull(),
}, (table) => [index("execution_waiters_order").on(table.sequence)]);

export const agentContinueKeys = sqliteTable("agent_continue_keys", {
  agentId: text("agent_id").notNull().references(() => localAgentSessions.id, { onDelete: "cascade" }),
  requestKey: text("request_key").notNull(), requestHash: text("request_hash").notNull(),
}, (table) => [primaryKey({ columns: [table.agentId, table.requestKey] })]);

export const agentTaskKeys = sqliteTable("agent_task_keys", {
  workspaceRoot: text("workspace_root").notNull(),
  workspaceScope: text("workspace_scope").notNull(),
  target: text("target").notNull(),
  taskKey: text("task_key").notNull(),
  requestHash: text("request_hash").notNull(),
  agentId: text("agent_id").notNull().references(() => localAgentSessions.id),
}, (table) => [primaryKey({ columns: [table.workspaceRoot, table.workspaceScope, table.target, table.taskKey] })]);

export const agentUsageSnapshots = sqliteTable("agent_usage_snapshots", {
  agentId: text("agent_id").notNull().references(() => localAgentSessions.id),
  threadId: text("thread_id").notNull(),
  turnId: text("turn_id").notNull(),
  totalTokens: integer("total_tokens").notNull(),
  totals: text("totals").notNull(),
  lastRequest: text("last_request"),
  baseline: text("baseline"),
  baselineKind: text("baseline_kind").notNull(),
  observedAt: text("observed_at").notNull(),
  providerVersion: text("provider_version"),
}, (table) => [primaryKey({ columns: [table.agentId, table.threadId, table.turnId] })]);

export const consoleProjects = sqliteTable("console_projects", {
  id: text("id").primaryKey(), root: text("root").notNull().unique(), name: text("name").notNull(), createdAt: text("created_at").notNull(),
});
export const consoleWorkItems = sqliteTable("console_work_items", {
  id: text("id").primaryKey(), projectId: text("project_id").notNull().references(() => consoleProjects.id),
  itemKey: text("item_key").notNull(), title: text("title").notNull(), createdAt: text("created_at").notNull(),
}, (table) => [uniqueIndex("console_item_identity").on(table.projectId, table.itemKey)]);
export const consoleWorkRuns = sqliteTable("console_work_runs", {
  id: text("id").primaryKey(), projectId: text("project_id").notNull().references(() => consoleProjects.id),
  itemId: text("item_id").notNull().references(() => consoleWorkItems.id), workspaceId: text("workspace_id"),
  runKey: text("run_key").notNull(), requestHash: text("request_hash").notNull(), origin: text("origin").notNull(),
  status: text("status").notNull().default("running"), acceptance: text("acceptance").notNull().default("pending"),
  summary: text("summary").notNull().default(""), evidence: text("evidence").notNull().default("[]"),
  revision: integer("revision").notNull().default(1), createdAt: text("created_at").notNull(), finishedAt: text("finished_at"),
}, (table) => [uniqueIndex("console_run_identity").on(table.itemId, table.runKey), index("console_runs_project").on(table.projectId, table.createdAt, table.id)]);
export const consoleOperations = sqliteTable("console_operations", {
  id: text("id").primaryKey(), runId: text("run_id").notNull().references(() => consoleWorkRuns.id), requestKey: text("request_key").notNull(),
  kind: text("kind").notNull(), label: text("label").notNull(), status: text("status").notNull(), evidence: text("evidence").notNull().default("[]"),
  createdAt: text("created_at").notNull(), finishedAt: text("finished_at"),
}, (table) => [uniqueIndex("console_operation_identity").on(table.runId, table.requestKey)]);
export const consoleThreads = sqliteTable("console_threads", {
  id: text("id").primaryKey(), projectId: text("project_id").notNull().references(() => consoleProjects.id),
  agentId: text("agent_id").notNull().references(() => localAgentSessions.id), instanceId: text("instance_id").notNull(), threadId: text("thread_id").notNull(),
  createdHere: integer("created_here").notNull(), identityVerified: integer("identity_verified").notNull(), origin: text("origin").notNull(),
  title: text("title").notNull(), nameStatus: text("name_status").notNull().default("pending"), externalActivity: integer("external_activity").notNull().default(0),
  protected: integer("protected").notNull().default(0), archiveState: text("archive_state").notNull().default("active"), revision: integer("revision").notNull().default(1),
  createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, (table) => [uniqueIndex("console_thread_identity").on(table.instanceId, table.threadId), index("console_threads_project").on(table.projectId, table.updatedAt)]);
export const consoleExecutions = sqliteTable("console_executions", {
  id: text("id").primaryKey(), runId: text("run_id").notNull().references(() => consoleWorkRuns.id), agentId: text("agent_id").notNull().references(() => localAgentSessions.id),
  provider: text("provider").notNull(), managedThreadId: text("managed_thread_id").references(() => consoleThreads.id), providerTurnId: text("provider_turn_id"),
  status: text("status").notNull(), requested: integer("requested").notNull().default(0), providerFinished: integer("provider_finished").notNull().default(0),
  baseline: text("baseline"), cumulative: text("cumulative"), delta: text("delta"), usageQuality: text("usage_quality").notNull().default("not_used"),
  boundaryReason: text("boundary_reason").notNull().default("no_provider_request"), requestedModel: text("requested_model"), requestedEffort: text("requested_effort"),
  createdAt: text("created_at").notNull(), finishedAt: text("finished_at"),
}, (table) => [index("console_exec_run").on(table.runId, table.createdAt), index("console_exec_agent").on(table.agentId, table.createdAt),
  uniqueIndex("console_exec_provider_turn").on(table.managedThreadId, table.providerTurnId).where(sql`${table.providerTurnId} is not null`)]);
export const consoleArchiveBatches = sqliteTable("console_archive_batches", {
  id: text("id").primaryKey(), projectId: text("project_id").notNull().references(() => consoleProjects.id), mode: text("mode").notNull(),
  status: text("status").notNull(), requestHash: text("request_hash").notNull(), acceptPartial: integer("accept_partial").notNull(), externalIdle: integer("external_idle").notNull(),
  createdAt: text("created_at").notNull(), expiresAt: text("expires_at").notNull(), updatedAt: text("updated_at").notNull(),
});
export const consoleArchiveEntries = sqliteTable("console_archive_entries", {
  batchId: text("batch_id").notNull().references(() => consoleArchiveBatches.id), managedThreadId: text("managed_thread_id").notNull().references(() => consoleThreads.id),
  expectedRevision: integer("expected_revision").notNull(), expectedSnapshot: text("expected_snapshot"), status: text("status").notNull(), reason: text("reason"), updatedAt: text("updated_at").notNull(),
}, (table) => [primaryKey({ columns: [table.batchId, table.managedThreadId] })]);
