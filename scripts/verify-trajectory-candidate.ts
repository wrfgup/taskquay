import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve, join, relative } from "node:path";
const root = process.cwd(), directory = resolve(process.argv[2] ?? "releases/trajectory-two-day-20260908");
const baseline = process.argv[3] ?? spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true }).stdout.trim();
if (!/^[a-f0-9]{40}$/.test(baseline)) throw new Error("Explicit baseline must be a full commit SHA.");
mkdirSync(directory, { recursive: true });
// Compiled version.ts resolves the package manifest relative to the candidate.
writeFileSync(join(directory, "package.json"), readFileSync(resolve("package.json")));
const digest = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const tsc = resolve("node_modules/typescript/bin/tsc");
const steps = [
  { name: "typecheck", args: ["-p", "tsconfig.json", "--noEmit"] },
  { name: "isolated-build", args: ["-p", "tsconfig.build.json", "--outDir", join(directory, "candidate")] },
].map(({ name, args }) => {
  const started = new Date().toISOString();
  const result = spawnSync(process.execPath, [tsc, ...args], { cwd: root, encoding: "utf8", timeout: 120_000, windowsHide: true, maxBuffer: 1024 * 1024 });
  const output = (result.stdout ?? "") + (result.stderr ?? "");
  writeFileSync(join(directory, `${name}.log`), output);
  return { name, started, finished: new Date().toISOString(), exitCode: result.status, signal: result.signal, failedToRun: !!result.error, outputSha256: digest(output) };
});
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]).sort();
}
const manifest = files(join(directory, "candidate")).map((path) => ({ path: relative(join(directory, "candidate"), path).replaceAll("\\", "/"), sha256: digest(readFileSync(path)) }));
const sourceManifest = files(resolve("src")).map((path) => ({ path: relative(root, path).replaceAll("\\", "/"), sha256: digest(readFileSync(path)) }));
const inputPaths = ["AGENTS.md", "src/process-sessions.ts", "src/tool-surfaces/workspace-context.ts", "src/mcp-request-diagnostics.ts", "src/local-agent-codex.ts", "src/tool-surfaces/codex.ts", "src/tool-surfaces/work-task.ts"];
const baselineInputs = inputPaths.map((path) => {
  const content = spawnSync("git", ["show", `${baseline}:${path}`], { windowsHide: true, maxBuffer: 1024 * 1024 });
  return { path, sha256: digest(content.stdout), exitCode: content.status };
});
const receipt = { status: steps.every((s) => s.exitCode === 0 && !s.failedToRun) ? "passed" : "failed", steps,
  baselineCommit: baseline, baselineInputs, candidateFiles: manifest.length,
  candidateManifestSha256: digest(JSON.stringify(manifest)), sourceManifestSha256: digest(JSON.stringify(sourceManifest)), manifest, sourceManifest,
  liveDistChanged: false, uiBuild: "not_run_no_ui_change", packagedNpmInstall: "not_verified" };
const path = join(directory, "candidate-verification.json"), body = JSON.stringify(receipt, null, 2);
writeFileSync(path, body);
console.log(JSON.stringify({ path, sha256: digest(body), status: receipt.status, steps, candidateFiles: manifest.length,
  candidateManifestSha256: receipt.candidateManifestSha256, sourceManifestSha256: receipt.sourceManifestSha256, baselineInputs }));
process.exitCode = receipt.status === "passed" ? 0 : 1;
