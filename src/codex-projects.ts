import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, win32 } from "node:path";
import { createInterface } from "node:readline";
import { readDesktopCatalog } from "./codex-desktop-catalog.js";
import { ensureSavedDesktopProject } from "./codex-desktop-open.js";
import * as z from "zod/v4";
import { assertAllowedPath, canonicalPathIdentity, expandHomePath, isPathInsideRoot } from "./roots.js";

// Verified against Desktop 26.901.6511.0 / bundled app-server 0.153.4.
// These are real project RPCs, not edits to Desktop JSON or Codex SQLite.
export const PROJECT_PROTOCOL = "codex-app-server-projects/0.153.4";
const projectSchema = z.object({ id: z.string().min(1), name: z.string(),
  roots: z.array(z.object({ path: z.string().min(1) }).passthrough()).min(1),
  createdAt: z.number().int(), updatedAt: z.number().int(), position: z.number().int(),
  metadata: z.record(z.string(), z.string()),
}).passthrough();
const threadSchema = z.object({ id: z.string().min(1), cwd: z.string().min(1),
  projectId: z.string().nullable(), path: z.string().nullable().optional(),
}).passthrough();
type Project = z.infer<typeof projectSchema>;
type Thread = z.infer<typeof threadSchema>;
export type ProjectMethod = "project/list" | "project/create" | "project/read" | "thread/read" | "thread/metadata/update" | "thread/start" | "thread/name/set";
export interface ProjectControl {
  home: string;
  command: string;
  request(method: ProjectMethod, params: unknown): Promise<unknown>;
  close(): Promise<void>;
}
export interface ProjectReceipt {
  protocol: string;
  status: "persisted_registration" | "partial" | "not_applicable";
  roots: string[];
  createdDirectories: string[];
  projectId?: string;
  clientProjectId?: string;
  clientRegistration?: "verified" | "missing_or_unverified";
  clientCreation?: "existing" | "requested_and_verified";
  reused?: boolean;
  provider?: { home: string; command: string; homeMatched: boolean };
  before?: { projectId: string | null; threads: { id: string; cwd: string; projectId: string | null }[] };
  after?: { projectId: string; roots: string[]; threads: { id: string; cwd: string; projectId: string | null }[] };
  uiStatus: "unverified";
  action?: string;
  code?: string;
}
export function projectPathKey(path: string): string {
  // Do not lowercase Linux paths inside WSL. wsl$ and wsl.localhost are aliases.
  if (/^(?:[A-Za-z]:[\\/]|[\\/]{2})/.test(path)) {
    let normalized = win32.normalize(path).replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\(?=[A-Za-z]:)/, "");
    normalized = normalized.replace(/\\+$/, "");
    const wsl = /^\\\\(?:wsl\$|wsl\.localhost)\\([^\\]+)(.*)$/i.exec(normalized);
    return wsl ? `\\\\wsl.localhost\\${wsl[1]!.toLowerCase()}${wsl[2]}` : normalized.toLowerCase();
  }
  return canonicalPathIdentity(resolve(path));
}
export function normalizeProjectPath(path: string): string {
  const expanded = expandHomePath(path);
  if (process.platform !== "win32") return expanded;
  return expanded.replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\(?=[A-Za-z]:)/, "");
}
async function pathKey(path: string) {
  try { return projectPathKey(await realpath(path)); } catch { return projectPathKey(path); }
}

/** Validate both lexical and real parents BEFORE creating anything. Never expand allowed roots. */
export async function prepareProjectRoots(paths: string[], allowedRoots: string[], create = false) {
  if (!paths.length || paths.length > 16) throw new Error("Provide 1–16 project roots.");
  paths = paths.map(normalizeProjectPath);
  allowedRoots = allowedRoots.map(normalizeProjectPath);
  const relevantRoots = allowedRoots.filter((root) => paths.some((path) => isPathInsideRoot(path, root)));
  const allowed = await Promise.all(relevantRoots.map((root) => realpath(resolve(expandHomePath(root)))));
  const planned: { path: string; missing: boolean }[] = [];
  for (const input of paths) {
    if (!isAbsolute(input) || (process.platform === "win32" && !/^(?:[A-Za-z]:[\\/]|[\\/]{2})/.test(input))) throw new Error("Project roots must be absolute local paths (use UNC for WSL on Windows).");
    const path = assertAllowedPath(input, allowedRoots);
    let parent = path;
    while (!existsSync(parent)) {
      const next = dirname(parent);
      if (next === parent) throw new Error("Project has no existing parent.");
      parent = next;
    }
    assertAllowedPath(await realpath(parent), allowed);
    const missing = parent !== path;
    if (missing && !create) throw new Error("Directory does not exist. Verify the intended path. Only if directory creation is authorized and your host exposes create_directory, repeat open_workspace with create_directory=true; otherwise have the directory created through an authorized available tool or by the user, then open it. Do not guess or auto-create a different path.");
    if (!(await stat(parent)).isDirectory()) throw new Error("Project root/parent must be a directory.");
    planned.push({ path, missing });
  }
  const roots: string[] = [], createdDirectories: string[] = [];
  for (const plan of planned) {
    if (plan.missing) {
      // Revalidate immediately before mutation, including junction/symlink parents.
      let parent = dirname(plan.path);
      while (!existsSync(parent)) parent = dirname(parent);
      assertAllowedPath(await realpath(parent), allowed);
      await mkdir(plan.path, { recursive: true });
      createdDirectories.push(plan.path);
    }
    const root = assertAllowedPath(await realpath(plan.path), allowed);
    if (!roots.some((other) => projectPathKey(other) === projectPathKey(root))) roots.push(root);
  }
  return { roots, createdDirectories };
}

async function listProjects(client: ProjectControl): Promise<Project[]> {
  const projects: Project[] = [];
  let cursor: string | null = null;
  const seen = new Set<string>();
  for (let page = 0; page < 20; page++) {
    const result = z.object({ data: z.array(projectSchema), nextCursor: z.string().nullable() }).passthrough()
      .parse(await client.request("project/list", { cursor, limit: 100 }));
    projects.push(...result.data);
    cursor = result.nextCursor;
    if (cursor === null) return projects;
    if (seen.has(cursor)) break;
    seen.add(cursor);
  }
  throw new Error("Project list pagination exceeded its safe bound.");
}
async function readThread(client: ProjectControl, threadId: string) {
  const { thread } = z.object({ thread: threadSchema }).passthrough().parse(
    await client.request("thread/read", { threadId, includeTurns: false }));
  if (thread.id !== threadId) throw new Error("Thread response identity mismatch.");
  return thread;
}
const threadEvidence = ({ id, cwd, projectId }: Thread) => ({ id, cwd, projectId });

/** Server owns transactions and idempotency. Never write its database or global state directly. */
export async function registerProject(client: ProjectControl, input: {
  roots: string[]; expectedHome: string; threadIds?: string[];
  desktopCatalog?: { clientProjectId: string; projectId: string; threadIds: string[] };
}): Promise<ProjectReceipt> {
  const receipt: ProjectReceipt = { protocol: PROJECT_PROTOCOL, status: "partial", roots: input.roots,
    createdDirectories: [], uiStatus: "unverified",
    provider: { home: client.home, command: client.command, homeMatched: false } };
  try {
    if (await pathKey(client.home) !== await pathKey(input.expectedHome)) throw new Error("Provider home differs from the Desktop instance. Select the matching provider home.");
    receipt.provider!.homeMatched = true;
    const keys = await Promise.all(input.roots.map(pathKey));
    const all = await listProjects(client);
    const matches: Project[] = [];
    for (const project of all) {
      const saved = await Promise.all(project.roots.map(({ path }) => pathKey(path)));
      // A workspace can be one root in an existing multi-root project. Never replace the other roots.
      if (keys.every((key) => saved.includes(key))) matches.push(project);
    }
    const selected = input.desktopCatalog ? matches.filter(p => p.id === input.desktopCatalog!.projectId) : matches;
    if (selected.length > 1) throw new Error("Multiple saved projects match these roots. Resolve the ambiguous Desktop project before retrying.");
    if (input.desktopCatalog && selected.length !== 1) throw new Error("Desktop client mapping does not match the app-server saved roots.");
    let project = selected[0];
    const threads = await Promise.all([...new Set(input.threadIds ?? [])].map((id) => readThread(client, id)));
    for (const thread of threads) {
      if (!keys.includes(await pathKey(thread.cwd))) throw new Error("Thread cwd differs from the requested roots; refusing reassignment.");
      if (thread.projectId !== null && thread.projectId !== project?.id &&
        !(input.desktopCatalog?.threadIds.includes(thread.id) && matches.some(p => p.id === thread.projectId))) {
        throw new Error("Thread already belongs to another project; refusing reassignment.");
      }
    }
    receipt.before = { projectId: project?.id ?? null, threads: threads.map(threadEvidence) };
    receipt.reused = Boolean(project);
    if (!project) {
      // Detect unrelated external project writes during read/validation. Retry by re-observing, not by launching a model.
      if (JSON.stringify(await listProjects(client)) !== JSON.stringify(all)) throw new Error("Concurrent project change detected; re-run registration.");
      project = z.object({ project: projectSchema }).passthrough().parse(await client.request("project/create", {
        idempotencyKey: `devspace-roots-v1-${createHash("sha256").update(JSON.stringify([...keys].sort())).digest("hex")}`,
        name: basename(input.roots[0]!), roots: input.roots.map((path) => ({ path })),
      })).project;
    }
    receipt.projectId = project.id;
    const verified = z.object({ project: projectSchema }).passthrough().parse(
      await client.request("project/read", { projectId: project.id })).project;
    if (verified.id !== project.id || JSON.stringify(verified.roots) !== JSON.stringify(project.roots)) throw new Error("Concurrent saved-root change detected; re-run registration.");
    const verifiedKeys = await Promise.all(verified.roots.map(({ path }) => pathKey(path)));
    if (!keys.every((key) => verifiedKeys.includes(key))) throw new Error("Saved roots do not match the requested directory.");
    receipt.after = { projectId: verified.id, roots: verified.roots.map(({ path }) => path), threads: [] };
    for (const before of threads) {
      const current = await readThread(client, before.id);
      if (JSON.stringify(threadEvidence(current)) !== JSON.stringify(threadEvidence(before))) throw new Error("Concurrent thread metadata change detected; re-run registration.");
      if (current.projectId !== verified.id) await client.request("thread/metadata/update", { threadId: before.id, projectId: verified.id });
      const after = await readThread(client, before.id);
      if (after.projectId !== verified.id || after.cwd !== before.cwd) throw new Error("Thread assignment readback mismatch; inspect this partial receipt before retrying.");
      receipt.after.threads.push(threadEvidence(after));
    }
    receipt.status = "persisted_registration";
    if (input.desktopCatalog) {
      receipt.clientProjectId = input.desktopCatalog.clientProjectId;
      receipt.clientRegistration = "verified";
    }
    return receipt;
  } catch (error) {
    receipt.code = error instanceof z.ZodError ? "DESKTOP_SCHEMA_UNSUPPORTED" : "DESKTOP_REGISTRATION_PARTIAL";
    receipt.action = error instanceof z.ZodError ? "Unexpected Desktop RPC schema; update the versioned adapter. No automatic inference retry."
      : error instanceof Error ? error.message : "Registration failed. Re-read project/thread metadata before retrying.";
    return receipt;
  }
}

export function desktopHome(env: NodeJS.ProcessEnv = process.env) { return resolve(env.CODEX_HOME ?? join(homedir(), ".codex")); }
export function hasDesktop(env: NodeJS.ProcessEnv = process.env) { return existsSync(join(desktopHome(env), ".codex-global-state.json")); }

/** Only a verified Desktop binary is used; PATH may contain an older unrelated CLI. */
export async function connectDesktopProjects(env: NodeJS.ProcessEnv = process.env): Promise<ProjectControl> {
  const base = env.LOCALAPPDATA && join(env.LOCALAPPDATA, "OpenAI", "Codex", "bin");
  const candidates = env.DEVSPACE_CODEX_DESKTOP_COMMAND ? [env.DEVSPACE_CODEX_DESKTOP_COMMAND]
    : base ? (await readdir(base, { withFileTypes: true })).filter((entry) => entry.isDirectory()).slice(0, 32)
      .map((entry) => join(base, entry.name, "codex.exe")) : [];
  const command = candidates.find((candidate) => {
    const probe = spawnSync(candidate, ["--version"], { env, windowsHide: true, encoding: "utf8", timeout: 5000 });
    return probe.status === 0 && probe.stdout.trim() === "codex-cli 0.153.4";
  });
  if (!command) throw new Error("No verified Desktop app-server 0.153.4 found. Configure DEVSPACE_CODEX_DESKTOP_COMMAND or update the adapter; no model was started.");
  const child = spawn(command, ["app-server"], { env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map<number, { method: string; resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  let sequence = 0;
  const fail = () => { for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error("Desktop control connection closed; re-observe registration before retrying.")); } pending.clear(); };
  child.on("error", fail); child.on("exit", fail); child.stderr.resume();
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    try {
      const message = JSON.parse(line);
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id); clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(`Desktop RPC ${entry.method} rejected request (code ${Number.isSafeInteger(message.error.code) ? message.error.code : "unknown"}); verify protocol/version and re-observe metadata.`));
      else entry.resolve(message.result);
    } catch { fail(); }
  });
  const request = (method: string, params: unknown) => new Promise<unknown>((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("Desktop RPC timeout; outcome unknown. Re-run the same idempotent registration to recover.")); }, 10_000);
    pending.set(id, { method, resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => { if (error) fail(); });
  });
  const close = async () => {
    fail(); child.stdin.end(); lines.close();
    if (child.exitCode !== null) return;
    await new Promise<void>((done) => {
      // Only reap the disposable control process created above; never touch Desktop or another task.
      const timer = setTimeout(() => { child.kill(); done(); }, 1000);
      child.once("exit", () => { clearTimeout(timer); done(); });
    });
  };
  try {
    const result = z.object({ codexHome: z.string() }).passthrough().parse(await request("initialize", {
      clientInfo: { name: "devspace-projects", version: "1.0.8" }, capabilities: { experimentalApi: true },
    }));
    return { home: result.codexHome, command, request, close };
  } catch (error) { await close(); throw error; }
}

export async function ensureDesktopProject(roots: string[], threadIds: string[] = [], env: NodeJS.ProcessEnv = process.env): Promise<ProjectReceipt> {
  if (!hasDesktop(env)) return { protocol: PROJECT_PROTOCOL, status: "not_applicable", roots, createdDirectories: [], uiStatus: "unverified" };
  let client: ProjectControl | undefined;
  try {
    client = await connectDesktopProjects(env);
    if (await pathKey(client.home) !== await pathKey(desktopHome(env))) throw new Error("Desktop provider home differs; no client workspace was opened.");
    const saved = await ensureSavedDesktopProject(roots, desktopHome(env), projectPathKey, env);
    const desktopCatalog = saved.catalog;
    const receipt = { ...await registerProject(client, { roots, threadIds, expectedHome: desktopHome(env), desktopCatalog }), clientCreation: saved.creation };
    const after = await readDesktopCatalog(roots, desktopHome(env), projectPathKey);
    if (after.projectId !== desktopCatalog.projectId || after.clientProjectId !== desktopCatalog.clientProjectId) {
      return { ...receipt, status: "partial", clientRegistration: "missing_or_unverified", action: "Desktop project changed concurrently; re-observe before starting a model." };
    }
    return receipt;
  } catch (error) {
    return { protocol: PROJECT_PROTOCOL, status: "partial", roots, createdDirectories: [], uiStatus: "unverified",
      clientRegistration: "missing_or_unverified", code: "DESKTOP_CONTROL_UNAVAILABLE", action: error instanceof z.ZodError ? "Unsupported Desktop saved-project schema; update the adapter." : error instanceof Error ? error.message : "Inspect Desktop control connection." };
  } finally { await client?.close(); }
}
