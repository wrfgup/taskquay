/** Wait for native read admission without inference, file reads or lock stealing. */
import { setTimeout as pause } from "node:timers/promises";
import { loadConfig } from "../src/config.js";
import { assertAllowedPath } from "../src/roots.js";
import { ExecutionCoordinator } from "../src/execution-coordinator.js";

const root = process.argv[2];
if (!root) throw new Error("Provide an already-authorized workspace root.");
const config = loadConfig();
const authorized = assertAllowedPath(root, config.allowedRoots);
const coordinator = new ExecutionCoordinator(config.stateDir);
const started = Date.now();
let interrupted = false;
let admitted = false;
const stop = () => { interrupted = true; };
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
try {
  // A bounded native queue lease may expire, but it is not task failure.
  // Renew through the coordinator API, never by editing its database.
  while (!interrupted && !admitted) {
    const ticket = coordinator.enqueue({ workspaceRoot: authorized, kind: "read", access: "read" }, 900_000);
    let lastNotice = 0;
    try {
      while (!interrupted) {
        let claim;
        try { claim = ticket.tryAcquire(); }
        catch (error) {
          if (error instanceof Error && error.message === "Execution wait expired or was cancelled; no provider invoked.") break;
          throw error;
        }
        if (claim) {
          claim.release();
          console.log(JSON.stringify({ state: "available", elapsedMs: Date.now() - started, providerInvoked: false, sourceRead: false, activeLocksModified: false }));
          process.exitCode = 0;
          admitted = true;
          break;
        }
        if (Date.now() - lastNotice >= 60_000) {
          console.log(JSON.stringify({ state: "waiting_for_read_admission", elapsedMs: Date.now() - started, providerInvoked: false }));
          lastNotice = Date.now();
        }
        await pause(1000);
      }
    } finally { ticket.cancel(); }
  }
  if (!admitted) console.log(JSON.stringify({ state: "waiting_cancelled", elapsedMs: Date.now() - started, providerInvoked: false, activeLocksModified: false }));
} finally {
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
  coordinator.close();
}
