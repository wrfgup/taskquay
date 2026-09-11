import * as z from "zod/v4";
import { registerAgentTaskTool } from "./agent-task.js";
import { trackedWork } from "./work-task.js";
import {
  editFileTool,
  runShellTool,
  writeFileTool,
} from "../pi-tools.js";
import {
  EDIT_TOOL_ANNOTATIONS,
  shellToolAnnotations,
  WRITE_TOOL_ANNOTATIONS,
  toolNames,
  workspaceIdDescription,
  type ToolInstructionContext,
  type ToolRegistrationContext,
} from "./types.js";
import {
  contentText,
  countDiffStats,
  logFailedToolResponse,
  logToolCall,
  resultOutputSchema,
  textBlock,
} from "./shared.js";

const CLAUDE_INSTRUCTIONS = `Follow instructions returned by ${toolNames.openWorkspace}; read applicable instruction and skill files before working in their scope.`;

export function claudeInstructions({
  agents,
  skills,
}: ToolInstructionContext): string {
  return `${agents}${skills}${CLAUDE_INSTRUCTIONS} Begin a work_task run even for host-only work; propagate workRunId to reads, mutations, commands and agent tasks. Finish with explicit acceptance evidence and include the returned Codex usage/completeness receipt in the final response. Read project context directly as the host with read or workspace_context before deciding to delegate. These tools do not invoke Codex; do not start workers merely to browse directories, summarize known logs or wait. Use agent_task for subagent control, not shell wrappers. Pass relevant versioned evidence and continue related sessions. Verified readers share bounded access; writes and unknown-effect commands remain exclusive.`;
}

export function registerClaudeTools(context: ToolRegistrationContext): void {
  registerAgentTaskTool(context);
  registerClaudeMutationTools(context);
  registerShellTool(context);
}

const CLAUDE_SHELL_DESCRIPTION = "Run a shell command in a workspace with the user's local permissions.";

function registerClaudeMutationTools(context: ToolRegistrationContext): void {
  const { server, config, workspaces, processSessions } = context;

  server.registerTool(
    toolNames.write,
    {
      title: "Write file",
      description: "Create or completely overwrite a file in a workspace.",
      inputSchema: {
        work_run_id: z.string().optional(),
        workspace_id: z.string().describe(workspaceIdDescription),
        path: z
          .string()
          .describe("File path to write, relative to the workspace root."),
        content: z.string().describe("Complete new file content."),
      },
      outputSchema: resultOutputSchema(),
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async ({ workspace_id, work_run_id, ...input }) => {
      const startedAt = performance.now();
      const workspaceId = workspace_id;
      const workRunId = work_run_id;
      const workspace = await workspaces.getWorkspace(workspaceId);
      workspaces.resolvePath(workspace, input.path);
      const response = await trackedWork(config.stateDir, workRunId, { root: workspace.root, workspaceId }, "write", () => processSessions.mutate(workspace.root, () => writeFileTool(input, {
        cwd: workspace.root,
        root: workspace.root,
      })));

      if (response.isError) {
        logFailedToolResponse(
          config,
          {
            tool: toolNames.write,
            workspaceId,
            path: input.path,
          },
          response.content,
          startedAt,
        );
        return response;
      }

      logToolCall(config, {
        tool: toolNames.write,
        workspaceId,
        path: input.path,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        ...response,
        structuredContent: {
          result: contentText(response.content),
        },
      };
    },
  );

  server.registerTool(
    toolNames.edit,
    {
      title: "Edit file",
      description:
        "Edit one file in a workspace by replacing exact text blocks. Each old_text must match a unique, non-overlapping region of the original file.",
      inputSchema: {
        work_run_id: z.string().optional(),
        workspace_id: z.string().describe(workspaceIdDescription),
        path: z
          .string()
          .describe("File path to edit, relative to the workspace root."),
        edits: z
          .array(
            z.object({
              old_text: z
                .string()
                .describe(
                  "Exact text to replace. Must match uniquely in the original file.",
                ),
              new_text: z.string().describe("Replacement text."),
            }),
          )
          .min(1),
      },
      outputSchema: resultOutputSchema({
        status: z.literal("applied"),
      }),
      annotations: EDIT_TOOL_ANNOTATIONS,
    },
    async ({ workspace_id, work_run_id, edits, ...input }) => {
      const startedAt = performance.now();
      const workspaceId = workspace_id;
      const workRunId = work_run_id;
      const workspace = await workspaces.getWorkspace(workspaceId);
      workspaces.resolvePath(workspace, input.path);
      const response = await trackedWork(config.stateDir, workRunId, { root: workspace.root, workspaceId }, "edit", () => processSessions.mutate(workspace.root, () => editFileTool({
        ...input,
        edits: edits.map(({ old_text, new_text }) => ({
          oldText: old_text,
          newText: new_text,
        })),
      }, {
        cwd: workspace.root,
        root: workspace.root,
      })));

      if (response.isError) {
        logFailedToolResponse(
          config,
          {
            tool: toolNames.edit,
            workspaceId,
            path: input.path,
          },
          response.content,
          startedAt,
        );
        return response;
      }

      const stats = countDiffStats(
        response.details?.patch ?? response.details?.diff,
      );
      const editResultText = `Edited ${input.path} (+${stats.additions} -${stats.removals}).`;
      const editContent = [textBlock(editResultText)];
      logToolCall(config, {
        tool: toolNames.edit,
        workspaceId,
        path: input.path,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        content: editContent,
        structuredContent: {
          status: "applied",
          result: contentText(editContent),
        },
      };
    },
  );
}

function registerShellTool(context: ToolRegistrationContext): void {
  const { server, config, workspaces, processSessions } = context;

  server.registerTool(
    toolNames.shell,
    {
      title: "Bash",
      description: CLAUDE_SHELL_DESCRIPTION,
      inputSchema: {
        work_run_id: z.string().optional(),
        workspace_id: z.string().describe(workspaceIdDescription),
        command: z
          .string()
          .describe("Shell command to execute."),
        working_directory: z
          .string()
          .optional()
          .describe(
            "Optional working directory relative to the workspace root. Defaults to the workspace root.",
          ),
        timeout: z
          .number()
          .positive()
          .max(300)
          .optional()
          .describe("Timeout in seconds. Defaults to 30, max 300."),
      },
      outputSchema: resultOutputSchema(),
      annotations: shellToolAnnotations(config),
    },
    async ({ workspace_id, working_directory, work_run_id, ...input }) => {
      const startedAt = performance.now();
      const workspaceId = workspace_id;
      const workingDirectory = working_directory;
      const workRunId = work_run_id;
      const workspace = await workspaces.getWorkspace(workspaceId);
      const cwd = workspaces.resolveWorkingDirectory(
        workspace,
        workingDirectory,
      );
      const response = await trackedWork(config.stateDir, workRunId, { root: workspace.root, workspaceId }, "bash", () => processSessions.mutate(workspace.root, () => runShellTool(input, {
        cwd,
        root: workspace.root,
      })));

      if (response.isError) {
        logFailedToolResponse(
          config,
          {
            tool: toolNames.shell,
            workspaceId,
            workingDirectory: workingDirectory ?? ".",
            command: input.command,
            commandLength: input.command.length,
          },
          response.content,
          startedAt,
        );
        return response;
      }

      logToolCall(config, {
        tool: toolNames.shell,
        workspaceId,
        workingDirectory: workingDirectory ?? ".",
        command: input.command,
        commandLength: input.command.length,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        ...response,
        structuredContent: {
          result: contentText(response.content),
        },
      };
    },
  );
}
