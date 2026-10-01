// Read-only, restricted metadata view. Never print chat contents, credentials or unrelated paths.
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { desktopHome, prepareProjectRoots, projectPathKey } from "../src/codex-projects.js";

const target = process.argv[2];
if (!target) throw new Error("Provide the authorized target project root");
await prepareProjectRoots([target], loadConfig().allowedRoots, false);
const path = join(desktopHome(), ".codex-global-state.json");
const state = JSON.parse(await readFile(path, "utf8"));
const fields = Object.keys(state).filter(k => /project|workspace/i.test(k));
const matches: string[] = [];
const visit = (value: unknown, key: string, depth: number) => {
  if (depth > 5) return;
  if (typeof value === "string") {
    if (projectPathKey(value) === projectPathKey(target)) matches.push(key);
  } else if (Array.isArray(value)) value.forEach((v, i) => visit(v, `${key}[${i}]`, depth + 1));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) visit(v, `${key}.${k}`, depth + 1);
  }
};
for (const field of fields) visit(state[field], field, 0);
console.log(JSON.stringify({ stateModifiedAt: (await stat(path)).mtime.toISOString(), fields,
  targetFieldPaths: matches, legacyProjectCount: Object.keys(state["local-projects"] ?? {}).length,
  hasLegacyServerMap: Boolean(state["app-server-project-id-by-legacy-project-id-by-host"]) }, null, 2));
