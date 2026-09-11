import express, { type Request, type Response } from "express";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";
import * as z from "zod/v4";
import type { ServerConfig } from "./config.js";
import { assertAllowedPath } from "./roots.js";
import { WorkLedger } from "./work-ledger.js";
import { ProjectArchive } from "./project-archive.js";
import { CodexThreadControl, type ThreadControl } from "./codex-thread-control.js";
import { createLocalAgentClient, type LocalAgentClient } from "./local-agent-client.js";
import { LocalAgentStore } from "./local-agent-store.js";
import { desktopThreadLink } from "./codex-desktop-open.js";

interface Session { csrf: string; expires: number }
const hash = (value: string) => createHash("sha256").update(value).digest();
const equal = (a: string, b: string) => timingSafeEqual(hash(a), hash(b));
const loopback = (address: string | undefined) => address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
const localHost = (hostname: string) => ["localhost", "127.0.0.1", "[::1]", "::1"].includes(hostname);
const stringParam = (value: string | string[] | undefined): string => typeof value === "string" ? value : "";

export function createProjectConsoleRouter(config: ServerConfig, options: {
  assetDirectory: string; providerFactory?: () => ThreadControl; clock?: () => number;
  agentClient?: Pick<LocalAgentClient, "get" | "control">;
}) {
  const router = express.Router();
  const sessions = new Map<string, Session>();
  const attempts = new Map<string, { count: number; until: number }>();
  const clock = options.clock ?? Date.now;
  const settings = config.console ?? { enabled: true, allowRemote: false, sessionTtlSeconds: 3600 };
  const agentClient = () => options.agentClient ?? createLocalAgentClient(config);
  const cookieName = "devspace_console_session";
  const sessionFor = (req: Request) => {
    const cookie = req.headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    if (!cookie || !/^[a-f0-9]{64}$/.test(cookie)) return undefined;
    const key = hash(cookie).toString("hex"); const session = sessions.get(key);
    if (!session || session.expires <= clock()) { sessions.delete(key); return undefined; }
    return { session, key };
  };
  const expectedOrigin = (req: Request): string | undefined => {
    const host = req.headers.host;
    if (!host || /[\s,@\\]/.test(host)) return undefined;
    let url: URL; try { url = new URL(`${req.secure ? "https" : "http"}://${host}`); } catch { return undefined; }
    const forwarded = req.headers["x-forwarded-for"] || req.headers["x-forwarded-host"] || req.headers.forwarded;
    if (loopback(req.socket.remoteAddress) && localHost(url.hostname) && !forwarded) return url.origin;
    const publicUrl = new URL(config.publicBaseUrl);
    if (!settings.allowRemote || publicUrl.protocol !== "https:" || !req.secure || url.host !== publicUrl.host) return undefined;
    return publicUrl.origin;
  };
  const setCookie = (req: Request, res: Response, token: string, maxAge: number) => {
    res.setHeader("Set-Cookie", `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/console; Max-Age=${maxAge}${req.secure ? "; Secure" : ""}`);
  };
  router.use((req, res, next) => {
    if (!settings.enabled) { res.sendStatus(404); return; }
    const origin = expectedOrigin(req);
    if (!origin) { res.status(403).json({ code: "CONSOLE_ACCESS", message: "管理台默认仅允许本机访问；远程入口需明确启用 HTTPS。" }); return; }
    if (req.headers.origin && req.headers.origin !== origin) { res.sendStatus(403); return; }
    res.locals.consoleOrigin = origin;
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'");
    next();
  });
  router.use(express.json({ limit: "32kb", strict: true }));
  // Resolve the fixed entry relative to the trusted build root. Absolute sendFile
  // paths containing a parent .cache directory can be rejected as dotfiles.
  router.get("/", (_req, res) => res.sendFile("console.html", { root: resolve(options.assetDirectory), dotfiles: "deny" }));
  router.use("/assets", express.static(resolve(options.assetDirectory, "assets"), { fallthrough: false, index: false, dotfiles: "deny" }));
  router.use("/api", (req, res, next) => {
    if (!["GET", "POST"].includes(req.method)) { res.sendStatus(405); return; }
    if (req.method === "POST" && req.headers.origin !== res.locals.consoleOrigin) { res.status(403).json({ code: "ORIGIN_REQUIRED" }); return; }
    if (req.path === "/login") { next(); return; }
    const auth = sessionFor(req);
    if (!auth) { res.status(401).json({ code: "CONSOLE_LOGIN_REQUIRED" }); return; }
    if (req.method === "POST" && (typeof req.headers["x-devspace-csrf"] !== "string" || !equal(req.headers["x-devspace-csrf"], auth.session.csrf))) {
      res.status(403).json({ code: "CSRF_REQUIRED" }); return;
    }
    res.locals.consoleSession = auth; next();
  });
  router.post("/api/login", (req, res) => {
    const key = req.socket.remoteAddress ?? "unknown";
    for (const [candidate, attempt] of attempts) if (attempt.until <= clock()) attempts.delete(candidate);
    const attempt = attempts.get(key) ?? { count: 0, until: clock() + 60_000 };
    if (attempts.size > 2000 || attempt.count >= 8) { res.status(429).json({ code: "LOGIN_RATE_LIMIT" }); return; }
    attempt.count++; attempts.set(key, attempt);
    const parsed = z.object({ password: z.string().min(1).max(2048) }).strict().safeParse(req.body);
    if (!parsed.success || !equal(parsed.data.password, config.oauth.ownerToken)) { res.status(401).json({ code: "LOGIN_REJECTED" }); return; }
    attempts.delete(key);
    for (const [sessionKey, session] of sessions) if (session.expires <= clock()) sessions.delete(sessionKey);
    if (sessions.size >= 256) { res.status(429).json({ code: "SESSION_LIMIT" }); return; }
    const previous = sessionFor(req); if (previous) sessions.delete(previous.key);
    const token = randomBytes(32).toString("hex"); const csrf = randomBytes(24).toString("hex");
    sessions.set(hash(token).toString("hex"), { csrf, expires: clock() + settings.sessionTtlSeconds * 1000 });
    setCookie(req, res, token, settings.sessionTtlSeconds); res.json({ authenticated: true, csrf });
  });
  router.get("/api/session", (_req, res) => res.json({ authenticated: true, csrf: res.locals.consoleSession.session.csrf, remoteEnabled: settings.allowRemote }));
  router.post("/api/logout", (req, res) => { sessions.delete(res.locals.consoleSession.key); setCookie(req, res, "", 0); res.json({ authenticated: false }); });

  const withLedger = (fn: (req: Request, ledger: WorkLedger) => unknown | Promise<unknown>) => async (req: Request, res: Response) => {
    const ledger = new WorkLedger(config.stateDir);
    try {
      const projectId = stringParam(req.params.projectId);
      if (projectId) assertAllowedPath(ledger.getProject(projectId).root, config.allowedRoots);
      res.json(await fn(req, ledger));
    } catch { res.status(409).json({ code: "CONSOLE_OPERATION_REJECTED", message: "请求未通过项目、状态或输入校验。刷新后查看任务状态；不会自动重放归档。" }); }
    finally { ledger.close(); }
  };
  router.get("/api/projects", withLedger((_req, ledger) => {
    // Only DevSpace-registered projects; do not scan Codex's private chat catalog on page refresh.
    const roots = ledger.db.prepare("select root from workspace_sessions union select workspace_root as root from local_agent_sessions").all() as { root: string }[];
    for (const { root } of roots) { try { assertAllowedPath(root, config.allowedRoots); ledger.importLegacy(root); } catch { /* inaccessible history remains undisclosed */ } }
    return { projects: ledger.projects().filter((project) => { try { assertAllowedPath(project.root, config.allowedRoots); return true; } catch { return false; } })
      .map((project) => ({ id: project.id, name: project.name, root: project.root, ...ledger.projectUsage(project.id) })) };
  }));
  router.get("/api/projects/:projectId/runs", withLedger((req, ledger) => {
    const query = z.object({ offset: z.coerce.number().int().min(0).max(100000).optional(), source: z.enum(["chatgpt_mcp", "other_mcp", "devspace_cli", "legacy_unknown", "console", ""]).optional(),
      status: z.enum(["running", "completed", "failed", "cancelled", "reconciliation_required", ""]).optional(),
      after: z.string().datetime().optional() }).parse(req.query);
    const projectId = stringParam(req.params.projectId);
    return { ...ledger.listRuns(projectId, query), stats: ledger.projectUsage(projectId, query.after) };
  }));
  router.get("/api/projects/:projectId/runs/:runId", withLedger((req, ledger) => ledger.detail(stringParam(req.params.projectId), stringParam(req.params.runId))));
  router.get("/api/projects/:projectId/threads", withLedger((req, ledger) => ({
    threads: ledger.threads(stringParam(req.params.projectId)).map((thread) => {
      const store = new LocalAgentStore(config.stateDir);
      try {
        const agent = store.getById(thread.agent_id);
        return { id: thread.id, title: thread.title,
      agentId: thread.agent_id, instanceId: thread.instance_id, createdHere: Boolean(thread.created_here),
      origin: JSON.parse(thread.origin), identityVerified: Boolean(thread.identity_verified), externalActivity: Boolean(thread.external_activity),
      protected: Boolean(thread.protected), archiveState: thread.archive_state, nameStatus: thread.name_status,
      providerThreadId: thread.thread_id, desktopThreadUrl: desktopThreadLink(thread.thread_id),
      control: agent ? { state: agent.controlState, providerTurnId: agent.providerTurnId, revision: agent.controlRevision,
        events: store.controlEvents(agent.id) } : undefined,
      updatedAt: thread.updated_at, runs: ledger.threadRuns(thread.id).map((run) => ({ id: run.id, status: run.status, acceptance: run.acceptance })) };
      } finally { store.close(); }
    }),
    catalogScope: "Only DevSpace registrations. Unmanaged chats are not collected or archived by this page." })));
  router.post("/api/projects/:projectId/threads/:threadId/control", withLedger(async (req, ledger) => {
    const body = z.object({ action: z.enum(["steer", "interrupt", "takeover", "returnControl"]),
      workRunId: z.string().min(1), requestKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
      expectedTurnId: z.string().min(1).max(256).optional(), prompt: z.string().min(1).max(12_000).optional() }).strict().parse(req.body);
    const projectId = stringParam(req.params.projectId); const managedThreadId = stringParam(req.params.threadId);
    const project = ledger.getProject(projectId);
    const thread = ledger.thread(managedThreadId);
    if (thread.project_id !== projectId) throw new Error("Thread belongs to a different project.");
    const store = new LocalAgentStore(config.stateDir);
    try {
      const agent = store.getById(thread.agent_id);
      if (!agent || agent.providerSessionId !== thread.thread_id) throw new Error("Managed agent/thread identity is unavailable.");
      const scope = { workspaceId: agent.workspaceId, workspaceRoot: project.root };
      ledger.requireScope(body.workRunId, project.root, agent.workspaceId);
      if (body.action === "returnControl") {
        const provider = options.providerFactory?.() ?? new CodexThreadControl();
        try {
          const snapshot = await provider.inspect(thread.thread_id);
          if (!snapshot.identityVerified || snapshot.instanceId !== thread.instance_id || resolve(snapshot.cwd) !== resolve(project.root)
            || !snapshot.turnsClosed || !["idle", "notLoaded"].includes(snapshot.status)) {
            throw new Error("Provider thread is active, external, or has an unverified identity.");
          }
        } finally { await provider.close(); }
      }
      const result = await agentClient().control({ agentId: agent.id, action: body.action, workRunId: body.workRunId,
        requestKey: body.requestKey, expectedTurnId: body.expectedTurnId, prompt: body.prompt, scope });
      if (result.isErr()) throw result.error;
      return { ...result.value, desktopThreadUrl: desktopThreadLink(thread.thread_id),
        note: body.action === "takeover" ? "DevSpace confirmed interruption and released the single-writer lease to Codex Desktop."
          : body.action === "returnControl" ? "Provider identity and idle state were verified before returning control to DevSpace."
          : "Control request was applied to the exact active provider turn." };
    } finally { store.close(); }
  }));
  router.post("/api/projects/:projectId/threads/:threadId/protect", withLedger((req, ledger) => {
    const body = z.object({ protected: z.boolean() }).strict().parse(req.body);
    ledger.protectThread(stringParam(req.params.projectId), stringParam(req.params.threadId), body.protected); return { saved: true };
  }));
  router.get("/api/projects/:projectId/attention", withLedger((req, ledger) => {
    const root = ledger.getProject(stringParam(req.params.projectId)).root;
    return { claims: ledger.db.prepare("select id,kind,owner_pid,agent_id,access_mode,acquired_at from execution_claims where checkout_root=?").all(root),
      waiters: ledger.db.prepare("select id,agent_id,access_mode,expires_at_ms from execution_waiters where checkout_root=?").all(root),
      note: "A PID or claim is not proof of a healthy task. Interrupted work requires reconciliation; archive never cancels a process." };
  }));
  const archive = (fn: (req: Request, service: ProjectArchive) => Promise<unknown> | unknown) => withLedger(async (req, ledger) => {
    const service = new ProjectArchive(ledger, options.providerFactory?.() ?? new CodexThreadControl());
    try { return await fn(req, service); } finally { await service.close(); }
  });
  router.post("/api/projects/:projectId/archive/preview", archive(async (req, service) => {
    const body = z.object({ mode: z.enum(["archive", "restore"]), threadKeys: z.array(z.string()).max(100).optional(), acceptPartial: z.boolean().optional() }).strict().parse(req.body);
    return service.plan(stringParam(req.params.projectId), body);
  }));
  router.get("/api/projects/:projectId/archive/:batchId", archive((req, service) => service.view(stringParam(req.params.projectId), stringParam(req.params.batchId))));
  router.post("/api/projects/:projectId/archive/:batchId/execute", archive(async (req, service) => {
    const body = z.object({ confirmationHash: z.string().regex(/^[a-f0-9]{64}$/), externalIdle: z.literal(true) }).strict().parse(req.body);
    return service.execute(stringParam(req.params.projectId), stringParam(req.params.batchId), body.confirmationHash, body.externalIdle);
  }));
  router.get("/api/projects/:projectId/archive", withLedger((req, ledger) => ({ batches: ledger.db.prepare(
    "select id,mode,status,created_at,updated_at from console_archive_batches where project_id=? order by created_at desc limit 50")
    .all(stringParam(req.params.projectId)) })));
  router.use((error: unknown, _req: Request, res: Response, _next: express.NextFunction) => {
    if (!res.headersSent) res.status(400).json({ code: "CONSOLE_REQUEST_REJECTED" });
    void error;
  });
  return { router, close: () => { sessions.clear(); attempts.clear(); } };
}
