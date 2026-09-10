import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recoverPreviousBootClaims } from '../scripts/recover-previous-boot-claims.mjs';

const id = 'claim_' + 'a'.repeat(32);
const current = 'claim_' + 'b'.repeat(32);
const bootTime = '2026-09-10T04:34:51Z';
const now = Date.parse('2026-09-10T13:45:00Z');
function fixture(t) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE execution_claims(id TEXT PRIMARY KEY, owner_id TEXT, owner_pid INTEGER, kind TEXT, checkout_root TEXT, agent_id TEXT, thread_key TEXT, access_mode TEXT, resources TEXT, acquired_at TEXT);
    CREATE TABLE local_agent_sessions(id TEXT PRIMARY KEY,workspace_root TEXT,status TEXT,error_code TEXT);
    CREATE TABLE console_executions(id TEXT,run_id TEXT,agent_id TEXT,status TEXT,created_at TEXT);
    CREATE TABLE execution_waiters(agent_id TEXT,expires_at_ms INTEGER);`);
  db.prepare('INSERT INTO execution_claims VALUES (?,?,?,?,?,?,?,?,?,?)').run(id, 'old-owner', 123, 'agent', '/project/app', 'agent', 'old-thread', 'write', '["test-release"]', '2026-09-10T04:20:25Z');
  db.prepare('INSERT INTO execution_claims VALUES (?,?,?,?,?,?,?,?,?,?)').run(current, 'current-owner', 456, 'command', '/project/other', null, null, 'write', '[]', '2026-09-10T13:00:00Z');
  db.prepare('INSERT INTO local_agent_sessions VALUES (?,?,?,?)').run('agent', '/project/app', 'error', 'DAEMON_UNAVAILABLE');
  db.prepare('INSERT INTO console_executions VALUES (?,?,?,?,?)').run('execution', 'run', 'agent', 'reconciliation_required', '2026-09-10T04:20:25Z');
  const auditDirectory = mkdtempSync(join(tmpdir(), 'devspace-boot-recovery-'));
  t.after(() => { db.close(); rmSync(auditDirectory, { recursive: true, force: true }); });
  return { db, options: { claimIds: [id], bootTime, now, auditDirectory } };
}
test('dry-run preserves claims and execution history without audit writes', t => {
  const { db, options } = fixture(t);
  assert.equal(recoverPreviousBootClaims(db, options).released, 0);
  assert.equal(db.prepare('SELECT count(*) n FROM execution_claims').get().n, 2);
  assert.deepEqual(readdirSync(options.auditDirectory), []);
});
test('explicit recovery releases only proven previous-boot claims and records audit', t => {
  const { db, options } = fixture(t);
  const result = recoverPreviousBootClaims(db, { ...options, apply: true });
  assert.equal(result.released, 1);
  assert.equal(result.inferenceInvoked, false);
  assert.ok(db.prepare('SELECT * FROM execution_claims WHERE id=?').get(current));
  assert.equal(db.prepare('SELECT status FROM console_executions').get().status, 'reconciliation_required');
  assert.equal(db.prepare('SELECT status FROM local_agent_sessions').get().status, 'error');
  assert.equal(readdirSync(options.auditDirectory).length, 2);
  assert.throws(() => recoverPreviousBootClaims(db, { ...options, apply: true }), /absent/);
});
for (const [name, sql] of [
  ['current boot claim', `UPDATE execution_claims SET acquired_at='2026-09-10T12:00:00Z' WHERE id='${id}'`],
  ['active agent', "UPDATE local_agent_sessions SET status='running'"],
  ['unknown agent failure', "UPDATE local_agent_sessions SET error_code='PROVIDER_EXECUTION_ERROR'"],
  ['new execution', "INSERT INTO console_executions VALUES ('new','run','agent','running','2026-09-10T13:00:00Z')"],
  ['mismatched workspace', "UPDATE local_agent_sessions SET workspace_root='/different'"],
  ['queued continuation', `INSERT INTO execution_waiters VALUES ('agent',${now + 60000})`],
  ['invalid acquired time', `UPDATE execution_claims SET acquired_at='invalid' WHERE id='${id}'`],
  ['unscoped command', `UPDATE execution_claims SET kind='command' WHERE id='${id}'`],
]) test(`refuses ${name} without mutation`, t => {
  const { db, options } = fixture(t); db.exec(sql);
  assert.throws(() => recoverPreviousBootClaims(db, { ...options, apply: true }));
  assert.equal(db.prepare('SELECT count(*) n FROM execution_claims').get().n, 2);
  assert.deepEqual(readdirSync(options.auditDirectory), []);
});
test('a mixed candidate set is all-or-nothing', t => {
  const { db, options } = fixture(t);
  assert.throws(() => recoverPreviousBootClaims(db, { ...options, claimIds: [id, current], apply: true }));
  assert.equal(db.prepare('SELECT count(*) n FROM execution_claims').get().n, 2);
});
test('rejects malformed, duplicate, future and missing boot evidence', t => {
  const { db, options } = fixture(t);
  for (const override of [{ bootTime: 'invalid' }, { bootTime: '2099-01-01' }, { claimIds: [] }, { claimIds: [id, id] }, { claimIds: ['*'] }]) {
    assert.throws(() => recoverPreviousBootClaims(db, { ...options, ...override, apply: true }));
  }
  assert.equal(db.prepare('SELECT count(*) n FROM execution_claims').get().n, 2);
});
