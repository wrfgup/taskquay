import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { migrateDatabase } from "./migrations.js";

test("upstream workspace recovery appends to the fork's existing migration history", () => {
  const db = new Database(":memory:");
  try {
    migrateDatabase(db);
    // Reconstruct the version-12 schema: only version 13 adds recovery_kind.
    db.exec("alter table workspace_sessions drop column recovery_kind; drop table execution_responses; delete from devspace_schema_migrations where version>=13;");
    const history = db.prepare("select version,name,applied_at from devspace_schema_migrations order by version").all();
    assert.equal(history.length, 12);
    db.prepare("insert into workspace_sessions(id,root,created_at,last_used_at) values(?,?,?,?)").run("fixture", "/fixture", "2026-09-01", "2026-09-01");
    migrateDatabase(db);
    assert.deepEqual(db.prepare("select version,name,applied_at from devspace_schema_migrations where version<=12 order by version").all(), history);
    assert.deepEqual(db.prepare("select version,name from devspace_schema_migrations where version=13").get(), { version: 13, name: "workspace-recovery-state" });
    assert.deepEqual(db.prepare("select id,root,recovery_kind from workspace_sessions").get(), { id: "fixture", root: "/fixture", recovery_kind: null });
    migrateDatabase(db);
    assert.equal((db.prepare("select count(*) as n from devspace_schema_migrations").get() as { n: number }).n, 14);
    assert(db.prepare("select name from sqlite_master where type='table' and name='execution_responses'").get());
  } finally { db.close(); }
});
