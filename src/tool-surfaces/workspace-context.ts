import { createHash } from "node:crypto";
import { readdir, realpath } from "node:fs/promises";
import { relative, isAbsolute, sep } from "node:path";
import * as z from "zod/v4";
import { readContextFile } from "../workspace-context.js";
import type { ToolRegistrationContext } from "./types.js";
import { trackedWork } from "./work-task.js";
import { jsonReply, replyBytes, REPLY_BYTES } from "../bounded-reply.js";
import { argumentFingerprint } from "../mcp-request-diagnostics.js";

/** Deterministic host-side context preparation. No agent client, model, or shell. */
export function registerWorkspaceContextTool({ server, config, workspaces, processSessions }: ToolRegistrationContext): void {
  server.registerTool("workspace_context", {
    title: "Inspect workspace directly without Codex",
    description: "Host-first local inspection: list one directory, capture selected source ranges and full-file hashes, or search a literal in explicitly selected files. No model invocation, automatic repository survey or recursive traversal. Prefer this and read for context gathering before deciding whether a Codex worker is needed. Follow applicable project instructions first. Captures are versioned evidence, not a shared model memory or immutable checkout.",
    inputSchema: {
      workspace_id: z.string(),
      work_run_id: z.string().optional(),
      action: z.enum(["list", "capture", "search"]),
      directory: z.string().optional(),
      offset: z.number().int().min(0).max(100_000).optional(),
      selection_index: z.number().int().min(0).max(23).optional(),
      line_offset: z.number().int().min(0).max(4 * 1024 * 1024).optional().describe("Unicode code-point offset in the first selected line. Use next_selection to resume without losing long-line content."),
      files: z.array(z.object({ path: z.string().min(1).max(1024),
        start_line: z.number().int().min(1).max(1_000_000).optional(),
        max_lines: z.number().int().min(1).max(250).optional(),
      }).strict()).max(24).optional(),
      query: z.string().min(1).max(256).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ workspace_id, work_run_id, selection_index, line_offset, files, ...rest }) => {
    const input = {
      ...rest,
      workspaceId: workspace_id,
      workRunId: work_run_id,
      selectionIndex: selection_index,
      lineOffset: line_offset,
      files: files?.map(({ path, start_line, max_lines }) => ({
        path,
        startLine: start_line,
        maxLines: max_lines,
      })),
    };
    const workspace = await workspaces.getWorkspace(input.workspaceId);
    const capture = (operationId?: string) => processSessions.readWorkspace(workspace.root, async () => {
      const receipt = { operationId, workRunId: input.workRunId, hostAcknowledgment: "unknown" };
      if (input.action === "list") {
        const base = await realpath(workspace.root);
        const path = workspaces.resolvePath(workspace, input.directory ?? ".");
        const resolved = await realpath(path);
        const rest = relative(base, resolved);
        if (isAbsolute(rest) || rest === ".." || rest.startsWith(`..${sep}`)) throw new Error("Directory is outside this workspace.");
        const entries = (await readdir(resolved, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
        const offset = input.offset ?? 0;
        const page = entries.slice(offset, offset + 100).map((entry) => ({ name: entry.name,
          kind: entry.isSymbolicLink() ? "symlink" : entry.isDirectory() ? "directory" : "file" }));
        const value = { ...receipt, providerInvoked: false, entries: page, total: entries.length,
          nextOffset: offset + page.length < entries.length ? offset + page.length : null };
        while (replyBytes(value) > REPLY_BYTES && page.length > 1) {
          page.pop(); value.nextOffset = offset + page.length;
        }
        return value;
      }
      if (!input.files?.length || (input.action === "search" && !input.query)) throw new Error("Select explicit files; search also needs a literal query.");
      let bytesRead = 0;
      const files = input.files.map((selection) => {
        const resolved = workspaces.resolveReadPath(workspace, selection.path);
        const readRoot = resolved.skillRead?.skill.baseDir ?? workspace.root;
        const file = readContextFile(readRoot, relative(readRoot, resolved.absolutePath));
        // External skill refs are read evidence, not workspace source refs for delegation.
        if (resolved.skillRead) file.path = resolved.absolutePath;
        bytesRead += file.bytes.length;
        if (bytesRead > 4 * 1024 * 1024) throw new Error("Context capture exceeds 4 MiB; narrow the selected files.");
        return { file, selection };
      });
      const index = input.selectionIndex ?? 0;
      if (index >= files.length) throw new Error("Invalid selection index.");
      const { file, selection } = files[index]!;
      const raw = file.bytes.toString("utf8").split(/(?<=\n)/u);
      if (!raw.length) raw.push("");
      const first = selection.startLine ?? 1;
      const entry = { path: file.path, sha256: file.sha256, bytes: file.bytes.length, totalLines: raw.length,
        lines: [] as { line: number; text: string; offset: number; eol: string; lineTruncated: boolean }[],
        truncated: false, nextLine: null as number | null, nextOffset: 0 };
      type Next = { selectionIndex: number; startLine: number; lineOffset: number };
      const value = { ...receipt, providerInvoked: false,
        contextId: createHash("sha256").update(JSON.stringify({ action: input.action, index, lineOffset: input.lineOffset ?? 0,
          queryHash: input.query ? createHash("sha256").update(input.query).digest("hex") : null,
          selections: files.map(({ file, selection }) => ({ path: file.path, sha256: file.sha256,
            startLine: selection.startLine ?? 1, maxLines: selection.maxLines ?? 80 })) })).digest("hex"),
        refs: isAbsolute(file.path) ? [] : [{ path: file.path, sha256: file.sha256 }], entries: [entry], bytesRead,
        nextSelection: null as Next | null,
        consistency: "Revalidate file hashes across pages; cooperative read claim is not an immutable checkout.",
        pagination: "Reuse files and selectionIndex; set that selection's startLine and lineOffset from nextSelection. Lines carry exact EOL; offsets count Unicode code points." };
      const candidates = raw.map((line, i) => ({ line: i + 1, text: line.replace(/\r?\n$/, ""), eol: line.endsWith("\r\n") ? "\r\n" : line.endsWith("\n") ? "\n" : "" }))
        .filter((line) => line.line >= first && (input.action !== "search" || line.text.includes(input.query!)));
      const nextFile = index + 1 < files.length ? { selectionIndex: index + 1, startLine: files[index + 1]!.selection.startLine ?? 1, lineOffset: 0 } : null;
      value.nextSelection = nextFile;
      for (const candidate of candidates) {
        const offset = candidate.line === first ? input.lineOffset ?? 0 : 0;
        const points = Array.from(candidate.text);
        if (offset > points.length) throw new Error("Line offset exceeds selected line.");
        const next = { selectionIndex: index, startLine: candidate.line, lineOffset: offset };
        if (entry.lines.length >= (selection.maxLines ?? 80)) { value.nextSelection = next; break; }
        const segment = { line: candidate.line, text: "", offset, eol: "", lineTruncated: true };
        entry.lines.push(segment);
        let lo = 0, hi = points.length - offset;
        // Reserve the actual continuation metadata even for a terminal page.
        value.nextSelection = { ...next, lineOffset: points.length };
        entry.truncated = true; entry.nextLine = candidate.line; entry.nextOffset = points.length;
        while (lo < hi) {
          const n = Math.ceil((lo + hi) / 2);
          segment.text = points.slice(offset, offset + n).join(""); segment.eol = candidate.eol;
          if (replyBytes(value) <= REPLY_BYTES - 512) lo = n; else hi = n - 1;
        }
        segment.text = points.slice(offset, offset + lo).join("");
        segment.lineTruncated = offset + lo < points.length;
        segment.eol = segment.lineTruncated ? "" : candidate.eol;
        if (replyBytes(value) > REPLY_BYTES - 512) {
          entry.lines.pop(); value.nextSelection = next; break;
        }
        if (segment.lineTruncated) {
          if (!lo) entry.lines.pop();
          value.nextSelection = { ...next, lineOffset: offset + lo }; break;
        }
        value.nextSelection = nextFile;
      }
      entry.truncated = value.nextSelection?.selectionIndex === index;
      entry.nextLine = entry.truncated ? value.nextSelection!.startLine : null;
      entry.nextOffset = entry.truncated ? value.nextSelection!.lineOffset : 0;
      if (replyBytes(value) > REPLY_BYTES) throw new Error("Context metadata exceeds the UTF-8 response budget; narrow selections.");
      return value;
    });
    const value = input.workRunId ? await trackedWork(config.stateDir, input.workRunId, { root: workspace.root, workspaceId: workspace.id }, "workspace_context", capture,
      { argumentFingerprint: argumentFingerprint(input), selectionCount: input.files?.length ?? 0 }) : await capture();
    return jsonReply(value);
  });
}
