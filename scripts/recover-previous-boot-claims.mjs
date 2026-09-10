import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

/** OS evidence, not elapsed time or a caller-supplied timeout. */
export function windowsBootTime() {
  if (process.platform !== 'win32') throw new Error('This recovery requires Windows boot evidence.');
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '(Get-CimInstance Win32_OperatingSystem -ErrorAction Stop).LastBootUpTime.ToUniversalTime().ToString("o")'],
  { encoding: 'utf8', windowsHide: true, timeout: 15_000, maxBuffer: 4096 }).trim();
}

function sameRoot(left, right) {
  const normalize = value => resolve(value).replaceAll('\\', '/').toLowerCase();
  return typeof left === 'string' && typeof right === 'string' && normalize(left) === normalize(right);
}

/**
 * Explicit maintenance only. Does not inspect prompts, replay work, steal a live
 * claim, change usage or mark an interrupted operation successful. A full OS
 * reboot proves the former process and its children cannot still be running.
 */
export function recoverPreviousBootClaims(db, { claimIds, bootTime, now = Date.now(), apply = false, auditDirectory }) {
  const boot = Date.parse(bootTime);
  if (!Number.isFinite(boot) || boot <= 0 || boot > now || now - boot < 1000) throw new Error('Invalid or unconfirmed OS boot time.');
  if (!Array.isArray(claimIds) || claimIds.length < 1 || claimIds.length > 16 ||
      new Set(claimIds).size !== claimIds.length || claimIds.some(id => !/^claim_[a-f0-9]{32}$/.test(id))) {
    throw new Error('Supply 1–16 unique explicit claim IDs.');
  }
  if (apply && (!auditDirectory || !isAbsolute(auditDirectory))) throw new Error('An absolute audit directory is required.');
  db.exec('BEGIN IMMEDIATE');
  try {
    const claims = claimIds.map(id => {
      const claim = db.prepare('SELECT * FROM execution_claims WHERE id=?').get(id);
      if (!claim) throw new Error(`Claim ${id} is absent; inspect prior receipts before repeating recovery.`);
      const acquired = Date.parse(claim.acquired_at);
      if (claim.kind !== 'agent' || !claim.agent_id || !claim.owner_id ||
          !Number.isSafeInteger(claim.owner_pid) || claim.owner_pid < 1 ||
          !Number.isFinite(acquired) || acquired <= 0 || acquired >= boot - 5000) {
        throw new Error(`Claim ${id} is not a proven previous-boot agent claim.`);
      }
      const session = db.prepare('SELECT id,workspace_root,status,error_code FROM local_agent_sessions WHERE id=?').get(claim.agent_id);
      const execution = db.prepare('SELECT id,run_id,status,created_at FROM console_executions WHERE agent_id=? ORDER BY rowid DESC LIMIT 1').get(claim.agent_id);
      // Store uses "error"; the model-facing presentation calls it "failed".
      if (!session || session.status !== 'error' || session.error_code !== 'DAEMON_UNAVAILABLE' ||
          !sameRoot(session.workspace_root, claim.checkout_root) || !execution ||
          execution.status !== 'reconciliation_required' ||
          !Number.isFinite(Date.parse(execution.created_at)) || Date.parse(execution.created_at) >= boot - 5000) {
        throw new Error(`Claim ${id} has an active, unknown or mismatched execution boundary.`);
      }
      const waiters = db.prepare('SELECT count(*) AS n FROM execution_waiters WHERE agent_id=? AND expires_at_ms>?').get(claim.agent_id, now);
      if (waiters.n !== 0) throw new Error(`Claim ${id} has a new queued continuation; leave it untouched.`);
      return { ...claim, executionId: execution.id, workRunId: execution.run_id };
    });
    const receipt = {
      schema: 'devspace.previous-boot-claim-recovery', version: 1,
      recordedAt: new Date(now).toISOString(), bootTime: new Date(boot).toISOString(),
      action: apply ? 'release-previous-boot-claims' : 'dry-run',
      claims, released: 0, state: 'validated',
      sourceFilesChanged: false, inferenceInvoked: false, tasksReplayed: false,
      executionAndUsageHistoryPreserved: true,
    };
    let auditPath;
    if (apply) {
      mkdirSync(auditDirectory, { recursive: true, mode: 0o700 });
      auditPath = join(realpathSync(auditDirectory), `${Date.now()}-${randomUUID()}.prepared.json`);
      writeFileSync(auditPath, JSON.stringify(receipt, null, 2), { flag: 'wx', mode: 0o600 });
      for (const claim of claims) {
        const removed = db.prepare('DELETE FROM execution_claims WHERE id=? AND owner_id=? AND agent_id=? AND acquired_at=?')
          .run(claim.id, claim.owner_id, claim.agent_id, claim.acquired_at);
        if (removed.changes !== 1) throw new Error('Claim identity changed; transaction rolled back.');
      }
      receipt.released = claims.length;
    }
    db.exec('COMMIT');
    receipt.state = apply ? 'committed' : 'dry-run';
    if (auditPath) {
      try {
        writeFileSync(auditPath.replace('.prepared.json', '.completed.json'), JSON.stringify(receipt, null, 2), { flag: 'wx', mode: 0o600 });
      } catch {
        receipt.auditFinalization = 'prepared receipt exists; re-read claims before any retry';
      }
    }
    return { ...receipt, auditPath };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* Preserve the original failure. */ }
    throw error;
  }
}

function main(args) {
  let stateDir = join(homedir(), '.local/share/devspace');
  let apply = false;
  const claimIds = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--state-dir' && args[i + 1]) stateDir = args[++i];
    else if (args[i] === '--claim' && args[i + 1]) claimIds.push(args[++i]);
    else if (args[i] === '--apply') apply = true;
    else throw new Error('Usage: recover-previous-boot-claims [--state-dir absolute-path] --claim ID [--claim ID] [--apply]');
  }
  if (!isAbsolute(stateDir) || !existsSync(join(stateDir, 'devspace.sqlite'))) throw new Error('Existing absolute DevSpace state directory required.');
  stateDir = realpathSync(stateDir);
  const filename = realpathSync(join(stateDir, 'devspace.sqlite'));
  if (dirname(filename) !== stateDir) throw new Error('Database must not resolve outside its state directory.');
  const bootTime = windowsBootTime();
  const db = new DatabaseSync(filename);
  try {
    db.exec('PRAGMA busy_timeout=5000');
    const result = recoverPreviousBootClaims(db, { claimIds, bootTime, apply, auditDirectory: join(stateDir, 'recovery') });
    // Only lifecycle metadata; never include a stored prompt or provider output.
    console.log(JSON.stringify(result, null, 2));
  } finally { db.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(error instanceof Error ? error.message : 'Recovery failed.'); process.exitCode = 1; }
}
