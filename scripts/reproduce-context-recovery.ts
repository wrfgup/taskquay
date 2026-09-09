import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import ts from "typescript";
const baseline = "4ba4283f8e585cefbf9245d84d57f11ce8721031";
const result = spawnSync("git", ["show", `${baseline}:src/tool-surfaces/workspace-context.ts`], { encoding: "utf8", windowsHide: true });
assert.equal(result.status, 0);
const temporary = mkdtempSync(join(tmpdir(), "devspace-context-baseline-"));
const modulePath = join(temporary, "baseline.mjs");
const body = ts.transpileModule(result.stdout.replace(/from "(\.[^"]+)"/g, (_, p: string) =>
  `from "${pathToFileURL(resolve("src/tool-surfaces", p.replace(/\.js$/, ".ts"))).href}"`)
  .replace('from "zod/v4"', `from "${pathToFileURL(resolve("node_modules/zod/v4/index.js")).href}"`),
  { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
writeFileSync(modulePath, body);
try {
  const { registerWorkspaceContextTool } = await import(pathToFileURL(modulePath).href);
  for (let i = 0; i < 3; i++) writeFileSync(join(temporary, `${i}.txt`), ("中文".repeat(900) + "\n").repeat(80));
  writeFileSync(join(temporary, "long.txt"), "a" + "😀".repeat(2000) + "\nnext");
  let handler: (input: any) => Promise<any>;
  registerWorkspaceContextTool({ server: { registerTool: (_name: string, _schema: unknown, callback: typeof handler) => { handler = callback; } },
    workspaces: { getWorkspace: () => ({ id: "fixture", root: temporary }), resolveReadPath: (_ws: unknown, path: string) => ({ absolutePath: join(temporary, path) }) },
    processSessions: { readWorkspace: (_root: string, action: () => unknown) => action() } });
  const call = async (files: any[]) => handler!({ workspaceId: "fixture", action: "capture", files });
  const large = await call([0, 1, 2].map((n) => ({ path: `${n}.txt` })));
  const first = JSON.parse((await call([{ path: "long.txt", startLine: 1 }])).content[0].text);
  const second = JSON.parse((await call([{ path: "long.txt", startLine: 2 }])).content[0].text);
  const evidence = { baseline, serializedBytes: Buffer.byteLength(JSON.stringify(large)), budgetExceeded: Buffer.byteLength(JSON.stringify(large)) > 48 * 1024,
    rangeIdentityCollision: first.contextId === second.contextId,
    longLineTruncated: first.entries[0].lines[0].lineTruncated,
    splitSurrogate: /[\uD800-\uDBFF]$/.test(first.entries[0].lines[0].text),
    missingLongLineContinuation: first.entries[0].nextLine === null,
    implication: "Reproducible source/transport-size risk; does not prove historical host delivery loss." };
  assert(evidence.budgetExceeded && evidence.rangeIdentityCollision && evidence.longLineTruncated && evidence.splitSurrogate && evidence.missingLongLineContinuation);
  const path = resolve("releases/receipt-recovery-20260909/baseline-reproduction.json"); mkdirSync(dirname(path), { recursive: true });
  const json = JSON.stringify(evidence, null, 2); writeFileSync(path, json);
  console.log(JSON.stringify({ path, sha256: createHash("sha256").update(json).digest("hex"), ...evidence }));
} finally { rmSync(temporary, { recursive: true, force: true }); }
