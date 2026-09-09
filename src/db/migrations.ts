import type Database from "better-sqlite3";
import { migrateProjectConsole } from "../project-console-schema.js";

interface Migration {
  version: number;
  name: string;
  up(sqlite: Database.Database): void;
}

const migrations: Migration[] = [
  // New versions are appended below; existing migrations remain immutable.
  {
    version: 1,
    name: "workspace-state",
    up: migrateWorkspaceState,
  },
  {
    version: 2,
    name: "oauth-state",
    up: migrateOAuthState,
  },
  {
    version: 3,
    name: "local-agent-sessions",
    up: migrateLocalAgentSessions,
  },
  {
    version: 4,
    name: "workspace-conversation-bindings",
    up: migrateWorkspaceConversationBindings,
  },
  {
    version: 5,
    name: "local-agent-structured-errors",
    up: migrateLocalAgentStructuredErrors,
  },
  {
    version: 6,
    name: "local-agent-effort-rename",
    up: migrateLocalAgentEffortRename,
  },
  {
    version: 7,
    name: "execution-coordination",
    up(sqlite) {
      sqlite.exec(`create table if not exists execution_claims (
        id text primary key,
        owner_id text not null,
        owner_pid integer not null,
        kind text not null,
        checkout_root text not null,
        agent_id text,
        resources text not null,
        acquired_at text not null
      );`);
    },
  },
  {
    version: 8,
    name: "idempotent-agent-task-identity",
    up(sqlite) {
      sqlite.exec(`create table if not exists agent_task_keys (
        workspace_root text not null, workspace_scope text not null,
        target text not null, task_key text not null, request_hash text not null,
        agent_id text not null references local_agent_sessions(id),
        primary key (workspace_root, workspace_scope, target, task_key)
      );`);
    },
  },
  {
    version: 9,
    name: "provider-usage-snapshots",
    up(sqlite) {
      sqlite.exec(`create table if not exists agent_usage_snapshots (
        agent_id text not null references local_agent_sessions(id),
        thread_id text not null, turn_id text not null,
        total_tokens integer not null, totals text not null, last_request text,
        baseline text, baseline_kind text not null, observed_at text not null,
        provider_version text,
        primary key (agent_id, thread_id, turn_id)
      );`);
    },
  },
];

migrations.push({
  version: 10,
  name: "bounded-read-admission-and-context-affinity",
  up(sqlite) {
    // A legacy claim has unknown effects and remains exclusive after upgrade.
    addColumnIfMissing(sqlite, "execution_claims", "access_mode", "text not null default 'write'");
    addColumnIfMissing(sqlite, "execution_claims", "thread_key", "text");
    addColumnIfMissing(sqlite, "local_agent_sessions", "context_key", "text");
    addColumnIfMissing(sqlite, "local_agent_sessions", "context_signature", "text");
    addColumnIfMissing(sqlite, "local_agent_sessions", "work_item_id", "text");
    sqlite.exec(`
      create table execution_waiters (
        sequence integer primary key autoincrement,
        id text not null unique,
        owner_id text not null,
        owner_pid integer not null,
        kind text not null,
        checkout_root text not null,
        agent_id text,
        thread_key text,
        access_mode text not null,
        resources text not null,
        expires_at_ms integer not null
      );
      create index execution_waiters_order on execution_waiters(sequence);
      create table agent_continue_keys (
        agent_id text not null references local_agent_sessions(id) on delete cascade,
        request_key text not null,
        request_hash text not null,
        primary key(agent_id, request_key)
      );
      create index agent_context_affinity on local_agent_sessions
        (workspace_root, workspace_id, profile_name, work_item_id, context_key, context_signature);
    `);
  },
});

export function migrateDatabase(sqlite: Database.Database): void {
  const migrate = sqlite.transaction(() => {
    sqlite.exec(`
      create table if not exists devspace_schema_migrations (
        version integer primary key,
        name text not null,
        applied_at text not null
      );
    `);

    const appliedRows = sqlite
      .prepare("select version, name from devspace_schema_migrations order by version")
      .all() as Array<{ version: number; name: string }>;
    const migrationsByVersion = new Map(migrations.map((migration) => [migration.version, migration]));
    for (const row of appliedRows) {
      const expected = migrationsByVersion.get(row.version);
      if (!expected) {
        throw new Error(
          `Database migration history is incompatible: version ${row.version} (${JSON.stringify(row.name)}) is unknown to this build.`,
        );
      }
      if (row.name !== expected.name) {
        throw new Error(
          `Database migration history is incompatible: version ${row.version} is recorded as ${JSON.stringify(row.name)}, but this build expects ${JSON.stringify(expected.name)}.`,
        );
      }
    }
    const applied = new Set(appliedRows.map((row) => row.version));
    const recordMigration = sqlite.prepare(
      "insert into devspace_schema_migrations (version, name, applied_at) values (?, ?, ?)",
    );

    for (const migration of migrations) {
      if (applied.has(migration.version)) continue;
      migration.up(sqlite);
      recordMigration.run(migration.version, migration.name, new Date().toISOString());
    }
  });

  migrate.immediate();
}

migrations.push({ version: 11, name: "project-console-work-ledger", up: migrateProjectConsole });
migrations.push({ version: 12, name: "bounded-agent-progress", up(sqlite) {
  addColumnIfMissing(sqlite, "local_agent_sessions", "progress", "text");
} });
migrations.push({ version: 13, name: "workspace-recovery-state", up: migrateWorkspaceRecoveryState });
migrations.push({ version: 14, name: "successful-execution-responses", up(sqlite) {
  sqlite.exec(`create table if not exists execution_responses (
    execution_id text primary key references console_executions(id),
    response text not null, sha256 text not null, bytes integer not null
  );`);
} });

function migrateWorkspaceState(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists workspace_sessions (
      id text primary key,
      root text not null,
      status text not null default 'active',
      mode text not null default 'checkout',
      source_root text,
      base_ref text,
      base_sha text,
      managed text not null default 'false',
      created_at text not null,
      last_used_at text not null
    );

    create index if not exists workspace_sessions_root_idx
      on workspace_sessions(root, last_used_at desc);

    create index if not exists workspace_sessions_status_idx
      on workspace_sessions(status, last_used_at desc);

    create table if not exists loaded_agent_files (
      workspace_session_id text not null,
      path text not null,
      content_hash text not null,
      content text not null,
      loaded_at text not null,
      last_seen_at text not null,
      primary key (workspace_session_id, path),
      foreign key (workspace_session_id)
        references workspace_sessions(id)
        on delete cascade
    );

    create index if not exists loaded_agent_files_path_idx
      on loaded_agent_files(path);
  `);

  addColumnIfMissing(sqlite, "workspace_sessions", "mode", "text not null default 'checkout'");
  addColumnIfMissing(sqlite, "workspace_sessions", "source_root", "text");
  addColumnIfMissing(sqlite, "workspace_sessions", "base_ref", "text");
  addColumnIfMissing(sqlite, "workspace_sessions", "base_sha", "text");
  addColumnIfMissing(sqlite, "workspace_sessions", "managed", "text not null default 'false'");
}

function migrateOAuthState(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists oauth_clients (
      client_id text primary key,
      client_json text not null,
      issued_at integer not null
    );

    create index if not exists oauth_clients_issued_at_idx
      on oauth_clients(issued_at desc);

    create table if not exists oauth_access_tokens (
      token_hash text primary key,
      client_id text not null,
      scopes_json text not null,
      expires_at integer not null,
      resource text,
      foreign key (client_id) references oauth_clients(client_id) on delete cascade
    );

    create index if not exists oauth_access_tokens_client_id_idx
      on oauth_access_tokens(client_id);

    create index if not exists oauth_access_tokens_expires_at_idx
      on oauth_access_tokens(expires_at);

    create table if not exists oauth_refresh_tokens (
      token_hash text primary key,
      client_id text not null,
      scopes_json text not null,
      expires_at integer not null,
      resource text,
      foreign key (client_id) references oauth_clients(client_id) on delete cascade
    );

    create index if not exists oauth_refresh_tokens_client_id_idx
      on oauth_refresh_tokens(client_id);

    create index if not exists oauth_refresh_tokens_expires_at_idx
      on oauth_refresh_tokens(expires_at);
  `);
}

function migrateLocalAgentSessions(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists local_agent_sessions (
      id text primary key,
      workspace_id text,
      workspace_root text not null,
      profile_name text not null,
      provider text not null,
      model text,
      effort text,
      provider_session_id text,
      status text not null,
      latest_response text,
      error text,
      created_at text not null,
      updated_at text not null
    );

    create index if not exists local_agent_sessions_workspace_id_idx
      on local_agent_sessions(workspace_id, updated_at desc);

    create index if not exists local_agent_sessions_workspace_root_idx
      on local_agent_sessions(workspace_root, updated_at desc);

    create index if not exists local_agent_sessions_provider_session_id_idx
      on local_agent_sessions(provider_session_id);
  `);

  addColumnIfMissing(sqlite, "local_agent_sessions", "effort", "text");
}

function migrateWorkspaceConversationBindings(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists workspace_conversation_bindings (
      conversation_scope_id text not null,
      target_key text not null,
      workspace_session_id text not null,
      created_at text not null,
      last_used_at text not null,
      primary key (conversation_scope_id, target_key),
      foreign key (workspace_session_id)
        references workspace_sessions(id)
        on delete cascade
    );

    create index if not exists workspace_conversation_bindings_workspace_idx
      on workspace_conversation_bindings(workspace_session_id);
  `);
}

function migrateLocalAgentStructuredErrors(sqlite: Database.Database): void {
  addColumnIfMissing(sqlite, "local_agent_sessions", "error_code", "text");
  addColumnIfMissing(sqlite, "local_agent_sessions", "error_retryable", "text");
}

function migrateLocalAgentEffortRename(sqlite: Database.Database): void {
  const columns = sqlite.prepare("pragma table_info(local_agent_sessions)").all() as Array<{
    name: string;
  }>;
  const names = new Set(columns.map((column) => column.name));
  if (names.has("effort")) {
    if (names.has("thinking")) {
      sqlite.exec(`
        update local_agent_sessions
        set effort = thinking
        where effort is null and thinking is not null
      `);
    }
    return;
  }
  if (!names.has("thinking")) {
    addColumnIfMissing(sqlite, "local_agent_sessions", "effort", "text");
    return;
  }
  sqlite.exec("alter table local_agent_sessions rename column thinking to effort");
}

function migrateWorkspaceRecoveryState(sqlite: Database.Database): void {
  const workspaceStateExists = sqlite
    .prepare("select 1 from sqlite_master where type = 'table' and name = 'workspace_sessions'")
    .get();
  if (!workspaceStateExists) return;

  addColumnIfMissing(sqlite, "workspace_sessions", "recovery_kind", "text");
}

function addColumnIfMissing(
  sqlite: Database.Database,
  table: "workspace_sessions" | "local_agent_sessions" | "execution_claims",
  column: string,
  definition: string,
): void {
  const columns = sqlite.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.some((existingColumn) => existingColumn.name === column)) return;

  sqlite.exec(`alter table ${table} add column ${column} ${definition}`);
}
