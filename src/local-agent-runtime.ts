import type { Result } from "better-result";
import type { AgentProviderError } from "./local-agent-errors.js";
import type { LocalAgentProvider } from "./local-agent-profiles.js";
import type { ProviderThreadObservation } from "./work-ledger.js";
import type { AgentUsageObservation } from "./agent-usage.js";
import type { AgentActivity } from "./agent-progress.js";

export type LocalAgentWriteMode = "read_only" | "allowed" | "full_access";

export interface LocalAgentRunInput {
  prompt: string;
  workspaceRoot: string;
  providerSessionId?: string;
  writeMode?: LocalAgentWriteMode;
  model?: string;
  effort?: string;
  modelOverrideRequested?: boolean;
  effortOverrideRequested?: boolean;
  /** Adapter-owned strict static-analysis policy; never just a prompt assertion. */
  analysisOnly?: boolean;
  /** Stable profile slot, separate from each new user task. */
  profileInstructions?: string;
  sessionLabel?: string;
  /** Stable identity for this new continuation request. Required for history handoff. */
  requestKey?: string;
  /** Owner-controlled compatibility policy. This is not native history resume. */
  historyHandoff?: "disabled" | "verified-unsupported";
}

export interface LocalAgentRunResult {
  provider: LocalAgentProvider;
  providerSessionId: string | null;
  finalResponse: string;
  items: unknown[];
}

/** Exact, live provider connection that owns one active turn. */
export interface LocalAgentTurnControl {
  readonly providerThreadId: string;
  readonly providerTurnId: string;
  steer(prompt: string): Promise<{ turnId: string }>;
  interrupt(): Promise<void>;
  isAlive(): boolean;
}

export interface LocalAgentRunCallbacks {
  /** Positive adapter evidence: failure occurred before any inference dispatch. */
  onNotRequested?: () => void;
  onThreadInfo?: (observation: ProviderThreadObservation) => void | Promise<void>;
  onNameResult?: (success: boolean) => void;
  onRequest?: () => void | Promise<void>;
  onTurnStarted?: (turnId: string) => void | Promise<void>;
  onControlReady?: (control: LocalAgentTurnControl) => void | Promise<void>;
  onProviderFinished?: () => void;
  onUsage?: (observation: AgentUsageObservation) => void;
  onActivity?: (activity: AgentActivity) => void;
  /**
   * Called as soon as a provider creates or resolves a durable continuation
   * identity. The callback is awaited before the provider starts work that
   * could otherwise fail and lose that identity.
   */
  onSessionId?: (providerSessionId: string) => void | Promise<void>;
  /** Records a new-thread compatibility lineage before any handoff turn starts. */
  onHistoryHandoff?: (handoff: { type: "fresh_thread_handoff"; parentThreadId: string; threadId: string }) => void | Promise<void>;
}

export interface LocalAgentRuntimeContext {
  agentId: string;
  provider: LocalAgentProvider;
  workspaceRoot: string;
  providerSessionId?: string;
  writeMode?: LocalAgentWriteMode;
  model?: string;
  effort?: string;
  agentDir?: string;
}

/**
 * A runtime is deliberately disposable. Nothing from this interface is
 * persisted; the provider session ID in LocalAgentStore is the continuation
 * identity used when a later runtime is created.
 */
export interface LocalAgentRuntime {
  readonly provider: LocalAgentProvider;
  run(
    input: LocalAgentRunInput,
    callbacks?: LocalAgentRunCallbacks,
  ): Promise<Result<LocalAgentRunResult, AgentProviderError>>;
  releaseSession(providerSessionId: string): Promise<void>;
  close(): Promise<void>;
  isAlive(): boolean;
}

export interface LocalAgentDriver {
  readonly provider: LocalAgentProvider;
  readonly readOnlyConcurrency?: boolean;
  readonly persistentProfileInstructions?: boolean;
  /** Provider adapter reports thread/turn/request lifecycle boundaries to the work ledger. */
  readonly reportsWorkLifecycle?: boolean;
  runtimeKey(context: LocalAgentRuntimeContext): string;
  createRuntime(context: LocalAgentRuntimeContext): Promise<Result<LocalAgentRuntime, AgentProviderError>>;
  readonly idleTimeoutMs?: number;
}
