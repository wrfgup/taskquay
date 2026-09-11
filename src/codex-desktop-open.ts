import { spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, win32 } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DesktopProjectMissingError, DesktopMappingPendingError, readDesktopCatalog } from "./codex-desktop-catalog.js";

type SavedCatalog = Awaited<ReturnType<typeof readDesktopCatalog>>;
export interface DesktopOpenRuntime {
  read(): Promise<SavedCatalog>;
  open(link: string): Promise<void>;
  pause(): Promise<void>;
  now(): number;
}
const pending = new Map<string, Promise<{ catalog: SavedCatalog; creation: "existing" | "requested_and_verified" }>>();

/** No prompt, origin URL or command can be injected through a workspace path. */
export function desktopWorkspaceLink(root: string): string {
  if (!(isAbsolute(root) || win32.isAbsolute(root)) || root.length > 4096 || /[\u0000-\u001f]/.test(root)) throw new Error("An absolute local workspace directory is required.");
  const link = new URL("codex://threads/new");
  link.searchParams.set("path", root);
  return link.href;
}

export function desktopThreadLink(threadId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{7,255}$/.test(threadId)) throw new Error("A valid local Codex thread id is required.");
  return `codex://threads/${encodeURIComponent(threadId)}`;
}

/** Read client-owned metadata; only a genuinely absent single-root project may open a draft. */
export async function ensureClientProject(roots: string[], runtime: DesktopOpenRuntime, timeoutMs = 15_000) {
  if (!roots.length || timeoutMs < 1 || timeoutMs > 30_000) throw new Error("Invalid bounded project-registration request.");
  try { return { catalog: await runtime.read(), creation: "existing" as const }; }
  catch (error) {
    if (!(error instanceof DesktopProjectMissingError)) throw error;
    if (roots.length !== 1) throw new Error("Missing multi-root Desktop projects require an explicit client multi-root operation; no separate projects were created.");
  }
  await runtime.open(desktopWorkspaceLink(roots[0]!));
  const deadline = runtime.now() + timeoutMs;
  for (;;) {
    try { return { catalog: await runtime.read(), creation: "requested_and_verified" as const }; }
    catch (error) {
      if (!(error instanceof DesktopProjectMissingError) && !(error instanceof DesktopMappingPendingError)) throw error;
    }
    if (runtime.now() >= deadline) throw new Error("Desktop workspace open was requested, but client registration is not yet verified. Re-observe before retrying; no model was started.");
    await runtime.pause();
  }
}

function openWindowsWorkspace(link: string, env: NodeJS.ProcessEnv): Promise<void> {
  if (process.platform !== "win32") return Promise.reject(new Error("Automatic Desktop workspace opening is currently verified on Windows only."));
  return new Promise((resolve, reject) => {
    // Constant program text; the URI is transported as data, not interpolated
    // into a shell command. No clipboard, menu inspection, global JSON write,
    // authentication modification or turn/start request is used.
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "$ErrorActionPreference='Stop'; Start-Process -FilePath $env:DEVSPACE_WORKSPACE_LINK"], {
      env: { ...env, DEVSPACE_WORKSPACE_LINK: link }, windowsHide: true, stdio: "ignore", shell: false,
    });
    const timer = setTimeout(() => { child.kill(); reject(new Error("Desktop link launcher did not return; re-observe the client before retrying.")); }, 5_000);
    child.once("error", () => { clearTimeout(timer); reject(new Error("Desktop workspace link could not be opened by the registered Windows URL handler.")); });
    child.once("close", (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error("Desktop workspace link launcher failed; no registration success is asserted.")); });
  });
}

export async function ensureSavedDesktopProject(roots: string[], home: string, key: (path: string) => string, env: NodeJS.ProcessEnv = process.env) {
  // Callers must already validate authorized roots via prepareProjectRoots.
  // Resolve existing directories here for identity; this is not an OS sandbox
  // or a cross-process guarantee against external filesystem replacement.
  const resolved = await Promise.all(roots.map(async (root) => {
    const path = await realpath(root);
    if (!(await stat(path)).isDirectory()) throw new Error("Desktop workspace must be an existing directory.");
    return path;
  }));
  const identity = JSON.stringify([key(home), resolved.map(key).sort()]);
  const current = pending.get(identity);
  if (current) return current;
  const action = ensureClientProject(resolved, {
    read: () => readDesktopCatalog(resolved, home, key),
    open: (link) => openWindowsWorkspace(link, env), pause: () => delay(250), now: Date.now,
  });
  pending.set(identity, action);
  try { return await action; } finally { if (pending.get(identity) === action) pending.delete(identity); }
}
