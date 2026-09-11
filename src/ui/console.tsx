import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./console.css";

type Quality = "complete" | "partial" | "unavailable" | "not_used";
type Counts = { totalTokens: number; inputTokens: number; outputTokens: number; cachedInputTokens?: number; reasoningOutputTokens?: number; cacheWriteInputTokens?: number };
type Origin = { entryPoint: string; modelLabel?: string; clientLabel?: string; evidence?: string };
interface Usage { usageStatus: Quality; codexUsage: Counts | null; missingExecutions: number; executions: number; pendingExecutions: number }
interface Receipt extends Usage { workRunId: string; projectId: string; title: string; executionStatus: string; acceptanceStatus: string; origin: Origin;
  codexThreads: number; receiptRevision: number; createdAt?: string; finishedAt?: string }
interface Project extends Usage { id: string; name: string; root: string; taskCount: number; activeTasks: number; pendingAcceptance: number; needsAttention: number }
interface Thread { id: string; title: string; agentId: string; providerThreadId: string; desktopThreadUrl: string; origin: Origin; createdHere: boolean; identityVerified: boolean;
  externalActivity: boolean; protected: boolean; archiveState: string; nameStatus: string; updatedAt: string; runs: { id: string; status: string; acceptance: string }[];
  control?: { state: string; providerTurnId?: string; revision: number; events: { sequence: number; eventType: string; state: string; createdAt: string }[] } }
interface Batch { batchId: string; projectId: string; mode: "archive" | "restore"; status: string; confirmationHash: string; expiresAt: string;
  acceptPartial: boolean; readyCount: number; succeededCount: number; entries: { managedThreadId: string; title: string; status: string; reason: string | null }[] }
type Detail = Receipt & { summary: string; evidence: { label: string; reference: string; outcome: string }[];
  operations: { id: string; kind: string; label: string; status: string; created_at: string }[];
  turns: { executionId: string; agentId: string; status: string; codexUsage: Counts | null; usageStatus: Quality; boundary: string; requestedModel: string | null; requestedEffort: string | null }[] };
const sourceLabels: Record<string, string> = { chatgpt_mcp: "ChatGPT → DevSpace", other_mcp: "MCP 主控 → DevSpace", devspace_cli: "DevSpace CLI", console: "管理台", legacy_unknown: "历史来源待确认" };
const states: Record<string, string> = { running: "执行中", queued: "排队中", completed: "执行完成", failed: "失败", cancelled: "已取消", reconciliation_required: "待核对",
  passed: "验收通过", pending: "待验收", not_applicable: "无需验收", active: "未归档", archived: "已归档", unknown: "状态未知",
  archiving: "归档中", restoring: "恢复中", planned: "待确认", executing: "处理中", succeeded: "成功", partial: "部分完成", ready: "可执行", skipped: "已跳过",
  devspace_active: "DevSpace 控制中", interrupting: "正在中断", desktop_pending: "等待 Desktop 接管", desktop_owned: "Desktop 已接管", terminal: "当前无活动轮次" };
const qualities: Record<Quality, string> = { complete: "统计完整", partial: "部分已记录", unavailable: "用量未知", not_used: "未调用 Codex" };
const reasons: Record<string, string> = {
  preview_budget_exhausted: "本次预览时间预算已用完，请缩小所选批次后重新预览",
  unproven_creation: "无法证明由 DevSpace 创建", unverified_provider_instance: "提供方实例未确认", external_turns_detected: "存在外部续写",
  user_protected: "已设为保留", archive_state_ineligible: "当前归档状态不符合条件", managed_agent_active: "代理仍在执行或排队",
  open_or_unaccepted_work: "关联任务未关闭或未验收", usage_incomplete: "用量尚有缺口", active_execution_claim: "还有执行占用",
  not_archived_by_devspace: "没有本系统归档成功的回执", provider_instance_changed: "Codex 账号或实例已变化",
  incomplete_descendant_inventory: "无法完整核查后代会话", provider_project_mismatch: "提供方项目不匹配", provider_thread_active_or_unknown: "提供方仍活动或状态未知",
  unarchived_descendants_require_review: "存在未归档后代，需单独核查", external_or_unmapped_turns: "发现未纳管执行，已保护",
  provider_archive_state_changed: "Codex 中的状态已变化", provider_state_unavailable: "无法读取提供方状态", managed_state_changed_since_preview: "预览后的任务状态已变化",
  provider_state_changed_since_preview: "预览后的会话内容或状态已变化", provider_acknowledgement_or_verification_missing: "请求结果待核对，不会盲目重发",
  unknown_prior_side_effect_not_replayed: "此前操作结果不确定，需要继续核对", externally_changed_or_protected: "外部修改或用户保护", unproven_creation_or_instance: "创建或实例归属不足",
};
const n = (value: number | undefined | null) => value == null ? "—" : new Intl.NumberFormat("zh-CN").format(value);
const date = (value: string | null | undefined) => value ? new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }) : "—";
const label = (value: string) => states[value] ?? value;

function Badge({ value, children }: { value: string; children?: React.ReactNode }) {
  return <span className={`badge badge-${value}`}>{children ?? label(value)}</span>;
}
function TokenValue({ usage, compact = false }: { usage: Usage; compact?: boolean }) {
  return <span className={compact ? "token compact" : "token"}><strong>{n(usage.codexUsage?.totalTokens)}</strong>{!compact && <small>Token</small>}
    <span className={`quality ${usage.usageStatus}`}>{qualities[usage.usageStatus]}</span></span>;
}
function Modal({ title, children, close, locked = false }: { title: string; children: React.ReactNode; close: () => void; locked?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); return () => ref.current?.close(); }, []);
  return <dialog className="modal" ref={ref} onCancel={(event) => { event.preventDefault(); if (!locked) close(); }} aria-label={title}>
    <header><h2>{title}</h2><button className="icon-button" aria-label="关闭" onClick={close} disabled={locked}>×</button></header><div className="modal-content">{children}</div></dialog>;
}

function ConsoleApp() {
  const [csrf, setCsrf] = useState<string | null>(null);
  const [boot, setBoot] = useState(true); const [password, setPassword] = useState("");
  const [error, setError] = useState(""); const [message, setMessage] = useState(""); const [busy, setBusy] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState(new URLSearchParams(location.search).get("project") ?? "");
  const [tab, setTab] = useState("tasks"); const [source, setSource] = useState(""); const [status, setStatus] = useState(""); const [range, setRange] = useState("all");
  const [runs, setRuns] = useState<Receipt[]>([]); const [offset, setOffset] = useState<number | null>(null); const [stats, setStats] = useState<Project | null>(null);
  const [threads, setThreads] = useState<Thread[]>([]); const [selection, setSelection] = useState<Set<string>>(new Set());
  const [detail, setDetail] = useState<Detail | null>(null); const [batch, setBatch] = useState<Batch | null>(null);
  const [history, setHistory] = useState<{ id: string; mode: string; status: string; created_at: string }[]>([]);
  const [attention, setAttention] = useState<{ claims: any[]; waiters: any[] }>({ claims: [], waiters: [] });
  const [acceptPartial, setAcceptPartial] = useState(false); const [externalIdle, setExternalIdle] = useState(false);
  const [updated, setUpdated] = useState<string>(); const epoch = useRef(0);
  const initialRun = useRef(new URLSearchParams(location.search).get("run"));
  const project = projects.find((entry) => entry.id === projectId);
  const api = useCallback(async (path: string, body?: unknown) => {
    const response = await fetch(`/console/api/${path}`, { method: body === undefined ? "GET" : "POST", credentials: "same-origin",
      cache: "no-store", headers: body === undefined ? {} : { "Content-Type": "application/json", ...(csrf ? { "X-DevSpace-CSRF": csrf } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    if (response.status === 401) { setCsrf(null); throw new Error(path === "login" ? "授权口令不正确。" : "会话已过期，请重新登录。"); }
    const result = await response.json();
    if (!response.ok) throw new Error(result.message ?? (response.status === 429 ? "操作过于频繁，请稍后再试。" : "请求未通过校验，状态尚未改变。"));
    return result;
  }, [csrf]);
  useEffect(() => { void api("session").then((result) => setCsrf(result.csrf)).catch(() => {}).finally(() => setBoot(false)); }, []);
  const query = () => {
    const params = new URLSearchParams(); if (source) params.set("source", source); if (status) params.set("status", status);
    if (range !== "all") params.set("after", new Date(Date.now() - Number(range) * 86400000).toISOString());
    return params;
  };
  const refresh = useCallback(async () => {
    if (!csrf) return;
    const turn = ++epoch.current;
    try {
      const list = await api("projects"); if (turn !== epoch.current) return;
      setProjects(list.projects);
      const id = list.projects.some((entry: Project) => entry.id === projectId) ? projectId : list.projects[0]?.id;
      if (!id) { setUpdated(new Date().toISOString()); return; }
      if (id !== projectId) { setProjectId(id); return; }
      const root = `projects/${encodeURIComponent(id)}`;
      const tasks = await api(`${root}/runs?${query()}`); if (turn !== epoch.current) return;
      setRuns(tasks.entries); setOffset(tasks.nextOffset); setStats(tasks.stats);
      if (tab === "sessions") {
        const [sessions, batches] = await Promise.all([api(`${root}/threads`), api(`${root}/archive`)]);
        if (turn !== epoch.current) return; setThreads(sessions.threads); setHistory(batches.batches);
      }
      if (tab === "attention") { const next = await api(`${root}/attention`); if (turn === epoch.current) setAttention(next); }
      setUpdated(new Date().toISOString());
    } catch (cause) { if (turn === epoch.current) setError(cause instanceof Error ? cause.message : "读取失败"); }
  }, [api, csrf, projectId, tab, source, status, range]);
  useEffect(() => { void refresh(); const timer = setInterval(() => { if (!document.hidden && !busy && !batch && !detail) void refresh(); }, 5000);
    return () => { clearInterval(timer); epoch.current++; }; }, [refresh, busy, batch, detail]);
  useEffect(() => { setSelection(new Set()); setDetail(null); setBatch(null); }, [projectId]);
  const act = async (action: () => Promise<void>) => { setBusy(true); setError(""); try { await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : "操作失败"); } finally { setBusy(false); } };
  const openDetail = (runId: string) => act(async () => setDetail(await api(`projects/${projectId}/runs/${runId}`)));
  useEffect(() => {
    if (!csrf || !projectId || !initialRun.current) return;
    const runId = initialRun.current; initialRun.current = null;
    void act(async () => setDetail(await api(`projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}`)));
  }, [csrf, projectId]);
  const preview = (mode: "archive" | "restore") => act(async () => {
    setExternalIdle(false); setBatch(await api(`projects/${projectId}/archive/preview`, { mode, acceptPartial,
      ...(selection.size ? { threadKeys: [...selection] } : {}) }));
  });
  const execute = () => act(async () => {
    if (!batch || !externalIdle) return;
    let result = batch;
    do {
      result = await api(`projects/${projectId}/archive/${result.batchId}/execute`, { confirmationHash: result.confirmationHash, externalIdle: true });
      setBatch(result);
    } while (result.status === "executing" && result.readyCount > 0);
    setMessage(result.status === "reconciliation_required" ? "部分结果需要核对，未盲目重试。批次记录已保存。" : "批次执行结果已保存，任务和用量历史保持不变。");
    await refresh();
  });
  const controlThread = (thread: Thread, action: "steer" | "interrupt" | "takeover" | "returnControl") => {
    const run = thread.runs.find((entry) => entry.status === "running") ?? thread.runs[0];
    if (!run) { setError("该会话没有可验证的工作运行，不能发送控制请求。"); return; }
    const prompt = action === "steer" ? window.prompt("输入要追加到当前轮次的新方向。内容会发送给当前 Codex turn。")?.trim() : undefined;
    if (action === "steer" && !prompt) return;
    if (action === "takeover" && !window.confirm("接管会先中断当前轮次；只有收到 interrupted 终态后才把写入权交给 Desktop。继续吗？")) return;
    const requestKey = `console-${action}-${typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}`}`;
    void act(async () => {
      const result = await api(`projects/${projectId}/threads/${thread.id}/control`, { action, workRunId: run.id, requestKey,
        ...(thread.control?.providerTurnId ? { expectedTurnId: thread.control.providerTurnId } : {}), ...(prompt ? { prompt } : {}) });
      setMessage(result.note); await refresh();
      if (action === "takeover") location.href = result.desktopThreadUrl;
    });
  };

  if (boot) return <main className="boot" aria-busy="true">正在连接 DevSpace…</main>;
  if (!csrf) return <main className="login-page"><section className="login-card">
    <div className="brand-mark">D<span>›</span></div><p className="eyebrow">DEVSPACE / PROJECT CONSOLE</p><h1>项目任务台</h1>
    <p className="lead">任务从哪里来，进展到哪里，<br />Codex 用了多少——一处看清。</p>
    <form onSubmit={(event) => { event.preventDefault(); void act(async () => { const result = await api("login", { password }); setPassword(""); setCsrf(result.csrf); }); }}>
      <label htmlFor="owner-password">DevSpace 授权口令</label><input id="owner-password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required maxLength={2048} />
      {error && <p className="notice error" role="alert">{error}</p>}<button className="primary" disabled={busy}>{busy ? "正在验证…" : "进入任务台"}</button>
    </form><p className="privacy-note">使用现有 DevSpace owner token 登录。口令不会写入网址或浏览器本地存储。浏览、统计和归档本身不调用 Codex 推理。</p>
  </section><div className="login-caption">本机执行 · 来源可追溯 · 验收有依据</div></main>;

  return <div className="console-shell">
    <aside className="sidebar"><a className="brand" href="/console/"><span className="brand-mark small">D<span>›</span></span><span>DevSpace<small>项目任务台</small></span></a>
      <div className="sidebar-heading">项目 <span>{projects.length}</span></div>
      <nav aria-label="项目选择">{projects.map((entry) => <button key={entry.id} className={`project-button ${entry.id === projectId ? "selected" : ""}`} onClick={() => setProjectId(entry.id)} disabled={busy}>
        <span className="project-initial">{entry.name.slice(0, 1).toUpperCase()}</span><span>{entry.name}<small>{entry.taskCount} 项任务 · {entry.activeTasks} 项进行中</small></span>{entry.activeTasks > 0 && <i className="live-dot" />}
      </button>)}</nav>
      <div className="sidebar-bottom"><span className="online-dot" /> 已认证的管理会话<p>仅展示 DevSpace 登记的任务。<br />未纳管聊天不会自动收集。</p><button onClick={() => void act(async () => { await api("logout", {}); setCsrf(null); })}>退出登录</button></div>
    </aside>
    <main className="main-content"><header className="page-header"><div><p className="eyebrow">WORK, WITH A RECORD</p><h1>{project?.name ?? "项目任务台"}</h1><p className="path" title={project?.root}>{project?.root ?? "打开工作区并开始任务后，这里会出现项目。"}</p></div>
      <div className="header-actions"><span className="updated">{updated ? `${date(updated)} 更新` : "读取中"}</span><button onClick={() => void refresh()} disabled={busy}>↻ 刷新</button><button onClick={() => void act(async () => { await api("logout", {}); setCsrf(null); })} disabled={busy}>退出</button></div></header>
      {error && <div role="alert" className="notice error">{error}<button onClick={() => setError("")}>关闭</button></div>}
      {message && <div role="status" className="notice success">{message}<button onClick={() => setMessage("")}>关闭</button></div>}
      {!project ? <section className="empty big"><span>◇</span><h2>还没有可见项目</h2><p>通过 DevSpace 打开工作区，再由主控使用 work_task 开始一项任务。<br />纯主控任务也会记账，未调用 Codex 时明确显示零。</p></section> : <>
      <section className="metric-grid" aria-label="项目统计"><article className="metric accent"><span>已记录的 Codex 消耗</span>{stats ? <TokenValue usage={stats} /> : <strong>—</strong>}<small>按任务开始时间统计 · 不等于订阅账单</small></article>
        <article className="metric"><span>进行中的任务</span><strong>{stats?.activeTasks ?? 0}<small> / {stats?.taskCount ?? 0}</small></strong><small>执行状态与验收结果分别记录</small></article>
        <article className="metric"><span>等待验收</span><strong>{stats?.pendingAcceptance ?? 0}</strong><small>模型回复结束，不代表验收通过</small></article>
        <article className="metric"><span>需要关注</span><strong>{stats?.needsAttention ?? 0}</strong><small>失败、历史缺口或待核对状态</small></article></section>
      <nav className="tabs" aria-label="项目页面">{[["tasks", "任务"], ["sessions", "Codex 会话"], ["usage", "用量"], ["attention", "需处理项"]].map(([value, text]) =>
        <button key={value} className={tab === value ? "active" : ""} onClick={() => setTab(value)} disabled={busy} aria-current={tab === value ? "page" : undefined}>{text}</button>)}</nav>
      {(tab === "tasks" || tab === "usage") && <>
        <div className="toolbar"><div className="filters"><label>来源<select value={source} onChange={(event) => setSource(event.target.value)}><option value="">全部来源</option>{Object.entries(sourceLabels).map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></label>
          <label>状态<select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">全部状态</option>{["running", "completed", "failed", "cancelled", "reconciliation_required"].map((value) => <option key={value} value={value}>{label(value)}</option>)}</select></label>
          <label>开始时间<select value={range} onChange={(event) => setRange(event.target.value)}><option value="all">全部时间</option><option value="7">近 7 天</option><option value="30">近 30 天</option></select></label></div><span className="subtle">缓存与推理明细不重复计入总量</span></div>
        {tab === "usage" && <section className="usage-explainer"><h2>看总消耗，也看统计边界</h2><p>完整：受管执行与用量边界齐全。部分：有已记录值，但仍有缺口。未知：没有足够证据，不能写成零。未调用：确认没有发起 Codex 推理。</p>
          <dl><div><dt>输入</dt><dd>{n(stats?.codexUsage?.inputTokens)}</dd></div><div><dt>其中缓存读取</dt><dd>{n(stats?.codexUsage?.cachedInputTokens)}</dd></div><div><dt>输出</dt><dd>{n(stats?.codexUsage?.outputTokens)}</dd></div><div><dt>缺少完整用量的执行</dt><dd>{n(stats?.missingExecutions)}</dd></div></dl></section>}
        <section className="table-panel"><div className="panel-title"><h2>{tab === "usage" ? "逐任务用量" : "项目任务"}</h2><span>一项需求一份回执</span></div>
          {!runs.length ? <div className="empty"><h3>没有符合条件的任务</h3><p>调整筛选条件，或开始一项新的工作。</p></div> : <div className="table-scroll"><table><thead><tr><th>任务 / 来源</th><th>执行与验收</th><th>Codex Token</th><th>会话</th><th>开始时间</th></tr></thead><tbody>{runs.map((run) => <tr key={run.workRunId}>
            <td><button className="task-title" onClick={() => void openDetail(run.workRunId)}>{run.title}</button><div className="source-line">{sourceLabels[run.origin.entryPoint] ?? run.origin.entryPoint}{run.origin.modelLabel && <span> · {run.origin.modelLabel}（标签）</span>}</div></td>
            <td><div className="state-stack"><Badge value={run.executionStatus} /><Badge value={run.acceptanceStatus} /></div></td><td><TokenValue usage={run} compact /></td><td>{run.codexThreads}</td><td className="date">{date(run.createdAt)}</td></tr>)}</tbody></table></div>}
          {offset !== null && <button className="load-more" disabled={busy} onClick={() => void act(async () => { const params = query(); params.set("offset", String(offset)); const more = await api(`projects/${projectId}/runs?${params}`); setRuns((current) => [...current, ...more.entries]); setOffset(more.nextOffset); })}>加载更多</button>}
        </section></>}
      {tab === "sessions" && <>
        <div className="session-note"><span>◇</span><div><strong>只整理能证明归属的会话</strong><p>Codex 归档会隐藏原聊天，不删除任务或 Token 历史；它也不会取消进程。存在外部续写或未验收任务时，默认跳过。</p></div></div>
        <div className="toolbar session-toolbar"><label className="check-label"><input type="checkbox" checked={acceptPartial} onChange={(event) => setAcceptPartial(event.target.checked)} />预览时允许保留不完整用量回执</label><div className="button-row"><button onClick={() => void preview("restore")} disabled={busy}>恢复已归档会话</button><button className="primary" onClick={() => void preview("archive")} disabled={busy}>{selection.size ? `预览归档 ${selection.size} 个会话` : "预览项目归档"}</button></div></div>
        <section className="table-panel"><div className="panel-title"><h2>受管 Codex 会话</h2><span>{threads.length} 个 · 来源登记，不靠标题猜测</span></div>{!threads.length ? <div className="empty"><h3>没有受管 Codex 会话</h3><p>主控直接读取不创建 Codex 聊天。</p></div> : <div className="table-scroll"><table><thead><tr><th><span className="sr-only">选择</span></th><th>会话 / 归属</th><th>实时控制</th><th>来源可信度</th><th>归档状态</th><th>保留</th></tr></thead><tbody>{threads.map((thread) => <tr key={thread.id}>
          <td><input type="checkbox" aria-label={`选择 ${thread.title}`} checked={selection.has(thread.id)} onChange={(event) => setSelection((current) => { const next = new Set(current); event.target.checked ? next.add(thread.id) : next.delete(thread.id); return next; })} /></td>
          <td><strong className="thread-title">{thread.title}</strong><div className="source-line">{sourceLabels[thread.origin.entryPoint] ?? "来源待确认"} · {thread.runs.length} 个工作执行</div><code>{thread.agentId}</code></td>
          <td className="control-cell"><Badge value={thread.control?.state ?? "terminal"} /><div className="button-row"><a className="thread-link" href={thread.desktopThreadUrl}>在 Desktop 打开</a>
            {thread.control?.state === "devspace_active" && <><button onClick={() => controlThread(thread, "steer")} disabled={busy}>转向</button><button onClick={() => controlThread(thread, "interrupt")} disabled={busy}>中断</button><button className="primary" onClick={() => controlThread(thread, "takeover")} disabled={busy}>接管</button></>}
            {thread.control?.state === "desktop_owned" && <button onClick={() => controlThread(thread, "returnControl")} disabled={busy}>归还 DevSpace</button>}</div>
            <div className="control-events">{thread.control?.events.slice(-3).map((event) => <span key={event.sequence}>{date(event.createdAt)} · {label(event.state)}</span>)}</div></td>
          <td>{thread.externalActivity ? <Badge value="reconciliation_required">外部续写</Badge> : <Badge value={thread.createdHere && thread.identityVerified ? "passed" : "pending"}>{thread.createdHere && thread.identityVerified ? "已登记创建" : "关联待核实"}</Badge>}</td>
          <td><Badge value={thread.archiveState} /></td><td><button className={thread.protected ? "protect active" : "protect"} onClick={() => void act(async () => { await api(`projects/${projectId}/threads/${thread.id}/protect`, { protected: !thread.protected }); await refresh(); })} disabled={busy}>{thread.protected ? "已保留" : "设为保留"}</button></td></tr>)}</tbody></table></div>}</section>
        <section className="history-panel"><h2>归档与恢复批次</h2>{!history.length ? <p className="subtle">尚无批次。预览和确认会留存独立记录。</p> : history.map((entry) => <button className="history-row" key={entry.id} onClick={() => void act(async () => { setExternalIdle(false); setBatch(await api(`projects/${projectId}/archive/${entry.id}`)); })}><span>{entry.mode === "archive" ? "归档" : "恢复"} · {date(entry.created_at)}</span><Badge value={entry.status} /><span>查看回执 →</span></button>)}</section>
      </>}
      {tab === "attention" && <section className="table-panel"><div className="panel-title"><h2>执行占用与等待</h2><span>只展示证据，不自动杀进程</span></div><div className="attention-content"><p>进程存在、模型线程空闲、任务完成是不同状态。中断遗留占用需要核对，不能通过归档聊天来“清理”。</p>
        {!attention.claims.length && !attention.waiters.length ? <div className="empty"><h3>当前没有登记的占用或等待</h3><p>这不等于已扫描并确认所有外部 Codex 客户端都已停止。</p></div> : [...attention.claims, ...attention.waiters].map((entry) => <div className="claim" key={entry.id}><strong>{entry.kind ?? "queued"}</strong><code>{entry.agent_id ?? entry.id}</code><span>{entry.access_mode} · {entry.owner_pid ? `PID ${entry.owner_pid}` : "尚未调用模型"}</span></div>)}</div></section>}
      </>}
      <footer className="page-footer"><span>DevSpace · 执行与证据层</span><span>页面刷新、统计和归档控制均不启动模型推理</span></footer>
    </main>
    {detail && <Modal title="任务详情与完成回执" close={() => setDetail(null)}><p className="eyebrow">{sourceLabels[detail.origin.entryPoint]}</p><h3 className="detail-title">{detail.title}</h3><div className="button-row"><Badge value={detail.executionStatus} /><Badge value={detail.acceptanceStatus} /></div>
      <div className="detail-usage"><TokenValue usage={detail} /><p>回执版本 {detail.receiptRevision} · {detail.missingExecutions} 个执行存在用量缺口</p></div><p>{detail.summary || "工作尚未提交最终验收摘要。"}</p>
      <h3>验收证据</h3>{detail.evidence.length ? detail.evidence.map((entry, index) => <div className="evidence" key={index}><Badge value={entry.outcome} /><strong>{entry.label}</strong><code>{entry.reference}</code></div>) : <p className="subtle">尚无最终验收证据，不将模型回复自动视为通过。</p>}
      <h3>Codex 执行</h3>{detail.turns.length ? detail.turns.map((turn) => <div className="execution" key={turn.executionId}><div><code>{turn.agentId}</code><Badge value={turn.status} /></div><span>{turn.requestedModel ?? "模型未记录"} · {turn.requestedEffort ?? "推理档位未记录"}</span><strong>{n(turn.codexUsage?.totalTokens)} Token · {qualities[turn.usageStatus]}</strong><small>{turn.boundary}</small></div>) : <p className="subtle">没有 Codex 执行记录；主控和本地工具可以独立完成任务。</p>}
      <h3>工具与验证操作</h3>{detail.operations.map((entry) => <div className="operation" key={entry.id}><span>{entry.label}</span><Badge value={entry.status} /></div>)}<p className="privacy-note">这里只展示任务摘要与证据引用，不复制私人聊天全文或隐藏推理。模型名称标签不作为可信来源证明。</p>
    </Modal>}
    {batch && <Modal title={batch.mode === "archive" ? "确认项目会话归档" : "确认恢复 Codex 会话"} close={() => setBatch(null)} locked={busy}>
      <p className="lead">{batch.readyCount} 个可执行 · {batch.succeededCount} 个已成功</p><p className="subtle">范围已冻结，确认后新创建的会话不会被加入。本操作不删除聊天、任务或用量历史。</p>
      <div className="batch-entries">{batch.entries.length ? batch.entries.map((entry) => <div className="batch-entry" key={entry.managedThreadId}><strong>{entry.title}</strong><Badge value={entry.status} />{entry.reason && <p>{reasons[entry.reason] ?? entry.reason}</p>}</div>) : <div className="empty">没有可选会话</div>}</div>
      <label className="check-label external-confirm"><input type="checkbox" checked={externalIdle} onChange={(event) => setExternalIdle(event.target.checked)} disabled={busy} />我已暂停此项目其他 Codex 客户端中的操作，确认只处理上述清单。</label>
      <p className="privacy-note">DevSpace 无法锁住独立的外部客户端；状态不明、外部续写或后代关系无法核实时仍会跳过。归档不代表后台任务已停止。</p>
      <button className="primary full-width" disabled={busy || !externalIdle || (!batch.readyCount && batch.status !== "reconciliation_required")} onClick={() => void execute()}>{busy ? "正在逐项核对与执行…" : batch.status === "reconciliation_required" ? "核对上次执行结果（不盲目重放）" : `确认${batch.mode === "archive" ? "归档" : "恢复"}`}</button>
    </Modal>}
  </div>;
}

const root = document.getElementById("root"); if (root) createRoot(root).render(<ConsoleApp />);
