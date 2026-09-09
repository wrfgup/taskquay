/** Execute the same HTTP recovery assertions against compiled candidate modules. */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import ts from "typescript";
const candidate = resolve(process.argv[2] ?? "releases/receipt-recovery-20260909/candidate");
const directory = dirname(candidate), testPath = join(directory, "compiled-recovery.test.mjs");
const source = readFileSync(resolve("src/receipt-recovery.test.ts"), "utf8").replace(/from "(\.[^"]+)"/g,
  (_, path: string) => `from "${pathToFileURL(resolve(candidate, path)).href}"`);
writeFileSync(testPath, ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText);
const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", testPath],
  { windowsHide: true, encoding: "utf8", timeout: 90000, maxBuffer: 4 * 1024 * 1024 });
const output = (result.stdout ?? "") + (result.stderr ?? "");
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
writeFileSync(join(directory, "compiled-recovery.log"), output);
const receipt = { status: result.status === 0 && !result.error ? "passed" : "failed", exitCode: result.status,
  transport: "real SDK StreamableHTTP loopback", tests: Number(output.match(/^# tests (\d+)$/m)?.[1]),
  pass: Number(output.match(/^# pass (\d+)$/m)?.[1]), fail: Number(output.match(/^# fail (\d+)$/m)?.[1]),
  outputSha256: sha(output), testSourceSha256: sha(readFileSync(resolve("src/receipt-recovery.test.ts"))),
  candidate, scope: "compiled context/work/agent/process/patch registrations with fixture provider, no real inference or live server mutation" };
const body = JSON.stringify(receipt, null, 2), path = join(directory, "compiled-recovery.json"); writeFileSync(path, body);
console.log(JSON.stringify({ path, sha256: sha(body), ...receipt }));
process.exitCode = receipt.status === "passed" ? 0 : 1;
