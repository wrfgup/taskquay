import * as z from "zod/v4";
import { executionContractSchema } from "../execution-contract-schema.js";
import { registerAgentTaskTool } from "./agent-task.js";
import { applyPatch } from "../apply-patch.js";
import {
  MAX_PROCESS_YIELD_MS,
  type ProcessSnapshot,
} from "../process-sessions.js";
import { trackedWork } from "./work-task.js";
import { argumentFingerprint } from "../mcp-request-diagnostics.js";
import { textPage } from "../bounded-reply.js";
import {
  EDIT_TOOL_ANNOTATIONS,
  shellToolAnnotations,
  toolNames,
  workspaceIdDescription,
  type ToolRegistrationContext,
} from "./types.js";
import {
  contentText,
  resultOutputSchema,
  runLoggedToolOperation,
  textBlock,
} from "./shared.js";

type CodexRegistration = (context: ToolRegistrationContext) => void;

const CODEX_INSTRUCTIONS = `Read project context directly as the host with ${toolNames.read} or workspace_context before deciding to delegate. Those tools do not invoke Codex. Do not start a worker just to browse directories, summarize known logs or wait. Use apply_patch for file modifications, exec_command for commands, and write_stdin for running processes. Use agent_task (not shell wrappers) for subagent control. Provide only relevant host-prepared evidence, continue related sessions, and use a separate context when independent review is needed. Verified readers share bounded source access; mutations and unknown-effect commands remain exclusive. Declare shared build/device resources across worktrees. Never bypass claims using another path or state directory. Shell commands still have local-user authority, not an OS sandbox. Follow workspace instructions and applicable skills.`;

export function codexInstructions(): string {
  return "Begin a work_task run even for host-only work; propagate workRunId through read/context/mutation/command/agent tools. Finish with acceptance evidence after child operations stop and include the returned Codex usage and completeness in the final answer. If a response is lost or a tool fails, use work_task snapshot/history only when exposed by your host schema; otherwise use get and available process/agent observe tools. The server cannot force ChatGPT to refresh its schema. Never blindly replay commands, writes, deployments or agent starts: they may already have taken effect. Empty polls replay bounded terminal receipts for up to five minutes subject to a count cap; earlier running reads drain output and cannot be recovered. A running work run alone does not prove child work is active. Use the returned execution platform/shell, never assume PowerShell or Bash from the host environment. " + CODEX_INSTRUCTIONS;
}

export function registerCodexTools(context: ToolRegistrationContext): void {
  for (const register of CODEX_REGISTRATIONS) {
    register(context);
  }
}

const CODEX_REGISTRATIONS: readonly CodexRegistration[] = [
  registerAgentTaskTool,
  registerApplyPatchTool,
  registerCodexProcessTools,
];

function processResult(snapshot: ProcessSnapshot): string {
  const status = snapshot.running
    ? `Process running with session ID ${snapshot.sessionId}.`
    : snapshot.signal
      ? `Process exited after signal ${snapshot.signal}.`
      : `Process exited with code ${snapshot.exitCode ?? "unknown"}.`;
  const correlation = snapshot.operationId ? `\nWork run ${snapshot.workRunId}; operation ${snapshot.operationId}.` : "";
  const recovery = !snapshot.running && (snapshot.exitCode !== 0 || snapshot.signal)
    ? "\nInspect the failure and any side effects before retrying; do not blindly replay this command." : "";
  const output = snapshot.output
    ? `${snapshot.output.replace(/\n$/, "")}\n${status}`
    : status;
  return output + correlation + recovery + `\nSession ${snapshot.sessionId}; phase=${snapshot.phase}; terminalReplay=${snapshot.terminalReplay}; outputScope=${snapshot.outputScope}. Execution: ${JSON.stringify(snapshot.execution)}.`;
}

function processOutputSchema(): z.ZodRawShape {
  return resultOutputSchema({
    execution: executionContractSchema,
    phase: z.enum(["running", "root_exited_stdio_open", "closed"]),
    root_exited_elapsed_ms: z.number().nonnegative().optional(),
    terminal_replay: z.boolean(),
    output_scope: z.literal("since_previous_read"),
    operation_id: z.string().optional(),
    work_run_id: z.string().optional(),
    session_id: z.number().optional(),
    running: z.boolean(),
    exit_code: z.number().int().optional(),
    signal: z.string().optional(),
    wall_time_ms: z.number().nonnegative(),
    output_truncated: z.boolean(),
  });
}

function processToolResponse(snapshot: ProcessSnapshot) {
  const page = textPage(snapshot.output, 0, 16 * 1024);
  if (page.nextOffset !== null) snapshot = { ...snapshot, output: page.text + "\n[Response byte budget reached; full output hash is in work_task get metadata.]", outputTruncated: true };
  const result = processResult(snapshot);
  const content = [textBlock(result)];
  return {
    content,
    structuredContent: {
      result,
      execution: {
        platform: snapshot.execution.platform,
        shell: snapshot.execution.shell,
        transport: snapshot.execution.transport,
        pty_capability: snapshot.execution.ptyCapability,
      },
      phase: snapshot.phase,
      root_exited_elapsed_ms: snapshot.rootExitedElapsedMs,
      terminal_replay: snapshot.terminalReplay,
      output_scope: snapshot.outputScope,
      operation_id: snapshot.operationId,
      work_run_id: snapshot.workRunId,
      session_id: snapshot.sessionId,
      running: snapshot.running,
      exit_code: snapshot.exitCode,
      signal: snapshot.signal,
      wall_time_ms: snapshot.wallTimeMs,
      output_truncated: snapshot.outputTruncated,
    },
  };
}

function registerApplyPatchTool(context: ToolRegistrationContext): void {
  const { server, config, workspaces, processSessions } = context;

  server.registerTool(
    "apply_patch",
    {
      title: "Apply patch",
      description:
        "Apply one Codex-style patch in a workspace. Supports adding, overwriting, updating, deleting, and moving files. Use this for all file modifications. Paths must be relative to the workspace.",
      inputSchema: {
        workspace_id: z.string().describe(workspaceIdDescription),
        work_run_id: z.string().optional(),
        request_key: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/).optional().describe("Stable mutation identity within work_run_id. A repeated key returns a recovery error without reapplying the patch."),
        patch: z
          .string()
          .describe(
            "Patch text enclosed by *** Begin Patch and *** End Patch markers.",
          ),
      },
      outputSchema: resultOutputSchema({
        additions: z.number(),
        removals: z.number(),
        files: z.array(
          z.object({
            path: z.string(),
            previous_path: z.string().optional(),
            operation: z.enum(["add", "update", "delete", "move"]),
          }),
        ),
      }),
      annotations: EDIT_TOOL_ANNOTATIONS,
    },
    async ({ workspace_id, work_run_id, patch, request_key }) => {
      const workspaceId = workspace_id;
      const workRunId = work_run_id;
      const requestKey = request_key;
      if (requestKey && !workRunId) throw new Error("requestKey requires workRunId.");
      let operationId: string | undefined;
      const startedAt = performance.now();
      const applied = await runLoggedToolOperation(
        config,
        { tool: "apply_patch", workspaceId },
        startedAt,
        async () => {
          const workspace = await workspaces.getWorkspace(workspaceId);
          return trackedWork(config.stateDir, workRunId, { root: workspace.root, workspaceId }, "apply_patch",
            (id) => { operationId = id; return processSessions.mutate(workspace.root, () => applyPatch(workspace.root, patch)); },
            { argumentFingerprint: argumentFingerprint({ patch }), selectionCount: 0, requestKey });
        },
      );
      const paths = applied.files.map((file) => file.path).join(", ");
      const result = `Applied patch to ${applied.files.length} file(s): ${paths}`;
      const content = [textBlock(result)];

      return {
        content,
        structuredContent: {
          result,
          operation_id: operationId,
          work_run_id: workRunId,
          host_acknowledgment: "unknown",
          additions: applied.additions,
          removals: applied.removals,
          files: applied.files.map(({ previousPath, ...file }) => ({
            ...file,
            previous_path: previousPath,
          })),
        },
      };
    },
  );
}

function registerCodexProcessTools(context: ToolRegistrationContext): void {
  const { server, config, workspaces, processSessions } = context;

  server.registerTool(
    "exec_command",
    {
      title: "Execute command",
      description:
        "Run a command with the local user's authority. Commands are not sandboxed; workspace validation only selects the initial working directory. Returns the result when it exits during the yield window, otherwise returns a session_id to continue with write_stdin. Use this for file inspection, tests, builds, package scripts, and long-running processes. After failure or a missing response, inspect the existing work run before retrying; side effects may already have occurred. Never automatically replay deployments or other mutations.",
      inputSchema: {
        workspace_id: z.string().describe(workspaceIdDescription),
        cmd: z.string().min(1).describe("Shell command to execute."),
        request_key: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/).optional().describe("Stable command identity within work_run_id; a repeated key never runs the command again. Recover using work_task get."),
        work_run_id: z.string().optional().describe("Work run whose command remains active until the process exits, not merely until the first yield."),
        resources: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/)).max(16).optional()
          .describe("Additional exclusive resource keys for shared build outputs/devices. Checkout exclusion is automatic."),
        tty: z
          .boolean()
          .optional()
          .describe(
            "Request a pseudo-terminal. Windows uses a pipe fallback; other platforms require optional node-pty. See execution in the response. Defaults to false.",
          ),
        columns: z
          .number()
          .int()
          .min(1)
          .max(1_000)
          .optional()
          .describe("Initial PTY width. Defaults to 80."),
        rows: z
          .number()
          .int()
          .min(1)
          .max(1_000)
          .optional()
          .describe("Initial PTY height. Defaults to 24."),
        working_directory: z
          .string()
          .optional()
          .describe(
            "Working directory relative to the workspace root. Defaults to the workspace root.",
          ),
        yield_time_ms: z
          .number()
          .int()
          .min(0)
          .max(MAX_PROCESS_YIELD_MS)
          .optional()
          .describe(
            "Milliseconds to wait before returning a running session. Defaults to 10000, maximum 12000. Use write_stdin for work that runs longer.",
          ),
        max_output_tokens: z
          .number()
          .int()
          .positive()
          .max(100_000)
          .optional()
          .describe("Approximate output token budget. Defaults to 10000."),
      },
      outputSchema: processOutputSchema(),
      annotations: shellToolAnnotations(config),
    },
    async ({
      workspace_id,
      cmd,
      request_key,
      work_run_id,
      tty,
      columns,
      rows,
      working_directory,
      yield_time_ms,
      max_output_tokens,
      resources,
    }) => {
      const startedAt = performance.now();
      const workspaceId = workspace_id;
      const workingDirectory = working_directory;
      const yieldTimeMs = yield_time_ms;
      const maxOutputTokens = max_output_tokens;
      const requestKey = request_key;
      const workRunId = work_run_id;
      const snapshot = await runLoggedToolOperation(
        config,
        {
          tool: "exec_command",
          workspaceId,
          workingDirectory: workingDirectory ?? ".",
          command: cmd,
          commandLength: cmd.length,
        },
        startedAt,
        async () => {
          const workspace = await workspaces.getWorkspace(workspaceId);
          const cwd = workspaces.resolveWorkingDirectory(
            workspace,
            workingDirectory,
          );
          return processSessions.start({
            workspaceId,
            command: cmd,
            requestKey,
            workRunId,
            cwd,
            workspaceRoot: workspace.root,
            tty,
            columns,
            rows,
            yieldTimeMs,
            maxOutputTokens,
            resources,
          });
        },
      );

      return processToolResponse(snapshot);
    },
  );

  server.registerTool(
    "write_stdin",
    {
      title: "Write to process",
      description:
        "Poll or write characters to a process returned by exec_command. Empty polls replay the same bounded terminal receipt within five minutes, subject to a count cap. Running polls drain output; earlier consumed text is not recoverable. Terminal replay ignores new output budgets. Never resend nonempty chars blindly. Pass \\u0003 to send Ctrl-C. Use work_task snapshot/history only if exposed by the host; otherwise get and available observe tools. Do not restart a command to recover output.",
      inputSchema: {
        workspace_id: z
          .string()
          .describe("Workspace identifier used to start the process."),
        session_id: z
          .number()
          .describe("Process session identifier returned by exec_command."),
        chars: z
          .string()
          .optional()
          .describe(
            "Characters to write. Omit or pass an empty string to poll.",
          ),
        columns: z
          .number()
          .int()
          .min(1)
          .max(1_000)
          .optional()
          .describe("Resize a PTY to this width."),
        rows: z
          .number()
          .int()
          .min(1)
          .max(1_000)
          .optional()
          .describe("Resize a PTY to this height."),
        yield_time_ms: z
          .number()
          .int()
          .min(0)
          .max(MAX_PROCESS_YIELD_MS)
          .optional()
          .describe(
            "Milliseconds to wait for process output or completion. Maximum 12000; polling defaults to 5000 and interactive writes to 250.",
          ),
        max_output_tokens: z
          .number()
          .int()
          .positive()
          .max(100_000)
          .optional()
          .describe("Approximate output token budget. Defaults to 10000."),
      },
      outputSchema: processOutputSchema(),
      annotations: shellToolAnnotations(config),
    },
    async ({
      workspace_id,
      session_id,
      chars,
      columns,
      rows,
      yield_time_ms,
      max_output_tokens,
    }) => {
      const startedAt = performance.now();
      const workspaceId = workspace_id;
      const sessionId = session_id;
      const yieldTimeMs = yield_time_ms;
      const maxOutputTokens = max_output_tokens;
      const snapshot = await runLoggedToolOperation(
        config,
        { tool: "write_stdin", workspaceId },
        startedAt,
        async () => {
          await workspaces.getWorkspace(workspaceId);
          return processSessions.write({
            workspaceId,
            sessionId,
            chars,
            columns,
            rows,
            yieldTimeMs,
            maxOutputTokens,
          });
        },
      );

      return processToolResponse(snapshot);
    },
  );
}
