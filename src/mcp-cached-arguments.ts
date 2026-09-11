import { isDeepStrictEqual } from "node:util";

// Only actual former DevSpace fields, not a recursive case converter. Canonical
// validation still enforces tool availability, permissions, types and bounds.
const common = { workspaceId: "workspace_id", workRunId: "work_run_id" };
const aliases: Record<string, Record<string, string>> = {
  open_workspace: { baseRef: "base_ref", createDirectory: "create_directory" },
  read: { ...common, responseOffset: "response_offset" },
  workspace_context: { ...common, selectionIndex: "selection_index" },
  work_task: { ...common, workItemId: "work_item_id", runKey: "run_key", requestKey: "request_key", hostModelLabel: "host_model_label" },
  agent_task: { ...common, agentId: "agent_id", taskKey: "task_key", readOnly: "read_only", workItemId: "work_item_id",
    contextKey: "context_key", freshContext: "fresh_context", requestKey: "request_key", waitMs: "wait_ms",
    knownRevision: "known_revision", includeResponse: "include_response", responseOffset: "response_offset" },
  apply_patch: common,
  exec_command: { ...common, workingDirectory: "working_directory", yieldTimeMs: "yield_time_ms", maxOutputTokens: "max_output_tokens" },
  write_stdin: { ...common, sessionId: "session_id", yieldTimeMs: "yield_time_ms", maxOutputTokens: "max_output_tokens" },
  show_changes: { workspaceId: "workspace_id" },
};
const fileAliases = { startLine: "start_line", maxLines: "max_lines", lineOffset: "line_offset" };
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
export class ConflictingToolAliasError extends Error {
  constructor() { super("Conflicting legacy and canonical tool fields; no operation was performed."); }
}
function normalize(values: Record<string, unknown>, mapping: Record<string, string>): Record<string, unknown> {
  const output = { ...values };
  for (const [legacy, canonical] of Object.entries(mapping)) {
    if (!Object.hasOwn(values, legacy)) continue;
    if (Object.hasOwn(values, canonical) && !isDeepStrictEqual(values[legacy], values[canonical])) throw new ConflictingToolAliasError();
    output[canonical] = values[legacy];
    delete output[legacy];
  }
  return output;
}
export function normalizeCachedToolCall(body: unknown): unknown {
  if (!record(body) || body.method !== "tools/call" || !record(body.params)) return body;
  const params = body.params;
  if (typeof params.name !== "string" || !Object.hasOwn(aliases, params.name) || !record(params.arguments)) return body;
  const arguments_ = normalize(params.arguments, aliases[params.name]!);
  if (params.name === "workspace_context" && Array.isArray(arguments_.files)) {
    arguments_.files = arguments_.files.map((file) => record(file) ? normalize(file, fileAliases) : file);
  }
  return { ...body, params: { ...params, arguments: arguments_ } };
}
