import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

const SECTION = 'claudeSubagents';

function cfg() {
  return vscode.workspace.getConfiguration(SECTION);
}

export function claudeHome(): string {
  const override = cfg().get<string>('claudeHome', '').trim();
  if (override) {
    return override;
  }
  const env = process.env.CLAUDE_CONFIG_DIR;
  if (env && env.trim()) {
    return env.trim();
  }
  return path.join(os.homedir(), '.claude');
}

export function projectsDir(): string {
  return path.join(claudeHome(), 'projects');
}

export function sessionsDir(): string {
  return path.join(claudeHome(), 'sessions');
}

export const settings = {
  refreshIntervalMs: () => Math.max(500, cfg().get<number>('refreshIntervalMs', 2000)),
  onlyCurrentWorkspace: () => cfg().get<boolean>('onlyCurrentWorkspace', true),
  onlyActive: () => cfg().get<boolean>('onlyActive', false),
  maxSessions: () => Math.max(1, cfg().get<number>('maxSessions', 25)),
  sessionMaxAgeDays: () => Math.max(0, cfg().get<number>('sessionMaxAgeDays', 14)),
  runningThresholdSeconds: () => Math.max(5, cfg().get<number>('runningThresholdSeconds', 90)),
  maxEvents: () => Math.max(20, cfg().get<number>('maxEvents', 500)),
  treeActivityItems: () => Math.max(0, cfg().get<number>('treeActivityItems', 12)),
  showThinking: () => cfg().get<boolean>('showThinking', true),
  notifyOnFinish: () => cfg().get<boolean>('notifyOnFinish', false)
};

export async function updateSetting(key: string, value: unknown): Promise<void> {
  await cfg().update(key, value, vscode.ConfigurationTarget.Global);
}

/** Case-insensitive path containment, tolerant of Windows separators. */
export function isInsideAny(target: string | undefined, roots: string[]): boolean {
  if (!target || roots.length === 0) {
    return false;
  }
  const norm = (p: string) => path.resolve(p).replace(/[\/]+$/, '').toLowerCase();
  const t = norm(target);
  return roots.some((r) => {
    const root = norm(r);
    return t === root || t.startsWith(root + path.sep.toLowerCase()) || t.startsWith(root + '/');
  });
}

export function workspaceRoots(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
}
