import * as vscode from 'vscode';
import { settings } from './config';
import { AgentEvent, AgentInfo, AgentStatus } from './model';
import { baseCss, clientHelpersJs, esc, nonce, stripFor, toolCategory } from './ui';

/** Keeps the DOM (and the postMessage payload) manageable on very long runs. */
const MAX_RENDERED_EVENTS = 150;
/** Cells in the activity strip. */
const STRIP_LENGTH = 60;

export interface DetailActions {
  openTranscript(agent: AgentInfo): void;
  copyPrompt(agent: AgentInfo): void;
  copyReport(agent: AgentInfo): void;
  revealFolder(agent: AgentInfo): void;
}

/* ------------------------------------------------------------ payload */

interface DetailEvent {
  /** Index in the full snapshot.events array; stable across updates. */
  i: number;
  kind: AgentEvent['kind'];
  at: number;
  text?: string;
  /** Tool call number (#1, #2 …) across the whole run. */
  n?: number;
  name?: string;
  cat?: string;
  summary?: string;
  input?: string;
  result?: string;
  isError?: boolean;
  endedAt?: number;
}

interface DetailPayload {
  id: string;
  description: string;
  agentType: string;
  phase?: string;
  workflowId?: string;
  model?: string;
  spawnDepth: number;
  parentAgentId?: string;
  stoppedByUser: boolean;
  status: AgentStatus;
  startedAt: number;
  lastActivity: number;
  durationMs: number;
  toolCalls: number;
  toolErrors: number;
  messages: number;
  tokensIn: number;
  tokensOut: number;
  tokensCacheRead: number;
  currentTool?: { name: string; summary: string; at: number };
  strip: string;
  toolCounts: { name: string; cat: string; count: number; errors: number }[];
  finalText?: string;
  prompt?: string;
  promptAt?: number;
  truncated: boolean;
  omitted: number;
  events: DetailEvent[];
  showThinking: boolean;
  generatedAt: number;
}

function buildPayload(agent: AgentInfo): DetailPayload {
  const snap = agent.snapshot;
  const all = snap.events;

  const counts = new Map<string, { count: number; errors: number }>();
  let toolsInEvents = 0;
  for (const event of all) {
    if (event.kind === 'tool') {
      toolsInEvents++;
      const entry = counts.get(event.name) ?? { count: 0, errors: 0 };
      entry.count++;
      if (event.isError) {
        entry.errors++;
      }
      counts.set(event.name, entry);
    }
  }
  // Tool numbers stay meaningful even when older events were dropped from the buffer.
  let toolNumber = Math.max(0, snap.toolCalls - toolsInEvents);

  const start = Math.max(0, all.length - MAX_RENDERED_EVENTS);
  const events: DetailEvent[] = [];
  let promptAt: number | undefined;
  for (let i = 0; i < all.length; i++) {
    const event = all[i];
    if (event.kind === 'prompt') {
      promptAt = event.at;
      continue;
    }
    if (event.kind === 'tool') {
      toolNumber++;
    }
    if (i < start) {
      continue;
    }
    if (event.kind === 'tool') {
      events.push({
        i,
        kind: 'tool',
        at: event.at,
        n: toolNumber,
        name: event.name,
        cat: toolCategory(event.name),
        summary: event.summary,
        input: event.input,
        result: event.result,
        isError: event.isError,
        endedAt: event.endedAt
      });
    } else {
      events.push({ i, kind: event.kind, at: event.at, text: event.text });
    }
  }

  return {
    id: agent.transcriptPath,
    description: agent.disambiguator ? `${agent.description} ${agent.disambiguator}` : agent.description,
    agentType: agent.agentType,
    phase: agent.workflowPhase,
    workflowId: agent.workflowId,
    model: snap.model,
    spawnDepth: agent.spawnDepth,
    parentAgentId: agent.parentAgentId,
    stoppedByUser: agent.stoppedByUser,
    status: agent.status,
    startedAt: agent.startedAt,
    lastActivity: agent.lastActivity,
    durationMs: agent.durationMs,
    toolCalls: snap.toolCalls,
    toolErrors: snap.toolErrors,
    messages: snap.messages,
    tokensIn: snap.tokensIn,
    tokensOut: snap.tokensOut,
    tokensCacheRead: snap.tokensCacheRead,
    currentTool: agent.status === 'running' ? snap.currentTool : undefined,
    strip: stripFor(agent, STRIP_LENGTH),
    toolCounts: [...counts.entries()]
      .map(([name, c]) => ({ name, cat: toolCategory(name), count: c.count, errors: c.errors }))
      .sort((a, b) => b.count - a.count),
    finalText: snap.finalText,
    prompt: snap.prompt,
    promptAt,
    truncated: snap.truncated,
    omitted: start > 0 ? all.filter((e, i) => i < start && e.kind !== 'prompt').length : 0,
    events,
    showThinking: settings.showThinking(),
    generatedAt: Date.now()
  };
}

/* --------------------------------------------------------------- html */

function pageCss(): string {
  return `
body { padding: 0 18px 56px; }
.wrap { max-width: 1180px; margin: 0 auto; }

/* header */
.head { position: sticky; top: 0; z-index: 5; background: var(--surface); padding: 14px 0 10px; border-bottom: 1px solid var(--grid); margin-bottom: 14px; }
.head-top { display: flex; gap: 14px; align-items: flex-start; justify-content: space-between; flex-wrap: wrap; }
.head h1 { font-size: 1.2rem; font-weight: 600; margin: 0 0 6px; line-height: 1.3; word-break: break-word; }
.badges { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-bottom: 8px; }
.status-line { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; font-size: .8rem; }
.actions { display: flex; flex-wrap: wrap; gap: 6px; flex: none; }

/* now bar */
.now {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 10px; padding: 8px 12px; border-radius: var(--radius);
  background: color-mix(in srgb, var(--c-run) 8%, var(--card)); border: 1px solid color-mix(in srgb, var(--c-run) 30%, transparent);
  border-left: 3px solid var(--c-run); font-size: .82rem;
}
.now .lbl { font-size: .66rem; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; color: var(--c-run); }
.now .what { flex: 1; min-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.now .elapsed { font-variant-numeric: tabular-nums; color: var(--ink-2); }
.tool-name { display: inline-flex; align-items: center; gap: 4px; font-family: var(--mono); font-size: .76rem; font-weight: 600; padding: 0 6px; border-radius: 4px; background: color-mix(in srgb, var(--tc, var(--ink-2)) var(--tint), transparent); color: var(--tc, var(--ink)); white-space: nowrap; }

/* tiles */
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin: 14px 0; }
.tile { background: var(--card); border: 1px solid var(--grid); border-radius: var(--radius); padding: 10px 12px; min-width: 0; }
.tile .k { font-size: .66rem; text-transform: uppercase; letter-spacing: .07em; color: var(--ink-2); display: flex; align-items: center; gap: 5px; }
.tile .v { font-size: 1.25rem; font-weight: 600; margin-top: 3px; line-height: 1.2; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tile .v small { font-size: .74rem; font-weight: 500; color: var(--ink-2); }
.tile .sub { font-size: .7rem; color: var(--ink-3); margin-top: 3px; line-height: 1.3; }
.tokbar { display: flex; height: 5px; border-radius: 3px; overflow: hidden; background: var(--card-2); margin-top: 6px; }
.tokbar span { display: block; height: 100%; }
.tok-in { background: var(--seq-4); } .tok-out { background: var(--c-done); } .tok-cache { background: var(--seq-2); }
.toklegend { display: flex; gap: 8px; font-size: .66rem; color: var(--ink-2); margin-top: 4px; flex-wrap: wrap; }
.toklegend span { display: inline-flex; align-items: center; gap: 4px; }
.sw { width: 8px; height: 8px; border-radius: 2px; display: inline-block; }

/* sections */
h2 { font-size: .74rem; text-transform: uppercase; letter-spacing: .09em; color: var(--ink-2); margin: 22px 0 8px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
h2 .cnt { font-weight: 500; text-transform: none; letter-spacing: 0; color: var(--ink-3); }
.legend { display: flex; gap: 12px; flex-wrap: wrap; font-size: .7rem; color: var(--ink-2); align-items: center; }
.legend span { display: inline-flex; align-items: center; gap: 4px; }
.strip-row { display: flex; gap: 14px; align-items: center; flex-wrap: wrap; background: var(--card); border: 1px solid var(--grid); border-radius: var(--radius); padding: 10px 12px; }
.strip-row .strip { flex-wrap: wrap; height: auto; row-gap: 3px; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.chip { display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--grid); background: var(--card); font-size: .74rem; }
.chip .n { font-variant-numeric: tabular-nums; color: var(--ink-2); }
.chip .e { color: var(--c-err); font-weight: 600; font-variant-numeric: tabular-nums; }

/* report */
.report { border: 1px solid color-mix(in srgb, var(--c-done) 35%, transparent); border-left: 4px solid var(--c-done); background: color-mix(in srgb, var(--c-done) 5%, var(--card)); border-radius: var(--radius); padding: 10px 16px 14px; }
.report h2 { margin-top: 4px; color: var(--c-done); }
.md { line-height: 1.55; font-size: .86rem; word-break: break-word; }
.md p { margin: 6px 0; white-space: pre-wrap; }
.md h3 { font-size: 1rem; margin: 12px 0 4px; }
.md h4 { font-size: .9rem; margin: 10px 0 3px; }
.md ul, .md ol { margin: 4px 0 6px; padding-left: 22px; }
.md li { margin: 2px 0; white-space: pre-wrap; }
.md pre.code { margin: 8px 0; }

/* timeline */
.tl-tools { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin-bottom: 10px; position: sticky; top: 0; z-index: 1; }
.tl-tools .search { max-width: 280px; }
.tl-tools .found { font-size: .72rem; color: var(--ink-2); }
.ev { border-left: 3px solid var(--grid); background: var(--card); border-radius: 0 6px 6px 0; margin: 4px 0; padding: 0; }
.ev.tool { border-left-color: var(--tc); }
.ev.tool.err { border-left-color: var(--c-err); background: color-mix(in srgb, var(--c-err) 5%, var(--card)); }
.ev.tool.pending { border-left-color: var(--c-run); background: color-mix(in srgb, var(--c-run) 6%, var(--card)); }
.ev.thinking { border-left-color: var(--c-think); }
.ev.text { border-left-color: var(--c-text); }
.ev.prompt { border-left-color: var(--seq-5); margin-bottom: 12px; }
.ev summary { cursor: pointer; display: flex; align-items: center; gap: 8px; list-style: none; padding: 6px 10px; min-height: 30px; }
.ev summary::-webkit-details-marker { display: none; }
.ev summary:hover { background: var(--card-2); }
.ev .num { font-family: var(--mono); font-size: .68rem; color: var(--ink-3); flex: none; width: 34px; text-align: right; }
.ev .sum { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: .82rem; min-width: 0; }
.ev .meta { flex: none; display: flex; gap: 8px; align-items: center; font-size: .7rem; color: var(--ink-2); font-variant-numeric: tabular-nums; }
.ev .kind { font-size: .64rem; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; padding: 0 6px; border-radius: 4px; flex: none; }
.ev.thinking .kind { color: var(--c-think); background: color-mix(in srgb, var(--c-think) var(--tint), transparent); }
.ev.text .kind { color: var(--c-text); background: color-mix(in srgb, var(--c-text) var(--tint), transparent); }
.ev.prompt .kind { color: var(--seq-5); background: color-mix(in srgb, var(--seq-5) var(--tint), transparent); }
.ev .body { padding: 4px 12px 12px 52px; }
.ev .io-label { font-size: .66rem; text-transform: uppercase; letter-spacing: .07em; color: var(--ink-2); margin: 8px 0 3px; display: flex; align-items: center; gap: 5px; }
.ev .io-label.err { color: var(--c-err); }
.ev .slow { color: var(--c-stall); }
.pending-dot { width: 7px; height: 7px; }
.note { font-size: .74rem; color: var(--ink-2); padding: 6px 0; }
.empty { padding: 30px 0; text-align: center; color: var(--ink-2); }
.warn-pill { margin-left: auto; }
`;
}

function pageJs(): string {
  return `
const vscodeApi = acquireVsCodeApi();
let A = window.__INITIAL__;
let filter = 'all';
let query = '';
let ticker;

const FILTERS = [
  ['all', 'Todo', 'layers'],
  ['tools', 'Herramientas', 'tools'],
  ['errors', 'Errores', 'warning'],
  ['thinking', 'Razonamiento', 'sparkle'],
  ['text', 'Respuestas', 'comment']
];

function toolNameHtml(name) {
  const cat = toolCat(name);
  return '<span class="tool-name" style="--tc:var(--t-' + cat + ')" data-tip="<b>' + esc(prettyTool(name)) + '</b><br><span class=k>' + esc(TOOLCAT[cat].label) + '</span>">' + toolIcon(name) + esc(prettyTool(name)) + '</span>';
}

/* Safe minimal markdown: fenced code → pre, headings, bullets, bold, inline code. Everything escaped first. */
function inline(s) {
  return esc(s)
    .replace(/\`([^\`]+)\`/g, '<code>$1</code>')
    .replace(/\\*\\*([^*]+)\\*\\*/g, '<b>$1</b>');
}
function renderMd(text) {
  const parts = String(text || '').split(/\`\`\`/g);
  return parts.map((part, idx) => {
    if (idx % 2 === 1) {
      const nl = part.indexOf('\\n');
      const body = nl >= 0 ? part.slice(nl + 1) : part;
      return '<pre class="code">' + esc(body) + '</pre>';
    }
    const out = [];
    let list = null;
    let para = [];
    const flushPara = () => { if (para.length) { out.push('<p>' + para.join('\\n') + '</p>'); para = []; } };
    const flushList = () => { if (list) { out.push('<' + list.tag + '>' + list.items.join('') + '</' + list.tag + '>'); list = null; } };
    for (const raw of part.split('\\n')) {
      const line = raw.replace(/\\s+$/, '');
      let m;
      if ((m = /^(#{1,3})\\s+(.*)$/.exec(line))) {
        flushPara(); flushList();
        out.push(m[1].length === 1 ? '<h3>' + inline(m[2]) + '</h3>' : '<h4>' + inline(m[2]) + '</h4>');
      } else if ((m = /^\\s*[-*•]\\s+(.*)$/.exec(line))) {
        flushPara();
        if (!list || list.tag !== 'ul') { flushList(); list = { tag: 'ul', items: [] }; }
        list.items.push('<li>' + inline(m[1]) + '</li>');
      } else if ((m = /^\\s*\\d+[.)]\\s+(.*)$/.exec(line))) {
        flushPara();
        if (!list || list.tag !== 'ol') { flushList(); list = { tag: 'ol', items: [] }; }
        list.items.push('<li>' + inline(m[1]) + '</li>');
      } else if (line.trim() === '') {
        flushPara(); flushList();
      } else {
        flushList();
        para.push(inline(line));
      }
    }
    flushPara(); flushList();
    return out.join('');
  }).join('');
}

function header() {
  const st = STATE[A.status] || STATE.unknown;
  const badges = [typeBadge(A.agentType)];
  if (A.agentType.toLowerCase() === 'fork') badges.push('<span class="badge badge-outline" data-tip="Copia del contexto de la sesión principal">fork</span>');
  if (A.phase) badges.push('<span class="badge badge-outline" data-tip="<b>Fase del workflow</b>">' + icon('layers') + esc(A.phase) + '</span>');
  if (A.workflowId) badges.push('<span class="badge badge-outline mono" data-tip="<b>Workflow</b><br>' + esc(A.workflowId) + '">' + icon('chain') + esc(A.workflowId) + '</span>');
  if (A.model) badges.push('<span class="badge badge-outline" data-tip="<b>Modelo</b><br>' + esc(A.model) + '">' + icon('zap') + esc(shortModel(A.model)) + '</span>');
  if (A.spawnDepth > 1) badges.push('<span class="badge badge-outline" data-tip="Profundidad de anidamiento: lanzado por otro subagente' + (A.parentAgentId ? '<br>padre: ' + esc(A.parentAgentId) : '') + '">' + icon('agents') + 'nivel ' + A.spawnDepth + '</span>');

  let hint = st.hint;
  if (A.status === 'stalled') hint += ' Última escritura ' + ago(A.lastActivity) + '.';
  if (A.status === 'cancelled') hint = 'Detenido por el usuario. ' + hint;
  if (A.status === 'completed' && A.stoppedByUser) hint += ' (El usuario pidió parar, pero alcanzó a cerrar el turno.)';

  return '<div class="head">' +
    '<div class="head-top"><div style="min-width:0;flex:1">' +
      '<h1>' + esc(A.description) + '</h1>' +
      '<div class="badges">' + badges.join('') + '</div>' +
      '<div class="status-line">' + statusPill(A.status, A.status === 'running' ? ago(A.lastActivity) : '') + '<span class="muted">' + esc(hint) + '</span></div>' +
    '</div>' +
    '<div class="actions">' +
      '<button class="btn" data-action="transcript" data-tip="Abre el archivo JSONL crudo del subagente en el editor">' + icon('json') + 'Transcript</button>' +
      '<button class="btn" data-action="copyPrompt" data-tip="Copia al portapapeles la tarea que recibió">' + icon('copy') + 'Copiar prompt</button>' +
      '<button class="btn" data-action="copyReport" data-tip="Copia al portapapeles el informe final' + (A.finalText ? '' : ' (todavía no hay)') + '">' + icon('copy') + 'Copiar informe</button>' +
      '<button class="btn btn-ghost" data-action="reveal" data-tip="Muestra la carpeta del transcript en el explorador del sistema">' + icon('folder') + '</button>' +
    '</div></div>' +
    nowBar() +
  '</div>';
}

function nowBar() {
  if (A.status !== 'running') return '';
  if (!A.currentTool) {
    return '<div class="now"><span class="dot bg-run pulse"></span><span class="lbl">Ahora</span>' + icon('sparkle', 'st-run') + '<span class="what">Razonando o escribiendo la respuesta…</span><span class="elapsed" data-tip="Tiempo total desde que arrancó">' + dur(Date.now() - A.startedAt) + '</span></div>';
  }
  const t = A.currentTool;
  const elapsed = Date.now() - t.at;
  return '<div class="now"><span class="dot bg-run pulse"></span><span class="lbl">Ahora</span>' + toolNameHtml(t.name) +
    '<span class="what" title="' + esc(t.summary) + '">' + esc(t.summary || '') + '</span>' +
    '<span class="elapsed" data-live-since="' + t.at + '" data-tip="Tiempo que lleva esta llamada a herramienta">' + dur(elapsed) + '</span>' +
    '<span id="now-warn" class="pill pill-stall warn-pill' + (elapsed > 60000 ? '' : ' hidden') + '" data-tip="Una llamada suele tardar segundos. Puede ser un comando largo (tests, build) o algo colgado.">' + icon('warning') + 'lleva más de 60 s en esta herramienta</span>' +
  '</div>';
}

function tiles() {
  const tokTotal = A.tokensIn + A.tokensOut + A.tokensCacheRead;
  const pct = (n) => tokTotal ? (n / tokTotal * 100) : 0;
  const errs = A.toolErrors ? ' <small class="st-err">· ' + A.toolErrors + ' con error</small>' : '';
  return '<div class="tiles">' +
    tile('clock', 'Duración', (A.status === 'running' ? '<span data-live-since="' + A.startedAt + '">' + dur(Date.now() - A.startedAt) + '</span>' : dur(A.durationMs)), 'inicio ' + clockS(A.startedAt) + (A.status !== 'running' ? ' · fin ' + clockS(A.lastActivity) : '')) +
    tile('tools', 'Herramientas', A.toolCalls + errs, 'llamadas a herramientas (Bash, Read, Edit…) que hizo') +
    tile('message', 'Mensajes', A.messages, 'turnos del asistente en el transcript') +
    '<div class="tile"><div class="k">' + icon('coins') + 'Tokens</div>' +
      '<div class="v">' + tok(A.tokensOut) + ' <small>generados</small></div>' +
      '<div class="tokbar">' +
        '<span class="tok-in" style="width:' + pct(A.tokensIn) + '%" data-tip="<b>Entrada</b> ' + A.tokensIn.toLocaleString('es') + ' tokens"></span>' +
        '<span class="tok-out" style="width:' + pct(A.tokensOut) + '%" data-tip="<b>Salida</b> ' + A.tokensOut.toLocaleString('es') + ' tokens"></span>' +
        '<span class="tok-cache" style="width:' + pct(A.tokensCacheRead) + '%" data-tip="<b>Caché leída</b> ' + A.tokensCacheRead.toLocaleString('es') + ' tokens"></span>' +
      '</div>' +
      '<div class="toklegend"><span><i class="sw tok-in"></i>' + tok(A.tokensIn) + ' entrada</span><span><i class="sw tok-out"></i>' + tok(A.tokensOut) + ' salida</span><span><i class="sw tok-cache"></i>' + tok(A.tokensCacheRead) + ' caché</span></div>' +
    '</div>' +
    tile('refresh', 'Última actividad', '<span style="font-size:1rem">' + ago(A.lastActivity) + '</span>', clockS(A.lastActivity) + ' · última línea escrita en el transcript') +
  '</div>';
}
function tile(ic, k, v, sub) {
  return '<div class="tile"><div class="k">' + icon(ic) + esc(k) + '</div><div class="v">' + v + '</div><div class="sub">' + esc(sub) + '</div></div>';
}

function activity() {
  if (!A.toolCalls) return '';
  const chips = A.toolCounts.map((t) =>
    '<span class="chip" style="--tc:var(--t-' + t.cat + ')" data-tip="<b>' + esc(prettyTool(t.name)) + '</b><br><span class=k>' + esc(TOOLCAT[t.cat].label) + '</span><br>' + t.count + ' llamadas' + (t.errors ? ', ' + t.errors + ' con error' : '') + '">' +
      toolIcon(t.name) + '<span>' + esc(prettyTool(t.name)) + '</span><span class="n">' + t.count + '</span>' + (t.errors ? '<span class="e">' + t.errors + ' ✕</span>' : '') +
    '</span>'
  ).join('');
  return '<h2>' + icon('graph') + 'Actividad <span class="cnt">últimas ' + Math.min(A.toolCalls, ${STRIP_LENGTH}) + ' llamadas, de izquierda (antigua) a derecha (reciente)</span></h2>' +
    '<div class="strip-row">' + stripHtml(A.strip) +
      '<div class="legend"><span>cada celda = una llamada</span>' +
        '<span><i class="cell cell-1"></i>rápida</span><span><i class="cell cell-4"></i>media</span><span><i class="cell cell-6"></i>lenta</span><span><i class="cell cell-e"></i>error</span><span><i class="cell cell-p"></i>en curso</span>' +
      '</div>' +
    '</div>' +
    '<div class="chips">' + chips + '</div>';
}

function report() {
  if (!A.finalText) {
    if (A.status === 'completed') return '';
    return '<h2>' + icon('comment') + 'Informe final</h2><div class="note">' + (A.status === 'running' ? 'Todavía trabajando: el informe aparece cuando cierre el turno.' : 'No entregó informe final.') + '</div>';
  }
  return '<div class="report" style="margin-top:22px"><h2>' + icon('check') + 'Informe final <span class="cnt">' + A.finalText.length.toLocaleString('es') + ' caracteres</span></h2><div class="md">' + renderMd(A.finalText) + '</div></div>';
}

function matches(ev) {
  if (filter === 'tools' && ev.kind !== 'tool') return false;
  if (filter === 'errors' && !(ev.kind === 'tool' && ev.isError)) return false;
  if (filter === 'thinking' && ev.kind !== 'thinking') return false;
  if (filter === 'text' && ev.kind !== 'text') return false;
  if (ev.kind === 'thinking' && !A.showThinking) return false;
  if (query) {
    const hay = (ev.kind === 'tool' ? (ev.name + ' ' + prettyTool(ev.name) + ' ' + (ev.summary || '') + ' ' + (ev.input || '').slice(0, 400)) : (ev.text || '').slice(0, 600)).toLowerCase();
    if (!hay.includes(query)) return false;
  }
  return true;
}

function eventHtml(ev) {
  const id = 'ev-' + ev.i;
  if (ev.kind === 'tool') {
    const pending = ev.result === undefined && ev.endedAt === undefined;
    const ms = ev.endedAt && ev.at ? ev.endedAt - ev.at : -1;
    const cls = 'ev tool' + (ev.isError ? ' err' : pending ? ' pending' : '');
    const timeHtml = pending
      ? '<span class="st-run"><span class="dot bg-run pulse pending-dot"></span> en curso <span data-live-since="' + ev.at + '">' + dur(Date.now() - ev.at) + '</span></span>'
      : '<span class="' + (ms > 60000 ? 'slow' : '') + '" data-tip="Duración de la llamada">' + dur(ms) + '</span>';
    return '<details class="' + cls + '" id="' + id + '" style="--tc:var(--t-' + ev.cat + ')">' +
      '<summary><span class="num">#' + ev.n + '</span>' + toolNameHtml(ev.name) +
        (ev.isError ? '<span class="pill pill-err" data-tip="La herramienta devolvió un error">' + icon('warning') + 'error</span>' : '') +
        '<span class="sum" title="' + esc(ev.summary) + '">' + esc(ev.summary || '') + '</span>' +
        '<span class="meta">' + timeHtml + '<span>' + clockS(ev.at) + '</span></span>' +
      '</summary>' +
      '<div class="body"><div class="io-label">' + icon('chevron') + 'Entrada</div><pre class="code">' + esc(ev.input) + '</pre>' +
        (ev.result !== undefined ? '<div class="io-label' + (ev.isError ? ' err' : '') + '">' + icon(ev.isError ? 'warning' : 'check') + 'Resultado' + (ev.isError ? ' (error)' : '') + '</div><pre class="code">' + esc(ev.result) + '</pre>' : '<div class="note">Esperando resultado…</div>') +
      '</div></details>';
  }
  const isThink = ev.kind === 'thinking';
  const first = (ev.text || '').replace(/\\s+/g, ' ').trim();
  return '<details class="ev ' + ev.kind + '" id="' + id + '">' +
    '<summary><span class="num"></span>' + icon(isThink ? 'sparkle' : 'comment', isThink ? 'st-think' : 'st-done') +
      '<span class="kind">' + (isThink ? 'razona' : 'responde') + '</span>' +
      '<span class="sum">' + esc(first.slice(0, 160)) + '</span>' +
      '<span class="meta"><span>' + first.length.toLocaleString('es') + ' car.</span><span>' + clockS(ev.at) + '</span></span>' +
    '</summary><div class="body"><div class="md">' + renderMd(ev.text) + '</div></div></details>';
}

function promptCard() {
  if (!A.prompt) return '';
  const short = A.prompt.length < 600;
  return '<details class="ev prompt" id="ev-prompt"' + (short ? ' open' : '') + '>' +
    '<summary><span class="num"></span>' + icon('message', 'st-run') + '<span class="kind">tarea recibida</span>' +
      '<span class="sum">' + esc(A.prompt.replace(/\\s+/g, ' ').slice(0, 160)) + '</span>' +
      '<span class="meta"><span>' + A.prompt.length.toLocaleString('es') + ' car.</span>' + (A.promptAt ? '<span>' + clockS(A.promptAt) + '</span>' : '') + '</span>' +
    '</summary><div class="body"><div class="md">' + renderMd(A.prompt) + '</div></div></details>';
}

function timeline() {
  const counts = { all: 0, tools: 0, errors: 0, thinking: 0, text: 0 };
  for (const ev of A.events) {
    if (ev.kind === 'thinking' && !A.showThinking) continue;
    counts.all++;
    if (ev.kind === 'tool') { counts.tools++; if (ev.isError) counts.errors++; }
    if (ev.kind === 'thinking') counts.thinking++;
    if (ev.kind === 'text') counts.text++;
  }
  const seg = '<div class="seg">' + FILTERS.filter(([k]) => k === 'all' || counts[k] > 0 || k === filter).map(([k, label, ic]) =>
    '<button data-filter="' + k + '" class="' + (filter === k ? 'on' : '') + '">' + icon(ic) + label + ' <span class="n">' + counts[k] + '</span></button>'
  ).join('') + '</div>';
  const shown = A.events.filter(matches);
  const rows = shown.map(eventHtml).join('');
  const notes = [];
  if (A.truncated) notes.push('<div class="note">' + icon('warning', 'st-stall') + ' Transcript muy grande: solo se leyó el final del archivo.</div>');
  if (A.omitted) notes.push('<div class="note">… ' + A.omitted + ' eventos anteriores no se muestran (límite de ${MAX_RENDERED_EVENTS}).</div>');
  return '<h2>' + icon('clock') + 'Línea de tiempo <span class="cnt">' + shown.length + ' de ' + counts.all + ' eventos</span></h2>' +
    '<div class="tl-tools">' + seg + '<input class="search" id="q" type="search" placeholder="Filtrar por herramienta, archivo, comando…" value="' + esc(query) + '">' +
      (query ? '<span class="found">' + shown.length + ' coincidencias</span>' : '') + '</div>' +
    promptCard() + notes.join('') +
    (rows || '<div class="empty">' + (A.events.length ? 'Nada coincide con el filtro.' : 'Sin eventos todavía.') + '</div>');
}

function render() {
  const openIds = new Set(Array.from(document.querySelectorAll('details[open]')).map((d) => d.id).filter(Boolean));
  const firstRender = !document.querySelector('.head');
  const atBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 80;
  const y = window.scrollY;
  const active = document.activeElement;
  const qFocused = active && active.id === 'q';
  const selStart = qFocused ? active.selectionStart : null;

  document.getElementById('root').innerHTML = '<div class="wrap">' + header() + tiles() + activity() + report() + timeline() + '</div>';

  for (const id of openIds) {
    const el = document.getElementById(id);
    if (el) el.open = true;
  }
  if (!firstRender) window.scrollTo(0, atBottom ? document.body.scrollHeight : y);

  for (const btn of document.querySelectorAll('[data-action]')) {
    btn.addEventListener('click', () => vscodeApi.postMessage({ type: 'action', name: btn.getAttribute('data-action') }));
  }
  for (const btn of document.querySelectorAll('[data-filter]')) {
    btn.addEventListener('click', () => { filter = btn.getAttribute('data-filter'); render(); });
  }
  const q = document.getElementById('q');
  let deb;
  q.addEventListener('input', () => {
    clearTimeout(deb);
    deb = setTimeout(() => { query = q.value.trim().toLowerCase(); render(); }, 120);
  });
  if (qFocused) { q.focus(); if (selStart != null) q.setSelectionRange(selStart, selStart); }
}

function tick() {
  const now = Date.now();
  for (const el of document.querySelectorAll('[data-live-since]')) {
    el.textContent = dur(now - Number(el.getAttribute('data-live-since')));
  }
  const warn = document.getElementById('now-warn');
  if (warn && A.currentTool) warn.classList.toggle('hidden', now - A.currentTool.at <= 60000);
}

window.addEventListener('message', (event) => {
  const msg = event.data;
  if (msg && msg.type === 'update') {
    A = msg.payload;
    render();
  }
});

bindTips();
render();
ticker = setInterval(tick, 1000);
vscodeApi.postMessage({ type: 'ready' });
`;
}

function shellHtml(payload: DetailPayload, csp: string, n: string): string {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(payload.description)}</title>
<style>${baseCss()}${pageCss()}</style>
</head>
<body>
<div id="root"></div>
<div id="tip"></div>
<script nonce="${n}">
window.__INITIAL__ = ${JSON.stringify(payload).replace(/</g, '\\u003c')};
${clientHelpersJs()}
${pageJs()}
</script>
</body>
</html>`;
}

/* -------------------------------------------------------------- panels */

interface OpenPanel {
  panel: vscode.WebviewPanel;
  agent: AgentInfo;
  /** Cheap change detector, so an idle panel is not re-rendered every tick. */
  signature: string;
}

/** Webview panels showing one subagent each, kept in sync with the scanner. */
export class DetailPanels {
  private panels = new Map<string, OpenPanel>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly actions: DetailActions
  ) {}

  show(agent: AgentInfo): void {
    const existing = this.panels.get(agent.transcriptPath);
    if (existing) {
      existing.panel.reveal(existing.panel.viewColumn, false);
      this.render(existing, agent);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'claudeSubagentDetail',
      agent.description.slice(0, 40),
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: true }
    );
    panel.iconPath = new vscode.ThemeIcon('robot');
    const open: OpenPanel = { panel, agent, signature: '' };
    this.panels.set(agent.transcriptPath, open);
    panel.onDidDispose(() => this.panels.delete(agent.transcriptPath), null, this.context.subscriptions);
    panel.webview.onDidReceiveMessage(
      (message: { type?: string; name?: string }) => {
        if (message?.type !== 'action') {
          return;
        }
        const current = open.agent;
        switch (message.name) {
          case 'transcript':
            this.actions.openTranscript(current);
            break;
          case 'copyPrompt':
            this.actions.copyPrompt(current);
            break;
          case 'copyReport':
            this.actions.copyReport(current);
            break;
          case 'reveal':
            this.actions.revealFolder(current);
            break;
        }
      },
      null,
      this.context.subscriptions
    );
    this.render(open, agent, true);
  }

  refresh(agents: AgentInfo[]): void {
    if (this.panels.size === 0) {
      return;
    }
    const byPath = new Map(agents.map((a) => [a.transcriptPath, a]));
    for (const [key, open] of this.panels) {
      const agent = byPath.get(key);
      if (agent) {
        this.render(open, agent);
      }
    }
  }

  private render(open: OpenPanel, agent: AgentInfo, initial = false): void {
    open.agent = agent;
    const snap = agent.snapshot;
    const signature = `${agent.status}:${agent.lastActivity}:${snap.events.length}:${snap.toolCalls}:${snap.toolErrors}:${
      snap.currentTool?.at ?? 0
    }:${snap.finalText?.length ?? 0}`;
    if (!initial && signature === open.signature) {
      return;
    }
    open.signature = signature;
    const glyph = agent.status === 'running' ? '▶ ' : agent.status === 'stalled' ? '⏸ ' : agent.status === 'cancelled' ? '✕ ' : '';
    open.panel.title = `${glyph}${agent.description.slice(0, 40)}`;
    const payload = buildPayload(agent);
    if (initial) {
      const n = nonce();
      const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${n}';`;
      open.panel.webview.html = shellHtml(payload, csp, n);
      return;
    }
    void open.panel.webview.postMessage({ type: 'update', payload });
  }
}
