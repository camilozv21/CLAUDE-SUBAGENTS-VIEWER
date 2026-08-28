/**
 * Shared design system for the three webviews (sidebar, dashboard, detail).
 *
 * Everything visual lives here so the extension reads as one product: status
 * colours and their meaning, tool categories with icons, the agent-type palette,
 * the base CSS and the client-side helpers each webview script starts from.
 *
 * Status is never colour-alone: every state carries a glyph, a label and a
 * one-line hint that explains to the developer what the state means.
 */
import { AgentInfo, AgentStatus } from './model';

export function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function nonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

/* ------------------------------------------------------------------ status */

export interface StatusMeta {
  /** CSS suffix: .pill-run, .dot-run, --c-run … */
  cls: string;
  glyph: string;
  icon: string;
  label: string;
  /** Short explanation shown next to the label. */
  hint: string;
}

export const STATUS: Record<AgentStatus, StatusMeta> = {
  running: {
    cls: 'run',
    glyph: '▶',
    icon: 'play',
    label: 'Ejecutando',
    hint: 'Está trabajando ahora mismo; el transcript se sigue escribiendo.'
  },
  completed: {
    cls: 'done',
    glyph: '✓',
    icon: 'check',
    label: 'Completado',
    hint: 'Cerró su turno y entregó un informe final.'
  },
  stalled: {
    cls: 'stall',
    glyph: '⏸',
    icon: 'pause',
    label: 'Detenido',
    hint: 'Se quedó a medias: dejó de escribir sin cerrar el turno (workflow cancelado, sesión cerrada o error).'
  },
  cancelled: {
    cls: 'cancel',
    glyph: '✕',
    icon: 'x',
    label: 'Cancelado',
    hint: 'El usuario lo detuvo (Esc / stop) antes de que terminara.'
  },
  unknown: {
    cls: 'cancel',
    glyph: '?',
    icon: 'question',
    label: 'Desconocido',
    hint: 'No se pudo determinar el estado a partir del transcript.'
  }
};

/* ------------------------------------------------------------ tool categories */

export type ToolCategory =
  | 'shell'
  | 'file'
  | 'edit'
  | 'search'
  | 'web'
  | 'agent'
  | 'skill'
  | 'plan'
  | 'output'
  | 'mcp'
  | 'other';

export interface ToolCategoryMeta {
  label: string;
  icon: string;
}

export const TOOL_CATEGORIES: Record<ToolCategory, ToolCategoryMeta> = {
  shell: { label: 'Terminal', icon: 'terminal' },
  file: { label: 'Lectura de archivos', icon: 'file' },
  edit: { label: 'Escritura de archivos', icon: 'pencil' },
  search: { label: 'Búsqueda', icon: 'search' },
  web: { label: 'Web', icon: 'globe' },
  agent: { label: 'Subagentes', icon: 'agents' },
  skill: { label: 'Skills', icon: 'bulb' },
  plan: { label: 'Planificación', icon: 'checklist' },
  output: { label: 'Resultado', icon: 'json' },
  mcp: { label: 'MCP', icon: 'plug' },
  other: { label: 'Otra herramienta', icon: 'tools' }
};

const TOOL_TO_CATEGORY: Record<string, ToolCategory> = {
  Bash: 'shell',
  PowerShell: 'shell',
  Read: 'file',
  Glob: 'file',
  NotebookRead: 'file',
  LS: 'file',
  Write: 'edit',
  Edit: 'edit',
  MultiEdit: 'edit',
  NotebookEdit: 'edit',
  Grep: 'search',
  ToolSearch: 'search',
  WebSearch: 'web',
  WebFetch: 'web',
  Agent: 'agent',
  Task: 'agent',
  Workflow: 'agent',
  SendMessage: 'agent',
  ListAgents: 'agent',
  Skill: 'skill',
  TaskCreate: 'plan',
  TaskUpdate: 'plan',
  TaskList: 'plan',
  TodoWrite: 'plan',
  EnterPlanMode: 'plan',
  ExitPlanMode: 'plan',
  AskUserQuestion: 'plan',
  StructuredOutput: 'output',
  Artifact: 'output'
};

export function toolCategory(name: string): ToolCategory {
  if (name.startsWith('mcp__')) {
    return 'mcp';
  }
  return TOOL_TO_CATEGORY[name] ?? 'other';
}

/** 'mcp__claude-in-chrome__navigate' → 'chrome: navigate'. */
export function prettyToolName(name: string): string {
  const m = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(name);
  if (!m) {
    return name;
  }
  const server =
    m[1]
      .replace(/^claude[-_]?(ai[-_]?|in[-_]?)?/i, '')
      .replace(/[-_]+/g, ' ')
      .trim() || m[1];
  return `${server}: ${m[2]}`;
}

/* -------------------------------------------------------------- agent types */

/** 8 hues; known agent types pin a slot so they look the same everywhere. */
const TYPE_SLOTS: Record<string, number> = {
  explore: 0,
  plan: 1,
  'general-purpose': 2,
  claude: 2,
  fork: 3,
  'code-reviewer': 4,
  'workflow-subagent': 5,
  agent: 6,
  'statusline-setup': 7,
  'claude-code-guide': 7
};

export function typeSlot(agentType: string): number {
  const key = agentType.toLowerCase();
  if (key in TYPE_SLOTS) {
    return TYPE_SLOTS[key];
  }
  let h = 0;
  for (let i = 0; i < key.length; i++) {
    h = (h * 31 + key.charCodeAt(i)) >>> 0;
  }
  return h % 8;
}

/* ---------------------------------------------------------------- strips */

/** Duration bands for one tool call, as a single character. */
export function stripChar(ms: number, isError: boolean): string {
  if (isError) {
    return 'e';
  }
  if (ms < 0) {
    return '0';
  }
  if (ms < 1000) {
    return '1';
  }
  if (ms < 5000) {
    return '2';
  }
  if (ms < 15000) {
    return '3';
  }
  if (ms < 60000) {
    return '4';
  }
  if (ms < 300000) {
    return '5';
  }
  return '6';
}

/** Most recent `length` tool calls as a band string, oldest first. 'p' = still pending. */
export function stripFor(agent: AgentInfo, length: number): string {
  const cells: string[] = [];
  const events = agent.snapshot.events;
  for (let i = events.length - 1; i >= 0 && cells.length < length; i--) {
    const event = events[i];
    if (event.kind !== 'tool') {
      continue;
    }
    if (event.result === undefined && event.endedAt === undefined) {
      cells.push('p');
      continue;
    }
    cells.push(stripChar(event.endedAt && event.at ? Math.max(0, event.endedAt - event.at) : -1, event.isError === true));
  }
  return cells.reverse().join('');
}

/* ---------------------------------------------------------------- icons */

/** 16×16 stroke icons. Inner SVG only; `icon()` wraps them. */
export const ICONS: Record<string, string> = {
  terminal:
    '<rect x="1.5" y="3" width="13" height="10" rx="1.5" fill="none" stroke="currentColor"/><path d="M4.5 6l2 2-2 2M8 10h3.5" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/>',
  file: '<path d="M4 1.5h5l3 3v10H4z" fill="none" stroke="currentColor" stroke-linejoin="round"/><path d="M9 1.5v3h3" fill="none" stroke="currentColor" stroke-linejoin="round"/>',
  pencil:
    '<path d="M11.2 2.3l2.5 2.5L6 12.5H3.5V10z" fill="none" stroke="currentColor" stroke-linejoin="round"/><path d="M9.5 4l2.5 2.5" stroke="currentColor"/>',
  search:
    '<circle cx="6.8" cy="6.8" r="4.3" fill="none" stroke="currentColor"/><path d="M10 10l4 4" stroke="currentColor" stroke-linecap="round"/>',
  globe:
    '<circle cx="8" cy="8" r="6" fill="none" stroke="currentColor"/><path d="M2 8h12M8 2c2.4 2.6 2.4 9.4 0 12M8 2c-2.4 2.6-2.4 9.4 0 12" fill="none" stroke="currentColor"/>',
  agents:
    '<circle cx="8" cy="3.8" r="2" fill="none" stroke="currentColor"/><circle cx="3.8" cy="12.2" r="2" fill="none" stroke="currentColor"/><circle cx="12.2" cy="12.2" r="2" fill="none" stroke="currentColor"/><path d="M7 5.6L4.8 10.3M9 5.6l2.2 4.7" stroke="currentColor"/>',
  bulb: '<path d="M6 12.5h4M6.5 14.5h3M8 1.5a4.2 4.2 0 0 0-2.6 7.5c.5.4.6.9.6 1.4v.6h4v-.6c0-.5.1-1 .6-1.4A4.2 4.2 0 0 0 8 1.5z" fill="none" stroke="currentColor" stroke-linejoin="round"/>',
  checklist:
    '<path d="M2.5 4.5l1.2 1.2L6 3.5M2.5 9.5l1.2 1.2L6 8.5M8 4.5h6M8 9.5h6M8 13h4" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/>',
  json: '<path d="M5 4L2 8l3 4M11 4l3 4-3 4M9.5 2.5l-3 11" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/>',
  plug: '<path d="M5 2v3.5M11 2v3.5M3.5 5.5h9v2a4.5 4.5 0 0 1-9 0zM8 12v2.5" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/>',
  tools:
    '<path d="M10.2 1.8a4 4 0 0 0-4 5.4L2 11.5 4.5 14l4.3-4.2a4 4 0 0 0 5.4-4l-2.6 1.2-1.6-1.6L11.2 3z" fill="none" stroke="currentColor" stroke-linejoin="round"/>',
  sparkle: '<path d="M8 1.5l1.6 4.9L14.5 8l-4.9 1.6L8 14.5l-1.6-4.9L1.5 8l4.9-1.6z" fill="currentColor"/>',
  comment: '<path d="M2 3h12v8H6.5L3 14v-3H2z" fill="none" stroke="currentColor" stroke-linejoin="round"/>',
  check: '<path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  play: '<path d="M4.5 2.5l9 5.5-9 5.5z" fill="currentColor"/>',
  pause: '<path d="M4.5 3h2.5v10H4.5zM9 3h2.5v10H9z" fill="currentColor"/>',
  x: '<path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  question:
    '<circle cx="8" cy="8" r="6" fill="none" stroke="currentColor"/><path d="M6 6.5a2 2 0 1 1 2.8 1.8c-.5.3-.8.7-.8 1.2V10M8 12v.5" fill="none" stroke="currentColor" stroke-linecap="round"/>',
  warning:
    '<path d="M8 2l6.5 11.5h-13z" fill="none" stroke="currentColor" stroke-linejoin="round"/><path d="M8 6.5v3.5M8 12v.3" stroke="currentColor" stroke-linecap="round"/>',
  folder: '<path d="M1.5 3.5h4.5l1.5 1.5h7v8h-13z" fill="none" stroke="currentColor" stroke-linejoin="round"/>',
  chain:
    '<path d="M6.5 9.5l3-3M5.2 7.8L3.6 9.4a2.2 2.2 0 0 0 3 3L8.2 11M7.8 5l1.6-1.6a2.2 2.2 0 0 1 3 3L10.8 8" fill="none" stroke="currentColor" stroke-linecap="round"/>',
  chevron:
    '<path d="M6 3.5l4.5 4.5L6 12.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
  clock:
    '<circle cx="8" cy="8" r="6" fill="none" stroke="currentColor"/><path d="M8 4.5V8l2.5 1.5" fill="none" stroke="currentColor" stroke-linecap="round"/>',
  coins:
    '<ellipse cx="8" cy="4.5" rx="5" ry="2" fill="none" stroke="currentColor"/><path d="M3 4.5v7c0 1.1 2.2 2 5 2s5-.9 5-2v-7M3 8c0 1.1 2.2 2 5 2s5-.9 5-2" fill="none" stroke="currentColor"/>',
  graph: '<path d="M2 13.5h12M4 11V7.5M7.5 11V3.5M11 11V6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
  copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1" fill="none" stroke="currentColor"/><path d="M2.5 10.5v-8h8" fill="none" stroke="currentColor" stroke-linejoin="round"/>',
  refresh:
    '<path d="M13 8a5 5 0 1 1-1.6-3.7M13.5 2v3.2h-3.2" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/>',
  vm: '<rect x="1.5" y="2.5" width="13" height="9" rx="1.2" fill="none" stroke="currentColor"/><path d="M5 14h6" stroke="currentColor" stroke-linecap="round"/>',
  eye: '<path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" fill="none" stroke="currentColor" stroke-linejoin="round"/><circle cx="8" cy="8" r="2" fill="none" stroke="currentColor"/>',
  robot:
    '<rect x="2.5" y="5" width="11" height="8.5" rx="2" fill="none" stroke="currentColor"/><path d="M8 5V2.5M6.5 2.5h3" stroke="currentColor" stroke-linecap="round"/><circle cx="6" cy="9" r="1" fill="currentColor"/><circle cx="10" cy="9" r="1" fill="currentColor"/><path d="M6.5 11.5h3" stroke="currentColor" stroke-linecap="round"/>',
  zap: '<path d="M9 1.5L3.5 9H7.5L7 14.5 12.5 7H8.5z" fill="none" stroke="currentColor" stroke-linejoin="round"/>',
  message:
    '<path d="M2 4h12v7H9l-3 3v-3H2z" fill="none" stroke="currentColor" stroke-linejoin="round"/><path d="M5 7h6M5 9h4" stroke="currentColor" stroke-linecap="round"/>',
  layers: '<path d="M8 2l6 3-6 3-6-3zM2 8l6 3 6-3M2 11l6 3 6-3" fill="none" stroke="currentColor" stroke-linejoin="round"/>',
  filter: '<path d="M2 3h12l-4.5 5.5V13l-3 1V8.5z" fill="none" stroke="currentColor" stroke-linejoin="round"/>',
  dot: '<circle cx="8" cy="8" r="3" fill="currentColor"/>'
};

export function icon(name: string, cls = ''): string {
  const body = ICONS[name] ?? ICONS.tools;
  return `<svg class="ic${cls ? ` ${cls}` : ''}" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">${body}</svg>`;
}

export function toolIcon(name: string, cls = ''): string {
  const cat = toolCategory(name);
  return icon(TOOL_CATEGORIES[cat].icon, `tc-${cat}${cls ? ` ${cls}` : ''}`);
}

/* ------------------------------------------------------------------ CSS */

/**
 * Design tokens + generic components. Palette validated for CVD separation and
 * contrast on both the light and the dark VS Code themes; the dark block only
 * lightens the same hues.
 */
export function baseCss(): string {
  return `
* { box-sizing: border-box; }
:root {
  --c-run: #1f6fd0; --c-done: #1a7f37; --c-stall: #b7791f; --c-cancel: #6e7781; --c-err: #cf222e; --c-think: #8250df; --c-text: #1a7f37;
  --t-shell: #8250df; --t-file: #0e7490; --t-edit: #c2410c; --t-search: #1d4ed8; --t-web: #4f46e5; --t-agent: #be185d; --t-skill: #a16207; --t-plan: #0f766e; --t-output: #475569; --t-mcp: #7c3aed; --t-other: #6e7781;
  --seq-1: #b6d3f2; --seq-2: #8fbbea; --seq-3: #66a2e2; --seq-4: #3f88d9; --seq-5: #1f6fd0; --seq-6: #155aa8;
  --ty-0: #0e7490; --ty-1: #4f46e5; --ty-2: #1f6fd0; --ty-3: #be185d; --ty-4: #c2410c; --ty-5: #7c3aed; --ty-6: #0f766e; --ty-7: #a16207;
  --ink: var(--vscode-foreground);
  --ink-2: var(--vscode-descriptionForeground);
  --ink-3: color-mix(in srgb, var(--vscode-descriptionForeground) 70%, transparent);
  --surface: var(--vscode-editor-background);
  --card: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
  --card-2: color-mix(in srgb, var(--vscode-foreground) 5%, transparent);
  --grid: var(--vscode-panel-border, var(--vscode-widget-border, rgba(128,128,128,.25)));
  --focus: var(--vscode-focusBorder);
  --code-bg: var(--vscode-textCodeBlock-background);
  --mono: var(--vscode-editor-font-family, ui-monospace, Menlo, Consolas, monospace);
  --radius: 8px;
  --tint: 13%;
}
body.vscode-dark, body.vscode-high-contrast {
  --c-run: #4c9bef; --c-done: #3fb950; --c-stall: #e3b341; --c-cancel: #8b949e; --c-err: #f85149; --c-think: #a371f7; --c-text: #3fb950;
  --t-shell: #b48af5; --t-file: #22b8cf; --t-edit: #fb923c; --t-search: #60a5fa; --t-web: #818cf8; --t-agent: #f472b6; --t-skill: #facc15; --t-plan: #2dd4bf; --t-output: #94a3b8; --t-mcp: #c084fc; --t-other: #8b949e;
  --seq-1: #1f4b80; --seq-2: #2a64a8; --seq-3: #3a7fcf; --seq-4: #5b9ae3; --seq-5: #86b6ef; --seq-6: #b7d3f6;
  --ty-0: #22b8cf; --ty-1: #818cf8; --ty-2: #4c9bef; --ty-3: #f472b6; --ty-4: #fb923c; --ty-5: #c084fc; --ty-6: #2dd4bf; --ty-7: #facc15;
  --tint: 18%;
}
body {
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size, 13px);
  color: var(--ink);
  background: var(--surface);
  margin: 0;
  line-height: 1.4;
}
a { color: var(--vscode-textLink-foreground); }
.muted { color: var(--ink-2); }
.faint { color: var(--ink-3); }
.mono { font-family: var(--mono); }
.num { font-variant-numeric: tabular-nums; }
.ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* icons */
.ic { width: 1em; height: 1em; vertical-align: -0.15em; flex: none; }
.ic-lg { width: 1.25em; height: 1.25em; }
.tc-shell { color: var(--t-shell); } .tc-file { color: var(--t-file); } .tc-edit { color: var(--t-edit); }
.tc-search { color: var(--t-search); } .tc-web { color: var(--t-web); } .tc-agent { color: var(--t-agent); }
.tc-skill { color: var(--t-skill); } .tc-plan { color: var(--t-plan); } .tc-output { color: var(--t-output); }
.tc-mcp { color: var(--t-mcp); } .tc-other { color: var(--t-other); }

/* status colour hooks */
.st-run { color: var(--c-run); } .st-done { color: var(--c-done); } .st-stall { color: var(--c-stall); } .st-cancel { color: var(--c-cancel); } .st-err { color: var(--c-err); }
.bg-run { background: var(--c-run); } .bg-done { background: var(--c-done); } .bg-stall { background: var(--c-stall); } .bg-cancel { background: var(--c-cancel); } .bg-err { background: var(--c-err); }

/* pills: status with glyph + label, tinted background */
.pill {
  display: inline-flex; align-items: center; gap: 5px; padding: 1px 8px 1px 6px; border-radius: 999px;
  font-size: .72rem; font-weight: 600; letter-spacing: .01em; white-space: nowrap; line-height: 1.5;
  border: 1px solid transparent;
}
.pill-run { color: var(--c-run); background: color-mix(in srgb, var(--c-run) var(--tint), transparent); border-color: color-mix(in srgb, var(--c-run) 35%, transparent); }
.pill-done { color: var(--c-done); background: color-mix(in srgb, var(--c-done) var(--tint), transparent); border-color: color-mix(in srgb, var(--c-done) 35%, transparent); }
.pill-stall { color: var(--c-stall); background: color-mix(in srgb, var(--c-stall) var(--tint), transparent); border-color: color-mix(in srgb, var(--c-stall) 35%, transparent); }
.pill-cancel { color: var(--c-cancel); background: color-mix(in srgb, var(--c-cancel) var(--tint), transparent); border-color: color-mix(in srgb, var(--c-cancel) 35%, transparent); }
.pill-err { color: var(--c-err); background: color-mix(in srgb, var(--c-err) var(--tint), transparent); border-color: color-mix(in srgb, var(--c-err) 35%, transparent); }
.pill-neutral { color: var(--ink-2); background: var(--card-2); border-color: var(--grid); }

/* badges: agent type / phase / model */
.badge {
  display: inline-flex; align-items: center; gap: 4px; padding: 0 6px; border-radius: 4px;
  font-size: .68rem; font-weight: 600; letter-spacing: .02em; white-space: nowrap; line-height: 1.6;
  color: var(--tc, var(--ink-2)); background: color-mix(in srgb, var(--tc, var(--ink-2)) var(--tint), transparent);
}
.badge-outline { background: transparent; border: 1px solid color-mix(in srgb, var(--tc, var(--ink-2)) 40%, transparent); }
.type-0 { --tc: var(--ty-0); } .type-1 { --tc: var(--ty-1); } .type-2 { --tc: var(--ty-2); } .type-3 { --tc: var(--ty-3); }
.type-4 { --tc: var(--ty-4); } .type-5 { --tc: var(--ty-5); } .type-6 { --tc: var(--ty-6); } .type-7 { --tc: var(--ty-7); }

/* dots */
.dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; flex: none; }
.pulse { animation: pulse 1.4s ease-in-out infinite; }
@keyframes pulse { 0%,100% { opacity: 1; transform: scale(1); } 50% { opacity: .35; transform: scale(.7); } }
.spin { animation: spin 1.1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

/* activity strip: one cell per tool call, coloured by duration */
.strip { display: inline-flex; gap: 2px; align-items: flex-end; height: 12px; }
.cell { width: 5px; height: 10px; border-radius: 1.5px; flex: none; background: var(--seq-3); }
.cell-e { background: var(--c-err); height: 12px; }
.cell-p { background: transparent; border: 1px dashed var(--c-run); }
.cell-1 { background: var(--seq-1); } .cell-2 { background: var(--seq-2); } .cell-3 { background: var(--seq-3); }
.cell-4 { background: var(--seq-4); } .cell-5 { background: var(--seq-5); } .cell-6 { background: var(--seq-6); } .cell-0 { background: var(--seq-3); }

/* stacked status bar */
.stack { display: flex; height: 5px; border-radius: 3px; overflow: hidden; background: var(--card-2); }
.stack > span { display: block; height: 100%; }

/* buttons */
.btn {
  display: inline-flex; align-items: center; gap: 5px; padding: 3px 9px; border-radius: 5px; cursor: pointer;
  font-family: inherit; font-size: .76rem; line-height: 1.4; color: var(--ink);
  background: var(--vscode-button-secondaryBackground, var(--card-2)); border: 1px solid var(--grid);
}
.btn:hover { background: var(--vscode-button-secondaryHoverBackground, var(--card-2)); border-color: var(--focus); }
.btn-primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: transparent; }
.btn-primary:hover { background: var(--vscode-button-hoverBackground); }
.btn-ghost { background: transparent; border-color: transparent; color: var(--ink-2); padding: 2px 5px; }
.btn-ghost:hover { color: var(--ink); background: var(--card-2); border-color: transparent; }
.btn:focus-visible { outline: 1px solid var(--focus); outline-offset: 1px; }

/* segmented control */
.seg { display: inline-flex; border: 1px solid var(--grid); border-radius: 6px; overflow: hidden; background: var(--card-2); }
.seg button {
  font-family: inherit; font-size: .74rem; padding: 3px 9px; border: 0; background: transparent; color: var(--ink-2); cursor: pointer;
  display: inline-flex; align-items: center; gap: 5px; white-space: nowrap;
}
.seg button + button { border-left: 1px solid var(--grid); }
.seg button.on { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.seg button:hover:not(.on) { color: var(--ink); }
.seg .n { font-variant-numeric: tabular-nums; opacity: .8; }

/* inputs */
input.search, select.sel {
  font-family: inherit; font-size: .78rem; color: var(--vscode-input-foreground); background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border, var(--grid)); border-radius: 5px; padding: 4px 8px; outline: none; width: 100%;
}
input.search:focus, select.sel:focus { border-color: var(--focus); }
input.search::placeholder { color: var(--vscode-input-placeholderForeground); }

/* code */
code, .code { font-family: var(--mono); }
code { background: var(--code-bg); padding: 0 4px; border-radius: 3px; font-size: .9em; }
pre.code { background: var(--code-bg); padding: 8px 10px; border-radius: 6px; overflow: auto; white-space: pre-wrap; word-break: break-word; font-size: .8rem; margin: 0; max-height: 420px; }

/* tooltip (data-tip) */
#tip {
  position: fixed; z-index: 100; pointer-events: none; max-width: 360px; display: none; line-height: 1.45;
  background: var(--vscode-editorHoverWidget-background, var(--card)); color: var(--vscode-editorHoverWidget-foreground, var(--ink));
  border: 1px solid var(--vscode-editorHoverWidget-border, var(--grid)); border-radius: 6px; padding: 7px 10px; font-size: .74rem;
  box-shadow: 0 4px 16px rgba(0,0,0,.28);
}
#tip b { font-weight: 600; }
#tip .k { color: var(--ink-2); }

/* misc */
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
.hidden { display: none !important; }
`;
}

/* --------------------------------------------------------- client helpers */

/**
 * Helpers every webview script starts with. Plain JS, injected as a string.
 * Exposes: esc, dur, durShort, tok, clock, clockS, stamp, ago, shortLabel,
 * shortModel, icon, toolCat, toolIcon, prettyTool, typeSlot, typeBadge,
 * statusPill, stripHtml, stackHtml, bindTips, plus the STATE/TOOLCAT/BANDS maps.
 */
export function clientHelpersJs(): string {
  return `
const ICONS = ${JSON.stringify(ICONS)};
const STATE = ${JSON.stringify(STATUS)};
const TOOLCAT = ${JSON.stringify(TOOL_CATEGORIES)};
const TOOL_TO_CAT = ${JSON.stringify(TOOL_TO_CATEGORY)};
const TYPE_SLOTS = ${JSON.stringify(TYPE_SLOTS)};
const BANDS = {
  'p': ['cell-p', 'en curso'],
  '0': ['cell-0', 'duración desconocida'],
  '1': ['cell-1', 'menos de 1 s'],
  '2': ['cell-2', '1–5 s'],
  '3': ['cell-3', '5–15 s'],
  '4': ['cell-4', '15–60 s'],
  '5': ['cell-5', '1–5 min'],
  '6': ['cell-6', 'más de 5 min'],
  'e': ['cell-e', 'terminó con error']
};
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function dur(ms) {
  if (!ms || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ' + (s % 60) + 's';
  return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
}
function durShort(ms) {
  if (!ms || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm';
  return Math.floor(m / 60) + 'h' + (m % 60 ? ' ' + (m % 60) + 'm' : '');
}
function tok(n) {
  n = Number(n) || 0;
  if (n < 1000) return String(n);
  if (n < 1e6) return (n / 1000).toFixed(n < 1e4 ? 1 : 0) + 'k';
  return (n / 1e6).toFixed(1) + 'M';
}
function pad2(n) { return String(n).padStart(2, '0'); }
function clock(ts) { const d = new Date(ts); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }
function clockS(ts) { const d = new Date(ts); return clock(ts) + ':' + pad2(d.getSeconds()); }
function stamp(ts) { const d = new Date(ts); return pad2(d.getDate()) + '/' + pad2(d.getMonth() + 1) + ' ' + clock(ts); }
function ago(ts) {
  if (!ts) return '—';
  const d = Date.now() - ts;
  if (d < 10000) return 'ahora mismo';
  return 'hace ' + durShort(d);
}
function shortLabel(s, max) {
  s = String(s || '');
  const m = /\\s(#[0-9a-z]{2,6})$/i.exec(s);
  const id = m ? m[1] : '';
  const base = id ? s.slice(0, s.length - id.length - 1) : s;
  if (base.length + (id ? id.length + 1 : 0) <= max) return s;
  const room = Math.max(8, max - (id ? id.length + 2 : 1));
  return base.slice(0, room).trimEnd() + '…' + (id ? ' ' + id : '');
}
function shortModel(model) {
  if (!model) return '';
  const m = /^(?:[a-z]{2}\\.)?(?:anthropic\\.)?claude-([a-z]+)-(\\d+(?:-\\d+)*)(?:-\\d{8})?(?:-v\\d+(?::\\d+)?)?$/i.exec(String(model).trim());
  if (!m) return model.length > 22 ? model.slice(0, 21) + '…' : model;
  return m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase() + ' ' + m[2].replace(/-/g, '.');
}
function icon(name, cls) {
  const body = ICONS[name] || ICONS.tools;
  return '<svg class="ic' + (cls ? ' ' + cls : '') + '" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">' + body + '</svg>';
}
function toolCat(name) {
  name = String(name || '');
  if (name.startsWith('mcp__')) return 'mcp';
  return TOOL_TO_CAT[name] || 'other';
}
function toolIcon(name, cls) {
  const cat = toolCat(name);
  return icon(TOOLCAT[cat].icon, 'tc-' + cat + (cls ? ' ' + cls : ''));
}
function prettyTool(name) {
  name = String(name || '');
  const m = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(name);
  if (!m) return name;
  const server = m[1].replace(/^claude[-_]?(ai[-_]?|in[-_]?)?/i, '').replace(/[-_]+/g, ' ').trim() || m[1];
  return server + ': ' + m[2];
}
function typeSlot(t) {
  const key = String(t || '').toLowerCase();
  if (key in TYPE_SLOTS) return TYPE_SLOTS[key];
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return h % 8;
}
function typeBadge(t, extraCls) {
  return '<span class="badge type-' + typeSlot(t) + (extraCls ? ' ' + extraCls : '') + '" data-tip="<b>Tipo de subagente</b><br>' + esc(t) + '">' + esc(t) + '</span>';
}
function statusPill(status, extra) {
  const st = STATE[status] || STATE.unknown;
  return '<span class="pill pill-' + st.cls + '" data-tip="<b>' + st.label + '</b><br>' + esc(st.hint) + '">' + icon(st.icon) + st.label + (extra ? ' <span class="faint">· ' + esc(extra) + '</span>' : '') + '</span>';
}
function stripHtml(strip) {
  if (!strip) return '';
  return '<span class="strip">' + Array.from(strip).map((c) => {
    const b = BANDS[c] || BANDS['0'];
    return '<span class="cell ' + b[0] + '" data-tip="' + esc(b[1]) + '"></span>';
  }).join('') + '</span>';
}
function stackHtml(counts) {
  const total = (counts.running || 0) + (counts.completed || 0) + (counts.stalled || 0) + (counts.cancelled || 0);
  if (!total) return '<div class="stack"></div>';
  const seg = (n, cls, label) => n ? '<span class="bg-' + cls + '" style="width:' + (n / total * 100) + '%" data-tip="' + n + ' ' + label + '"></span>' : '';
  return '<div class="stack">' + seg(counts.running, 'run', 'ejecutando') + seg(counts.completed, 'done', 'completados') + seg(counts.stalled, 'stall', 'detenidos') + seg(counts.cancelled, 'cancel', 'cancelados') + '</div>';
}
function bindTips() {
  let tip = document.getElementById('tip');
  if (!tip) { tip = document.createElement('div'); tip.id = 'tip'; document.body.appendChild(tip); }
  document.addEventListener('mousemove', (e) => {
    const host = e.target && e.target.closest ? e.target.closest('[data-tip]') : null;
    if (!host) { tip.style.display = 'none'; return; }
    tip.innerHTML = host.getAttribute('data-tip');
    tip.style.display = 'block';
    const box = tip.getBoundingClientRect();
    let x = e.clientX + 14, y = e.clientY + 16;
    if (x + box.width > window.innerWidth - 8) x = Math.max(4, e.clientX - box.width - 14);
    if (y + box.height > window.innerHeight - 8) y = Math.max(4, e.clientY - box.height - 16);
    tip.style.left = x + 'px'; tip.style.top = y + 'px';
  });
  document.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
}
`;
}
