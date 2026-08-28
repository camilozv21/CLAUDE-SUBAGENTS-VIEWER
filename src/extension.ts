import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { isInsideAny, projectsDir, settings, updateSetting, workspaceRoots } from './config';
import { Dashboard } from './dashboard';
import { DetailPanels } from './detailPanel';
import { AgentInfo, SessionInfo } from './model';
import { Scanner } from './scanner';
import { SidebarView } from './sidebar';

let scanner: Scanner;
let sidebar: SidebarView;
let panels: DetailPanels;
let dashboard: Dashboard;
let statusBar: vscode.StatusBarItem;
let timer: NodeJS.Timeout | undefined;
let watcher: fs.FSWatcher | undefined;
let debounce: NodeJS.Timeout | undefined;
let output: vscode.OutputChannel;
let sessions: SessionInfo[] = [];
let lastRunning = new Set<string>();

/* --------------------------------------------------------------- helpers */

function allAgents(): AgentInfo[] {
  return sessions.flatMap((s) => s.agents);
}

function findAgent(transcriptPath: string): AgentInfo | undefined {
  return allAgents().find((a) => a.transcriptPath === transcriptPath);
}

function agentFromArg(arg: unknown): AgentInfo | undefined {
  if (typeof arg === 'string') {
    return findAgent(arg);
  }
  if (arg && typeof arg === 'object' && 'transcriptPath' in (arg as AgentInfo)) {
    return findAgent((arg as AgentInfo).transcriptPath) ?? (arg as AgentInfo);
  }
  return undefined;
}

/** Sessions inside the open workspace when the scope setting asks for it. */
function scopedSessions(): SessionInfo[] {
  const roots = workspaceRoots();
  if (!settings.onlyCurrentWorkspace() || roots.length === 0) {
    return sessions;
  }
  return sessions.filter((s) => isInsideAny(s.cwd, roots));
}

async function openTranscript(agent: AgentInfo): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(agent.transcriptPath));
  await vscode.window.showTextDocument(doc, { preview: true });
}

async function copyPrompt(agent: AgentInfo): Promise<void> {
  if (!agent.snapshot.prompt) {
    void vscode.window.showWarningMessage('Este subagente no tiene un prompt registrado.');
    return;
  }
  await vscode.env.clipboard.writeText(agent.snapshot.prompt);
  void vscode.window.setStatusBarMessage('$(check) Prompt del subagente copiado', 2500);
}

async function copyReport(agent: AgentInfo): Promise<void> {
  if (!agent.snapshot.finalText) {
    void vscode.window.showWarningMessage('Este subagente todavía no tiene informe final.');
    return;
  }
  await vscode.env.clipboard.writeText(agent.snapshot.finalText);
  void vscode.window.setStatusBarMessage('$(check) Informe final copiado', 2500);
}

async function revealFolder(dir: string): Promise<void> {
  await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(dir));
}

async function setScope(scope: 'workspace' | 'all'): Promise<void> {
  await updateSetting('onlyCurrentWorkspace', scope === 'workspace');
  refresh(true);
}

/* ------------------------------------------------------------ status bar */

function updateStatusBar(): void {
  const scoped = scopedSessions();
  const running = scoped.reduce((n, s) => n + s.agents.filter((a) => a.status === 'running').length, 0);
  const total = scoped.reduce((n, s) => n + s.agents.length, 0);
  const errors = scoped.reduce((n, s) => n + s.agents.reduce((m, a) => m + a.snapshot.toolErrors, 0), 0);
  if (running > 0) {
    statusBar.text = `$(sync~spin) ${running} subagente${running === 1 ? '' : 's'}`;
    statusBar.tooltip = new vscode.MarkdownString(
      `**Claude Code** · ${running} subagente${running === 1 ? '' : 's'} trabajando ahora\n\n${total} registrados${
        errors ? ` · ${errors} herramientas con error` : ''
      }\n\nClic para abrir el panel gráfico.`
    );
    statusBar.show();
  } else if (total > 0) {
    statusBar.text = `$(robot) ${total}`;
    statusBar.tooltip = new vscode.MarkdownString(
      `**Claude Code** · ${total} subagentes registrados, ninguno activo.\n\nClic para abrir el panel gráfico.`
    );
    statusBar.show();
  } else {
    statusBar.hide();
  }
}

function notifyFinished(): void {
  const nowRunning = new Set<string>();
  for (const agent of allAgents()) {
    if (agent.status === 'running') {
      nowRunning.add(agent.transcriptPath);
    }
  }
  if (settings.notifyOnFinish()) {
    const finished = allAgents().filter((a) => a.status === 'completed' && lastRunning.has(a.transcriptPath));
    for (const agent of finished) {
      void vscode.window
        .showInformationMessage(`Subagente terminado: ${agent.description}`, 'Ver detalle')
        .then((choice) => {
          if (choice) {
            panels.show(agent);
          }
        });
    }
  }
  lastRunning = nowRunning;
}

/* --------------------------------------------------------------- refresh */

function refresh(force = false): void {
  try {
    sessions = scanner.scan();
    sidebar.update(sessions, force);
    dashboard.update(scopedSessions(), force);
    panels.refresh(allAgents());
    updateStatusBar();
    notifyFinished();
  } catch (error) {
    output.appendLine(`[scan] ${String(error)}`);
  }
}

function scheduleRefresh(delay = 250): void {
  if (debounce) {
    clearTimeout(debounce);
  }
  debounce = setTimeout(() => refresh(), delay);
}

function restartTimer(): void {
  if (timer) {
    clearInterval(timer);
  }
  timer = setInterval(() => refresh(), settings.refreshIntervalMs());
}

function startWatcher(): void {
  watcher?.close();
  watcher = undefined;
  const root = projectsDir();
  if (!fs.existsSync(root)) {
    output.appendLine(`[watch] no existe ${root}`);
    return;
  }
  try {
    watcher = fs.watch(root, { recursive: true, persistent: false }, (_event, filename) => {
      const name = filename ? String(filename) : '';
      if (!name || !/subagents[\\/]/.test(name)) {
        return;
      }
      scheduleRefresh();
    });
    watcher.on('error', (error) => output.appendLine(`[watch] ${String(error)}`));
  } catch (error) {
    output.appendLine(`[watch] no se pudo observar ${root}: ${String(error)}`);
  }
}

/* -------------------------------------------------------------- activate */

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('Claude Subagents');
  scanner = new Scanner();

  panels = new DetailPanels(context, {
    openTranscript: (agent) => void openTranscript(agent),
    copyPrompt: (agent) => void copyPrompt(agent),
    copyReport: (agent) => void copyReport(agent),
    revealFolder: (agent) => void revealFolder(path.dirname(agent.transcriptPath))
  });

  dashboard = new Dashboard(context, (transcriptPath) => {
    const agent = findAgent(transcriptPath);
    if (agent) {
      panels.show(agent);
    }
  });

  sidebar = new SidebarView(context, {
    openAgent: (id) => {
      const agent = findAgent(id);
      if (agent) {
        panels.show(agent);
      }
    },
    openTranscript: (id) => {
      const agent = findAgent(id);
      if (agent) {
        void openTranscript(agent);
      }
    },
    copyPrompt: (id) => {
      const agent = findAgent(id);
      if (agent) {
        void copyPrompt(agent);
      }
    },
    copyReport: (id) => {
      const agent = findAgent(id);
      if (agent) {
        void copyReport(agent);
      }
    },
    revealSession: (dir) => void revealFolder(dir),
    openDashboard: (focus) => dashboard.show(scopedSessions(), focus),
    setScope: (scope) => void setScope(scope),
    refresh: () => refresh(true),
    openSettings: () => void vscode.commands.executeCommand('workbench.action.openSettings', 'claudeSubagents')
  });

  context.subscriptions.push(
    output,
    vscode.window.registerWebviewViewProvider(SidebarView.viewType, sidebar, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'claudeSubagents.openDashboard';
  statusBar.name = 'Claude Subagents';
  context.subscriptions.push(statusBar);

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeSubagents.refresh', () => refresh(true)),
    vscode.commands.registerCommand('claudeSubagents.openDashboard', () => dashboard.show(scopedSessions())),
    vscode.commands.registerCommand('claudeSubagents.focus', () =>
      vscode.commands.executeCommand('claudeSubagents.panel.focus')
    ),
    vscode.commands.registerCommand('claudeSubagents.openDetail', (arg: unknown) => {
      const agent = agentFromArg(arg);
      if (agent) {
        panels.show(agent);
      }
    }),
    vscode.commands.registerCommand('claudeSubagents.openTranscript', (arg: unknown) => {
      const agent = agentFromArg(arg);
      if (agent) {
        void openTranscript(agent);
      }
    }),
    vscode.commands.registerCommand('claudeSubagents.copyPrompt', (arg: unknown) => {
      const agent = agentFromArg(arg);
      if (agent) {
        void copyPrompt(agent);
      }
    }),
    vscode.commands.registerCommand('claudeSubagents.copyReport', (arg: unknown) => {
      const agent = agentFromArg(arg);
      if (agent) {
        void copyReport(agent);
      }
    }),
    vscode.commands.registerCommand('claudeSubagents.toggleWorkspaceOnly', () =>
      setScope(settings.onlyCurrentWorkspace() ? 'all' : 'workspace')
    ),
    vscode.commands.registerCommand('claudeSubagents.openSettings', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', 'claudeSubagents')
    )
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('claudeSubagents')) {
        return;
      }
      if (event.affectsConfiguration('claudeSubagents.refreshIntervalMs')) {
        restartTimer();
      }
      if (event.affectsConfiguration('claudeSubagents.claudeHome')) {
        startWatcher();
      }
      refresh(true);
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => refresh(true))
  );

  startWatcher();
  restartTimer();
  refresh(true);
}

export function deactivate(): void {
  if (timer) {
    clearInterval(timer);
  }
  if (debounce) {
    clearTimeout(debounce);
  }
  watcher?.close();
}
