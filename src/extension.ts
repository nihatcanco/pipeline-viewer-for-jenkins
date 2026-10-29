import * as vscode from 'vscode';
import { JenkinsClient, JenkinsJob, displayName, isFolder } from './jenkinsClient';
import { JobsProvider, Node, errorMessage } from './jobsProvider';
import { LOG_SCHEME, LogProvider } from './logProvider';
import { SECTION, numberSetting, settings } from './settings';
import { Status, statusFromColor, statusFromResult, statusLabel } from './status';

const CREDENTIALS_KEY = 'credentials';

/** The API token is stored with the server and user it was entered for, and is never sent anywhere else. */
interface Credentials {
  origin: string;
  username: string;
  token: string;
}

function originOf(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
}

async function storedToken(secrets: vscode.SecretStorage, url: string, username: string): Promise<string | undefined> {
  const origin = originOf(url);
  try {
    const saved = JSON.parse((await secrets.get(CREDENTIALS_KEY)) ?? 'null') as Credentials | null;
    if (origin && saved?.origin === origin && saved.username === username) {
      return saved.token;
    }
  } catch {
    // An unreadable entry is treated as no token.
  }
  return undefined;
}

/** Basic auth over plain http exposes the token to anyone on the network path, unless the server is this machine. */
function sendsTokenInClear(url: string): boolean {
  const parsed = new URL(url);
  return parsed.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
}

interface TrackedJob {
  fullName: string;
  url: string;
  status: Status;
  lastCompleted?: { number: number; result: string | null } | null;
}

function flatten(jobs: JenkinsJob[], prefix = ''): TrackedJob[] {
  return jobs.flatMap((job) => {
    const fullName = prefix + displayName(job);
    if (isFolder(job)) {
      return flatten(job.jobs ?? [], `${fullName} / `);
    }
    return [{ fullName, url: job.url, status: statusFromColor(job.color), lastCompleted: job.lastCompletedBuild }];
  });
}

class Controller implements vscode.Disposable {
  client?: JenkinsClient;
  readonly provider = new JobsProvider();
  private readonly statusBar = vscode.window.createStatusBarItem(`${SECTION}.status`, vscode.StatusBarAlignment.Left, 50);
  private timer?: NodeJS.Timeout;
  private refreshing = false;
  private refreshQueued = false;
  private previous?: Map<string, TrackedJob>;

  constructor(private readonly secrets: vscode.SecretStorage) {
    this.statusBar.name = 'Jenkins';
    this.statusBar.command = `${SECTION}.jobs.focus`;
  }

  async reconnect(): Promise<void> {
    const config = settings();
    const url = config.get<string>('url', '').trim();
    const username = config.get<string>('username', '').trim();
    const token = (await storedToken(this.secrets, url, username)) ?? '';

    this.client = url ? new JenkinsClient(url, username, token) : undefined;
    this.previous = undefined;
    await vscode.commands.executeCommand('setContext', `${SECTION}.configured`, !!this.client);
    this.provider.setClient(this.client);

    clearInterval(this.timer);
    this.timer = undefined;
    if (this.client) {
      // The upper bound keeps the delay below setInterval's 32-bit limit, past which Node fires every millisecond.
      const seconds = numberSetting('refreshInterval', 30, 5, 86_400);
      this.timer = setInterval(() => void this.refresh(), seconds * 1000);
    }
    await this.refresh();
  }

  async refresh(): Promise<void> {
    if (this.refreshing) {
      this.refreshQueued = true;
      return;
    }
    const client = this.client;
    if (!client) {
      this.statusBar.hide();
      return;
    }
    this.refreshing = true;
    try {
      const jobs = await client.getJobs();
      if (client === this.client) {
        this.provider.setJobs(jobs);
        const tracked = flatten(jobs);
        this.notifyFinishedBuilds(tracked);
        this.updateStatusBar(tracked);
      }
    } catch (err) {
      if (client === this.client) {
        this.provider.setError(errorMessage(err));
        this.statusBar.text = '$(warning) Jenkins';
        this.statusBar.tooltip = errorMessage(err);
        this.statusBar.show();
      }
    } finally {
      this.refreshing = false;
    }
    if (this.refreshQueued) {
      this.refreshQueued = false;
      await this.refresh();
    }
  }

  private notifyFinishedBuilds(tracked: TrackedJob[]): void {
    const previous = this.previous;
    this.previous = new Map(tracked.map((job) => [job.url, job]));
    const mode = settings().get<string>('notifications', 'failures');
    if (!previous || mode === 'off') {
      return;
    }
    for (const job of tracked) {
      const before = previous.get(job.url);
      const build = job.lastCompleted;
      // Only jobs we already knew about, whose latest completed build number moved on since the last poll.
      if (!before || !build || build.number === before.lastCompleted?.number) {
        continue;
      }
      const status = statusFromResult(build.result);
      const failed = status === 'failure' || status === 'unstable';
      if (mode === 'failures' && !failed) {
        continue;
      }
      void this.showBuildNotification(`${job.fullName} #${build.number} ${statusLabel(status)}`, status, `${job.url}${build.number}/`);
    }
  }

  private async showBuildNotification(message: string, status: Status, buildUrl: string): Promise<void> {
    const show =
      status === 'failure'
        ? vscode.window.showErrorMessage
        : status === 'unstable'
          ? vscode.window.showWarningMessage
          : vscode.window.showInformationMessage;
    const choice = await show(`Jenkins: ${message}`, 'Show Log', 'Open in Browser');
    if (choice === 'Show Log') {
      await openLog(message, buildUrl);
    } else if (choice === 'Open in Browser' && this.client) {
      await vscode.env.openExternal(vscode.Uri.parse(this.client.resolve(buildUrl)));
    }
  }

  private updateStatusBar(tracked: TrackedJob[]): void {
    const failing = tracked.filter((job) => job.status === 'failure');
    const running = tracked.filter((job) => job.status === 'running');
    const parts = ['Jenkins', failing.length ? `$(error) ${failing.length}` : '$(pass)'];
    if (running.length) {
      parts.push(`$(sync~spin) ${running.length}`);
    }
    this.statusBar.text = parts.join(' ');

    const tooltip = new vscode.MarkdownString(undefined, true);
    tooltip.appendMarkdown(`**Jenkins** — ${tracked.length} jobs\n\n`);
    for (const [title, jobs] of [
      ['Failing', failing],
      ['Running', running],
    ] as const) {
      if (jobs.length) {
        tooltip.appendMarkdown(`${title}:\n`);
        for (const job of jobs) {
          tooltip.appendText(`- ${job.fullName}\n`);
        }
        tooltip.appendMarkdown('\n');
      }
    }
    if (!failing.length && !running.length) {
      tooltip.appendMarkdown('All jobs are green or idle.');
    }
    this.statusBar.tooltip = tooltip;
    this.statusBar.show();
  }

  dispose(): void {
    clearInterval(this.timer);
    this.statusBar.dispose();
  }
}

let logs: LogProvider;

async function openLog(title: string, buildUrl: string): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(LogProvider.uri(title, buildUrl));
  const editor = await vscode.window.showTextDocument(doc, { preview: true });
  // Failures are almost always at the bottom of the log.
  const end = new vscode.Position(doc.lineCount - 1, 0);
  editor.selection = new vscode.Selection(end, end);
  editor.revealRange(new vscode.Range(end, end), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

function nodeUrl(node: Node): string | undefined {
  switch (node.kind) {
    case 'folder':
    case 'job':
      return node.job.url;
    case 'build':
    case 'stage':
      return node.build.url;
    default:
      return undefined;
  }
}

async function configure(controller: Controller, secrets: vscode.SecretStorage): Promise<void> {
  const config = settings();
  const url = await vscode.window.showInputBox({
    title: 'Jenkins URL',
    prompt: 'Base URL of your Jenkins server',
    value: config.get<string>('url') || 'https://',
    ignoreFocusOut: true,
    validateInput: (value) => (originOf(value.trim()) ? undefined : 'Enter an http:// or https:// URL'),
  });
  if (url === undefined) {
    return;
  }
  const username = await vscode.window.showInputBox({
    title: 'Jenkins Username',
    prompt: 'Leave empty for anonymous access',
    value: config.get<string>('username', ''),
    ignoreFocusOut: true,
  });
  if (username === undefined) {
    return;
  }
  const saved = await storedToken(secrets, url.trim(), username.trim());
  let token = '';
  if (username.trim()) {
    const entered = await vscode.window.showInputBox({
      title: 'Jenkins API Token',
      prompt: 'Create one in Jenkins under your user → Security → API Token',
      placeHolder: saved ? 'Leave empty to keep the stored token' : undefined,
      password: true,
      ignoreFocusOut: true,
    });
    if (entered === undefined) {
      return;
    }
    token = entered.trim() || saved || '';
  }

  if (token && sendsTokenInClear(url.trim())) {
    const choice = await vscode.window.showWarningMessage(
      'This Jenkins URL uses http://, so your API token would be sent unencrypted. Use https:// if the server supports it.',
      { modal: true },
      'Use http:// Anyway',
    );
    if (choice !== 'Use http:// Anyway') {
      return;
    }
  }

  const testClient = new JenkinsClient(url.trim(), username.trim(), token);
  try {
    const jobs = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Connecting to Jenkins…' },
      () => testClient.getJobs(),
    );
    void vscode.window.showInformationMessage(`Connected to Jenkins: found ${flatten(jobs).length} jobs.`);
  } catch (err) {
    const choice = await vscode.window.showErrorMessage(`Jenkins connection failed: ${errorMessage(err)}`, 'Save Anyway');
    if (choice !== 'Save Anyway') {
      return;
    }
  }

  if (token) {
    const credentials: Credentials = { origin: originOf(url.trim())!, username: username.trim(), token };
    await secrets.store(CREDENTIALS_KEY, JSON.stringify(credentials));
  } else {
    await secrets.delete(CREDENTIALS_KEY);
  }
  await config.update('url', url.trim(), vscode.ConfigurationTarget.Global);
  await config.update('username', username.trim(), vscode.ConfigurationTarget.Global);
  await controller.reconnect();
}

export function activate(context: vscode.ExtensionContext): void {
  const controller = new Controller(context.secrets);
  logs = new LogProvider(() => controller.client);

  const requireClient = (): JenkinsClient | undefined => {
    if (!controller.client) {
      void vscode.window.showWarningMessage('Jenkins is not configured.', 'Configure').then((choice) => {
        if (choice) {
          void vscode.commands.executeCommand('pipelineViewerForJenkins.configure');
        }
      });
    }
    return controller.client;
  };

  context.subscriptions.push(
    controller,
    vscode.window.createTreeView(`${SECTION}.jobs`, { treeDataProvider: controller.provider, showCollapseAll: true }),
    vscode.workspace.registerTextDocumentContentProvider(LOG_SCHEME, logs),

    vscode.commands.registerCommand('pipelineViewerForJenkins.configure', () => configure(controller, context.secrets)),
    vscode.commands.registerCommand('pipelineViewerForJenkins.refresh', () => controller.refresh()),

    vscode.commands.registerCommand('pipelineViewerForJenkins.build', async (node: Node) => {
      const client = requireClient();
      if (!client || node?.kind !== 'job') {
        return;
      }
      try {
        await client.triggerBuild(node.job.url);
        void vscode.window.showInformationMessage(`Build scheduled: ${displayName(node.job)}`);
        // Give Jenkins a moment to move the build out of the queue before refreshing.
        setTimeout(() => void controller.refresh(), 3000);
      } catch (err) {
        void vscode.window.showErrorMessage(`Could not start build: ${errorMessage(err)}`);
      }
    }),

    vscode.commands.registerCommand('pipelineViewerForJenkins.stopBuild', async (node: Node) => {
      const client = requireClient();
      if (!client || node?.kind !== 'build') {
        return;
      }
      const choice = await vscode.window.showWarningMessage(
        `Abort ${displayName(node.job)} #${node.build.number}?`,
        { modal: true },
        'Abort',
      );
      if (choice !== 'Abort') {
        return;
      }
      try {
        await client.stopBuild(node.build.url);
        setTimeout(() => void controller.refresh(), 2000);
      } catch (err) {
        void vscode.window.showErrorMessage(`Could not abort build: ${errorMessage(err)}`);
      }
    }),

    vscode.commands.registerCommand('pipelineViewerForJenkins.openInBrowser', async (node: Node) => {
      const client = requireClient();
      const url = node && nodeUrl(node);
      if (client && url) {
        await vscode.env.openExternal(vscode.Uri.parse(client.resolve(url)));
      }
    }),

    vscode.commands.registerCommand('pipelineViewerForJenkins.openLog', async (node: Node) => {
      if (!requireClient() || !node) {
        return;
      }
      if (node.kind === 'job') {
        await openLog(`${displayName(node.job)} last build`, `${node.job.url}lastBuild/`);
      } else if (node.kind === 'build' || node.kind === 'stage') {
        await openLog(`${displayName(node.job)} #${node.build.number}`, node.build.url);
      }
    }),

    vscode.commands.registerCommand('pipelineViewerForJenkins.reloadLog', () => {
      const uri = vscode.window.activeTextEditor?.document.uri;
      if (uri?.scheme === LOG_SCHEME) {
        logs.reload(uri);
      }
    }),

    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(`${SECTION}.buildHistoryLimit`)) {
        controller.provider.refresh();
      }
      if (
        e.affectsConfiguration(`${SECTION}.url`) ||
        e.affectsConfiguration(`${SECTION}.username`) ||
        e.affectsConfiguration(`${SECTION}.refreshInterval`)
      ) {
        void controller.reconnect();
      }
    }),
  );

  void controller.reconnect();
}

export function deactivate(): void {}
