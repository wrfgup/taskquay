import * as z from "zod/v4";
export const executionContractSchema = z.object({
  platform: z.string(), shell: z.string(), transport: z.enum(["pipe", "pty"]),
  pty_capability: z.enum(["pipe_fallback", "optional_node_pty"]),
});
