import * as z from "zod/v4";
import {
  LOCAL_AGENT_PROVIDERS,
  type LocalAgentProvider,
} from "./local-agent-profiles.js";

const providerSchema = z.object({
  id: z.enum(LOCAL_AGENT_PROVIDERS as [LocalAgentProvider, ...LocalAgentProvider[]]),
  enabled: z.boolean(),
  model: z.string().trim().min(1).optional(),
  effort: z.string().trim().min(1).optional(),
  reasoningLimits: z.array(z.object({
    model: z.string().trim().regex(/^[a-z0-9][a-z0-9._-]*$/),
    maxEffort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]),
  }).strict()).max(32).optional(),
  writeMode: z.enum(["read_only", "allowed", "full_access"]).optional(),
  readOnlyDefaults: z.object({
    model: z.string().trim().min(1).optional(),
    effort: z.string().trim().min(1).optional(),
  }).strict().optional(),
  historyHandoff: z.enum(["disabled", "verified-unsupported"]).optional()
    .describe("Owner opt-in for a traced fresh-thread handoff only after Codex explicitly rejects paginated history resume."),
}).strict();

export const subagentsConfigSchema = z.object({
  enabled: z.boolean(),
  instructions: z.enum(["on-demand", "preload"]).default("on-demand"),
  providers: z.array(providerSchema),
  maxConcurrentAgents: z.number().int().min(1).max(16).optional(),
  maxConcurrentReaders: z.number().int().min(1).max(8).optional(),
  queueWaitMs: z.number().int().min(0).max(900_000).optional(),
  maxNewSessionsPerWorkItem: z.number().int().min(1).max(16).optional(),
  sharedResources: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/)).max(16).optional(),
}).strict().superRefine((value, context) => {
  const seen = new Set<LocalAgentProvider>();
  for (const [index, provider] of value.providers.entries()) {
    if (provider.reasoningLimits?.length && provider.id !== "codex") {
      context.addIssue({ code: "custom", path: ["providers", index, "reasoningLimits"],
        message: "Reasoning limits currently support only the Codex provider." });
    }
    if (provider.historyHandoff && provider.id !== "codex") {
      context.addIssue({ code: "custom", path: ["providers", index, "historyHandoff"],
        message: "History handoff currently supports only the Codex provider." });
    }
    if (seen.has(provider.id)) {
      context.addIssue({
        code: "custom",
        path: ["providers", index, "id"],
        message: `Duplicate subagent provider: ${provider.id}`,
      });
    }
    seen.add(provider.id);
  }
});

export const storedSubagentsConfigSchema = z.union([
  z.boolean(),
  subagentsConfigSchema,
]);

export type SubagentProviderConfig = z.infer<typeof providerSchema>;
export type SubagentsConfig = z.infer<typeof subagentsConfigSchema>;
export type StoredSubagentsConfig = z.infer<typeof storedSubagentsConfigSchema>;

export function subagentProviderConfig(
  config: SubagentsConfig,
  provider: LocalAgentProvider,
): SubagentProviderConfig | undefined {
  return config.providers.find((entry) => entry.id === provider);
}

export function isSubagentProviderEnabled(
  config: SubagentsConfig,
  provider: LocalAgentProvider,
): boolean {
  return config.enabled && subagentProviderConfig(config, provider)?.enabled === true;
}
