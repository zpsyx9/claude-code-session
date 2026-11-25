import * as vscode from 'vscode';
import { spawn } from 'child_process';
import { SessionManager } from './sessionManager';
import { Panel } from './panel';
import { normPath } from './session/claudeEnvironment';

const TOKEN_WINDOW_HOURS = 24;
const CLAUDE_UPDATE_KEY = 'lastClaudeUpdate';
// Each VS Code window activates the extension; this stops parallel updates when several open at once.
const CLAUDE_UPDATE_MIN_GAP_MS = 60 * 60 * 1000;

function updateClaudeCli(context: vscode.ExtensionContext): void {
  if (!vscode.workspace.getConfiguration('claudeCodeSession').get<boolean>('updateClaudeOnStartup', true)) { return; }
  const last = context.globalState.get<number>(CLAUDE_UPDATE_KEY, 0);
  if (Date.now() - last < CLAUDE_UPDATE_MIN_GAP_MS) { return; }
  void context.globalState.update(CLAUDE_UPDATE_KEY, Date.now());

  const out = vscode.window.createOutputChannel('Claude Code Session');
  context.subscriptions.push(out);
  out.appendLine(`[${new Date().toLocaleString()}] claude update`);
  try {
    // shell on Windows so an npm-installed claude.cmd also resolves.
    const child = spawn('claude', ['update'], { shell: process.platform === 'win32', windowsHide: true });
    child.stdout.on('data', d => out.append(String(d)));
    child.stderr.on('data', d => out.append(String(d)));
    child.on('error', err => out.appendLine(`claude update failed to start: ${err.message}`));
    child.on('close', code => {
      out.appendLine(`claude update exited with code ${code}`);
      if (code !== 0) {
        vscode.window.showWarningMessage('claude update failed. See Output -> Claude Code Session.');
      }
    });
  } catch (err) {
    out.appendLine(`claude update failed to start: ${(err as Error).message}`);
  }
}

let sessionManager: SessionManager | undefined;
let panel: Panel | undefined;

export function activate(context: vscode.ExtensionContext) {
  panel = Panel.createProvider(context);
  updateClaudeCli(context);

  // Each VS Code window runs its own extension host, so scoping the manager
  // to this window's workspace folders makes each window track its own project.
  const onSessions = (sessions: Parameters<Panel['sendSessions']>[0]) => {
    panel!.sendSessions(sessions);
  };
  const workspaceRoots = () =>
    (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);

  sessionManager = new SessionManager(onSessions, workspaceRoots());

  // Register sidebar webview provider
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('claude-code-session.sidebar', panel, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  // Keep the command for opening as an editor panel
  context.subscriptions.push(
    vscode.commands.registerCommand('claude-code-session.open', () => {
      panel!.openAsPanel();
    })
  );

  const usageTick = () => {
    panel!.sendUsage(sessionManager!.computeUsageFromLogs());
  };
  usageTick();
  const usageTimer = setInterval(usageTick, 60_000);

  // Downloaded SKILL.md files get a "Source: <url>" CodeLens on line 1; the files themselves are
  // left untouched because plugin updates overwrite the cache.
  const skillSourceUrls = new Map<string, string>();
  const skillLensChanged = new vscode.EventEmitter<void>();
  context.subscriptions.push(
    skillLensChanged,
    vscode.languages.registerCodeLensProvider({ scheme: 'file', pattern: '**/SKILL.md' }, {
      onDidChangeCodeLenses: skillLensChanged.event,
      provideCodeLenses(doc) {
        const url = skillSourceUrls.get(normPath(doc.uri.fsPath));
        if (!url) { return []; }
        return [new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), {
          title: `Source: ${url}`,
          tooltip: 'Open the source in the browser',
          command: 'vscode.open',
          arguments: [vscode.Uri.parse(url)],
        })];
      },
    })
  );

  const envTick = () => {
    const skills = sessionManager!.getSkills(workspaceRoots()[0]);
    const before = JSON.stringify([...skillSourceUrls]);
    skillSourceUrls.clear();
    for (const s of skills) {
      if (s.sourceUrl) { skillSourceUrls.set(normPath(s.path), s.sourceUrl); }
    }
    if (JSON.stringify([...skillSourceUrls]) !== before) { skillLensChanged.fire(); }
    panel!.sendEnvData({
      recentFiles:    sessionManager!.getRecentFiles(),
      mcpServers:     sessionManager!.getMcpServers(),
      recentSessions: sessionManager!.getRecentSessions(),
      skills,
      clis:           sessionManager!.getInstalledClis(),
    });
    panel!.sendProjectInfo();
  };
  envTick();
  const envTimer = setInterval(envTick, 10_000);

  // Scan JSONL for the last 24h of token events every 30s
  const tokenTick = () => {
    panel!.sendTokenActivity(
      sessionManager!.getTokenActivity(TOKEN_WINDOW_HOURS),
      TOKEN_WINDOW_HOURS
    );
  };
  tokenTick();
  const tokenTimer = setInterval(tokenTick, 30_000);

  // Fresh data on sidebar open
  panel.onReady(() => { usageTick(); envTick(); tokenTick(); });

  // Folders added/removed in this window → rebuild the manager with the new scope
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      sessionManager?.dispose();
      sessionManager = new SessionManager(onSessions, workspaceRoots());
      envTick();
      tokenTick();
    })
  );

  // Manual refresh from the webview
  panel.onRefreshTokenActivity(() => tokenTick());

  context.subscriptions.push({
    dispose: () => {
      clearInterval(usageTimer);
      clearInterval(envTimer);
      clearInterval(tokenTimer);
      sessionManager?.dispose();
      panel?.dispose();
    },
  });
}

export function deactivate() {
  sessionManager?.dispose();
  panel?.dispose();
}
