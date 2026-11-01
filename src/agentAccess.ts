import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { INSTRUCTIONS, jenkinsTools } from './agentTools';
import { JenkinsClient } from './jenkinsClient';
import { errorMessage } from './jobsProvider';
import { McpServer } from './mcpServer';
import { SECTION, numberSetting, settings } from './settings';

const TOKEN_KEY = 'mcpToken';
const DEFAULT_PORT = 47_632;

function port(): number {
  return numberSetting('mcp.port', DEFAULT_PORT, 1024, 65_535);
}

export function serverUrl(): string {
  return `http://127.0.0.1:${port()}/mcp`;
}

/** Only the user settings can turn the server on, so a workspace cannot open Jenkins up to agents. */
export function enabled(): boolean {
  return settings().inspect<boolean>('mcp.enabled')?.globalValue === true;
}

/** What the server is doing: `portInUse` usually means another VS Code window serves agents. */
export type AgentState = { kind: 'off' | 'running' | 'portInUse' } | { kind: 'failed'; message: string };

/** Runs the MCP server that AI agents connect to, while it is turned on in the user settings. */
export class AgentAccess implements vscode.Disposable {
  private server?: McpServer;
  private current: AgentState = { kind: 'off' };
  private readonly stateChanged = new vscode.EventEmitter<void>();
  readonly onDidChangeState = this.stateChanged.event;
  private retry?: NodeJS.Timeout;
  /** Starts and stops run one after another, so the port is free again before the next listen. */
  private queue = Promise.resolve();
  private disposed = false;
  private creating?: Promise<string>;
  private readonly disposables: vscode.Disposable[];

  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly getClient: () => JenkinsClient | undefined,
    private readonly changed: () => void,
    private readonly version: string,
  ) {
    this.disposables = [
      this.stateChanged,
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(`${SECTION}.mcp`)) {
          this.update();
        }
      }),
      // Another window may have created or reset the token.
      secrets.onDidChange((e) => {
        if (e.key === TOKEN_KEY) {
          this.update();
        }
      }),
    ];
  }

  get state(): AgentState {
    return this.current;
  }

  private setState(state: AgentState): void {
    this.current = state;
    this.stateChanged.fire();
  }

  /** Starts, restarts or stops the server to match the settings. */
  update(): void {
    this.queue = this.queue
      .then(() => this.apply())
      .catch((err) => {
        this.setState({ kind: 'failed', message: errorMessage(err) });
        void vscode.window.showErrorMessage(`Could not start the Jenkins MCP server: ${errorMessage(err)}`);
      });
  }

  private async apply(): Promise<void> {
    clearTimeout(this.retry);
    await this.server?.close();
    this.server = undefined;
    if (this.disposed || !enabled()) {
      if (!this.disposed) {
        this.setState({ kind: 'off' });
      }
      return;
    }
    const server = new McpServer(
      { name: 'pipeline-viewer-for-jenkins', title: 'Jenkins', version: this.version, instructions: INSTRUCTIONS },
      jenkinsTools({
        client: this.getClient,
        confirm: async (message, detail, action) =>
          (await vscode.window.showWarningMessage(message, { modal: true, detail }, action)) === action,
        changed: this.changed,
      }),
      await this.token(),
    );
    try {
      await server.listen(port());
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') {
        throw err;
      }
      // Usually another VS Code window serves agents already. Try again, to take over once that window closes.
      this.retry = setTimeout(() => this.update(), 30_000);
      this.setState({ kind: 'portInUse' });
      return;
    }
    if (this.disposed) {
      await server.close();
    } else {
      this.server = server;
      this.setState({ kind: 'running' });
    }
  }

  private async token(): Promise<string> {
    const stored = await this.secrets.get(TOKEN_KEY);
    if (stored) {
      return stored;
    }
    // Setting up and starting the server both ask for the first token at once, and must get the same one.
    this.creating ??= (async () => {
      const token = randomBytes(32).toString('base64url');
      await this.secrets.store(TOKEN_KEY, token);
      return token;
    })();
    return this.creating;
  }

  /** Asks before turning the server on. Resolves to whether it is on. */
  async turnOn(): Promise<boolean> {
    if (enabled()) {
      return true;
    }
    const choice = await vscode.window.showInformationMessage(
      'Let AI agents such as Claude Code use Jenkins?',
      {
        modal: true,
        detail:
          `This starts an MCP server at ${serverUrl()}. Only programs on this computer that have its ` +
          'access token can connect. Agents can read jobs, builds and console logs, and starting or aborting a build ' +
          'needs your approval each time.\n\nWhat an agent reads, such as console logs, is sent to its AI provider.',
      },
      'Turn On',
    );
    if (choice !== 'Turn On') {
      return false;
    }
    await settings().update('mcp.enabled', true, vscode.ConfigurationTarget.Global);
    return true;
  }

  async turnOff(): Promise<void> {
    await settings().update('mcp.enabled', false, vscode.ConfigurationTarget.Global);
  }

  /** Copies what an agent needs to connect, which includes the access token. */
  async copySetup(client: 'claude' | 'json'): Promise<void> {
    const url = serverUrl();
    const authorization = `Bearer ${await this.token()}`;
    await vscode.env.clipboard.writeText(
      client === 'claude'
        ? `claude mcp add --transport http --scope user jenkins ${url} --header "Authorization: ${authorization}"`
        : JSON.stringify({ mcpServers: { jenkins: { type: 'http', url, headers: { Authorization: authorization } } } }, null, 2),
    );
    void vscode.window.showInformationMessage(
      'Copied. It contains the access token, so keep it out of repositories and shared files.',
    );
  }

  async setUp(): Promise<void> {
    if (!(await this.turnOn())) {
      return;
    }
    const items: (vscode.QuickPickItem & { client?: 'claude' | 'json' })[] = [
      { label: 'Claude Code', description: 'Copy a command to run in a terminal', client: 'claude' },
      { label: 'Other MCP clients', description: 'Copy a JSON configuration, e.g. for Cursor', client: 'json' },
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      { label: 'Turn Off AI Agent Access', description: 'Stop the MCP server' },
    ];
    const pick = await vscode.window.showQuickPick(items, {
      title: 'AI Agent Access',
      placeHolder: `MCP server at ${serverUrl()}. Which agent do you want to connect?`,
    });
    if (!pick) {
      return;
    }
    if (!pick.client) {
      return this.turnOff();
    }
    await this.copySetup(pick.client);
  }

  async resetToken(): Promise<void> {
    const choice = await vscode.window.showWarningMessage(
      'Reset the AI agent access token?',
      { modal: true, detail: 'Agents set up with the current token lose access until you set them up again.' },
      'Reset',
    );
    if (choice !== 'Reset') {
      return;
    }
    // The secret storage change restarts the server with the new token.
    await this.secrets.store(TOKEN_KEY, randomBytes(32).toString('base64url'));
    const next = await vscode.window.showInformationMessage('The access token was reset.', 'Set Up Agents');
    if (next) {
      await this.setUp();
    }
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.retry);
    vscode.Disposable.from(...this.disposables).dispose();
    void this.server?.close();
  }
}
