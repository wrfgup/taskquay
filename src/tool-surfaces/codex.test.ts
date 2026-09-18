import assert from "node:assert/strict";
import test from "node:test";
import { processLogFields } from "./codex.js";

test("process logging keeps a running command successful", () => {
  assert.deepEqual(
    processLogFields({
      execution: { platform: "win32", shell: "powershell", transport: "pipe", ptyCapability: "pipe_fallback" },
      terminalReplay: false,
      outputScope: "since_previous_read",
      sessionId: 7,
      output: "",
      outputTruncated: false,
      running: true,
      phase: "running",
      wallTimeMs: 10,
    }),
    { sessionId: 7, running: true, exitCode: undefined, success: true },
  );
});

test("process logging marks a zero exit code successful", () => {
  assert.deepEqual(
    processLogFields({
      execution: { platform: "win32", shell: "powershell", transport: "pipe", ptyCapability: "pipe_fallback" },
      terminalReplay: false,
      outputScope: "since_previous_read",
      output: "done",
      outputTruncated: false,
      running: false,
      phase: "closed",
      exitCode: 0,
      wallTimeMs: 20,
    }),
    { sessionId: undefined, running: false, exitCode: 0, success: true },
  );
});

test("process logging marks a non-zero exit code failed", () => {
  assert.deepEqual(
    processLogFields({
      execution: { platform: "win32", shell: "powershell", transport: "pipe", ptyCapability: "pipe_fallback" },
      terminalReplay: false,
      outputScope: "since_previous_read",
      output: "failed",
      outputTruncated: false,
      running: false,
      phase: "closed",
      exitCode: 1,
      wallTimeMs: 30,
    }),
    {
      sessionId: undefined,
      running: false,
      exitCode: 1,
      success: false,
      error: "Process exited with code 1.",
    },
  );
});
