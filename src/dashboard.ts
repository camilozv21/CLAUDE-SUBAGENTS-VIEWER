import * as path from 'path';
import * as vscode from 'vscode';
import { AgentInfo, AgentStatus, SessionInfo } from './model';
import { baseCss, clientHelpersJs, nonce, stripFor, toolCategory, ToolCategory } from './ui';

/** How many agents the dashboard renders before it starts dropping the oldest. */
const MAX_AGENTS = 240;
/** Tool calls kept per activity strip. */
const STRIP_LENGTH = 40;

interface DashAgent {
  id: string;
  label: string;
  type: string;
  phase?: string;
  workflow?: string;
  sessionId: string;
  sessionLabel: string;
  status: AgentStatus;
  stoppedByUser: boolean;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  toolCalls: number;
  toolErrors: number;
  tokensIn: number;
  tokensOut: number;
  model?: string;
  currentName?: string;
  currentSummary?: string;
  currentAt?: number;
  /** Names of the tools this agent used (for search). */
  toolNames: string[];
  /** One character per recent tool call: '1'-'6' duration band, 'e' error, 'p' pending, '0' unknown. */
  strip: string;
  report?: string;
}

interface DashSession {
  id: string;
  label: string;
  cwd?: string;
  live: boolean;
  entrypoint?: string;
  agents: number;
  running: number;
  completed: number;
  stalled: number;
  cancelled: number;
  toolCalls: number;
  toolErrors: number;
  tokensOut: number;
  lastActivity: number;
}

interface DashData {
  generatedAt: number;
  sessions: DashSession[];
  agents: DashAgent[];
  tools: { name: string; count: number; category: ToolCategory }[];
  categories: { category: ToolCategory; count: number }[];
  totals: {
    agents: number;
    running: number;
    completed: number;
    stalled: number;
    cancelled: number;
    toolCalls: number;
    toolErrors: number;
    tokensIn: number;
    tokensOut: number;
  };
  dropped: number;
}

export interface DashboardFocus {
  sessionId?: string;
  onlyActive?: boolean;
}

function sessionLabel(session: SessionInfo): string {
  if (session.cwd) {
    return path.basename(session.cwd) || session.cwd;
  }
  return session.projectDirName;
}

function toDashAgent(agent: AgentInfo, session: SessionInfo): DashAgent {
  const snap = agent.snapshot;
  const toolNames = new Set<string>();
  for (const event of snap.events) {
    if (event.kind === 'tool') {
      toolNames.add(event.name);
    }
  }
  return {
    id: agent.transcriptPath,
    label: agent.disambiguator ? `${agent.description} ${agent.disambiguator}` : agent.description,
    type: agent.agentType,
    phase: agent.workflowPhase,
    workflow: agent.workflowId,
    sessionId: session.sessionId,
    sessionLabel: sessionLabel(session),
    status: agent.status,
    stoppedByUser: agent.stoppedByUser,
    startedAt: agent.startedAt,
    endedAt: agent.lastActivity,
    durationMs: agent.durationMs,
    toolCalls: snap.toolCalls,
    toolErrors: snap.toolErrors,
    tokensIn: snap.tokensIn,
    tokensOut: snap.tokensOut,
    model: snap.model,
    currentName: agent.status === 'running' ? snap.currentTool?.name : undefined,
    currentSummary: agent.status === 'running' ? snap.currentTool?.summary : undefined,
    currentAt: agent.status === 'running' ? snap.currentTool?.at : undefined,
    toolNames: [...toolNames],
    strip: stripFor(agent, STRIP_LENGTH),
    report: snap.finalText ? snap.finalText.replace(/\s+/g, ' ').slice(0, 260) : undefined
  };
}

export function buildDashboardData(sessions: SessionInfo[]): DashData {
  const agents: DashAgent[] = [];
  const toolCounts = new Map<string, number>();
  const categoryCounts = new Map<ToolCategory, number>();
  const totals = {
    agents: 0,
    running: 0,
    completed: 0,
    stalled: 0,
    cancelled: 0,
    toolCalls: 0,
    toolErrors: 0,
    tokensIn: 0,
    tokensOut: 0
  };

  for (const session of sessions) {
    for (const agent of session.agents) {
      totals.agents++;
      totals.toolCalls += agent.snapshot.toolCalls;
      totals.toolErrors += agent.snapshot.toolErrors;
      totals.tokensIn += agent.snapshot.tokensIn;
      totals.tokensOut += agent.snapshot.tokensOut;
      if (agent.status === 'running') {
        totals.running++;
      } else if (agent.status === 'completed') {
        totals.completed++;
      } else if (agent.status === 'stalled') {
        totals.stalled++;
      } else if (agent.status === 'cancelled') {
        totals.cancelled++;
      }
      for (const event of agent.snapshot.events) {
        if (event.kind === 'tool') {
          toolCounts.set(event.name, (toolCounts.get(event.name) ?? 0) + 1);
          const cat = toolCategory(event.name);
          categoryCounts.set(cat, (categoryCounts.get(cat) ?? 0) + 1);
        }
      }
      agents.push(toDashAgent(agent, session));
    }
  }

  // Running first, then problems, then most recent: the top of the list is what needs eyes now.
  agents.sort((a, b) => {
    const rank = (s: AgentStatus) => (s === 'running' ? 0 : s === 'stalled' ? 1 : s === 'cancelled' ? 2 : 3);
    if (rank(a.status) !== rank(b.status)) {
      return rank(a.status) - rank(b.status);
    }
    return b.endedAt - a.endedAt;
  });

  const dropped = Math.max(0, agents.length - MAX_AGENTS);

  return {
    generatedAt: Date.now(),
    sessions: sessions.map((s) => ({
      id: s.sessionId,
      label: sessionLabel(s),
      cwd: s.cwd,
      live: s.live,
      entrypoint: s.entrypoint,
      agents: s.agents.length,
      running: s.agents.filter((a) => a.status === 'running').length,
      completed: s.agents.filter((a) => a.status === 'completed').length,
      stalled: s.agents.filter((a) => a.status === 'stalled').length,
      cancelled: s.agents.filter((a) => a.status === 'cancelled').length,
      toolCalls: s.agents.reduce((n, a) => n + a.snapshot.toolCalls, 0),
      toolErrors: s.agents.reduce((n, a) => n + a.snapshot.toolErrors, 0),
      tokensOut: s.agents.reduce((n, a) => n + a.snapshot.tokensOut, 0),
      lastActivity: s.lastActivity
    })),
    agents: agents.slice(0, MAX_AGENTS),
    tools: [...toolCounts.entries()]
      .map(([name, count]) => ({ name, count, category: toolCategory(name) }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10),
    categories: [...categoryCounts.entries()]
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => b.count - a.count),
    totals,
    dropped
  };
}

function pageCss(): string {
  return `
body { padding: 0 22px 56px; }
.viz-root { max-width: 1240px; margin: 0 auto; }
h1 { font-size: 1.2rem; margin: 22px 0 2px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
h2 { font-size: .76rem; text-transform: uppercase; letter-spacing: .08em; color: var(--ink-2); margin: 30px 0 8px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
h2 .sub { text-transform: none; letter-spacing: 0; font-weight: 400; color: var(--ink-3); }
.subtitle { color: var(--ink-2); font-size: .8rem; margin: 2px 0 0; }
.legend { display: flex; gap: 14px; flex-wrap: wrap; font-size: .74rem; color: var(--ink-2); margin: 6px 0 10px; align-items: center; }
.legend span { display: inline-flex; align-items: center; gap: 5px; }

/* toolbar */
.toolbar { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin: 16px 0 6px; position: sticky; top: 0; z-index: 5; background: var(--surface); padding: 8px 0; border-bottom: 1px solid var(--grid); }
.toolbar .sel { width: auto; min-width: 200px; max-width: 320px; }
.toolbar .search-wrap { flex: 1 1 200px; min-width: 160px; max-width: 360px; position: relative; }
.toolbar .search-wrap .ic { position: absolute; left: 8px; top: 50%; transform: translateY(-50%); color: var(--ink-3); pointer-events: none; }
.toolbar input.search { padding-left: 26px; }
.toolbar .spacer { flex: 1; }
.chip-note { font-size: .72rem; color: var(--ink-2); }

/* KPI row */
.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-top: 14px; }
.tile { background: var(--card); border: 1px solid var(--grid); border-radius: var(--radius); padding: 12px 14px; display: flex; flex-direction: column; gap: 2px; min-width: 0; position: relative; }
.tile.click { cursor: pointer; }
.tile.click:hover { border-color: var(--focus); }
.tile.on { border-color: var(--tc); box-shadow: inset 0 0 0 1px var(--tc); }
.tile .k { font-size: .68rem; text-transform: uppercase; letter-spacing: .06em; color: var(--ink-2); display: flex; align-items: center; gap: 6px; font-weight: 600; }
.tile .v { font-size: 1.8rem; font-weight: 600; line-height: 1.1; margin-top: 4px; font-variant-numeric: tabular-nums; }
.tile .d { font-size: .7rem; color: var(--ink-3); line-height: 1.3; }
.tile.hero { grid-column: span 2; border-left: 4px solid var(--c-run); }
.tile.hero .v { font-size: 3rem; }
.tile.t-run { --tc: var(--c-run); } .tile.t-done { --tc: var(--c-done); } .tile.t-stall { --tc: var(--c-stall); } .tile.t-cancel { --tc: var(--c-cancel); } .tile.t-err { --tc: var(--c-err); }
.tile.t-run .v { color: var(--c-run); } .tile.t-done .v { color: var(--c-done); } .tile.t-stall .v { color: var(--c-stall); } .tile.t-cancel .v { color: var(--c-cancel); }
.tile.t-err .v.bad { color: var(--c-err); }

/* panels */
.chart { background: var(--card); border: 1px solid var(--grid); border-radius: var(--radius); padding: 14px 16px 10px; }

/* gantt */
.rows { max-height: 440px; overflow-y: auto; overflow-x: hidden; padding-right: 8px; }
.row { display: flex; align-items: center; gap: 10px; height: 26px; cursor: pointer; border-radius: 4px; }
.row:hover { background: var(--card-2); }
.row:hover .name { color: var(--ink); }
.row .name { width: 230px; flex: none; font-size: .77rem; color: var(--ink-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: flex; align-items: center; gap: 6px; padding-left: 4px; }
.row .name .ic { flex: none; }
.track { position: relative; flex: 1; height: 100%; }
.bar { position: absolute; top: 50%; transform: translateY(-50%); height: 14px; border-radius: 4px; min-width: 3px; }
.bar.bg-run { background: linear-gradient(90deg, var(--c-run), color-mix(in srgb, var(--c-run) 60%, transparent)); }
.gridline { position: absolute; top: 0; bottom: 0; width: 1px; background: var(--grid); opacity: .6; }
.nowline { position: absolute; top: 0; bottom: 0; width: 2px; background: var(--c-run); opacity: .9; }
.axis { display: flex; margin-top: 6px; }
.axis .spacer { width: 240px; flex: none; }
.axis .ticks { position: relative; flex: 1; height: 16px; font-size: .68rem; color: var(--ink-2); font-variant-numeric: tabular-nums; }
.axis .tick { position: absolute; transform: translateX(-50%); white-space: nowrap; }

/* cards */
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 12px; }
.card { background: var(--card); border: 1px solid var(--grid); border-left: 4px solid var(--grid); border-radius: var(--radius); padding: 12px 14px; cursor: pointer; display: flex; flex-direction: column; gap: 7px; min-width: 0; }
.card:hover { border-color: var(--focus); border-left-color: var(--sc); }
.card.s-run { --sc: var(--c-run); } .card.s-done { --sc: var(--c-done); } .card.s-stall { --sc: var(--c-stall); } .card.s-cancel { --sc: var(--c-cancel); }
.card { border-left-color: var(--sc, var(--grid)); }
.card .head { display: flex; align-items: flex-start; gap: 8px; }
.card .title { font-weight: 600; font-size: .9rem; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.card .badges { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; }
.card .now { font-size: .76rem; display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-radius: 6px; background: color-mix(in srgb, var(--c-run) 9%, transparent); border: 1px solid color-mix(in srgb, var(--c-run) 25%, transparent); min-width: 0; }
.card .now .lbl { font-size: .62rem; text-transform: uppercase; letter-spacing: .06em; color: var(--c-run); font-weight: 700; flex: none; }
.card .now .tool { font-weight: 600; flex: none; }
.card .now .what { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; color: var(--ink-2); font-family: var(--mono); font-size: .72rem; }
.card .now .el { flex: none; color: var(--ink-2); font-variant-numeric: tabular-nums; }
.card .now .el.slow { color: var(--c-stall); font-weight: 600; }
.card .rep { font-size: .75rem; color: var(--ink-2); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; line-height: 1.4; }
.card .rep .lbl { font-size: .62rem; text-transform: uppercase; letter-spacing: .06em; color: var(--c-done); font-weight: 700; margin-right: 6px; }
.card .hint { font-size: .74rem; color: var(--ink-2); display: flex; gap: 6px; align-items: flex-start; line-height: 1.35; }
.card .hint .ic { margin-top: 2px; }
.card .foot { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; margin-top: 2px; }
.card .stats { display: flex; gap: 10px; font-size: .72rem; color: var(--ink-2); flex-wrap: wrap; }
.card .stats span { display: inline-flex; align-items: center; gap: 4px; font-variant-numeric: tabular-nums; }
.card .stats .bad { color: var(--c-err); font-weight: 600; }

/* tool bars */
.bars .brow { display: flex; align-items: center; gap: 10px; height: 28px; }
.bars .bname { width: 190px; flex: none; font-size: .78rem; color: var(--ink-2); display: flex; align-items: center; gap: 7px; justify-content: flex-end; overflow: hidden; }
.bars .bname span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bars .btrack { flex: 1; position: relative; height: 100%; display: flex; align-items: center; }
.bars .bfill { height: 14px; border-radius: 4px; min-width: 2px; }
.bars .bval { font-size: .74rem; color: var(--ink-2); margin-left: 8px; font-variant-numeric: tabular-nums; }
.two { display: grid; grid-template-columns: 3fr 2fr; gap: 12px; }
@media (max-width: 900px) { .two { grid-template-columns: 1fr; } }
.catbar { display: flex; height: 18px; border-radius: 5px; overflow: hidden; background: var(--card-2); margin-top: 8px; }
.catbar span { display: block; height: 100%; }
.catlegend { display: flex; flex-wrap: wrap; gap: 6px 14px; margin-top: 12px; font-size: .74rem; }
.catlegend span { display: inline-flex; align-items: center; gap: 6px; color: var(--ink-2); }
.catlegend .sw { width: 10px; height: 10px; border-radius: 2px; }
.catlegend b { color: var(--ink); font-variant-numeric: tabular-nums; }

/* table */
table { width: 100%; border-collapse: collapse; font-size: .76rem; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--grid); vertical-align: middle; }
th { color: var(--ink-2); font-weight: 600; text-transform: uppercase; font-size: .66rem; letter-spacing: .05em; position: sticky; top: 0; background: var(--card); }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
tr.r { cursor: pointer; }
tr.r:hover td { background: var(--card-2); }
td .bad { color: var(--c-err); font-weight: 600; }
.tablewrap { overflow: auto; max-height: 70vh; }

/* empty */
.empty { padding: 56px 20px; text-align: center; color: var(--ink-2); display: flex; flex-direction: column; align-items: center; gap: 8px; }
.empty .ic { width: 42px; height: 42px; color: var(--ink-3); }
.empty b { color: var(--ink); font-size: .95rem; }
.empty p { margin: 0; max-width: 460px; font-size: .8rem; line-height: 1.5; }
.more { margin: 12px 0 0; }
`;
}

function scriptJs(data: DashData, focus: DashboardFocus | undefined): string {
  return `
${clientHelpersJs()}
const vscodeApi = acquireVsCodeApi();
let DATA = ${JSON.stringify(data)};
const INITIAL_FOCUS = ${JSON.stringify(focus ?? null)};

const saved = vscodeApi.getState() || {};
const UI = {
  session: saved.session || 'all',
  status: saved.status || 'all',
  query: saved.query || '',
  view: saved.view || 'cards',
  cardLimit: 60
};
if (INITIAL_FOCUS) {
  if (INITIAL_FOCUS.sessionId) UI.session = INITIAL_FOCUS.sessionId;
  if (INITIAL_FOCUS.onlyActive) UI.status = 'running';
}
function persist() {
  vscodeApi.setState({ session: UI.session, status: UI.status, query: UI.query, view: UI.view });
}

const STATUS_FILTERS = [
  { key: 'all', label: 'Todos', tip: 'Todos los subagentes de la selección' },
  { key: 'running', label: 'Ejecutando', cls: 'run', tip: 'Solo los que están trabajando ahora mismo' },
  { key: 'completed', label: 'Completados', cls: 'done', tip: 'Los que cerraron su turno con un informe' },
  { key: 'problems', label: 'Con problemas', cls: 'stall', tip: 'Detenidos a medias, cancelados por el usuario o con alguna herramienta que falló' }
];

function hasProblems(a) {
  return a.status === 'stalled' || a.status === 'cancelled' || a.toolErrors > 0;
}
function matchesStatus(a) {
  if (UI.status === 'all') return true;
  if (UI.status === 'problems') return hasProblems(a);
  return a.status === UI.status;
}
function matchesQuery(a) {
  const q = UI.query.trim().toLowerCase();
  if (!q) return true;
  const hay = [a.label, a.type, a.phase || '', a.sessionLabel, a.currentName || '', a.model || '', shortModel(a.model)].concat(a.toolNames || []).join(' ').toLowerCase();
  return q.split(/\\s+/).every((w) => hay.includes(w));
}
function visibleAgents() {
  return DATA.agents.filter((a) => (UI.session === 'all' || a.sessionId === UI.session) && matchesStatus(a) && matchesQuery(a));
}
function scopedSessions() {
  return DATA.sessions.filter((s) => UI.session === 'all' || s.id === UI.session);
}
function slowClass(ms) { return ms > 60000 ? ' slow' : ''; }

/* ---------- toolbar ---------- */
function toolbar(agents) {
  const options = ['<option value="all">Todas las sesiones (' + DATA.sessions.length + ')</option>'].concat(
    DATA.sessions.map((s) =>
      '<option value="' + esc(s.id) + '"' + (s.id === UI.session ? ' selected' : '') + '>' +
      (s.live ? '● ' : '○ ') + esc(s.label) + ' — ' + s.agents + ' subagentes' + (s.running ? ' (' + s.running + ' activos)' : '') + '</option>'
    )
  ).join('');
  const seg = STATUS_FILTERS.map((f) => {
    const n = DATA.agents.filter((a) => (UI.session === 'all' || a.sessionId === UI.session) && matchesQuery(a) && (f.key === 'all' || (f.key === 'problems' ? hasProblems(a) : a.status === f.key))).length;
    return '<button data-status="' + f.key + '" class="' + (UI.status === f.key ? 'on' : '') + '" data-tip="' + esc(f.tip) + '">' +
      (f.cls ? '<span class="dot bg-' + f.cls + '"></span>' : icon('layers')) + f.label + ' <span class="n">' + n + '</span></button>';
  }).join('');
  return '<div class="toolbar">' +
    '<select id="sel" class="sel" data-tip="<b>Sesión</b><br>Cada sesión es una conversación de Claude Code. ● = el proceso sigue abierto.">' + options + '</select>' +
    '<div class="seg" id="seg">' + seg + '</div>' +
    '<div class="search-wrap">' + icon('search') + '<input id="q" class="search" type="search" placeholder="Buscar por nombre, tipo, herramienta, fase…" value="' + esc(UI.query) + '"></div>' +
    '<div class="spacer"></div>' +
    '<div class="seg"><button id="v-cards" class="' + (UI.view === 'cards' ? 'on' : '') + '">' + icon('layers') + 'Tarjetas</button><button id="v-table" class="' + (UI.view === 'table' ? 'on' : '') + '">' + icon('checklist') + 'Tabla</button></div>' +
    '</div>' +
    '<div class="chip-note">' + agents.length + ' subagente' + (agents.length === 1 ? '' : 's') + ' coinciden con la selección' + (UI.query ? ' · búsqueda «' + esc(UI.query) + '»' : '') + '</div>';
}

/* ---------- KPIs ---------- */
function kpis() {
  const scope = scopedSessions();
  const sum = (key) => scope.reduce((n, s) => n + (s[key] || 0), 0);
  const running = sum('running'), completed = sum('completed'), stalled = sum('stalled'), cancelled = sum('cancelled');
  const tools = sum('toolCalls'), errors = sum('toolErrors'), tokens = sum('tokensOut');
  const tile = (cls, key, label, value, desc, extraCls) =>
    '<div class="tile ' + cls + (key ? ' click' : '') + (key && UI.status === key ? ' on' : '') + (extraCls ? ' ' + extraCls : '') + '"' + (key ? ' data-status="' + key + '" data-tip="Clic para filtrar: ' + esc(label) + '"' : '') + '>' +
    '<div class="k">' + (cls.startsWith('t-') && cls !== 't-err' ? '<span class="dot bg-' + cls.slice(2) + (cls === 't-run' && running ? ' pulse' : '') + '"></span>' : '') + label + '</div>' +
    '<div class="v' + (cls === 't-err' && value > 0 ? ' bad' : '') + '">' + value + '</div><div class="d">' + desc + '</div></div>';
  return '<div class="kpis">' +
    tile('t-run', 'running', 'Ejecutando ahora', running, running ? 'subagentes trabajando en este momento' : 'nadie trabajando ahora mismo', 'hero') +
    tile('t-done', 'completed', 'Completados', completed, 'terminaron y entregaron informe') +
    tile('t-stall', 'problems', 'Detenidos', stalled, 'se quedaron a medias sin cerrar el turno') +
    tile('t-cancel', 'problems', 'Cancelados', cancelled, 'parados por el usuario (Esc / stop)') +
    tile('', null, 'Herramientas', tools.toLocaleString('es'), 'llamadas a herramientas en total') +
    tile('t-err', 'problems', 'Con error', errors.toLocaleString('es'), errors ? 'herramientas que devolvieron error' : 'ninguna herramienta falló') +
    tile('', null, 'Tokens generados', tok(tokens), 'salida de todos los subagentes') +
    '</div>';
}

/* ---------- gantt ---------- */
function tipFor(a) {
  const st = STATE[a.status] || STATE.unknown;
  const lines = [
    '<b>' + esc(a.label) + '</b>',
    '<span class="k">tipo</span> ' + esc(a.type) + (a.phase ? ' · <span class="k">fase</span> ' + esc(a.phase) : ''),
    st.glyph + ' ' + st.label + ' · ' + dur(a.durationMs),
    a.toolCalls + ' herramientas' + (a.toolErrors ? ' · <span style="color:var(--c-err)">' + a.toolErrors + ' con error</span>' : '') + ' · ' + tok(a.tokensOut) + ' tokens',
    a.currentName ? '<span class="k">ahora</span> <b>' + esc(prettyTool(a.currentName)) + '</b> ' + esc(a.currentSummary || '') : '',
    '<span class="k">inicio</span> ' + clock(a.startedAt) + ' · <span class="k">última actividad</span> ' + clock(a.endedAt)
  ];
  return lines.filter(Boolean).join('<br>');
}

function gantt(agents) {
  if (agents.length === 0) return '';
  const sessionId = UI.session !== 'all' ? UI.session : agents[0].sessionId;
  const session = DATA.sessions.find((s) => s.id === sessionId);
  const inSession = agents.filter((a) => a.sessionId === sessionId);
  const rows = inSession.slice(0, 60).sort((a, b) => a.startedAt - b.startedAt);
  if (rows.length === 0) return '';

  const now = Date.now();
  let min = Infinity, max = -Infinity;
  for (const a of rows) { min = Math.min(min, a.startedAt); max = Math.max(max, a.endedAt); }
  if (rows.some((a) => a.status === 'running')) max = Math.max(max, now);
  const span = Math.max(1, max - min);
  const pad = span * 0.02;
  const lo = min - pad, hi = max + pad;
  const scale = (t) => ((t - lo) / (hi - lo)) * 100;
  const crossesDay = hi - lo > 20 * 3600 * 1000;

  const ticks = [];
  for (let i = 0; i <= 4; i++) {
    const t = lo + ((hi - lo) * i) / 4;
    ticks.push({ pct: (i / 4) * 100, label: crossesDay ? stamp(t) : clock(t) });
  }
  const gridHtml = ticks.map((t) => '<div class="gridline" style="left:' + t.pct + '%"></div>').join('');
  const nowPct = scale(now);
  const nowHtml = nowPct >= 0 && nowPct <= 100 ? '<div class="nowline" style="left:' + nowPct + '%" data-tip="ahora · ' + clockS(now) + '"></div>' : '';

  const rowsHtml = rows.map((a) => {
    const st = STATE[a.status] || STATE.unknown;
    const left = scale(a.startedAt);
    const right = scale(a.status === 'running' ? Math.max(a.endedAt, now) : a.endedAt);
    const width = Math.max(0.4, right - left);
    return '<div class="row" data-id="' + esc(a.id) + '" data-tip="' + esc(tipFor(a)) + '">' +
      '<div class="name">' + icon(st.icon, 'st-' + st.cls) + '<span class="ellipsis">' + esc(shortLabel(a.label, 32)) + '</span></div>' +
      '<div class="track">' + gridHtml + nowHtml + '<div class="bar bg-' + st.cls + '" style="left:' + left + '%;width:' + width + '%"></div></div></div>';
  }).join('');
  const axisHtml = ticks.map((t) => '<div class="tick" style="left:' + t.pct + '%">' + t.label + '</div>').join('');

  const scope = session ? esc(session.label) : 'sesión reciente';
  const why = UI.session === 'all' && DATA.sessions.length > 1
    ? 'Se dibuja una sola sesión (la más activa de ' + DATA.sessions.length + ') porque las demás están separadas por horas o días y compartir el eje aplastaría las barras. Elige otra con el selector.'
    : 'Cada barra es un subagente sobre el eje de tiempo real.';

  return '<h2>' + icon('clock') + 'Actividad en el tiempo <span class="sub">· sesión <b>' + scope + '</b></span></h2>' +
    '<p class="subtitle">' + why + '</p>' +
    '<div class="legend">' +
      '<span><span class="dot bg-run"></span>▶ ejecutando</span><span><span class="dot bg-done"></span>✓ completado</span>' +
      '<span><span class="dot bg-stall"></span>⏸ detenido</span><span><span class="dot bg-cancel"></span>✕ cancelado</span>' +
      '<span><span style="display:inline-block;width:2px;height:12px;background:var(--c-run)"></span> línea azul = ahora</span></div>' +
    '<div class="chart"><div class="rows">' + rowsHtml + '</div><div class="axis"><div class="spacer"></div><div class="ticks">' + axisHtml + '</div></div></div>' +
    (rows.length < inSession.length ? '<p class="subtitle">Mostrando ' + rows.length + ' de ' + inSession.length + ' subagentes de esta sesión.</p>' : '');
}

/* ---------- cards ---------- */
function cardBody(a) {
  const st = STATE[a.status] || STATE.unknown;
  if (a.status === 'running') {
    if (a.currentName) {
      const since = a.currentAt || a.endedAt;
      const el = Date.now() - since;
      return '<div class="now"><span class="lbl">Ahora</span>' + toolIcon(a.currentName) + '<span class="tool">' + esc(prettyTool(a.currentName)) + '</span>' +
        '<span class="what" title="' + esc(a.currentSummary || '') + '">' + esc(a.currentSummary || '') + '</span>' +
        '<span class="el' + slowClass(el) + '" data-live-since="' + since + '" data-live-fmt="short" data-tip="Tiempo que lleva en esta herramienta' + (el > 60000 ? '<br><b>Más de un minuto</b>: puede estar atascada.' : '') + '">' + durShort(el) + '</span></div>';
    }
    return '<div class="now"><span class="lbl">Ahora</span>' + icon('sparkle', 'st-run') + '<span class="what">pensando / redactando la respuesta…</span></div>';
  }
  if (a.status === 'completed' && a.report) {
    return '<div class="rep"><span class="lbl">Informe</span>' + esc(a.report) + '</div>';
  }
  if (a.status === 'completed') {
    return '<div class="hint">' + icon('check', 'st-done') + '<span>Terminó sin texto final registrado.</span></div>';
  }
  return '<div class="hint">' + icon(st.icon, 'st-' + st.cls) + '<span>' + esc(st.hint) + (a.status === 'stalled' ? ' Última escritura ' + ago(a.endedAt) + '.' : '') + '</span></div>';
}

function cards(agents) {
  if (agents.length === 0) {
    return '<div class="chart"><div class="empty">' + icon('filter') + '<b>Nada que mostrar con estos filtros</b><p>Prueba con «Todos», borra la búsqueda o cambia de sesión.</p></div></div>';
  }
  const shown = agents.slice(0, UI.cardLimit);
  const html = shown.map((a) => {
    const st = STATE[a.status] || STATE.unknown;
    return '<div class="card s-' + st.cls + '" data-id="' + esc(a.id) + '" title="Clic para abrir el detalle">' +
      '<div class="head"><div class="title" title="' + esc(a.label) + '">' + esc(a.label) + '</div>' + statusPill(a.status) + '</div>' +
      '<div class="badges">' + typeBadge(a.type) + (a.phase ? '<span class="badge badge-outline" data-tip="<b>Fase del workflow</b><br>' + esc(a.phase) + '">' + icon('chain') + esc(a.phase) + '</span>' : '') +
        (a.model ? '<span class="badge badge-outline" data-tip="<b>Modelo</b><br>' + esc(a.model) + '">' + esc(shortModel(a.model)) + '</span>' : '') +
        '<span class="faint" style="font-size:.7rem" data-tip="Sesión">' + icon('vm') + ' ' + esc(a.sessionLabel) + '</span></div>' +
      cardBody(a) +
      '<div class="foot"><div class="stats">' +
        '<span data-tip="Llamadas a herramientas">' + icon('tools') + a.toolCalls + '</span>' +
        (a.toolErrors ? '<span class="bad" data-tip="Herramientas que devolvieron error">' + icon('warning') + a.toolErrors + '</span>' : '') +
        '<span data-tip="Duración' + (a.status === 'running' ? ' (en vivo)' : '') + '">' + icon('clock') + (a.status === 'running' ? '<span data-live-since="' + a.startedAt + '" data-live-fmt="short">' + durShort(Date.now() - a.startedAt) + '</span>' : durShort(a.durationMs)) + '</span>' +
        '<span data-tip="Tokens generados (salida)">' + icon('coins') + tok(a.tokensOut) + '</span>' +
      '</div>' + stripHtml(a.strip) + '</div></div>';
  }).join('');
  const more = agents.length > shown.length
    ? '<p class="more"><button id="more" class="btn">Mostrar 60 más — quedan ' + (agents.length - shown.length) + '</button></p>'
    : '';
  return '<h2>' + icon('robot') + 'Subagentes <span class="sub">· ' + shown.length + ' de ' + agents.length + '</span></h2>' +
    '<div class="legend"><span>Tira de actividad: cada celda es una llamada a herramienta, de la más antigua a la más reciente.</span>' +
      '<span><span class="cell cell-1"></span>rápida (&lt;1 s)</span><span><span class="cell cell-4"></span>media (15–60 s)</span><span><span class="cell cell-6"></span>lenta (&gt;5 min)</span>' +
      '<span><span class="cell cell-e"></span>error</span><span><span class="cell cell-p"></span>en curso</span></div>' +
    '<div class="cards">' + html + '</div>' + more;
}

/* ---------- tool charts ---------- */
function toolBars() {
  const list = DATA.tools;
  if (list.length === 0) return '';
  const max = list[0].count;
  const rows = list.map((t) => {
    const pct = Math.max(1, (t.count / max) * 100);
    const cat = TOOLCAT[t.category] || TOOLCAT.other;
    return '<div class="brow" data-tip="<b>' + esc(prettyTool(t.name)) + '</b><br>' + t.count + ' llamadas · categoría: ' + esc(cat.label) + '">' +
      '<div class="bname">' + toolIcon(t.name) + '<span>' + esc(prettyTool(t.name)) + '</span></div>' +
      '<div class="btrack"><div class="bfill" style="width:' + pct + '%;background:var(--t-' + t.category + ')"></div><span class="bval">' + t.count.toLocaleString('es') + '</span></div></div>';
  }).join('');

  const cats = DATA.categories;
  const total = cats.reduce((n, c) => n + c.count, 0) || 1;
  const catBar = cats.map((c) => '<span style="width:' + (c.count / total * 100) + '%;background:var(--t-' + c.category + ')" data-tip="<b>' + esc((TOOLCAT[c.category] || TOOLCAT.other).label) + '</b><br>' + c.count + ' llamadas (' + Math.round(c.count / total * 100) + '%)"></span>').join('');
  const catLegend = cats.map((c) => '<span><span class="sw" style="background:var(--t-' + c.category + ')"></span>' + icon((TOOLCAT[c.category] || TOOLCAT.other).icon, 'tc-' + c.category) + esc((TOOLCAT[c.category] || TOOLCAT.other).label) + ' <b>' + c.count.toLocaleString('es') + '</b></span>').join('');

  return '<div class="two"><div>' +
    '<h2>' + icon('tools') + 'Herramientas más usadas <span class="sub">· en toda la flota</span></h2><div class="chart bars">' + rows + '</div></div>' +
    '<div><h2>' + icon('graph') + 'Por categoría</h2><div class="chart">' +
      '<p class="subtitle" style="margin:0">Qué tipo de trabajo hacen los subagentes: leer, buscar, escribir, ejecutar comandos…</p>' +
      '<div class="catbar">' + catBar + '</div><div class="catlegend">' + catLegend + '</div></div></div></div>';
}

/* ---------- table ---------- */
function table(agents) {
  if (agents.length === 0) return cards(agents);
  const rows = agents.map((a) => {
    return '<tr class="r" data-id="' + esc(a.id) + '"><td title="' + esc(a.label) + '">' + esc(shortLabel(a.label, 60)) + '</td><td>' + typeBadge(a.type) + '</td><td>' + esc(a.phase || '—') + '</td>' +
      '<td>' + statusPill(a.status) + '</td><td>' + esc(shortModel(a.model) || '—') + '</td><td class="num">' + clock(a.startedAt) + '</td>' +
      '<td class="num">' + (a.status === 'running' ? '<span data-live-since="' + a.startedAt + '" data-live-fmt="long">' + dur(Date.now() - a.startedAt) + '</span>' : dur(a.durationMs)) + '</td>' +
      '<td class="num">' + a.toolCalls + '</td><td class="num">' + (a.toolErrors ? '<span class="bad">' + a.toolErrors + '</span>' : '0') + '</td><td class="num">' + tok(a.tokensOut) + '</td>' +
      '<td>' + (a.currentName ? toolIcon(a.currentName) + ' ' + esc(prettyTool(a.currentName)) : '—') + '</td><td>' + esc(a.sessionLabel) + '</td></tr>';
  }).join('');
  return '<h2>' + icon('checklist') + 'Tabla <span class="sub">· ' + agents.length + ' subagentes · clic en una fila abre el detalle</span></h2><div class="chart tablewrap"><table>' +
    '<thead><tr><th>Subagente</th><th>Tipo</th><th>Fase</th><th>Estado</th><th>Modelo</th><th class="num">Inicio</th><th class="num">Duración</th>' +
    '<th class="num">Herr.</th><th class="num">Errores</th><th class="num">Tokens</th><th>Ahora</th><th>Sesión</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
}

/* ---------- render ---------- */
function emptyState() {
  return '<div class="chart"><div class="empty">' + icon('robot') + '<b>Todavía no hay subagentes</b>' +
    '<p>Cuando Claude Code lance subagentes (herramienta Agent, workflows, /code-review, forks…) aparecerán aquí en vivo, leídos directamente de los transcripts en <code>~/.claude/projects</code>. No hace falta configurar nada.</p></div></div>';
}

function render() {
  const agents = visibleAgents();
  const root = document.getElementById('root');
  const scrollY = window.scrollY;
  root.innerHTML =
    '<h1>' + icon('robot', 'st-run') + 'Subagentes de Claude Code</h1>' +
    '<div class="subtitle">' + DATA.totals.agents + ' subagente' + (DATA.totals.agents === 1 ? '' : 's') + ' en ' + DATA.sessions.length + ' sesion' + (DATA.sessions.length === 1 ? '' : 'es') +
      ' · actualizado ' + clockS(DATA.generatedAt) + (DATA.dropped ? ' · ' + DATA.dropped + ' más antiguos no mostrados' : '') + '</div>' +
    (DATA.totals.agents === 0 ? emptyState() :
      toolbar(agents) + kpis() +
      (UI.view === 'table' ? table(agents) : gantt(agents) + cards(agents) + toolBars()));

  const sel = document.getElementById('sel');
  if (sel) sel.addEventListener('change', (e) => { UI.session = e.target.value; UI.cardLimit = 60; persist(); render(); });
  for (const el of document.querySelectorAll('[data-status]')) {
    el.addEventListener('click', () => { UI.status = el.getAttribute('data-status'); UI.cardLimit = 60; persist(); render(); });
  }
  const q = document.getElementById('q');
  if (q) {
    q.addEventListener('input', () => {
      UI.query = q.value; UI.cardLimit = 60; persist();
      const pos = q.selectionStart;
      render();
      const q2 = document.getElementById('q');
      if (q2) { q2.focus(); try { q2.setSelectionRange(pos, pos); } catch (_) {} }
    });
  }
  const vc = document.getElementById('v-cards'), vt = document.getElementById('v-table');
  if (vc) vc.addEventListener('click', () => { UI.view = 'cards'; persist(); render(); });
  if (vt) vt.addEventListener('click', () => { UI.view = 'table'; persist(); render(); });
  const moreBtn = document.getElementById('more');
  if (moreBtn) moreBtn.addEventListener('click', () => { UI.cardLimit += 60; render(); });
  for (const el of document.querySelectorAll('[data-id]')) {
    el.addEventListener('click', () => vscodeApi.postMessage({ type: 'open', id: el.getAttribute('data-id') }));
  }
  window.scrollTo(0, scrollY);
}

/* Live clocks: tick durations every second without waiting for a data push. */
setInterval(() => {
  const now = Date.now();
  for (const el of document.querySelectorAll('[data-live-since]')) {
    const since = Number(el.getAttribute('data-live-since')) || now;
    const ms = now - since;
    el.textContent = el.getAttribute('data-live-fmt') === 'long' ? dur(ms) : durShort(ms);
    if (el.classList.contains('el')) el.classList.toggle('slow', ms > 60000);
  }
}, 1000);

window.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg) return;
  if (msg.type === 'data') { DATA = msg.payload; render(); }
  if (msg.type === 'focus') {
    if (msg.sessionId) UI.session = msg.sessionId;
    if (msg.onlyActive) UI.status = 'running';
    if (msg.onlyActive === false && UI.status === 'running') UI.status = 'all';
    persist(); render();
  }
});

bindTips();
render();
`;
}

function html(csp: string, n: string, data: DashData, focus: DashboardFocus | undefined): string {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Subagentes de Claude Code</title>
<style>${baseCss()}${pageCss()}</style>
</head>
<body>
<div class="viz-root" id="root"></div>
<div id="tip"></div>
<script nonce="${n}">${scriptJs(data, focus)}</script>
</body>
</html>`;
}

/** The graphical overview: one panel, reused, refreshed in place. */
export class Dashboard {
  private panel: vscode.WebviewPanel | undefined;
  private lastSignature = '';

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly onOpenAgent: (transcriptPath: string) => void
  ) {}

  get isOpen(): boolean {
    return this.panel !== undefined;
  }

  show(sessions: SessionInfo[], focus?: DashboardFocus): void {
    if (this.panel) {
      this.panel.reveal(this.panel.viewColumn, false);
      this.update(sessions, true);
      if (focus) {
        void this.panel.webview.postMessage({ type: 'focus', ...focus });
      }
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'claudeSubagentsDashboard',
      'Subagentes de Claude Code',
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: true }
    );
    panel.iconPath = new vscode.ThemeIcon('graph');
    this.panel = panel;
    panel.onDidDispose(
      () => {
        this.panel = undefined;
        this.lastSignature = '';
      },
      null,
      this.context.subscriptions
    );
    panel.webview.onDidReceiveMessage(
      (message: { type?: string; id?: string }) => {
        if (message?.type === 'open' && message.id) {
          this.onOpenAgent(message.id);
        }
      },
      null,
      this.context.subscriptions
    );

    const data = buildDashboardData(sessions);
    this.lastSignature = signatureOf(data);
    const n = nonce();
    const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${n}';`;
    panel.webview.html = html(csp, n, data, focus);
  }

  update(sessions: SessionInfo[], force = false): void {
    if (!this.panel) {
      return;
    }
    const data = buildDashboardData(sessions);
    const signature = signatureOf(data);
    if (!force && signature === this.lastSignature) {
      return;
    }
    this.lastSignature = signature;
    void this.panel.webview.postMessage({ type: 'data', payload: data });
  }
}

function signatureOf(data: DashData): string {
  const t = data.totals;
  return `${t.agents}:${t.running}:${t.completed}:${t.stalled}:${t.cancelled}:${t.toolCalls}:${t.toolErrors}:${t.tokensOut}:${data.agents
    .slice(0, 12)
    .map((a) => `${a.id}@${a.endedAt}:${a.currentName ?? ''}`)
    .join('|')}`;
}
