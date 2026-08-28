import * as fs from 'fs';
import { StringDecoder } from 'string_decoder';
import { AgentEvent, AgentSnapshot } from './model';

const MAX_TAIL_BYTES = 8 * 1024 * 1024;
const HUGE_FILE_BYTES = 40 * 1024 * 1024;
const MAX_LINE_BYTES = 6 * 1024 * 1024;
const MAX_TEXT = 20000;
const MAX_RESULT = 12000;

type ToolEvent = Extract<AgentEvent, { kind: 'tool' }>;

interface FileState {
  offset: number;
  decoder: StringDecoder;
  partial: string;
  snap: AgentSnapshot;
  pendingTools: Map<string, ToolEvent>;
}

function emptySnapshot(): AgentSnapshot {
  return {
    messages: 0,
    toolCalls: 0,
    toolErrors: 0,
    tokensIn: 0,
    tokensOut: 0,
    tokensCacheRead: 0,
    finished: false,
    events: [],
    truncated: false
  };
}

function clip(value: unknown, max: number): string {
  const s = typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? '';
  if (s.length <= max) {
    return s;
  }
  return s.slice(0, max) + `\n… (+${s.length - max} caracteres)`;
}

function firstLine(s: string, max = 160): string {
  const line = s.replace(/\s+/g, ' ').trim();
  return line.length > max ? line.slice(0, max - 1) + '…' : line;
}

/** Human one-liner describing what a tool call is doing. */
export function summarizeTool(name: string, input: Record<string, unknown> | undefined): string {
  const i = input ?? {};
  const str = (k: string): string | undefined => (typeof i[k] === 'string' ? (i[k] as string) : undefined);
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return firstLine(str('description') || str('command') || '');
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return firstLine(str('file_path') || '');
    case 'Grep':
      return firstLine(`${str('pattern') ?? ''}${str('path') ? ` en ${str('path')}` : ''}`);
    case 'Glob':
      return firstLine(str('pattern') || '');
    case 'Agent':
    case 'Task':
      return firstLine(`${str('subagent_type') ?? ''} — ${str('description') ?? ''}`);
    case 'WebFetch':
      return firstLine(str('url') || '');
    case 'WebSearch':
      return firstLine(str('query') || '');
    case 'Skill':
      return firstLine(str('skill') || '');
    case 'TaskCreate':
    case 'TaskUpdate':
      return firstLine(str('title') || str('taskId') || '');
    case 'StructuredOutput':
      return 'resultado estructurado';
    default: {
      const keys = Object.keys(i);
      if (keys.length === 0) {
        return '';
      }
      return firstLine(keys.map((k) => `${k}=${String(i[k])}`).join(' '), 140);
    }
  }
}

function pushEvent(snap: AgentSnapshot, ev: AgentEvent, maxEvents: number): void {
  snap.events.push(ev);
  if (snap.events.length > maxEvents) {
    snap.events.splice(0, snap.events.length - maxEvents);
    snap.truncated = true;
  }
}

function ingest(rec: any, state: FileState, maxEvents: number): void {
  const snap = state.snap;
  const at = rec?.timestamp ? Date.parse(rec.timestamp) : 0;
  if (at) {
    if (!snap.firstTimestamp) {
      snap.firstTimestamp = at;
    }
    snap.lastTimestamp = at;
  }
  if (!snap.cwd && typeof rec?.cwd === 'string') {
    snap.cwd = rec.cwd;
  }
  if (!snap.sessionId && typeof rec?.sessionId === 'string') {
    snap.sessionId = rec.sessionId;
  }
  if (!snap.slug && typeof rec?.slug === 'string') {
    snap.slug = rec.slug;
  }

  const msg = rec?.message;
  if (!msg) {
    return;
  }

  if (rec.type === 'user') {
    const content = msg.content;
    if (typeof content === 'string') {
      if (!snap.prompt) {
        snap.prompt = clip(content, MAX_TEXT);
        pushEvent(snap, { kind: 'prompt', at, text: snap.prompt }, maxEvents);
      }
      return;
    }
    if (!Array.isArray(content)) {
      return;
    }
    for (const block of content) {
      if (block?.type === 'tool_result') {
        const pending = state.pendingTools.get(block.tool_use_id);
        let text = '';
        if (typeof block.content === 'string') {
          text = block.content;
        } else if (Array.isArray(block.content)) {
          text = block.content
            .map((b: any) => (b?.type === 'text' ? b.text : `[${b?.type ?? 'bloque'}]`))
            .join('\n');
        }
        if (pending) {
          pending.result = clip(text, MAX_RESULT);
          pending.isError = block.is_error === true;
          if (pending.isError) {
            snap.toolErrors++;
          }
          pending.endedAt = at;
          state.pendingTools.delete(block.tool_use_id);
          if (state.pendingTools.size === 0) {
            snap.currentTool = undefined;
          }
        }
      } else if (block?.type === 'text' && !snap.prompt) {
        snap.prompt = clip(block.text, MAX_TEXT);
        pushEvent(snap, { kind: 'prompt', at, text: snap.prompt }, maxEvents);
      }
    }
    return;
  }

  if (rec.type !== 'assistant') {
    return;
  }

  snap.messages++;
  if (typeof msg.model === 'string') {
    snap.model = msg.model;
  }
  const usage = msg.usage;
  if (usage) {
    snap.tokensIn += Number(usage.input_tokens ?? 0) + Number(usage.cache_creation_input_tokens ?? 0);
    snap.tokensCacheRead += Number(usage.cache_read_input_tokens ?? 0);
    snap.tokensOut += Number(usage.output_tokens ?? 0);
  }

  const content = Array.isArray(msg.content) ? msg.content : [];
  let sawTool = false;
  let lastText: string | undefined;

  for (const block of content) {
    if (block?.type === 'thinking') {
      const text = clip(block.thinking ?? block.text ?? '', MAX_TEXT);
      if (text) {
        pushEvent(snap, { kind: 'thinking', at, text }, maxEvents);
      }
    } else if (block?.type === 'text') {
      const text = clip(block.text ?? '', MAX_TEXT);
      if (text.trim()) {
        lastText = text;
        pushEvent(snap, { kind: 'text', at, text }, maxEvents);
      }
    } else if (block?.type === 'tool_use') {
      sawTool = true;
      snap.toolCalls++;
      const summary = summarizeTool(block.name, block.input);
      const ev: ToolEvent = {
        kind: 'tool',
        at,
        id: String(block.id ?? ''),
        name: String(block.name ?? 'tool'),
        summary,
        input: clip(block.input, MAX_TEXT)
      };
      pushEvent(snap, ev, maxEvents);
      state.pendingTools.set(ev.id, ev);
      snap.currentTool = { name: ev.name, summary, at };
    }
  }

  if (sawTool) {
    snap.finished = false;
  } else if (lastText !== undefined) {
    snap.finalText = lastText;
    snap.finished = msg.stop_reason === 'end_turn' || msg.stop_reason === 'stop_sequence';
    snap.currentTool = undefined;
  }
}

/**
 * Reads Claude Code JSONL transcripts incrementally: the first call parses the
 * whole file, later calls only parse the bytes appended since.
 */
export class TranscriptStore {
  private states = new Map<string, FileState>();

  read(file: string, maxEvents: number): AgentSnapshot | undefined {
    let size: number;
    try {
      size = fs.statSync(file).size;
    } catch {
      this.states.delete(file);
      return undefined;
    }

    let state = this.states.get(file);
    if (!state || state.offset > size) {
      state = {
        offset: 0,
        decoder: new StringDecoder('utf8'),
        partial: '',
        snap: emptySnapshot(),
        pendingTools: new Map()
      };
      this.states.set(file, state);
      if (size > HUGE_FILE_BYTES) {
        state.offset = size - MAX_TAIL_BYTES;
        state.snap.truncated = true;
      }
    }

    if (size > state.offset) {
      const length = size - state.offset;
      const buffer = Buffer.allocUnsafe(length);
      let read = 0;
      let fd: number | undefined;
      const startedAtOffset = state.offset;
      try {
        fd = fs.openSync(file, 'r');
        read = fs.readSync(fd, buffer, 0, length, state.offset);
      } catch {
        return state.snap;
      } finally {
        if (fd !== undefined) {
          try {
            fs.closeSync(fd);
          } catch {
            /* ignore */
          }
        }
      }
      state.offset += read;

      let chunk = state.decoder.write(buffer.subarray(0, read));
      // Only when we skipped ahead on a huge file does the first line start mid-record.
      if (startedAtOffset > 0 && state.snap.events.length === 0 && state.snap.truncated) {
        const nl = chunk.indexOf('\n');
        chunk = nl >= 0 ? chunk.slice(nl + 1) : '';
      }
      const text = state.partial + chunk;
      const lines = text.split('\n');
      state.partial = lines.pop() ?? '';

      for (const line of lines) {
        if (!line || line.length > MAX_LINE_BYTES) {
          continue;
        }
        const trimmed = line.trimEnd();
        if (!trimmed.startsWith('{')) {
          continue;
        }
        let rec: any;
        try {
          rec = JSON.parse(trimmed);
        } catch {
          continue;
        }
        try {
          ingest(rec, state, maxEvents);
        } catch {
          /* a malformed record must never break the view */
        }
      }
    }

    return state.snap;
  }

  prune(keep: Set<string>): void {
    for (const key of [...this.states.keys()]) {
      if (!keep.has(key)) {
        this.states.delete(key);
      }
    }
  }
}
