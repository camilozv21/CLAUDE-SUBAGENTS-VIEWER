import * as fs from 'fs';
import * as path from 'path';
import { projectsDir, sessionsDir, settings } from './config';
import { AgentInfo, AgentStatus, SessionInfo } from './model';
import { TranscriptStore } from './transcript';

export interface LiveSession {
  pid: number;
  sessionId: string;
  cwd?: string;
  status?: string;
  name?: string;
  kind?: string;
  entrypoint?: string;
  version?: string;
  startedAt?: number;
}

interface AgentMeta {
  agentType?: string;
  description?: string;
  toolUseId?: string;
  spawnDepth?: number;
  parentAgentId?: string;
  model?: string;
  stoppedByUser?: boolean;
  isFork?: boolean;
}

interface WorkflowJournalAgent {
  agentId?: string;
  label?: string;
  phaseTitle?: string;
  state?: string;
  model?: string;
  lastToolName?: string;
  promptPreview?: string;
  tokens?: number;
  toolCalls?: number;
  durationMs?: number;
}

interface WorkflowJournal {
  workflowName?: string;
  status?: string;
  agentCount?: number;
  durationMs?: number;
  phases?: { title: string; detail?: string }[];
  byAgentId: Map<string, WorkflowJournalAgent>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A readable one-liner for agents that carry no description or workflow label. */
function summarizePrompt(source: string): string {
  for (const raw of source.split('\n')) {
    const line = raw
      .replace(/^[#>*\-\s]+/, '')
      .replace(/[*`_]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (line.length < 4) {
      continue;
    }
    return line.length > 70 ? `${line.slice(0, 69)}…` : line;
  }
  return 'subagente';
}

/**
 * Workflow agents often share one long boilerplate prompt, so their derived
 * labels collide. Tag the collisions with a short id instead of showing a
 * column of identical rows.
 */
function disambiguate(agents: AgentInfo[]): void {
  const counts = new Map<string, number>();
  for (const agent of agents) {
    counts.set(agent.description, (counts.get(agent.description) ?? 0) + 1);
  }
  for (const agent of agents) {
    agent.disambiguator = (counts.get(agent.description) ?? 0) > 1 ? `#${agent.agentId.slice(1, 5)}` : undefined;
  }
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

function safeReaddir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function safeStat(file: string): fs.Stats | undefined {
  try {
    return fs.statSync(file);
  } catch {
    return undefined;
  }
}

/** Sessions currently owned by a running Claude Code process. */
export function readLiveSessions(): Map<string, LiveSession> {
  const out = new Map<string, LiveSession>();
  for (const entry of safeReaddir(sessionsDir())) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      continue;
    }
    const data = readJson<LiveSession>(path.join(sessionsDir(), entry.name));
    if (data?.sessionId) {
      const existing = out.get(data.sessionId);
      // Prefer the record that reports activity.
      if (!existing || data.status === 'busy') {
        out.set(data.sessionId, data);
      }
    }
  }
  return out;
}

export class Scanner {
  private store = new TranscriptStore();
  private journalCache = new Map<string, { mtimeMs: number; journal: WorkflowJournal }>();
  private agentCache = new Map<string, { mtimeMs: number; size: number; info: AgentInfo }>();

  scan(): SessionInfo[] {
    const root = projectsDir();
    const live = readLiveSessions();
    const maxAgeMs = settings.sessionMaxAgeDays() * 24 * 3600 * 1000;
    const now = Date.now();

    type Candidate = { projectDirName: string; sessionId: string; sessionDir: string; mtimeMs: number };
    const candidates: Candidate[] = [];

    for (const project of safeReaddir(root)) {
      if (!project.isDirectory()) {
        continue;
      }
      const projectPath = path.join(root, project.name);
      for (const entry of safeReaddir(projectPath)) {
        if (!entry.isDirectory() || !UUID_RE.test(entry.name)) {
          continue;
        }
        const sessionDir = path.join(projectPath, entry.name);
        const subagentsDir = path.join(sessionDir, 'subagents');
        const stat = safeStat(subagentsDir);
        if (!stat || !stat.isDirectory()) {
          continue;
        }
        const mtimeMs = Math.max(stat.mtimeMs, safeStat(sessionDir)?.mtimeMs ?? 0);
        if (maxAgeMs > 0 && now - mtimeMs > maxAgeMs && !live.has(entry.name)) {
          continue;
        }
        candidates.push({ projectDirName: project.name, sessionId: entry.name, sessionDir, mtimeMs });
      }
    }

    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const selected = candidates.slice(0, settings.maxSessions());

    const seenTranscripts = new Set<string>();
    const sessions: SessionInfo[] = [];

    for (const candidate of selected) {
      const session = this.buildSession(candidate.sessionDir, candidate.sessionId, candidate.projectDirName, live, seenTranscripts);
      if (session) {
        sessions.push(session);
      }
    }

    this.store.prune(seenTranscripts);
    for (const key of [...this.agentCache.keys()]) {
      if (!seenTranscripts.has(key)) {
        this.agentCache.delete(key);
      }
    }
    sessions.sort((a, b) => {
      const aRunning = a.agents.some((x) => x.status === 'running') ? 1 : 0;
      const bRunning = b.agents.some((x) => x.status === 'running') ? 1 : 0;
      if (aRunning !== bRunning) {
        return bRunning - aRunning;
      }
      return b.lastActivity - a.lastActivity;
    });
    return sessions;
  }

  private buildSession(
    sessionDir: string,
    sessionId: string,
    projectDirName: string,
    live: Map<string, LiveSession>,
    seenTranscripts: Set<string>
  ): SessionInfo | undefined {
    const subagentsDir = path.join(sessionDir, 'subagents');
    const liveInfo = live.get(sessionId);
    const maxEvents = settings.maxEvents();

    const session: SessionInfo = {
      sessionId,
      projectDirName,
      sessionDir,
      transcriptPath: `${sessionDir}.jsonl`,
      live: Boolean(liveInfo),
      liveStatus: liveInfo?.status,
      livePid: liveInfo?.pid,
      liveName: liveInfo?.name,
      entrypoint: liveInfo?.entrypoint,
      version: liveInfo?.version,
      startedAt: liveInfo?.startedAt,
      cwd: liveInfo?.cwd,
      lastActivity: 0,
      agents: [],
      workflows: []
    };

    const direct = this.collectAgents(subagentsDir, sessionId, projectDirName, undefined, undefined, maxEvents, seenTranscripts);
    session.agents.push(...direct);

    const workflowsDir = path.join(subagentsDir, 'workflows');
    for (const entry of safeReaddir(workflowsDir)) {
      if (!entry.isDirectory()) {
        continue;
      }
      const workflowId = entry.name;
      const journal = this.readJournal(path.join(sessionDir, 'workflows', `${workflowId}.json`));
      const agents = this.collectAgents(
        path.join(workflowsDir, workflowId),
        sessionId,
        projectDirName,
        workflowId,
        journal,
        maxEvents,
        seenTranscripts
      );
      if (agents.length === 0) {
        continue;
      }
      session.workflows.push({
        workflowId,
        name: journal?.workflowName,
        status: journal?.status,
        agentCount: journal?.agentCount ?? agents.length,
        durationMs: journal?.durationMs,
        phases: journal?.phases,
        agents
      });
      session.agents.push(...agents);
    }

    if (session.agents.length === 0) {
      return undefined;
    }

    for (const agent of session.agents) {
      session.lastActivity = Math.max(session.lastActivity, agent.lastActivity);
      if (!session.cwd && agent.snapshot.cwd) {
        session.cwd = agent.snapshot.cwd;
      }
      if (!session.slug && agent.snapshot.slug) {
        session.slug = agent.snapshot.slug;
      }
    }

    session.agents.sort((a, b) => b.lastActivity - a.lastActivity);
    session.workflows.sort((a, b) => {
      const aLast = Math.max(...a.agents.map((x) => x.lastActivity));
      const bLast = Math.max(...b.agents.map((x) => x.lastActivity));
      return bLast - aLast;
    });
    return session;
  }

  private collectAgents(
    dir: string,
    sessionId: string,
    projectDirName: string,
    workflowId: string | undefined,
    journal: WorkflowJournal | undefined,
    maxEvents: number,
    seenTranscripts: Set<string>
  ): AgentInfo[] {
    const agents: AgentInfo[] = [];
    for (const entry of safeReaddir(dir)) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl') || !entry.name.startsWith('agent-')) {
        continue;
      }
      const transcriptPath = path.join(dir, entry.name);
      const stat = safeStat(transcriptPath);
      if (!stat) {
        continue;
      }
      seenTranscripts.add(transcriptPath);

      // Nothing appended since the last scan: reuse the parsed agent, only the
      // clock-dependent status needs recomputing.
      const cached = this.agentCache.get(transcriptPath);
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
        cached.info.status = this.deriveStatus(
          cached.info.snapshot.finished,
          cached.info.lastActivity,
          journal?.byAgentId.get(cached.info.agentId)?.state,
          cached.info.stoppedByUser
        );
        agents.push(cached.info);
        continue;
      }

      const agentId = entry.name.replace(/^agent-/, '').replace(/\.jsonl$/, '');
      const meta = readJson<AgentMeta>(transcriptPath.replace(/\.jsonl$/, '.meta.json')) ?? {};
      const snapshot = this.store.read(transcriptPath, maxEvents);
      if (!snapshot) {
        continue;
      }
      if (!snapshot.model && meta.model) {
        snapshot.model = meta.model;
      }

      const journalAgent = journal?.byAgentId.get(agentId);
      const lastActivity = Math.max(stat.mtimeMs, snapshot.lastTimestamp ?? 0);
      const startedAt = snapshot.firstTimestamp ?? stat.birthtimeMs ?? lastActivity;

      const info: AgentInfo = {
        agentId,
        agentType: meta.agentType ?? (workflowId ? 'workflow-subagent' : 'agent'),
        description: this.describe(meta, journalAgent, snapshot.prompt),
        toolUseId: meta.toolUseId,
        parentAgentId: meta.parentAgentId,
        spawnDepth: meta.spawnDepth ?? 1,
        stoppedByUser: meta.stoppedByUser === true,
        transcriptPath,
        sessionId,
        projectDirName,
        workflowId,
        workflowLabel: journalAgent?.label,
        workflowPhase: journalAgent?.phaseTitle,
        status: this.deriveStatus(snapshot.finished, lastActivity, journalAgent?.state, meta.stoppedByUser === true),
        startedAt,
        lastActivity,
        durationMs: journalAgent?.durationMs ?? Math.max(0, lastActivity - startedAt),
        snapshot
      };
      this.agentCache.set(transcriptPath, { mtimeMs: stat.mtimeMs, size: stat.size, info });
      agents.push(info);
    }
    disambiguate(agents);
    return agents;
  }

  private describe(meta: AgentMeta, journalAgent: WorkflowJournalAgent | undefined, prompt: string | undefined): string {
    if (journalAgent?.label) {
      return journalAgent.label;
    }
    if (meta.description) {
      return meta.description;
    }
    return summarizePrompt(prompt ?? journalAgent?.promptPreview ?? '');
  }

  private deriveStatus(
    finished: boolean,
    lastActivity: number,
    journalState: string | undefined,
    stoppedByUser: boolean
  ): AgentStatus {
    const fresh = Date.now() - lastActivity <= settings.runningThresholdSeconds() * 1000;
    // Recent writes win over the journal: a resumed run reuses the runId, so the
    // journal on disk can still say "done" while the agent is working again.
    if (!finished && fresh) {
      return 'running';
    }
    if (stoppedByUser && !finished) {
      return 'cancelled';
    }
    if (finished || journalState === 'done' || journalState === 'error' || journalState === 'failed') {
      return 'completed';
    }
    return 'stalled';
  }

  private readJournal(file: string): WorkflowJournal | undefined {
    const stat = safeStat(file);
    if (!stat) {
      return undefined;
    }
    const cached = this.journalCache.get(file);
    if (cached && cached.mtimeMs === stat.mtimeMs) {
      return cached.journal;
    }
    const raw = readJson<any>(file);
    if (!raw) {
      return undefined;
    }
    const byAgentId = new Map<string, WorkflowJournalAgent>();
    const progress = Array.isArray(raw.workflowProgress) ? raw.workflowProgress : [];
    for (const item of progress) {
      if (item?.type === 'workflow_agent' && typeof item.agentId === 'string') {
        byAgentId.set(item.agentId, item as WorkflowJournalAgent);
      }
    }
    const journal: WorkflowJournal = {
      workflowName: raw.workflowName,
      status: raw.status,
      agentCount: raw.agentCount,
      durationMs: raw.durationMs,
      phases: Array.isArray(raw.phases) ? raw.phases : undefined,
      byAgentId
    };
    this.journalCache.set(file, { mtimeMs: stat.mtimeMs, journal });
    return journal;
  }
}
