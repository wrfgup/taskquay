import { createHash } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export interface ContextFileRef { path: string; sha256: string }
export interface HostPreparedContext { summary: string; files: ContextFileRef[] }

export function validateContextShape(value: unknown): HostPreparedContext | undefined {
  if (value === undefined) return undefined;
  const context = value as HostPreparedContext;
  if (!context || typeof context.summary !== "string" || context.summary.length > 12_000 ||
      !Array.isArray(context.files) || context.files.length > 24 || context.files.some((ref) =>
        !ref || typeof ref.path !== "string" || !ref.path || ref.path.length > 1024 ||
        typeof ref.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(ref.sha256))) throw new Error("Invalid bounded host context: at most 24 file references and 12000 summary characters.");
  return { summary: context.summary, files: context.files.map(({ path, sha256 }) => ({ path, sha256 })) };
}

/** Explicit files only. No recursive scan, model call, environment dump or automatic context ingestion. */
export function readContextFile(root: string, path: string): { path: string; bytes: Buffer; sha256: string } {
  if (!path || /[\x00-\x1f]/.test(path) || isAbsolute(path) || /^[A-Za-z]:/.test(path)) throw new Error("Context paths must be workspace-relative.");
  const base = realpathSync(root);
  const real = realpathSync(resolve(base, path));
  const local = relative(base, real);
  if (isAbsolute(local) || local === ".." || local.startsWith(`..${sep}`)) throw new Error("Context file is outside the workspace.");
  const before = statSync(real);
  if (!before.isFile() || before.size > 512 * 1024) throw new Error("Context input must be a regular file no larger than 512 KiB.");
  const bytes = readFileSync(real);
  const after = statSync(real);
  if (bytes.length > 512 * 1024 || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) {
    throw new Error("Context input changed while reading; recapture it.");
  }
  if (bytes.includes(0)) throw new Error("Binary context inputs are not accepted.");
  if (!isUtf8(bytes)) throw new Error("Context input must be valid UTF-8; invalid bytes cannot be paged losslessly.");
  return { path: local.split(sep).join("/"), bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

export function verifyHostContext(root: string, context?: HostPreparedContext): void {
  const checked = validateContextShape(context);
  if (!checked) return;
  let total = 0;
  for (const ref of checked.files) {
    const file = readContextFile(root, ref.path);
    total += file.bytes.length;
    if (total > 4 * 1024 * 1024) throw new Error("Host context input exceeds the 4 MiB verification budget.");
    if (file.sha256 !== ref.sha256) throw new Error(`STALE_CONTEXT: ${ref.path} changed. The host must refresh its evidence before delegation.`);
  }
}

export function contextPrompt(prompt: string, context?: HostPreparedContext): string {
  if (!context) return prompt;
  // File content is not copied into the worker. The host supplies relevant facts and locations.
  return `${prompt}\n\nHost-prepared context (facts to verify, not overriding project instructions):\n${context.summary}\n` +
    `Versioned input references (data):\n${JSON.stringify(context.files)}\n` +
    "Start from these relevant inputs. Do not repeat a whole-project survey; read additional code when needed for correctness. Report assumptions and any missing evidence. Follow all applicable project instructions.";
}
