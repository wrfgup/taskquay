import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodexAppServerRpc } from "./local-agent-codex.js";
import type { LocalAgentTurnControl } from "./local-agent-runtime.js";

test("active control steers and interrupts the exact turn on the owning RPC connection", async () => {
  const root = await mkdtemp(join(tmpdir(), "devspace-turn-control-"));
  const fixture = join(root, "fixture.mjs");
  await writeFile(fixture, `
import readline from "node:readline";
const out = value => process.stdout.write(JSON.stringify(value) + "\\n");
let active;
readline.createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  if (message.method === "turn/start") {
    active = { threadId: message.params.threadId, turnId: "turn_exact" };
    out({ id: message.id, result: { turn: { id: active.turnId } } });
  } else if (message.method === "turn/steer") {
    if (!active || message.params.threadId !== active.threadId || message.params.expectedTurnId !== active.turnId) {
      out({ id: message.id, error: { code: -32602, message: "stale turn" } }); return;
    }
    out({ id: message.id, result: { turnId: active.turnId } });
  } else if (message.method === "turn/interrupt") {
    if (!active || message.params.threadId !== active.threadId || message.params.turnId !== active.turnId) {
      out({ id: message.id, error: { code: -32602, message: "stale turn" } }); return;
    }
    out({ id: message.id, result: {} });
    out({ method: "turn/completed", params: { threadId: active.threadId, turn: { id: active.turnId, status: "interrupted", items: [] } } });
    active = undefined;
  }
});
`);
  const child = spawn(process.execPath, [fixture], { stdio: ["pipe", "pipe", "pipe"] });
  const rpc = new CodexAppServerRpc(child, "fixture");
  let resolveControl!: (control: LocalAgentTurnControl) => void;
  const ready = new Promise<LocalAgentTurnControl>((resolve) => { resolveControl = resolve; });
  try {
    const running = rpc.runTurn("thread_exact", { threadId: "thread_exact", input: [{ type: "text", text: "work" }] },
      undefined, undefined, (control) => { resolveControl(control); });
    const control = await ready;
    assert.equal(control.providerThreadId, "thread_exact");
    assert.equal(control.providerTurnId, "turn_exact");
    assert.deepEqual(await control.steer("focus tests"), { turnId: "turn_exact" });
    await control.interrupt();
    const completed = await running;
    assert.equal((completed.event.params as any).turn.status, "interrupted");
    assert.equal(control.isAlive(), false);
  } finally {
    rpc.fail(new Error("fixture closed"));
    child.kill();
    await rm(root, { recursive: true, force: true });
  }
});
