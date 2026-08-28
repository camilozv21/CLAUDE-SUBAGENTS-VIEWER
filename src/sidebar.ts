import * as path from 'path';
import * as vscode from 'vscode';
import { isInsideAny, settings, workspaceRoots } from './config';
import { AgentInfo, AgentStatus, SessionInfo, WorkflowInfo } from './model';
import { baseCss, clientHelpersJs, nonce, stripFor } from './ui';

/* ------------------------------------------------------------- payload */

interface SideEvent {
  kind: 'tool' | 'thinking' | 'text';
  name?: string;
  summary: string;
  at: number;
  ms?: number;
  error?: boolean;
  pending?: boolean;
}

interface SideAgent {
  id: string;
  label: string;
  type: string;
  phase?: string;
  workflowId?: string;
  status: AgentStatus;
  stoppedByUser: boolean;
  depth: number;
  startedAt: number;
  lastActivity: number;
  durationMs: number;
  toolCalls: number;
  toolErrors: number;
  tokensIn: number;
  tokensOut: number;
  model?: string;
  currentName?: string;
  currentSummary?: string;
  currentAt?: number;
  strip: string;
  report?: string;
  promptPreview?: string;
  hasPrompt: boolean;
  hasReport: boolean;
  recent: SideEvent[];
  /** Tool names used, most frequent first (max 6). */
  topTools: { name: string; count: number }[];
}

interface Counts {
  running: number;
  completed: number;
  stalled: number;
  cancelled: number;
}

interface SideWorkflow {
  id: string;
  name?: string;
  status?: string;
  durationMs?: number;
  phases: { title: string; detail?: string }[];
  counts: Counts;
  agents: SideAgent[];
}

interface SideSession {
  id: string;
  dir: string;
  label: string;
  cwd?: string;
  slug?: string;
  live: boolean;
  liveStatus?: string;
  entrypoint?: string;
  version?: string;
  startedAt?: number;
  lastActivity: number;
  inWorkspace: boolean;
  counts: Counts;
  total: number;
  toolCalls: number;
  toolErrors: number;
  tokensOut: number;
  workflows: SideWorkflow[];
  /** Agents that do not belong to a workflow. */
  agents: SideAgent[];
}

export interface SideData {
  generatedAt: number;
  scope: 'workspace' | 'all';
  hasWorkspace: boolean;
  workspaceName?: string;
  thresholdSeconds: number;
  sessions: SideSession[];
}

const RECENT_EVENTS = 8;
const STRIP_LENGTH = 22;
const REPORT_CHARS = 280;

function emptyCounts(): Counts {
  return { running: 0, completed: 0, stalled: 0, cancelled: 0 };
}

function countInto(counts: Counts, status: AgentStatus): void {
  if (status === 'running') {
    counts.running++;
  } else if (status === 'completed') {
    counts.completed++;
  } else if (status === 'stalled') {
    counts.stalled++;
  } else if (status === 'cancelled') {
    counts.cancelled++;
  }
}

/** Collapses whitespace and drops the markdown markers that read as noise in a one-liner. */
function oneLine(text: string, max: number): string {
  const line = text
    .replace(/```[a-z]*/g, ' ')
    .replace(/[*_`#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function sessionLabel(session: SessionInfo): string {
  if (session.cwd) {
    return path.basename(session.cwd) || session.cwd;
  }
  return session.projectDirName.replace(/^[A-Za-z]--/, '').replace(/-+/g, '/');
}

function toSideAgent(agent: AgentInfo): SideAgent {
  const snap = agent.snapshot;
  const recent: SideEvent[] = [];
  const toolCounts = new Map<string, number>();
  for (const event of snap.events) {
    if (event.kind === 'tool') {
      toolCounts.set(event.name, (toolCounts.get(event.name) ?? 0) + 1);
    }
  }
  for (let i = snap.events.length - 1; i >= 0 && recent.length < RECENT_EVENTS; i--) {
    const event = snap.events[i];
    if (event.kind === 'prompt') {
      continue;
    }
    if (event.kind === 'tool') {
      const pending = event.result === undefined && event.endedAt === undefined;
      recent.push({
        kind: 'tool',
        name: event.name,
        summary: oneLine(event.summary, 110),
        at: event.at,
        ms: !pending && event.endedAt && event.at ? Math.max(0, event.endedAt - event.at) : undefined,
        error: event.isError === true,
        pending
      });
    } else {
      recent.push({ kind: event.kind, summary: oneLine(event.text, 110), at: event.at });
    }
  }
  recent.reverse();

  return {
    id: agent.transcriptPath,
    label: agent.disambiguator ? `${agent.description} ${agent.disambiguator}` : agent.description,
    type: agent.agentType,
    phase: agent.workflowPhase,
    workflowId: agent.workflowId,
    status: agent.status,
    stoppedByUser: agent.stoppedByUser,
    depth: agent.spawnDepth,
    startedAt: agent.startedAt,
    lastActivity: agent.lastActivity,
    durationMs: agent.durationMs,
    toolCalls: snap.toolCalls,
    toolErrors: snap.toolErrors,
    tokensIn: snap.tokensIn,
    tokensOut: snap.tokensOut,
    model: snap.model,
    currentName: agent.status === 'running' ? snap.currentTool?.name : undefined,
    currentSummary: agent.status === 'running' ? oneLine(snap.currentTool?.summary ?? '', 120) : undefined,
    currentAt: agent.status === 'running' ? snap.currentTool?.at : undefined,
    strip: stripFor(agent, STRIP_LENGTH),
    report: snap.finalText ? oneLine(snap.finalText, REPORT_CHARS) : undefined,
    promptPreview: snap.prompt ? oneLine(snap.prompt, 200) : undefined,
    hasPrompt: Boolean(snap.prompt),
    hasReport: Boolean(snap.finalText),
    recent,
    topTools: [...toolCounts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 6)
  };
}

function sortAgents(agents: SideAgent[]): SideAgent[] {
  return agents.sort((a, b) => {
    const rank = (s: AgentStatus) => (s === 'running' ? 0 : 1);
    if (rank(a.status) !== rank(b.status)) {
      return rank(a.status) - rank(b.status);
    }
    return b.lastActivity - a.lastActivity;
  });
}

function toSideWorkflow(workflow: WorkflowInfo): SideWorkflow {
  const counts = emptyCounts();
  const agents = workflow.agents.map(toSideAgent);
  for (const agent of agents) {
    countInto(counts, agent.status);
  }
  return {
    id: workflow.workflowId,
    name: workflow.name,
    status: workflow.status,
    durationMs: workflow.durationMs,
    phases: workflow.phases ?? [],
    counts,
    agents: sortAgents(agents)
  };
}

export function buildSidebarData(sessions: SessionInfo[]): SideData {
  const roots = workspaceRoots();
  const hasWorkspace = roots.length > 0;
  const scope: 'workspace' | 'all' = settings.onlyCurrentWorkspace() && hasWorkspace ? 'workspace' : 'all';

  const out: SideSession[] = sessions.map((session) => {
    const inWorkflow = new Set(session.workflows.flatMap((w) => w.agents.map((a) => a.transcriptPath)));
    const counts = emptyCounts();
    let toolCalls = 0;
    let toolErrors = 0;
    let tokensOut = 0;
    for (const agent of session.agents) {
      countInto(counts, agent.status);
      toolCalls += agent.snapshot.toolCalls;
      toolErrors += agent.snapshot.toolErrors;
      tokensOut += agent.snapshot.tokensOut;
    }
    return {
      id: session.sessionId,
      dir: session.sessionDir,
      label: sessionLabel(session),
      cwd: session.cwd,
      slug: session.slug,
      live: session.live,
      liveStatus: session.liveStatus,
      entrypoint: session.entrypoint,
      version: session.version,
      startedAt: session.startedAt,
      lastActivity: session.lastActivity,
      inWorkspace: hasWorkspace ? isInsideAny(session.cwd, roots) : true,
      counts,
      total: session.agents.length,
      toolCalls,
      toolErrors,
      tokensOut,
      workflows: session.workflows.map(toSideWorkflow),
      agents: sortAgents(session.agents.filter((a) => !inWorkflow.has(a.transcriptPath)).map(toSideAgent))
    };
  });

  return {
    generatedAt: Date.now(),
    scope,
    hasWorkspace,
    workspaceName: hasWorkspace ? path.basename(roots[0]) : undefined,
    thresholdSeconds: settings.runningThresholdSeconds(),
    sessions: out
  };
}

/* ---------------------------------------------------------------- view */

export interface SidebarActions {
  openAgent(transcriptPath: string): void;
  openTranscript(transcriptPath: string): void;
  copyPrompt(transcriptPath: string): void;
  copyReport(transcriptPath: string): void;
  revealSession(sessionDir: string): void;
  openDashboard(focus?: { sessionId?: string; onlyActive?: boolean }): void;
  setScope(scope: 'workspace' | 'all'): void;
  refresh(): void;
  openSettings(): void;
}

export class SidebarView implements vscode.WebviewViewProvider {
  static readonly viewType = 'claudeSubagents.panel';

  private view: vscode.WebviewView | undefined;
  private lastData: SideData | undefined;
  private lastSignature = '';

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly actions: SidebarActions
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [] };
    const n = nonce();
    const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${n}';`;
    view.webview.html = shellHtml(csp, n);

    view.webview.onDidReceiveMessage(
      (message: Record<string, unknown>) => this.onMessage(message),
      null,
      this.context.subscriptions
    );
    view.onDidDispose(
      () => {
        this.view = undefined;
        this.lastSignature = '';
      },
      null,
      this.context.subscriptions
    );
    view.onDidChangeVisibility(
      () => {
        if (view.visible && this.lastData) {
          void view.webview.postMessage({ type: 'data', payload: this.lastData });
        }
      },
      null,
      this.context.subscriptions
    );
  }

  update(sessions: SessionInfo[], force = false): void {
    const data = buildSidebarData(sessions);
    this.lastData = data;
    if (!this.view) {
      return;
    }
    const signature = signatureOf(data);
    if (!force && signature === this.lastSignature) {
      return;
    }
    this.lastSignature = signature;
    void this.view.webview.postMessage({ type: 'data', payload: data });
  }

  private onMessage(message: Record<string, unknown>): void {
    const id = typeof message.id === 'string' ? message.id : '';
    switch (message.type) {
      case 'ready':
        if (this.lastData) {
          void this.view?.webview.postMessage({ type: 'data', payload: this.lastData });
        } else {
          this.actions.refresh();
        }
        return;
      case 'open':
        if (id) {
          this.actions.openAgent(id);
        }
        return;
      case 'transcript':
        if (id) {
          this.actions.openTranscript(id);
        }
        return;
      case 'copyPrompt':
        if (id) {
          this.actions.copyPrompt(id);
        }
        return;
      case 'copyReport':
        if (id) {
          this.actions.copyReport(id);
        }
        return;
      case 'reveal':
        if (typeof message.dir === 'string') {
          this.actions.revealSession(message.dir);
        }
        return;
      case 'dashboard':
        this.actions.openDashboard({
          sessionId: typeof message.sessionId === 'string' ? message.sessionId : undefined,
          onlyActive: message.onlyActive === true
        });
        return;
      case 'setScope':
        this.actions.setScope(message.scope === 'all' ? 'all' : 'workspace');
        return;
      case 'refresh':
        this.actions.refresh();
        return;
      case 'settings':
        this.actions.openSettings();
        return;
      default:
        return;
    }
  }
}

function signatureOf(data: SideData): string {
  const parts: string[] = [data.scope];
  for (const session of data.sessions) {
    const c = session.counts;
    parts.push(`${session.id}:${session.live ? 1 : 0}:${session.lastActivity}:${c.running}/${c.completed}/${c.stalled}/${c.cancelled}:${session.toolCalls}`);
    for (const agent of session.agents) {
      parts.push(`${agent.id}@${agent.lastActivity}:${agent.status}:${agent.toolCalls}`);
    }
    for (const workflow of session.workflows) {
      for (const agent of workflow.agents) {
        parts.push(`${agent.id}@${agent.lastActivity}:${agent.status}:${agent.toolCalls}`);
      }
    }
  }
  return parts.join('|');
}

/* ---------------------------------------------------------------- html */

function css(): string {
  return `
body { background: var(--vscode-sideBar-background); padding: 0; overflow-x: hidden; }
#app { display: flex; flex-direction: column; min-height: 100vh; }

/* ---- header --------------------------------------------------------- */
.top { position: sticky; top: 0; z-index: 5; background: var(--vscode-sideBar-background); border-bottom: 1px solid var(--grid); padding: 8px 10px 8px; }
.hero { display: flex; align-items: center; gap: 9px; }
.hero .ring { width: 30px; height: 30px; border-radius: 50%; flex: none; display: flex; align-items: center; justify-content: center; position: relative; color: var(--sc); background: color-mix(in srgb, var(--sc) var(--tint), transparent); }
.hero .ring .ic { width: 15px; height: 15px; }
.hero .ring.run::after { content: ''; position: absolute; inset: -2px; border-radius: 50%; border: 2px solid transparent; border-top-color: var(--sc); animation: spin 1s linear infinite; }
.hero .t { font-weight: 600; font-size: .92rem; line-height: 1.25; }
.hero .s { color: var(--ink-2); font-size: .74rem; margin-top: 1px; }
.hero .grow { flex: 1; min-width: 0; }
.hero .tools { display: flex; gap: 2px; flex: none; }

.kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 5px; margin-top: 9px; }
.kpi { border: 1px solid var(--grid); border-radius: 6px; padding: 5px 4px 4px; text-align: center; cursor: pointer; background: var(--card-2); position: relative; transition: border-color .12s; }
.kpi:hover { border-color: color-mix(in srgb, var(--sc) 60%, transparent); }
.kpi.on { border-color: var(--sc); background: color-mix(in srgb, var(--sc) var(--tint), transparent); box-shadow: inset 0 0 0 1px var(--sc); }
.kpi .v { font-size: 1.15rem; font-weight: 700; line-height: 1.1; color: var(--sc); font-variant-numeric: tabular-nums; }
.kpi .k { font-size: .62rem; color: var(--ink-2); text-transform: uppercase; letter-spacing: .04em; margin-top: 2px; display: flex; align-items: center; justify-content: center; gap: 3px; }
.kpi .k .ic { width: .85em; height: .85em; color: var(--sc); }
.kpi.zero .v { color: var(--ink-3); }
.k-run { --sc: var(--c-run); } .k-done { --sc: var(--c-done); } .k-stall { --sc: var(--c-stall); } .k-cancel { --sc: var(--c-cancel); }

.toolbar { margin-top: 8px; display: flex; flex-direction: column; gap: 6px; }
.searchwrap { position: relative; }
.searchwrap .ic { position: absolute; left: 7px; top: 50%; transform: translateY(-50%); color: var(--ink-2); pointer-events: none; }
.searchwrap input { padding-left: 24px; padding-right: 22px; }
.searchwrap .clear { position: absolute; right: 3px; top: 50%; transform: translateY(-50%); }
.scope { display: flex; align-items: center; gap: 6px; }
.scope select { flex: 1; }
.scope .ic { color: var(--ink-2); }
.activefilter { display: flex; align-items: center; gap: 6px; font-size: .72rem; color: var(--ink-2); padding: 2px 0 0; }
.activefilter b { color: var(--ink); font-weight: 600; }

/* ---- list ------------------------------------------------------------ */
.list { flex: 1; padding: 6px 8px 14px; display: flex; flex-direction: column; gap: 8px; }

.session { border: 1px solid var(--grid); border-radius: var(--radius); background: var(--card); overflow: hidden; }
.session.live { border-color: color-mix(in srgb, var(--c-done) 45%, var(--grid)); }
.s-head { padding: 7px 8px 6px; cursor: pointer; user-select: none; }
.s-head:hover { background: var(--card-2); }
.s-row { display: flex; align-items: center; gap: 6px; min-width: 0; }
.s-row .chev { color: var(--ink-2); transition: transform .12s; flex: none; }
.session.open .s-row .chev { transform: rotate(90deg); }
.s-row .name { font-weight: 600; font-size: .84rem; flex: 1; min-width: 0; }
.s-row .live-pill { flex: none; }
.s-meta { display: flex; flex-wrap: wrap; gap: 3px 8px; font-size: .7rem; color: var(--ink-2); margin: 3px 0 0 20px; align-items: center; }
.s-meta .ic { color: var(--ink-3); }
.s-stack { margin: 6px 0 0 20px; }
.s-body { border-top: 1px solid var(--grid); padding: 6px 6px 6px; display: flex; flex-direction: column; gap: 6px; background: color-mix(in srgb, var(--vscode-sideBar-background) 60%, var(--card)); }
.session:not(.open) .s-body { display: none; }
.s-actions { display: flex; gap: 4px; justify-content: flex-end; padding: 2px 0 0; }

.wf { border: 1px dashed color-mix(in srgb, var(--t-agent) 45%, var(--grid)); border-radius: 7px; padding: 6px 6px 6px; display: flex; flex-direction: column; gap: 6px; background: color-mix(in srgb, var(--t-agent) 4%, transparent); }
.wf-head { display: flex; align-items: center; gap: 6px; min-width: 0; cursor: pointer; }
.wf-head .ic { color: var(--t-agent); }
.wf-head .name { font-weight: 600; font-size: .78rem; flex: 1; min-width: 0; }
.wf-head .chev { color: var(--ink-2); transition: transform .12s; }
.wf.open .wf-head .chev { transform: rotate(90deg); }
.wf-prog { display: flex; align-items: center; gap: 6px; font-size: .68rem; color: var(--ink-2); }
.wf-prog .bar { flex: 1; height: 5px; border-radius: 3px; background: var(--card-2); overflow: hidden; display: flex; }
.wf-prog .bar span { height: 100%; display: block; }
.phases { display: flex; flex-wrap: wrap; gap: 3px; }
.phase { font-size: .64rem; padding: 0 6px; border-radius: 999px; border: 1px solid var(--grid); color: var(--ink-2); display: inline-flex; gap: 4px; align-items: center; line-height: 1.6; }
.phase.active { border-color: var(--c-run); color: var(--c-run); background: color-mix(in srgb, var(--c-run) var(--tint), transparent); }
.phase.done { border-color: color-mix(in srgb, var(--c-done) 50%, transparent); color: var(--c-done); }
.phase .n { font-variant-numeric: tabular-nums; opacity: .85; }
.wf:not(.open) .wf-agents { display: none; }
.wf-agents { display: flex; flex-direction: column; gap: 6px; }

/* ---- agent card ------------------------------------------------------ */
.card { --sc: var(--c-cancel); border: 1px solid var(--grid); border-left: 3px solid var(--sc); border-radius: 7px; background: var(--card); padding: 6px 7px 6px 8px; position: relative; }
.card.run { --sc: var(--c-run); } .card.done { --sc: var(--c-done); } .card.stall { --sc: var(--c-stall); } .card.cancel { --sc: var(--c-cancel); }
.card.run { box-shadow: 0 0 0 1px color-mix(in srgb, var(--c-run) 25%, transparent); }
.card:hover { border-color: color-mix(in srgb, var(--sc) 55%, var(--grid)); }
.c-row1 { display: flex; align-items: center; gap: 6px; min-width: 0; }
.c-status { width: 20px; height: 20px; border-radius: 50%; flex: none; display: flex; align-items: center; justify-content: center; position: relative; color: var(--sc); background: color-mix(in srgb, var(--sc) var(--tint), transparent); }
.c-status .ic { width: 11px; height: 11px; }
.c-status.run::after { content: ''; position: absolute; inset: -2px; border-radius: 50%; border: 2px solid transparent; border-top-color: var(--sc); animation: spin 1s linear infinite; }
.c-title { flex: 1; min-width: 0; font-weight: 600; font-size: .82rem; cursor: pointer; line-height: 1.25; }
.c-title:hover { text-decoration: underline; text-decoration-color: var(--sc); }
.c-id { font-family: var(--mono); font-size: .66rem; color: var(--ink-3); flex: none; }
.c-time { font-size: .72rem; color: var(--ink-2); font-variant-numeric: tabular-nums; flex: none; display: inline-flex; align-items: center; gap: 3px; }
.c-time.run { color: var(--c-run); font-weight: 600; }
.c-exp { flex: none; }
.c-exp .ic { transition: transform .12s; }
.card.open .c-exp .ic { transform: rotate(90deg); }
.c-badges { display: flex; flex-wrap: wrap; gap: 3px 4px; margin: 4px 0 0 26px; align-items: center; }
.c-badges .pill { font-size: .66rem; padding: 0 7px 0 5px; }

.c-now { margin: 6px 0 0 26px; padding: 5px 7px; border-radius: 5px; background: color-mix(in srgb, var(--c-run) 8%, transparent); border: 1px solid color-mix(in srgb, var(--c-run) 25%, transparent); font-size: .74rem; }
.c-now .l1 { display: flex; align-items: center; gap: 5px; min-width: 0; }
.c-now .lbl { font-size: .6rem; text-transform: uppercase; letter-spacing: .06em; color: var(--c-run); font-weight: 700; flex: none; }
.c-now .tn { font-weight: 600; flex: none; }
.c-now .sum { flex: 1; min-width: 0; color: var(--ink-2); font-family: var(--mono); font-size: .7rem; }
.c-now .el { flex: none; color: var(--ink-2); font-variant-numeric: tabular-nums; }
.c-now .warn { margin-top: 4px; display: flex; gap: 5px; align-items: flex-start; color: var(--c-stall); font-size: .7rem; line-height: 1.3; }
.c-now .warn .ic { margin-top: 2px; }

.c-note { margin: 6px 0 0 26px; font-size: .72rem; color: var(--ink-2); line-height: 1.35; display: flex; gap: 5px; align-items: flex-start; }
.c-note .ic { flex: none; margin-top: 2px; }
.c-report { margin: 6px 0 0 26px; font-size: .72rem; color: var(--ink-2); line-height: 1.35; display: flex; gap: 5px; align-items: flex-start; border-left: 2px solid color-mix(in srgb, var(--c-done) 50%, transparent); padding-left: 6px; }
.c-report .txt { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.c-report .lbl { color: var(--c-done); font-weight: 700; font-size: .6rem; text-transform: uppercase; letter-spacing: .06em; flex: none; margin-top: 2px; }

.c-foot { display: flex; align-items: center; gap: 8px; margin: 6px 0 0 26px; font-size: .68rem; color: var(--ink-2); min-width: 0; flex-wrap: wrap; }
.c-foot .m { display: inline-flex; align-items: center; gap: 3px; white-space: nowrap; font-variant-numeric: tabular-nums; }
.c-foot .m .ic { color: var(--ink-3); }
.c-foot .m.err { color: var(--c-err); }
.c-foot .m.err .ic { color: var(--c-err); }
.c-foot .strip { margin-left: auto; }
.card .cell { width: 4px; }

.c-more { margin: 7px 0 0 0; border-top: 1px dashed var(--grid); padding-top: 6px; }
.card:not(.open) .c-more { display: none; }
.c-more h4 { margin: 0 0 4px; font-size: .62rem; text-transform: uppercase; letter-spacing: .06em; color: var(--ink-2); font-weight: 700; }
.ev { display: flex; align-items: flex-start; gap: 5px; font-size: .7rem; padding: 2px 0; min-width: 0; border-left: 2px solid var(--evc, var(--grid)); padding-left: 6px; margin-left: 4px; }
.ev .ic { flex: none; margin-top: 2px; }
.ev .name { font-weight: 600; flex: none; }
.ev .sum { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ink-2); font-family: var(--mono); font-size: .66rem; }
.ev .d { flex: none; color: var(--ink-3); font-variant-numeric: tabular-nums; }
.ev.err .d { color: var(--c-err); font-weight: 600; }
.ev.err { --evc: var(--c-err); }
.ev.thinking { --evc: var(--c-think); }
.ev.text { --evc: var(--c-text); }
.ev.thinking .sum, .ev.text .sum { font-family: inherit; font-size: .7rem; font-style: italic; }
.tools-used { display: flex; flex-wrap: wrap; gap: 3px; margin-bottom: 6px; }
.tools-used .tu { font-size: .64rem; border: 1px solid var(--grid); border-radius: 999px; padding: 0 6px; display: inline-flex; align-items: center; gap: 3px; color: var(--ink-2); line-height: 1.6; }
.prompt-prev { font-size: .7rem; color: var(--ink-2); font-style: italic; margin-bottom: 6px; line-height: 1.35; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.c-actions { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
.c-actions .btn { font-size: .7rem; padding: 2px 7px; }

/* ---- empty / foot ---------------------------------------------------- */
.empty { padding: 28px 14px; text-align: center; color: var(--ink-2); font-size: .8rem; line-height: 1.45; }
.empty .big { width: 40px; height: 40px; color: var(--ink-3); margin-bottom: 8px; }
.empty b { color: var(--ink); display: block; font-size: .9rem; margin-bottom: 4px; }
.empty .actions { display: flex; gap: 6px; justify-content: center; margin-top: 12px; flex-wrap: wrap; }
.empty code { font-size: .72rem; }
.more-row { display: flex; justify-content: center; padding: 2px 0; }

.foot { border-top: 1px solid var(--grid); padding: 6px 10px 8px; font-size: .7rem; color: var(--ink-2); background: var(--vscode-sideBar-background); position: sticky; bottom: 0; }
.foot .row { display: flex; align-items: center; gap: 8px; }
.foot .row .grow { flex: 1; }
.legend { margin-top: 6px; display: none; flex-direction: column; gap: 4px; }
.foot.open .legend { display: flex; }
.legend .lg { display: flex; align-items: flex-start; gap: 6px; line-height: 1.35; }
.legend .lg .pill { flex: none; }
.legend .lg .strip { flex: none; margin-top: 3px; }
.legend h5 { margin: 4px 0 0; font-size: .62rem; text-transform: uppercase; letter-spacing: .06em; color: var(--ink-3); font-weight: 700; }
.legend .cats { display: flex; flex-wrap: wrap; gap: 3px 8px; }
.legend .cats span { display: inline-flex; align-items: center; gap: 3px; }
`;
}

function clientJs(): string {
  // Plain string concatenation only: no template literals inside the webview script.
  return `
const vscodeApi = acquireVsCodeApi();
let DATA = null;
const saved = vscodeApi.getState() || {};
const S = {
  filter: saved.filter || 'all',
  q: saved.q || '',
  collapsed: saved.collapsed || {},
  wfCollapsed: saved.wfCollapsed || {},
  expanded: saved.expanded || {},
  more: saved.more || {},
  legend: !!saved.legend
};
const PAGE = 30;
function persist() { vscodeApi.setState(S); }
function post(msg) { vscodeApi.postMessage(msg); }

const FILTERS = {
  all: { label: 'todos', test: () => true },
  running: { label: 'ejecutando ahora', test: (a) => a.status === 'running' },
  completed: { label: 'completados', test: (a) => a.status === 'completed' },
  stalled: { label: 'detenidos', test: (a) => a.status === 'stalled' },
  cancelled: { label: 'cancelados', test: (a) => a.status === 'cancelled' }
};

function matchesQuery(a, q) {
  if (!q) return true;
  const hay = [a.label, a.type, a.phase || '', a.model || '', a.currentName || '', a.currentSummary || '', a.workflowId || '']
    .concat((a.topTools || []).map((t) => t.name))
    .join(' ').toLowerCase();
  return q.split(/\\s+/).every((w) => hay.indexOf(w) >= 0);
}
function agentVisible(a) {
  return (FILTERS[S.filter] || FILTERS.all).test(a) && matchesQuery(a, S.q.trim().toLowerCase());
}
function scopedSessions() {
  if (!DATA) return [];
  return DATA.sessions.filter((s) => DATA.scope === 'all' || s.inWorkspace);
}
function allAgents(s) { return s.agents.concat(s.workflows.flatMap((w) => w.agents)); }
function totals(sessions) {
  const t = { running: 0, completed: 0, stalled: 0, cancelled: 0, total: 0, live: 0 };
  for (const s of sessions) {
    t.running += s.counts.running; t.completed += s.counts.completed; t.stalled += s.counts.stalled; t.cancelled += s.counts.cancelled;
    t.total += s.total; if (s.live) t.live++;
  }
  return t;
}
function entryLabel(e) {
  if (!e) return '';
  if (e === 'claude-vscode') return 'VS Code';
  if (e === 'cli') return 'terminal';
  return e;
}
function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

/* ---------- header ---------- */
function renderHero(t) {
  let cls, ic, title, sub;
  const latest = scopedSessions().reduce((m, s) => Math.max(m, s.lastActivity), 0);
  if (t.running > 0) {
    cls = 'run'; ic = 'play';
    title = plural(t.running, 'subagente activo', 'subagentes activos') + ' ahora';
    sub = 'en ' + plural(scopedSessions().filter((s) => s.counts.running > 0).length, 'sesión', 'sesiones') + ' · último cambio <span data-ago="' + latest + '">' + ago(latest) + '</span>';
  } else if (t.total > 0) {
    cls = 'done'; ic = 'check';
    title = 'Sin actividad en este momento';
    sub = plural(t.total, 'subagente registrado', 'subagentes registrados') + ' · último <span data-ago="' + latest + '">' + ago(latest) + '</span>';
  } else {
    cls = 'cancel'; ic = 'robot';
    title = 'Sin subagentes todavía';
    sub = 'Aparecerán aquí en cuanto Claude Code lance alguno';
  }
  return '<div class="hero">' +
    '<div class="ring ' + cls + '" style="--sc:var(--c-' + cls + ')">' + icon(ic) + '</div>' +
    '<div class="grow"><div class="t">' + title + '</div><div class="s">' + sub + '</div></div>' +
    '<div class="tools">' +
      '<button class="btn btn-ghost" data-act="dashboard" data-tip="<b>Panel gráfico</b><br>Gantt, tarjetas y estadísticas de toda la flota">' + icon('graph') + '</button>' +
      '<button class="btn btn-ghost" data-act="refresh" data-tip="Volver a leer los transcripts ahora">' + icon('refresh') + '</button>' +
    '</div></div>';
}
function kpi(key, cls, ic, label, n, tipText) {
  const on = S.filter === key;
  return '<div class="kpi k-' + cls + (on ? ' on' : '') + (n === 0 ? ' zero' : '') + '" data-filter="' + key + '" data-tip="<b>' + label + '</b><br>' + esc(tipText) + '<br><span class=k>' + (on ? 'Clic para quitar el filtro' : 'Clic para ver solo estos') + '</span>">' +
    '<div class="v">' + n + '</div><div class="k">' + icon(ic) + label + '</div></div>';
}
function renderKpis(t) {
  return '<div class="kpis">' +
    kpi('running', 'run', 'play', 'Activos', t.running, STATE.running.hint) +
    kpi('completed', 'done', 'check', 'Listos', t.completed, STATE.completed.hint) +
    kpi('stalled', 'stall', 'pause', 'Detenidos', t.stalled, STATE.stalled.hint) +
    kpi('cancelled', 'cancel', 'x', 'Cancelados', t.cancelled, STATE.cancelled.hint) +
  '</div>';
}
function renderToolbar() {
  const inWs = DATA.sessions.filter((s) => s.inWorkspace).length;
  const all = DATA.sessions.length;
  const wsName = DATA.workspaceName ? esc(DATA.workspaceName) : 'este proyecto';
  const scopeSel = DATA.hasWorkspace
    ? '<div class="scope">' + icon('folder') + '<select class="sel" id="scope" data-tip="<b>Ámbito</b><br>Qué sesiones de Claude Code se muestran">' +
        '<option value="workspace"' + (DATA.scope === 'workspace' ? ' selected' : '') + '>Solo ' + wsName + ' (' + inWs + ' ' + (inWs === 1 ? 'sesión' : 'sesiones') + ')</option>' +
        '<option value="all"' + (DATA.scope === 'all' ? ' selected' : '') + '>Todos los proyectos (' + all + ' ' + (all === 1 ? 'sesión' : 'sesiones') + ')</option>' +
      '</select></div>'
    : '';
  return '<div class="toolbar">' +
    '<div class="searchwrap">' + icon('search') +
      '<input class="search" id="q" type="text" placeholder="Buscar por nombre, tipo, herramienta, fase…" value="' + esc(S.q) + '" spellcheck="false">' +
      (S.q ? '<button class="btn btn-ghost clear" id="qclear" data-tip="Limpiar búsqueda">' + icon('x') + '</button>' : '') +
    '</div>' + scopeSel + '</div>';
}
function renderActiveFilter(shown, total) {
  if (S.filter === 'all' && !S.q.trim()) return '';
  const bits = [];
  if (S.filter !== 'all') bits.push('estado <b>' + FILTERS[S.filter].label + '</b>');
  if (S.q.trim()) bits.push('búsqueda <b>«' + esc(S.q.trim()) + '»</b>');
  return '<div class="activefilter">' + icon('filter') + '<span>Mostrando ' + shown + ' de ' + total + ' · ' + bits.join(' · ') + '</span>' +
    '<button class="btn btn-ghost" data-act="clearfilters" data-tip="Quitar todos los filtros">' + icon('x') + ' quitar</button></div>';
}

/* ---------- cards ---------- */
function liveSpan(since, prefix) {
  return '<span data-live-since="' + since + '" data-live-prefix="' + esc(prefix || '') + '">' + (prefix || '') + durShort(Date.now() - since) + '</span>';
}
function nowBlock(a) {
  if (a.status !== 'running') return '';
  if (!a.currentName) {
    return '<div class="c-now"><div class="l1"><span class="dot bg-run pulse"></span><span class="lbl">Ahora</span>' + icon('sparkle', 'st-think') + '<span class="sum" style="font-family:inherit;font-style:italic">razonando o redactando la respuesta…</span></div></div>';
  }
  const since = a.currentAt || a.lastActivity;
  const elapsed = Date.now() - since;
  const long = elapsed > 60000;
  return '<div class="c-now">' +
    '<div class="l1"><span class="dot bg-run pulse"></span><span class="lbl">Ahora</span>' + toolIcon(a.currentName) +
      '<span class="tn">' + esc(prettyTool(a.currentName)) + '</span>' +
      '<span class="sum ellipsis" data-tip="' + esc(a.currentSummary || '') + '">' + esc(a.currentSummary || '') + '</span>' +
      '<span class="el">' + liveSpan(since, '') + '</span></div>' +
    (long ? '<div class="warn">' + icon('warning') + '<span>Lleva ' + liveSpan(since, '') + ' en esta llamada. Puede ser un comando largo, o un proceso colgado: revisa el detalle.</span></div>' : '') +
  '</div>';
}
function noteBlock(a) {
  if (a.status === 'completed') {
    if (a.report) {
      return '<div class="c-report"><span class="lbl">Informe</span><span class="txt" data-tip="' + esc(a.report) + '">' + esc(a.report) + '</span></div>';
    }
    return '<div class="c-note">' + icon('check', 'st-done') + '<span>Terminó sin redactar un informe final.</span></div>';
  }
  if (a.status === 'stalled') {
    return '<div class="c-note" data-tip="<b>¿Por qué detenido?</b><br>Dejó de escribir en su transcript sin cerrar el turno. Suele pasar al cancelar un workflow, cerrar la sesión de Claude Code o por un error de la API. Si vuelve a escribir, pasará de nuevo a ejecutando.">' + icon('pause', 'st-stall') + '<span>Sin actividad desde <b data-ago="' + a.lastActivity + '">' + ago(a.lastActivity) + '</b>; no cerró su turno.</span></div>';
  }
  if (a.status === 'cancelled') {
    return '<div class="c-note">' + icon('x', 'st-cancel') + '<span>Detenido por el usuario tras ' + dur(a.durationMs) + ' y ' + plural(a.toolCalls, 'herramienta', 'herramientas') + '.</span></div>';
  }
  return '';
}
function eventRow(e) {
  if (e.kind === 'thinking') {
    return '<div class="ev thinking">' + icon('sparkle', 'st-think') + '<span class="name">razona</span><span class="sum" data-tip="' + esc(e.summary) + '">' + esc(e.summary) + '</span><span class="d">' + clock(e.at) + '</span></div>';
  }
  if (e.kind === 'text') {
    return '<div class="ev text">' + icon('comment', 'st-done') + '<span class="name">dice</span><span class="sum" data-tip="' + esc(e.summary) + '">' + esc(e.summary) + '</span><span class="d">' + clock(e.at) + '</span></div>';
  }
  const cat = toolCat(e.name);
  const d = e.pending ? '<span class="st-run">en curso…</span>' : e.error ? 'error' : dur(e.ms);
  return '<div class="ev' + (e.error ? ' err' : '') + '" style="--evc:var(--t-' + cat + ')">' + toolIcon(e.name) +
    '<span class="name">' + esc(prettyTool(e.name)) + '</span>' +
    '<span class="sum" data-tip="' + esc(e.summary) + '">' + esc(e.summary) + '</span>' +
    '<span class="d" data-tip="' + (e.error ? 'La herramienta devolvió un error' : 'Duración de la llamada · ' + clockS(e.at)) + '">' + d + '</span></div>';
}
function moreBlock(a) {
  const tools = (a.topTools || []).map((t) => '<span class="tu">' + toolIcon(t.name) + esc(prettyTool(t.name)) + ' <b>' + t.count + '</b></span>').join('');
  return '<div class="c-more">' +
    (a.promptPreview ? '<h4>Tarea recibida</h4><div class="prompt-prev" data-tip="' + esc(a.promptPreview) + '">' + esc(a.promptPreview) + '</div>' : '') +
    (tools ? '<h4>Herramientas usadas</h4><div class="tools-used">' + tools + '</div>' : '') +
    '<h4>Últimos pasos</h4>' +
    (a.recent.length ? a.recent.map(eventRow).join('') : '<div class="faint" style="font-size:.7rem">Sin actividad registrada todavía.</div>') +
    '<div class="c-actions">' +
      '<button class="btn btn-primary" data-act="open" data-id="' + esc(a.id) + '">' + icon('eye') + ' Ver detalle</button>' +
      '<button class="btn" data-act="transcript" data-id="' + esc(a.id) + '" data-tip="Abrir el archivo JSONL del transcript">' + icon('json') + ' Transcript</button>' +
      (a.hasReport ? '<button class="btn" data-act="copyReport" data-id="' + esc(a.id) + '">' + icon('copy') + ' Informe</button>' : '') +
      (a.hasPrompt ? '<button class="btn" data-act="copyPrompt" data-id="' + esc(a.id) + '">' + icon('copy') + ' Prompt</button>' : '') +
    '</div></div>';
}
function card(a) {
  const st = STATE[a.status] || STATE.unknown;
  const open = !!S.expanded[a.id];
  const timeHtml = a.status === 'running'
    ? '<span class="c-time run" data-tip="Tiempo transcurrido desde que empezó">' + icon('clock') + liveSpan(a.startedAt, '') + '</span>'
    : '<span class="c-time" data-tip="<b>Duración total</b><br>Empezó ' + clockS(a.startedAt) + '<br>Última actividad ' + clockS(a.lastActivity) + '">' + icon('clock') + dur(a.durationMs) + '</span>';
  const badges = [typeBadge(a.type)];
  if (a.phase) badges.push('<span class="badge badge-outline" data-tip="<b>Fase del workflow</b>">' + icon('layers') + esc(a.phase) + '</span>');
  if (a.model) badges.push('<span class="badge badge-outline" data-tip="<b>Modelo</b><br>' + esc(a.model) + '">' + esc(shortModel(a.model)) + '</span>');
  if (a.depth > 1) badges.push('<span class="badge badge-outline" data-tip="Subagente lanzado por otro subagente (profundidad ' + a.depth + ')">anidado ·' + a.depth + '</span>');
  badges.push(statusPill(a.status));
  const foot = '<div class="c-foot">' +
    '<span class="m" data-tip="Llamadas a herramientas">' + icon('tools') + a.toolCalls + '</span>' +
    (a.toolErrors ? '<span class="m err" data-tip="Herramientas que devolvieron error">' + icon('warning') + a.toolErrors + '</span>' : '') +
    '<span class="m" data-tip="<b>Tokens</b><br>' + tok(a.tokensIn) + ' entrada · ' + tok(a.tokensOut) + ' salida">' + icon('coins') + tok(a.tokensOut) + '</span>' +
    (a.strip ? stripHtml(a.strip) : '') +
  '</div>';
  const idm = /^(.*)\\s(#[0-9a-z]{2,6})$/i.exec(a.label);
  const baseLabel = idm ? idm[1] : a.label;
  const idChip = idm ? '<span class="c-id" data-tip="Varios subagentes comparten el mismo nombre; este sufijo los distingue (inicio del id del agente)">' + esc(idm[2]) + '</span>' : '';
  return '<article class="card ' + st.cls + (open ? ' open' : '') + '" data-card="' + esc(a.id) + '">' +
    '<div class="c-row1">' +
      '<span class="c-status ' + st.cls + '" data-tip="<b>' + st.label + '</b><br>' + esc(st.hint) + '">' + icon(st.icon) + '</span>' +
      '<span class="c-title ellipsis" data-act="open" data-id="' + esc(a.id) + '" data-tip="<b>' + esc(a.label) + '</b><br><span class=k>Clic para abrir el detalle completo</span>">' + esc(baseLabel) + '</span>' + idChip +
      timeHtml +
      '<button class="btn btn-ghost c-exp" data-act="expand" data-id="' + esc(a.id) + '" data-tip="' + (open ? 'Contraer' : 'Ver últimos pasos y acciones') + '">' + icon('chevron') + '</button>' +
    '</div>' +
    '<div class="c-badges">' + badges.join('') + '</div>' +
    nowBlock(a) + noteBlock(a) + foot + moreBlock(a) +
  '</article>';
}

/* ---------- groups ---------- */
function workflowBlock(s, w) {
  const agents = w.agents.filter(agentVisible);
  if (!agents.length) return '';
  const open = !S.wfCollapsed[w.id];
  const total = w.agents.length;
  const done = w.counts.completed;
  const pct = (n) => (total ? (n / total * 100) : 0);
  const phaseCounts = {};
  const phaseRunning = {};
  for (const a of w.agents) {
    if (a.phase) { phaseCounts[a.phase] = (phaseCounts[a.phase] || 0) + 1; if (a.status === 'running') phaseRunning[a.phase] = true; }
  }
  const phases = (w.phases || []).map((p) => {
    const n = phaseCounts[p.title] || 0;
    const cls = phaseRunning[p.title] ? 'active' : n > 0 ? 'done' : '';
    return '<span class="phase ' + cls + '" data-tip="<b>Fase ' + esc(p.title) + '</b>' + (p.detail ? '<br>' + esc(p.detail) : '') + '<br>' + n + ' agentes' + (phaseRunning[p.title] ? ' · en curso' : '') + '">' + esc(p.title) + (n ? ' <span class="n">' + n + '</span>' : '') + '</span>';
  }).join('');
  const stName = w.counts.running > 0 ? 'running' : w.status === 'done' || w.status === 'completed' ? 'completed' : w.status === 'cancelled' || w.status === 'killed' ? 'cancelled' : done === total ? 'completed' : 'stalled';
  return '<div class="wf' + (open ? ' open' : '') + '" data-wf="' + esc(w.id) + '">' +
    '<div class="wf-head" data-act="togglewf" data-id="' + esc(w.id) + '">' + icon('chevron', 'chev') + icon('chain') +
      '<span class="name ellipsis" data-tip="<b>Workflow</b> ' + esc(w.id) + '<br>Grupo de agentes lanzados por un mismo script de orquestación' + (w.name ? '' : '<br><span class=k>El nombre aparece cuando Claude Code escribe el journal del workflow</span>') + '">' + esc(w.name || 'workflow ' + w.id.replace(/^wf_/, '').slice(0, 8)) + '</span>' +
      statusPill(stName, w.durationMs ? dur(w.durationMs) : '') +
    '</div>' +
    '<div class="wf-prog"><span class="num">' + done + ' de ' + total + ' completados</span><div class="bar" data-tip="' + w.counts.running + ' ejecutando · ' + done + ' completados · ' + w.counts.stalled + ' detenidos · ' + w.counts.cancelled + ' cancelados">' +
      '<span class="bg-done" style="width:' + pct(done) + '%"></span><span class="bg-run" style="width:' + pct(w.counts.running) + '%"></span><span class="bg-stall" style="width:' + pct(w.counts.stalled) + '%"></span><span class="bg-cancel" style="width:' + pct(w.counts.cancelled) + '%"></span>' +
    '</div></div>' +
    (phases ? '<div class="phases">' + phases + '</div>' : '') +
    '<div class="wf-agents">' + agents.map(card).join('') + '</div>' +
  '</div>';
}
function sessionBlock(s) {
  const visibleLoose = s.agents.filter(agentVisible);
  const wfHtml = s.workflows.map((w) => workflowBlock(s, w)).filter(Boolean);
  const visibleCount = visibleLoose.length + s.workflows.reduce((n, w) => n + w.agents.filter(agentVisible).length, 0);
  if (visibleCount === 0) return { html: '', shown: 0 };
  const open = !S.collapsed[s.id];
  const limit = S.more[s.id] || PAGE;
  const loose = visibleLoose.slice(0, limit);
  const hidden = visibleLoose.length - loose.length;
  const livePill = s.live
    ? '<span class="pill pill-done live-pill" data-tip="<b>Sesión abierta</b><br>Hay un proceso de Claude Code vivo para esta sesión' + (s.liveStatus ? ' (' + esc(s.liveStatus) + ')' : '') + '"><span class="dot bg-done' + (s.counts.running ? ' pulse' : '') + '"></span>abierta</span>'
    : '<span class="pill pill-neutral live-pill" data-tip="<b>Sesión cerrada</b><br>El proceso de Claude Code ya no está en ejecución; se muestra el histórico">cerrada</span>';
  const meta = [];
  meta.push('<span data-tip="Subagentes en esta sesión">' + icon('agents') + ' ' + plural(s.total, 'subagente', 'subagentes') + '</span>');
  if (s.workflows.length) meta.push('<span data-tip="Workflows (grupos orquestados)">' + icon('chain') + ' ' + plural(s.workflows.length, 'workflow', 'workflows') + '</span>');
  if (s.entrypoint) meta.push('<span data-tip="Desde dónde se lanzó Claude Code' + (s.version ? ' · v' + esc(s.version) : '') + '">' + icon(s.entrypoint === 'cli' ? 'terminal' : 'vm') + ' ' + esc(entryLabel(s.entrypoint)) + '</span>');
  if (s.toolErrors) meta.push('<span class="st-err" data-tip="Herramientas con error en la sesión">' + icon('warning') + ' ' + s.toolErrors + '</span>');
  meta.push('<span data-tip="Última escritura en cualquiera de sus transcripts">' + icon('clock') + ' <span data-ago="' + s.lastActivity + '">' + ago(s.lastActivity) + '</span></span>');
  const html = '<section class="session' + (open ? ' open' : '') + (s.live ? ' live' : '') + '" data-session="' + esc(s.id) + '">' +
    '<header class="s-head" data-act="togglesession" data-id="' + esc(s.id) + '">' +
      '<div class="s-row">' + icon('chevron', 'chev') + '<span class="name ellipsis" data-tip="<b>' + esc(s.label) + '</b><br>' + esc(s.cwd || s.dir) + (s.slug ? '<br><span class=k>tema: ' + esc(s.slug.replace(/-/g, ' ')) + '</span>' : '') + '">' + esc(s.label) + '</span>' +
        (s.counts.running ? '<span class="pill pill-run" data-tip="Subagentes ejecutando ahora en esta sesión">' + icon('play') + s.counts.running + '</span>' : '') + livePill + '</div>' +
      '<div class="s-meta">' + meta.join('') + '</div>' +
      '<div class="s-stack">' + stackHtml(s.counts) + '</div>' +
    '</header>' +
    '<div class="s-body">' +
      wfHtml.join('') + loose.map(card).join('') +
      (hidden > 0 ? '<div class="more-row"><button class="btn" data-act="more" data-id="' + esc(s.id) + '">Mostrar ' + Math.min(PAGE, hidden) + ' más · quedan ' + hidden + '</button></div>' : '') +
      '<div class="s-actions">' +
        '<button class="btn btn-ghost" data-act="dashboardsession" data-id="' + esc(s.id) + '" data-tip="Abrir el panel gráfico filtrado por esta sesión">' + icon('graph') + ' gráfico</button>' +
        '<button class="btn btn-ghost" data-act="reveal" data-dir="' + esc(s.dir) + '" data-tip="Abrir la carpeta de la sesión en el explorador de archivos">' + icon('folder') + ' carpeta</button>' +
      '</div>' +
    '</div></section>';
  return { html, shown: visibleCount };
}

/* ---------- empty & footer ---------- */
function emptyState(sessions, totalScoped) {
  const hiddenByScope = DATA.sessions.length - sessions.length;
  if (totalScoped === 0) {
    return '<div class="empty">' + icon('robot', 'big') + '<b>Todavía no hay subagentes' + (DATA.scope === 'workspace' && DATA.workspaceName ? ' en ' + esc(DATA.workspaceName) : '') + '</b>' +
      'Cuando Claude Code lance subagentes —con la herramienta <code>Agent</code>, un <code>Workflow</code>, <code>/code-review</code>…— aparecerán aquí en tiempo real, con la herramienta que ejecutan y su informe al terminar.' +
      (hiddenByScope > 0 ? '<div class="actions"><button class="btn btn-primary" data-act="scopeall">' + icon('folder') + ' Ver los ' + hiddenByScope + ' de otros proyectos</button></div>' : '') +
      '<div class="actions"><button class="btn" data-act="refresh">' + icon('refresh') + ' Volver a buscar</button><button class="btn" data-act="settings">Ajustes</button></div>' +
    '</div>';
  }
  return '<div class="empty">' + icon('filter', 'big') + '<b>Nada coincide con el filtro</b>' +
    'Hay ' + plural(totalScoped, 'subagente', 'subagentes') + ' pero ninguno cumple ' + (S.q.trim() ? 'la búsqueda «' + esc(S.q.trim()) + '»' : '') + (S.q.trim() && S.filter !== 'all' ? ' y ' : '') + (S.filter !== 'all' ? 'el estado «' + FILTERS[S.filter].label + '»' : '') + '.' +
    '<div class="actions"><button class="btn btn-primary" data-act="clearfilters">' + icon('x') + ' Quitar filtros</button></div></div>';
}
function footer() {
  const legend = '<div class="legend">' +
    ['running', 'completed', 'stalled', 'cancelled'].map((k) => '<div class="lg">' + statusPill(k) + '<span>' + esc(STATE[k].hint) + '</span></div>').join('') +
    '<h5>Tira de actividad</h5><div class="lg">' + stripHtml('1234566e') + '<span>Una celda por llamada a herramienta; de claro (menos de 1 s) a oscuro (más de 5 min). Rojo = devolvió error; punteado = en curso.</span></div>' +
    '<h5>Iconos de herramienta</h5><div class="cats">' + Object.keys(TOOLCAT).map((k) => '<span>' + icon(TOOLCAT[k].icon, 'tc-' + k) + esc(TOOLCAT[k].label) + '</span>').join('') + '</div>' +
    '<h5>Umbral</h5><div class="lg"><span>Un subagente sin cerrar su turno pasa a «detenido» tras ' + DATA.thresholdSeconds + ' s sin escribir (ajustable).</span></div>' +
  '</div>';
  return '<div class="foot' + (S.legend ? ' open' : '') + '"><div class="row">' +
    '<button class="btn btn-ghost" data-act="legend">' + icon('question') + ' ' + (S.legend ? 'Ocultar leyenda' : 'Leyenda') + '</button>' +
    '<span class="grow"></span>' +
    '<span class="faint" data-tip="Los datos se releen automáticamente al cambiar los transcripts">actualizado <span data-ago="' + DATA.generatedAt + '">' + ago(DATA.generatedAt) + '</span></span>' +
  '</div>' + legend + '</div>';
}

/* ---------- render ---------- */
let renderedToolbar = false;
function render() {
  const app = document.getElementById('app');
  if (!DATA) { app.innerHTML = '<div class="empty">' + icon('robot', 'big') + '<b>Leyendo transcripts…</b></div>'; return; }
  const sessions = scopedSessions();
  const t = totals(sessions);
  const blocks = [];
  let shown = 0;
  for (const s of sessions) {
    const b = sessionBlock(s);
    if (b.html) { blocks.push(b.html); shown += b.shown; }
  }
  const active = document.activeElement;
  const qFocused = active && active.id === 'q';
  const sel = qFocused ? [active.selectionStart, active.selectionEnd] : null;

  let top = document.getElementById('top');
  if (!top) {
    app.innerHTML = '<div class="top" id="top"></div><div class="list" id="list"></div><div id="foot"></div>';
    top = document.getElementById('top');
  }
  top.innerHTML = renderHero(t) + renderKpis(t) + renderToolbar() + renderActiveFilter(shown, t.total);
  document.getElementById('list').innerHTML = blocks.length ? blocks.join('') : emptyState(sessions, t.total);
  document.getElementById('foot').innerHTML = footer();

  if (qFocused) {
    const q = document.getElementById('q');
    q.focus();
    try { q.setSelectionRange(sel[0], sel[1]); } catch (e) {}
  }
  wire();
}
let qTimer = null;
function wire() {
  const q = document.getElementById('q');
  if (q) {
    q.addEventListener('input', () => {
      S.q = q.value; persist();
      if (qTimer) clearTimeout(qTimer);
      qTimer = setTimeout(render, 120);
    });
  }
  const scope = document.getElementById('scope');
  if (scope) scope.addEventListener('change', () => post({ type: 'setScope', scope: scope.value }));
  const qclear = document.getElementById('qclear');
  if (qclear) qclear.addEventListener('click', () => { S.q = ''; persist(); render(); });
}
document.addEventListener('click', (e) => {
  const kpiEl = e.target.closest ? e.target.closest('[data-filter]') : null;
  if (kpiEl) {
    const f = kpiEl.getAttribute('data-filter');
    S.filter = S.filter === f ? 'all' : f; persist(); render(); return;
  }
  const el = e.target.closest ? e.target.closest('[data-act]') : null;
  if (!el) return;
  const act = el.getAttribute('data-act');
  const id = el.getAttribute('data-id');
  switch (act) {
    case 'open': post({ type: 'open', id }); break;
    case 'transcript': post({ type: 'transcript', id }); break;
    case 'copyReport': post({ type: 'copyReport', id }); break;
    case 'copyPrompt': post({ type: 'copyPrompt', id }); break;
    case 'reveal': post({ type: 'reveal', dir: el.getAttribute('data-dir') }); break;
    case 'dashboard': post({ type: 'dashboard', onlyActive: S.filter === 'running' }); break;
    case 'dashboardsession': post({ type: 'dashboard', sessionId: id }); break;
    case 'refresh': post({ type: 'refresh' }); break;
    case 'settings': post({ type: 'settings' }); break;
    case 'scopeall': post({ type: 'setScope', scope: 'all' }); break;
    case 'clearfilters': S.filter = 'all'; S.q = ''; persist(); render(); break;
    case 'legend': S.legend = !S.legend; persist(); render(); break;
    case 'expand': S.expanded[id] = !S.expanded[id]; persist(); render(); break;
    case 'more': S.more[id] = (S.more[id] || PAGE) + PAGE; persist(); render(); break;
    case 'togglesession': S.collapsed[id] = !S.collapsed[id]; persist(); render(); break;
    case 'togglewf': S.wfCollapsed[id] = !S.wfCollapsed[id]; persist(); render(); break;
  }
  e.stopPropagation();
});
/* Elapsed times tick every second without waiting for a data push. */
setInterval(() => {
  const now = Date.now();
  for (const el of document.querySelectorAll('[data-live-since]')) {
    el.textContent = (el.getAttribute('data-live-prefix') || '') + durShort(now - Number(el.getAttribute('data-live-since')));
  }
  for (const el of document.querySelectorAll('[data-ago]')) {
    el.textContent = ago(Number(el.getAttribute('data-ago')));
  }
}, 1000);
window.addEventListener('message', (event) => {
  const msg = event.data;
  if (msg && msg.type === 'data') { DATA = msg.payload; render(); }
});
bindTips();
render();
post({ type: 'ready' });
`;
}

function shellHtml(csp: string, n: string): string {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Claude Subagents</title>
<style>${baseCss()}${css()}</style>
</head>
<body>
<div id="app"></div>
<div id="tip"></div>
<script nonce="${n}">${clientHelpersJs()}${clientJs()}</script>
</body>
</html>`;
}
