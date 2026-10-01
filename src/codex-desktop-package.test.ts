import test from "node:test";
import assert from "node:assert/strict";
import { desktopProjectLaunchArgs, validateDesktopPackageCommand } from "./codex-desktop-open.js";

test("packaged Desktop executable is taken from its manifest, not assumed to be codex.exe", () => {
  const installRoot = "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.928.2636.0_x64";
  const command = `${installRoot}\\app\\ChatGPT.exe`;
  assert.deepEqual(validateDesktopPackageCommand({ installRoot, command }), { installRoot, command });
  assert.equal(validateDesktopPackageCommand(null), null);
});
test("Desktop package discovery rejects ambiguous, relative, escaped and non-executable paths", () => {
  const installRoot = "C:\\apps\\Codex";
  for (const value of [[], {}, { installRoot, command: "codex.exe" },
    { installRoot, command: "C:\\apps\\other\\app.exe" }, { installRoot, command: "C:\\apps\\Codex\\..\\other.exe" },
    { installRoot, command: "C:\\apps\\Codex\\script.cmd" }]) assert.throws(() => validateDesktopPackageCommand(value));
});
test("workspace paths remain one data argument, never a command, prompt or origin", () => {
  const root = "D:\\project\\space & quoted 'folder'";
  assert.deepEqual(desktopProjectLaunchArgs(root), ["--open-project", root]);
  assert.throws(() => desktopProjectLaunchArgs("relative"));
  assert.throws(() => desktopProjectLaunchArgs("D:\\project\n--prompt"));
});
