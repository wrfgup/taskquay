import { homedir, hostname } from "node:os";
import { createHash } from "node:crypto";
import { setTimeout as settle } from "node:timers/promises";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { delimiter, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import {
  AgentProviderExecutionError,
  AgentProviderProtocolError,
  AgentProviderUnavailableError,
  captureAgentProviderResult,
} from "./local-agent-errors.js";
import { removeDevspaceNodeModulesBinFromPath } from "./local-agent-path.js";
import { parseCodexUsage } from "./agent-usage.js";
import { summarizeCodexFailure, summarizeCodexControlFailure } from "./codex-failure-summary.js";
import { quotaPreflight } from "./codex-quota-preflight.js";
import { codexActivity, type AgentActivity } from "./agent-progress.js";
import { ensureDesktopProject, type ProjectReceipt } from "./codex-projects.js";
import { terminateProcessTree } from "./process-platform.js";
import { DEVSPACE_VERSION } from "./version.js";
import type {
  LocalAgentDriver,
  LocalAgentRunCallbacks,
  LocalAgentRunInput,
  LocalAgentRunResult,
  LocalAgentRuntime,
  LocalAgentRuntimeContext,
  LocalAgentWriteMode,
} from "./local-agent-runtime.js";

export interface ResolvedCodexCommand {
  executable: string;
  version?: string;
}

export type CodexCommandResolver = (env: NodeJS.ProcessEnv) => ResolvedCodexCommand | undefined;

export function codexCommandEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const next = { ...env };
  delete next.CODEX_INTERNAL_ORIGINATOR_OVERRIDE;
  if (env.CODEX_COMMAND) return next;
  if (next.PATH) next.PATH = removeDevspaceNodeModulesBinFromPath(next.PATH);
  return next;
}

export function resolveCodexCommand(env: NodeJS.ProcessEnv = process.env): ResolvedCodexCommand | undefined {
  const command = env.CODEX_COMMAND ?? "codex";
  const probeEnv = codexCommandEnvironment(env);
  for (const candidate of commandCandidates(command, probeEnv)) {
    const result = spawnSync(candidate, ["--version"], {
      encoding: "utf8",
      env: probeEnv,
      windowsHide: true,
      timeout: 5_000,
      shell: usesWindowsCommandShell(candidate),
    });
    const code = result.error && "code" in result.error ? result.error.code : undefined;
    if (code === "ENOENT") continue;
    if (result.error || result.status !== 0) continue;
    return { executable: candidate, version: parseCodexVersion(result.stdout) };
  }
  return undefined;
}

export function isCodexAppServerSupported(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const result = spawnSync(command, ["app-server", "--help"], {
    encoding: "utf8",
    env: codexCommandEnvironment(env),
    windowsHide: true,
    timeout: 5_000,
    shell: usesWindowsCommandShell(command),
  });
  return result.error === undefined && result.status === 0;
}

export function parseCodexVersion(output: string | undefined): string | undefined {
  const match = output?.trim().match(/v?(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)/);
  return match?.[1];
}

export interface CodexAppServerRuntimeOptions {
  command: string;
  env: NodeJS.ProcessEnv;
  version?: string;
  registerProject?: (roots: string[], threadIds: string[], env: NodeJS.ProcessEnv) => Promise<ProjectReceipt>;
}

export type CodexControlMethod = "account/read" | "account/rateLimits/read" | "thread/read" | "thread/list" | "thread/loaded/list" |
  "thread/name/set" | "thread/archive" | "thread/unarchive";
const CONTROL_METHODS: ReadonlySet<string> = new Set(["account/read", "account/rateLimits/read", "thread/read", "thread/list", "thread/loaded/list",
  "thread/name/set", "thread/archive", "thread/unarchive"]);

export function codexInstanceIdentity(command: string, env: NodeJS.ProcessEnv, accountResult: unknown) {
  const account = asRecord(asRecord(accountResult)?.account);
  const accountKey = account?.type === "chatgpt" && typeof account.email === "string" ? account.email.trim().toLowerCase()
    : typeof account?.id === "string" ? account.id : undefined;
  const home = resolve(env.CODEX_HOME ?? join(homedir(), ".codex"));
  const identity = createHash("sha256").update(JSON.stringify([hostname(), home, resolve(command), account?.type ?? "unknown", accountKey ?? "unverified"])).digest("hex");
  return { instanceId: `codex_${identity}`, identityVerified: Boolean(accountKey) };
}

export class CodexAppServerRuntime implements LocalAgentRuntime {
  readonly provider = "codex" as const;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly rpc: CodexAppServerRpc;
  private alive = true;
  private closePromise?: Promise<void>;
  private identityPromise?: Promise<{ instanceId: string; identityVerified: boolean }>;

  constructor(private readonly options: CodexAppServerRuntimeOptions) {
    this.child = spawn(options.command, ["app-server"], {
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
      shell: usesWindowsCommandShell(options.command),
    });
    this.rpc = new CodexAppServerRpc(this.child, options.version);
    this.child.once("exit", (code, signal) => {
      this.alive = false;
      this.rpc.fail(new Error(
        `codex app-server exited with ${signal ? `signal ${signal}` : `code ${code ?? 1}`}.`,
      ));
    });
    this.child.once("error", (error) => {
      this.alive = false;
      this.rpc.fail(error);
    });
  }

  async initialize(): Promise<void> {
    await this.rpc.request("initialize", {
      clientInfo: { name: "devspace", title: "DevSpace", version: DEVSPACE_VERSION },
      capabilities: {},
    });
    this.rpc.notify("initialized");
  }

  /** Metadata/lifecycle RPC only. Never exposes arbitrary methods or starts inference. */
  async control(method: CodexControlMethod, params: unknown): Promise<unknown> {
    if (!CONTROL_METHODS.has(method)) throw new Error("Unsupported Codex lifecycle operation.");
    return this.rpc.request(method, params);
  }
  identity(refresh = false): Promise<{ instanceId: string; identityVerified: boolean }> {
    if (refresh) this.identityPromise = undefined;
    this.identityPromise ??= this.rpc.request("account/read", { refreshToken: false })
      .then((account) => codexInstanceIdentity(this.options.command, this.options.env, account))
      .catch(() => codexInstanceIdentity(this.options.command, this.options.env, null));
    return this.identityPromise;
  }

  async run(input: LocalAgentRunInput, callbacks?: LocalAgentRunCallbacks) {
    let requestPossible = false;
    const result = await captureAgentProviderResult({
      provider: this.provider,
      operation: "run",
      run: async (): Promise<LocalAgentRunResult> => {
        if (!this.isAlive()) {
          throw new AgentProviderUnavailableError({
            code: "PROVIDER_UNAVAILABLE",
            provider: this.provider,
            operation: "run",
            retryable: true,
            message: "Codex app-server is not running.",
          });
        }
        let quota: ReturnType<typeof quotaPreflight> | undefined;
        try {
          // Optional compatibility metadata must not add a full lifecycle RPC
          // timeout to every turn when an older peer does not answer it.
          quota = quotaPreflight(await this.rpc.request("account/rateLimits/read", {}, 5_000));
        } catch {
          // Older/API-key providers may not expose ChatGPT quota metadata.
          // Missing metadata is not zero quota and does not invent a restriction.
        }
        if (quota?.blockedByProvider) {
          throw new AgentProviderUnavailableError({
            code: "PROVIDER_UNAVAILABLE", provider: "codex", operation: "quota_preflight", retryable: false,
            message: JSON.stringify({ category: "usage_or_rate_limit", ...quota,
              nextAction: "check_provider_limits_before_resuming_original_thread" }),
          });
        }
        // 0.153.4 can read paginated summaries but cannot resume their history.
        // Do not silently fork, rewrite history, consume another session slot,
        // or classify this capability mismatch as a model execution failure.
        if (input.providerSessionId && this.options.version === "0.153.4") {
          const summary = asRecord(await this.control("thread/read", { threadId: input.providerSessionId, includeTurns: false }));
          const existing = asRecord(summary?.thread);
          if (existing?.id !== input.providerSessionId) throw new AgentProviderProtocolError({
            code: "PROVIDER_PROTOCOL_ERROR", provider: "codex", operation: "history_preflight", retryable: false,
            cause: "thread identity not confirmed", message: "Existing thread identity could not be verified; no resume or inference was requested.",
          });
          if (existing.historyMode === "paginated") throw new AgentProviderUnavailableError({
            code: "PROVIDER_UNAVAILABLE", provider: "codex", operation: "history_preflight", retryable: false,
            message: "PAGINATED_HISTORY_UNSUPPORTED: Codex 0.153.4 cannot resume this stored thread. Preserve its identity and results; use a provider version with verified paginated resume support or an explicitly authorized handoff. No thread, history, quota or session-budget policy was changed.",
          });
        }
        let threadConfig: Record<string, unknown> = {};
        const register = async (threadIds: string[]) => {
          const receipt = await this.options.registerProject?.([input.workspaceRoot], threadIds, this.options.env);
          if (receipt?.status === "partial") throw new AgentProviderUnavailableError({
            code: "PROVIDER_UNAVAILABLE", provider: "codex", operation: "register_project", retryable: false,
            message: JSON.stringify(receipt),
          });
        };
        // Registration failure is a control-plane partial result, never a reason to launch/retry inference.
        await register(input.providerSessionId ? [input.providerSessionId] : []);
        let developerInstructions: string | undefined;
        if (input.analysisOnly || input.profileInstructions) {
          // Pure configuration RPC: no model request and no global config mutation.
          const settings = await this.rpc.request("config/read", { cwd: input.workspaceRoot, includeLayers: true });
          const effective = asRecord(asRecord(settings)?.config);
          if (!effective) throw new Error("Cannot verify effective Codex configuration; refusing to start a paid turn.");
          if (input.analysisOnly) threadConfig = restrictedAnalysisConfig(settings);
          if (input.profileInstructions) developerInstructions = [
            typeof effective.developer_instructions === "string" ? effective.developer_instructions : undefined,
            input.profileInstructions,
          ].filter(Boolean).join("\n\n");
        }
        const threadResponse = await this.rpc.request(
          input.providerSessionId ? "thread/resume" : "thread/start",
          { ...threadParams(input), config: { "features.multi_agent": false, "features.multi_agent_v2": false, ...threadConfig },
            ...(developerInstructions ? { developerInstructions } : {}) },
        );
        if (input.analysisOnly) {
          const opened = asRecord(threadResponse);
          const sandbox = asRecord(opened?.sandbox);
          if (opened?.approvalPolicy !== "never" || sandbox?.type !== "readOnly" || sandbox.networkAccess === true) {
            throw new Error("Codex did not confirm the required offline read-only sandbox; no analysis turn started.");
          }
        }
        const threadId = readString(asRecord(threadResponse)?.thread, "id");
        if (!threadId) {
          throw new AgentProviderProtocolError({
            code: "PROVIDER_PROTOCOL_ERROR",
            provider: this.provider,
            operation: "open_thread",
            retryable: false,
            cause: threadResponse,
            message: "Codex app-server did not return a thread id.",
          });
        }

        await callbacks?.onSessionId?.(threadId);
        if (callbacks?.onThreadInfo) {
          const identity = await this.identity(true);
          let priorTurnIds: string[] | null = input.providerSessionId ? null : [];
          let priorTurnsClosed = !input.providerSessionId;
          if (input.providerSessionId) {
            try {
              const result = asRecord(await this.control("thread/read", { threadId, includeTurns: true }));
              const thread = asRecord(result?.thread);
              const turns = Array.isArray(thread?.turns) ? thread.turns.map(asRecord) : null;
              if (turns && turns.every((turn) => typeof turn?.id === "string")) {
                priorTurnIds = turns.map((turn) => turn!.id as string);
                priorTurnsClosed = turns.every((turn) => ["completed", "failed", "interrupted"].includes(String(turn?.status)));
              }
            } catch { /* A missing boundary is reported as unknown, not billed to this task. */ }
          }
          await callbacks.onThreadInfo({ ...identity, threadId, createdHere: !input.providerSessionId,
            priorTurnIds, priorTurnsClosed, title: input.sessionLabel });
        }
        if (!input.providerSessionId && input.sessionLabel) {
          try { await this.control("thread/name/set", { threadId, name: input.sessionLabel }); callbacks?.onNameResult?.(true); }
          catch { callbacks?.onNameResult?.(false); }
        }
        await register([threadId]);
        requestPossible = true;
        await callbacks?.onRequest?.();
        const completed = await this.rpc.runTurn(threadId, turnParams(input, threadId), (value) => {
          const usage = parseCodexUsage(value);
          if (!usage || usage.threadId !== threadId) return;
          // Telemetry failure must not cause paid work to be retried or crash the protocol loop.
          try { callbacks?.onUsage?.({ ...usage, newThread: !input.providerSessionId, providerVersion: this.options.version }); }
          catch { /* Missing telemetry remains unknown; it is never synthesized as zero. */ }
        }, callbacks?.onTurnStarted, (activity) => {
          try { callbacks?.onActivity?.(activity); } catch { /* Progress cannot fail or replay paid work. */ }
        });
        callbacks?.onProviderFinished?.();
        const parsed = parseCompletedTurn(completed.event.params, completed.items);
        if (parsed.failure) {
          const failure = summarizeCodexFailure(completed.event.params);
          throw new AgentProviderExecutionError({
            code: "PROVIDER_EXECUTION_ERROR",
            provider: this.provider,
            operation: "run",
            retryable: failure.retryable,
            cause: completed.event.params,
            message: failure.message,
          });
        }
        if (!parsed.finalResponse.trim()) {
          throw new AgentProviderProtocolError({
            code: "PROVIDER_PROTOCOL_ERROR",
            provider: this.provider,
            operation: "run",
            retryable: false,
            cause: completed.event.params,
            message: "Codex did not return a final assistant response.",
          });
        }
        return {
          provider: this.provider,
          providerSessionId: threadId,
          finalResponse: parsed.finalResponse.trim(),
          items: parsed.items,
        };
      },
    });
    if (result.isErr() && !requestPossible) callbacks?.onNotRequested?.();
    return result;
  }

  async releaseSession(providerSessionId: string): Promise<void> {
    if (!this.alive) return;
    try {
      await this.rpc.request("thread/unsubscribe", { threadId: providerSessionId });
    } catch {
      // Unsubscribe is an optimization; persisted thread identity remains valid.
    }
  }

  isAlive(): boolean {
    return this.alive && !this.child.killed && this.child.exitCode === null;
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = (async () => {
      this.alive = false;
      this.rpc.fail(new Error("codex app-server closed."));
      if (!this.child.stdin.destroyed) this.child.stdin.end();
      if (this.child.exitCode === null) {
        terminateProcessTree(this.child, "SIGTERM", process.platform !== "win32");
        if (!await waitForProcessExit(this.child, 1_000)) {
          terminateProcessTree(this.child, "SIGKILL", process.platform !== "win32");
        }
      }
    })();
    return this.closePromise;
  }
}

async function waitForProcessExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode !== null) return true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.removeListener("exit", onExit);
      resolve(false);
    }, timeoutMs);
    timer.unref();
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("exit", onExit);
  });
}

export class CodexLocalAgentDriver implements LocalAgentDriver {
  readonly readOnlyConcurrency = true;
  readonly persistentProfileInstructions = true;
  readonly reportsWorkLifecycle = true;
  readonly provider = "codex" as const;
  readonly idleTimeoutMs = 5 * 60_000;

  private commandResolved = false;
  private resolvedCommand?: ResolvedCodexCommand;

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly commandResolver: CodexCommandResolver = resolveCodexCommand,
  ) {}

  runtimeKey(_context: LocalAgentRuntimeContext): string {
    const command = this.resolveCommand();
    const executable = command?.executable ?? this.env.CODEX_COMMAND ?? "codex";
    const codexHome = resolve(this.env.CODEX_HOME ?? join(homedir(), ".codex"));
    return `codex:${executable}:${codexHome}`;
  }

  async createRuntime(_context: LocalAgentRuntimeContext) {
    return captureAgentProviderResult({
      provider: this.provider,
      operation: "create_runtime",
      run: async (): Promise<LocalAgentRuntime> => {
        const command = this.resolveCommand();
        if (!command) {
          throw new AgentProviderUnavailableError({
            code: "PROVIDER_UNAVAILABLE",
            provider: this.provider,
            operation: "create_runtime",
            retryable: false,
            message: "Codex executable was not found.",
          });
        }
        if (!isCodexAppServerSupported(command.executable, this.env)) {
          throw new AgentProviderUnavailableError({
            code: "PROVIDER_UNAVAILABLE",
            provider: this.provider,
            operation: "create_runtime",
            retryable: false,
            message: "Installed Codex does not support app-server.",
          });
        }
        const runtime = new CodexAppServerRuntime({
          command: command.executable,
          env: codexCommandEnvironment(this.env),
          version: command.version,
          registerProject: ensureDesktopProject,
        });
        try {
          await runtime.initialize();
          return runtime;
        } catch (cause) {
          await runtime.close();
          throw new AgentProviderProtocolError({
            code: "PROVIDER_PROTOCOL_ERROR",
            provider: this.provider,
            operation: "create_runtime",
            retryable: true,
            cause: codexAppServerError(errorMessage(cause), command.version),
            message: "Codex app-server initialization failed.",
          });
        }
      },
    });
  }

  private resolveCommand(): ResolvedCodexCommand | undefined {
    if (!this.commandResolved) {
      this.resolvedCommand = this.commandResolver(this.env);
      this.commandResolved = true;
    }
    return this.resolvedCommand;
  }
}

const MAX_TURN_ITEMS = 10_000;
const MAX_STDERR_BYTES = 32 * 1024;

interface CodexEvent {
  method: string;
  params?: unknown;
}

interface CodexTurnResult {
  event: CodexEvent;
  items: unknown[];
}

interface CodexTurnAccumulator {
  onActivity?: (activity: AgentActivity) => void;
  pendingActivity: Array<{ event: CodexEvent; activity: AgentActivity }>;
  threadId: string;
  turnId?: string;
  items: unknown[];
  pendingUsage: unknown[];
  onUsage?: (value: unknown) => void;
  completed?: CodexEvent;
  resolve: (result: CodexTurnResult) => void;
  reject: (error: Error) => void;
}

class CodexAppServerRpc {
  private readonly pending = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();
  private readonly turns = new Map<string, CodexTurnAccumulator>();
  private readonly recentUsage = new Map<string, { callback: (value: unknown) => void; expires: number }>();
  private nextId = 1;
  private fatalError?: Error;
  private buffer = "";
  private stderr = "";

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly version?: string,
  ) {
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => this.handleLine(line));
    child.stdin.on("error", (error) => this.fail(error));
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = appendTail(this.stderr, chunk.toString("utf8"), MAX_STDERR_BYTES);
    });
  }

  request(method: string, params?: unknown, timeoutMs = 30_000): Promise<unknown> {
    if (this.fatalError) return Promise.reject(this.fatalError);
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      const rejectControl = (cause: Error) => {
        const detail = summarizeCodexControlFailure(method, cause);
        reject(new AgentProviderProtocolError({ code: "PROVIDER_PROTOCOL_ERROR", provider: "codex",
          operation: detail.stage, retryable: detail.retryable, cause, message: detail.message }));
      };
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) rejectControl(new Error(`Codex RPC timed out: ${method}. Reconcile before replaying a lifecycle operation.`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); rejectControl(error); },
      });
      this.write({ id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  notify(method: string, params?: unknown): void {
    this.write({ method, ...(params === undefined ? {} : { params }) });
  }

  async runTurn(threadId: string, params: unknown, onUsage?: (value: unknown) => void,
    onTurnStarted?: (turnId: string) => void | Promise<void>, onActivity?: (activity: AgentActivity) => void): Promise<CodexTurnResult> {
    if (this.fatalError) throw this.fatalError;
    if (this.turns.has(threadId)) throw new Error(`Codex thread ${threadId} already has an active turn.`);
    let resolveTurn!: (result: CodexTurnResult) => void;
    let rejectTurn!: (error: Error) => void;
    const completion = new Promise<CodexTurnResult>((resolve, reject) => {
      resolveTurn = resolve;
      rejectTurn = reject;
    });
    const turn: CodexTurnAccumulator = {
      threadId,
      items: [],
      pendingUsage: [],
      pendingActivity: [],
      onUsage,
      onActivity,
      resolve: resolveTurn,
      reject: rejectTurn,
    };
    this.turns.set(threadId, turn);
    try {
      const response = await this.request("turn/start", params);
      turn.turnId = readString(asRecord(response)?.turn, "id");
      if (turn.turnId) await onTurnStarted?.(turn.turnId);
      for (const pending of turn.pendingActivity) {
        if (turn.turnId && turnMatchesEvent(turn, pending.event)) turn.onActivity?.(pending.activity);
      }
      turn.pendingActivity = [];
      for (const usage of turn.pendingUsage) {
        if (turn.turnId && asRecord(usage)?.turnId === turn.turnId) turn.onUsage?.(usage);
      }
      turn.pendingUsage = [];
      const result = turn.completed ? { event: turn.completed, items: turn.items } : await completion;
      // Bounded grace for final usage notifications delivered immediately after completion.
      if (onUsage) await settle(150);
      return result;
    } finally {
      if (turn.turnId && turn.onUsage) {
        this.recentUsage.set(`${threadId}:${turn.turnId}`, { callback: turn.onUsage, expires: Date.now() + 60_000 });
        for (const [key, handler] of this.recentUsage) if (handler.expires <= Date.now() || this.recentUsage.size > 128) this.recentUsage.delete(key);
      }
      if (this.turns.get(threadId) === turn) this.turns.delete(threadId);
    }
  }

  fail(error: Error): void {
    if (this.fatalError) return;
    this.fatalError = new Error(`${error.message}${this.stderr.trim() ? `\n${this.stderr.trim()}` : ""}${this.version ? `\ncodex version: ${this.version}` : ""}`);
    for (const pending of this.pending.values()) pending.reject(this.fatalError);
    for (const turn of this.turns.values()) turn.reject(this.fatalError);
    this.pending.clear();
    this.turns.clear();
    this.recentUsage.clear();
  }

  private write(message: Record<string, unknown>): void {
    if (this.fatalError) throw this.fatalError;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    this.buffer += line;
    const trimmed = this.buffer.trim();
    this.buffer = "";
    if (!trimmed) return;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      this.fail(new Error("codex app-server emitted malformed JSON."));
      return;
    }
    const id = typeof message.id === "string" || typeof message.id === "number" ? String(message.id) : undefined;
    const method = typeof message.method === "string" ? message.method : undefined;
    if (id && !method) {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      if (message.error !== undefined) {
        const error = new Error(protocolErrorText(message.error));
        const code = asRecord(message.error)?.code;
        if (Number.isSafeInteger(code)) Object.assign(error, { code });
        pending.reject(error);
      }
      else pending.resolve(message.result);
      return;
    }
    if (id && method) {
      this.write({ id: message.id, error: { code: -32601, message: `Unsupported app-server request: ${method}` } });
      return;
    }
    if (!method) return;
    const event = { method, params: message.params };
    const usageParams = asRecord(event.params);
    if (method === "thread/tokenUsage/updated" && typeof usageParams?.threadId === "string" && typeof usageParams.turnId === "string") {
      const previous = this.recentUsage.get(`${usageParams.threadId}:${usageParams.turnId}`);
      if (previous && previous.expires > Date.now()) { previous.callback(event.params); return; }
    }
    const turn = this.findTurn(event);
    if (!turn) return;
    const params = asRecord(event.params);
    const activity = codexActivity(event.method, event.params);
    if (activity) {
      if (!turn.turnId) {
        turn.pendingActivity.push({ event: { method: event.method, params: {
          threadId: params?.threadId, turnId: params?.turnId,
        } }, activity });
        if (turn.pendingActivity.length > 32) turn.pendingActivity.shift();
      } else if (turnMatchesEvent(turn, event)) turn.onActivity?.(activity);
    }
    if (event.method === "thread/tokenUsage/updated") {
      if (!turn.turnId) {
        turn.pendingUsage.push(event.params);
        if (turn.pendingUsage.length > 32) turn.pendingUsage.shift();
      } else if (params?.turnId === turn.turnId) turn.onUsage?.(event.params);
      return;
    }
    if (params?.item !== undefined) {
      turn.items.push(params.item);
      if (turn.items.length > MAX_TURN_ITEMS) turn.items.shift();
    }
    if (event.method !== "turn/completed" || !turnMatchesEvent(turn, event)) return;
    turn.completed = event;
    turn.resolve({ event, items: turn.items.slice() });
  }

  private findTurn(event: CodexEvent): CodexTurnAccumulator | undefined {
    const params = asRecord(event.params);
    const threadId = typeof params?.threadId === "string" ? params.threadId : undefined;
    const turnId = typeof params?.turnId === "string"
      ? params.turnId
      : readString(asRecord(params?.turn), "id");
    if (threadId) return this.turns.get(threadId);
    if (!turnId) return undefined;
    return Array.from(this.turns.values()).find((turn) => turn.turnId === turnId);
  }
}

/** Thread-local restrictions; never edit the user's config or expose its credential values. */
export function restrictedAnalysisConfig(settings: unknown): Record<string, unknown> {
  const root = asRecord(settings);
  const effective = asRecord(root?.config);
  if (!effective) throw new Error("Effective configuration is unavailable for read-only analysis.");
  const result: Record<string, unknown> = {
    "features.multi_agent": false, "features.multi_agent_v2": false,
    "features.apps": false, "features.plugins": false,
    "features.remote_plugin": false, "web_search": "disabled",
    "apps._default.enabled": false,
  };
  const configs = [effective, ...(Array.isArray(root?.layers) ? root.layers.map((layer) => asRecord(asRecord(layer)?.config)) : [])];
  for (const config of configs) {
    if (!config) continue;
    for (const table of ["mcp_servers", "apps", "plugins"]) {
      // Effective-config responses encode some absent optional tables as null.
      if (config[table] === undefined || config[table] === null) continue;
      const entries = asRecord(config[table]);
      if (!entries) throw new Error("Cannot safely interpret external tools configuration for shared analysis.");
      for (const name of Object.keys(entries)) {
        // Fail closed rather than invent dotted-key quoting unsupported by an installed provider.
        // Unicode server names and plugin@market identities are literal path segments.
        // Dots/quotes remain rejected: dotted override parsers differ across Codex versions.
        if (!/^[\p{L}\p{N}_@:/-]{1,256}$/u.test(name)) throw new Error("External tool identifier needs an explicitly supported read-only adapter.");
        result[`${table}.${name}.enabled`] = false;
      }
    }
  }
  return result;
}

function threadParams(input: LocalAgentRunInput): Record<string, unknown> {
  return {
    ...(input.providerSessionId ? { threadId: input.providerSessionId } : {}),
    cwd: input.workspaceRoot,
    approvalPolicy: "never",
    sandbox: sandboxFor(input.writeMode),
    // The host owns delegation. A single managed turn must not silently fan out
    // into additional paid contexts outside DevSpace's admission accounting.
    config: { "features.multi_agent": false },
    ...(input.model ? { model: input.model } : {}),
  };
}

function turnParams(input: LocalAgentRunInput, threadId: string): Record<string, unknown> {
  return {
    threadId,
    input: [{ type: "text", text: input.prompt }],
    approvalPolicy: "never",
    sandboxPolicy: input.analysisOnly ? { type: "readOnly", networkAccess: false } : sandboxPolicyFor(input.writeMode),
    ...(input.model ? { model: input.model } : {}),
    ...(input.effort ? { effort: input.effort } : {}),
  };
}

export function sandboxFor(writeMode: LocalAgentWriteMode | undefined): string {
  switch (writeMode) {
    case "allowed": return "workspace-write";
    case "full_access": return "danger-full-access";
    case "read_only":
    case undefined: return "read-only";
  }
}

function sandboxPolicyFor(writeMode: LocalAgentWriteMode | undefined): Record<string, string | boolean> {
  switch (writeMode) {
    case "allowed": return { type: "workspaceWrite", networkAccess: true };
    case "full_access": return { type: "dangerFullAccess" };
    case "read_only":
    case undefined: return { type: "readOnly" };
  }
}

function parseCompletedTurn(params: unknown, items: unknown[]): {
  finalResponse: string;
  items: unknown[];
  failure?: string;
} {
  const turn = asRecord(asRecord(params)?.turn);
  const completedItems = (Array.isArray(turn?.items) ? turn.items : items).slice(-MAX_TURN_ITEMS);
  let finalResponse = "";
  for (const item of completedItems) {
    const record = asRecord(item);
    if (!record) continue;
    const type = record.type;
    if ((type === "agentMessage" || type === "agent_message") && typeof record.text === "string") {
      finalResponse = record.text;
    }
  }
  const status = turn?.status;
  const error = asRecord(turn?.error);
  const failure = status === "failed"
    ? directString(error?.message) ?? "Codex turn failed."
    : undefined;
  return { finalResponse, items: completedItems, failure };
}

export function codexAppServerError(message: string, version?: string, stderr?: string): Error {
  return new Error([
    message,
    version ? `codex version: ${version}` : undefined,
    stderr?.trim() ? `stderr:\n${stderr.trim()}` : undefined,
  ].filter(Boolean).join("\n"));
}

function commandCandidates(command: string, env: NodeJS.ProcessEnv): string[] {
  if (command.includes("/") || command.includes("\\") || /\.(?:cmd|bat|exe|com)$/i.test(command)) return [command];
  const path = env.PATH;
  if (!path) return [command];
  const extensions = process.platform === "win32"
    ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];
  return path.split(delimiter)
    .filter(Boolean)
    .flatMap((directory) => extensions.map((extension) => resolve(directory, `${command}${extension}`)));
}

function usesWindowsCommandShell(command: string): boolean {
  return process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command);
}

function turnMatchesEvent(turn: CodexTurnAccumulator, event: CodexEvent): boolean {
  const params = asRecord(event.params);
  const eventThreadId = typeof params?.threadId === "string" ? params.threadId : undefined;
  const eventTurnId = typeof params?.turnId === "string"
    ? params.turnId
    : readString(asRecord(params?.turn), "id");
  if (eventThreadId && eventThreadId !== turn.threadId) return false;
  if (turn.turnId && eventTurnId && turn.turnId !== eventTurnId) return false;
  return eventThreadId === turn.threadId || Boolean(turn.turnId && eventTurnId === turn.turnId);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readString(value: unknown, key: string): string | undefined {
  const result = asRecord(value)?.[key];
  return typeof result === "string" ? result : undefined;
}

function directString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function protocolErrorText(value: unknown): string {
  const record = asRecord(value);
  if (!record) return String(value);
  const message = directString(record.message);
  const code = record.code;
  return message ? `codex app-server${code === undefined ? "" : ` ${String(code)}`}: ${message}` : String(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function appendTail(value: string, chunk: string, maxBytes: number): string {
  const next = value + chunk;
  if (Buffer.byteLength(next, "utf8") <= maxBytes) return next;
  const bytes = Buffer.from(next, "utf8");
  return bytes.subarray(bytes.length - maxBytes).toString("utf8");
}
