import { createHash } from "node:crypto";
import type { Request, Response } from "express";

type RecordEvent = (event: string, fields: Record<string, unknown>, level?: "info" | "warn" | "error") => void;
const methods = new Set(["initialize", "server/discover", "tools/list", "tools/call", "resources/list", "resources/read", "resources/templates/list", "notifications/initialized", "ping"]);
const tools = new Set(["open_workspace", "read", "workspace_context", "work_task", "agent_task", "exec_command", "write_stdin", "apply_patch", "show_changes", "write", "edit", "bash"]);
const actions = new Set(["begin", "record", "finish", "get", "list", "snapshot", "history", "start", "continue", "observe", "claims", "usage", "cancelQueued", "capture", "search"]);
const errorCodes = new Set(["WORK_STATE", "INVALID_TASK", "AGENT_CONFLICT", "EXECUTION_CONFLICT", "STALE_CONTEXT", "ACCESS_DENIED", "WORKSPACE_NOT_FOUND", "WORKSPACE_MISMATCH", "AGENT_NOT_FOUND"]);
const object = (value: unknown): Record<string, any> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
const known = (value: unknown, allowed: Set<string>) => typeof value === "string" && allowed.has(value) ? value : "other";
const identity = (value: unknown, prefix: string) => typeof value === "string" && new RegExp(`^${prefix}_[a-f0-9]{6,64}$`).test(value) ? value : undefined;

export function argumentFingerprint(args: Record<string, any>): string {
  const normalize = (value: any): any => Array.isArray(value) ? value.map(normalize)
    : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalize(value[key])])) : value;
  const selection = Array.isArray(args.files) ? args.files.map((file: any) => ({ path: String(file?.path ?? "").replaceAll("\\", "/"),
    startLine: file?.startLine ?? 1, maxLines: file?.maxLines ?? 80 })) : undefined;
  return createHash("sha256").update(JSON.stringify(normalize({ ...args,
    ...(typeof args.path === "string" ? { path: args.path.replaceAll("\\", "/") } : {}),
    ...(typeof args.directory === "string" ? { directory: args.directory.replaceAll("\\", "/") } : {}),
    ...(selection ? { files: selection } : {}) }))).digest("hex");
}

/** Metadata only. Never log request arguments, result text, headers, or raw errors.
 * This boundary also sees schema/auth failures that never enter a tool handler. */
export function traceMcpRequest(req: Request, res: Response, requestId: string, record: RecordEvent): void {
  const body = object(req.body), params = object(body.params), args = object(params.arguments);
  const session = object(params._meta)["openai/session"];
  const context = { requestId, method: known(body.method, methods),
    ...(body.method === "tools/call" ? { tool: known(params.name, tools), action: known(args.action, actions),
      workspaceId: identity(args.workspace_id ?? args.workspaceId, "ws"), workRunId: identity(args.work_run_id ?? args.workRunId, "run"), agentId: identity(args.agent_id ?? args.agentId, "agt") } : {}),
    argumentFingerprint: argumentFingerprint(args), selectionCount: Array.isArray(args.files) ? args.files.length : typeof args.path === "string" ? 1 : 0,
    conversationHash: typeof session === "string" && session.length <= 1024
      ? createHash("sha256").update(JSON.stringify(session)).digest("hex").slice(0, 24) : undefined };
  const started = performance.now(), limit = 64 * 1024;
  let bytes = 0, capturedBytes = 0, done = false;
  const chunks: Buffer[] = [], hash = createHash("sha256");
  const capture = (chunk: unknown, encoding?: unknown) => {
    if (chunk === undefined || chunk === null) return;
    const value = typeof chunk === "string" ? Buffer.from(chunk, typeof encoding === "string" ? encoding as BufferEncoding : "utf8")
      : Buffer.isBuffer(chunk) ? chunk : chunk instanceof Uint8Array ? Buffer.from(chunk) : undefined;
    if (!value) return;
    bytes += value.length; hash.update(value);
    if (bytes <= limit) { chunks.push(Buffer.from(value)); capturedBytes += value.length; }
    else { chunks.length = 0; capturedBytes = 0; }
  };
  const write = res.write, end = res.end;
  res.write = function (this: Response, ...args: any[]) { capture(args[0], args[1]); return (write as any).apply(this, args); } as Response["write"];
  res.end = function (this: Response, ...args: any[]) { capture(args[0], args[1]); return (end as any).apply(this, args); } as Response["end"];
  // Logging failures must never alter transport/tool semantics.
  const emit: RecordEvent = (...args) => { try { record(...args); } catch {} };
  emit("mcp_exchange_started", context);
  const finish = () => {
    if (done) return; done = true;
    let result: Record<string, unknown> = { resultInspection: bytes > limit ? "over_limit" : "unrecognized" };
    if (capturedBytes) {
      const text = Buffer.concat(chunks).toString("utf8");
      const messages = String(res.getHeader("content-type") ?? "").includes("text/event-stream")
        ? text.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()) : [text];
      for (const message of messages) {
        try {
          const envelope = object(JSON.parse(message));
          if (!("result" in envelope) && !("error" in envelope)) continue;
          const payload = object(envelope.result), error = object(envelope.error);
          const structured = object(payload.structuredContent);
          const content = Array.isArray(payload.content) ? payload.content : [];
          result = { resultInspection: "inspected", rpcErrorCode: Number.isInteger(error.code) ? error.code : undefined,
            operationId: identity(structured.operation_id ?? structured.operationId, "op"),
            toolError: payload.isError === true, contentBlocks: content.length,
            textBytes: content.reduce((n: number, block: any) => n + (typeof block?.text === "string" ? Buffer.byteLength(block.text) : 0), 0),
            structuredContentPresent: payload.structuredContent !== undefined };
          // Report only presence of receipt layers; values/errors may be private.
          for (const block of content) {
            if (block?.type !== "text" || typeof block.text !== "string") continue;
            try {
              const value = object(JSON.parse(block.text));
              result.operationId = identity(value.operation_id ?? value.operationId, "op") ?? result.operationId;
              result.receiptPresent = result.receiptPresent === true || "completionReceipt" in value || "completionSnapshot" in value || "receipt" in value || "workRunId" in value || "work_run_id" in value;
              if (typeof value.code === "string") result.toolErrorCode = known(value.code, errorCodes);
              if (typeof value.message === "string" && payload.isError === true) result.errorFingerprint = createHash("sha256").update(value.message).digest("hex").slice(0, 16);
            } catch { /* Non-JSON text is never returned to logs. */ }
          }
        } catch { /* No raw malformed response in diagnostics. */ }
      }
    }
    emit("mcp_exchange_finished", { ...context, httpStatus: res.statusCode, aborted: !res.writableFinished,
      transportStatus: res.writableFinished ? "finished" : "aborted", hostAcknowledgment: "unknown",
      durationMs: Math.round(performance.now() - started), responseBytes: bytes, responseSha256: hash.digest("hex"),
      responseFormat: String(res.getHeader("content-type") ?? "").includes("text/event-stream") ? "sse"
        : String(res.getHeader("content-type") ?? "").includes("application/json") ? "json" : "other",
      ...result }, !res.writableFinished ? "warn" : "info");
    chunks.length = 0;
    res.off("finish", finish); res.off("close", finish);
  };
  res.once("finish", finish); res.once("close", finish);
}
