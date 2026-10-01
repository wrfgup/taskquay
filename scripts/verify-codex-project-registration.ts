// Idempotent registration of an explicitly supplied authorized project, no model or empty thread.
import { mkdir, writeFile } from "node:fs/promises";
import { loadConfig } from "../src/config.js";
import { ensureDesktopProject, prepareProjectRoots } from "../src/codex-projects.js";

const root = process.argv[2];
if (!root) throw new Error("Supply an existing project root authorized by the DevSpace config");
const config = loadConfig();
const prepared = await prepareProjectRoots([root], config.allowedRoots, false);
const receipt = await ensureDesktopProject(prepared.roots);
await mkdir(".local/codex-0159-compat", { recursive: true });
await writeFile(".local/codex-0159-compat/live-project.json", JSON.stringify(receipt, null, 2) + "\n");
console.log(JSON.stringify(receipt, null, 2));
if (receipt.status !== "persisted_registration" || receipt.clientRegistration !== "verified") process.exitCode = 1;
