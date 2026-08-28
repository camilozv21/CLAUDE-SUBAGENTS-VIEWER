export type AgentStatus = 'running' | 'completed' | 'stalled' | 'cancelled' | 'unknown';

/** One meaningful thing that happened inside a subagent's transcript. */
export type AgentEvent =
  | { kind: 'prompt'; at: number; text: string }
  | { kind: 'thinking'; at: number; text: string }
  | { kind: 'text'; at: number; text: string }
  | {
      kind: 'tool';
      at: number;
      id: string;
      name: string;
      /** One-line human summary of the tool input, e.g. the bash command. */
      summary: string;
      /** Full input, pretty-printed. */
      input: string;
      result?: string;
      isError?: boolean;
      endedAt?: number;
    };

/** Everything derived from parsing a subagent transcript. */
export interface AgentSnapshot {
  messages: number;
  toolCalls: number;
  /** Tool calls whose result came back flagged as an error. */
  toolErrors: number;
  tokensIn: number;
  tokensOut: number;
  tokensCacheRead: number;
  model?: string;
  cwd?: string;
  sessionId?: string;
  slug?: string;
  firstTimestamp?: number;
  lastTimestamp?: number;
  prompt?: string;
  finalText?: string;
  /** True when the last assistant turn was plain text with no pending tool call. */
  finished: boolean;
  currentTool?: { name: string; summary: string; at: number };
  events: AgentEvent[];
  truncated: boolean;
}

export interface AgentInfo {
  agentId: string;
  agentType: string;
  description: string;
  /** Short id shown when several agents in a group share the same description. */
  disambiguator?: string;
  toolUseId?: string;
  parentAgentId?: string;
  spawnDepth: number;
  /** The user pressed Escape / stop while this agent was working. */
  stoppedByUser: boolean;
  transcriptPath: string;
  sessionId: string;
  projectDirName: string;
  workflowId?: string;
  /** Label from the workflow journal, when the agent belongs to a workflow. */
  workflowLabel?: string;
  workflowPhase?: string;
  status: AgentStatus;
  startedAt: number;
  lastActivity: number;
  durationMs: number;
  snapshot: AgentSnapshot;
}

export interface WorkflowInfo {
  workflowId: string;
  name?: string;
  status?: string;
  agentCount?: number;
  durationMs?: number;
  phases?: { title: string; detail?: string }[];
  agents: AgentInfo[];
}

export interface SessionInfo {
  sessionId: string;
  projectDirName: string;
  sessionDir: string;
  transcriptPath: string;
  cwd?: string;
  slug?: string;
  live: boolean;
  liveStatus?: string;
  livePid?: number;
  liveName?: string;
  /** 'cli' | 'claude-vscode' | ... from the live session record. */
  entrypoint?: string;
  version?: string;
  startedAt?: number;
  lastActivity: number;
  agents: AgentInfo[];
  workflows: WorkflowInfo[];
}

export function statusLabel(s: AgentStatus): string {
  switch (s) {
    case 'running':
      return 'ejecutando';
    case 'completed':
      return 'completado';
    case 'stalled':
      return 'detenido';
    case 'cancelled':
      return 'cancelado';
    default:
      return 'desconocido';
  }
}

export function formatDuration(ms: number): string {
  if (!ms || ms < 0) {
    return '—';
  }
  const s = Math.round(ms / 1000);
  if (s < 60) {
    return `${s}s`;
  }
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) {
    return `${m}m ${rs}s`;
  }
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function formatTokens(n: number): string {
  if (n < 1000) {
    return String(n);
  }
  if (n < 1_000_000) {
    return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  }
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function formatAgo(ts: number): string {
  if (!ts) {
    return '—';
  }
  const d = Date.now() - ts;
  if (d < 15_000) {
    return 'ahora';
  }
  return `hace ${formatDuration(d)}`;
}

/** 'claude-opus-4-1-20250805' → 'Opus 4.1', 'claude-fable-5' → 'Fable 5'. */
export function shortModel(model: string | undefined): string {
  if (!model) {
    return '';
  }
  const m = /^(?:[a-z]{2}\.)?(?:anthropic\.)?claude-([a-z]+)-(\d+(?:-\d+)*)(?:-\d{8})?(?:-v\d+(?::\d+)?)?$/i.exec(model.trim());
  if (!m) {
    return model.length > 22 ? `${model.slice(0, 21)}…` : model;
  }
  const family = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
  return `${family} ${m[2].replace(/-/g, '.')}`;
}
