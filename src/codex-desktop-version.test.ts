import test from "node:test";
import assert from "node:assert/strict";
import { verifiedDesktopVersion } from "./codex-projects.js";

test("only independently verified Desktop protocol versions are admitted", () => {
  assert(verifiedDesktopVersion("codex-cli 0.153.4\r\n"));
  assert(verifiedDesktopVersion("codex-cli 0.154.0-alpha.6.2\n"));
  for (const value of ["codex-cli 0.154.0", "codex-cli 0.154.0-alpha.6.3", "codex-cli 0.135.0", "codex-cli 0.154.0-alpha.6.2\nextra", "other-cli 0.153.4", ""]) {
    assert.equal(verifiedDesktopVersion(value), false);
  }
});
