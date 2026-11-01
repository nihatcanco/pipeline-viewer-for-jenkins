import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { AgentAccess, enabled as agentsEnabled, serverUrl } from './agentAccess';
import { originOf, saveConnection, storedToken, testConnection } from './connection';
import { errorMessage } from './jobsProvider';
import { SECTION, numberSetting, settings } from './settings';

/** Settings the page may write, with the bounds declared in package.json. */
const NUMBER_OPTIONS: Record<string, { fallback: number; min: number; max: number }> = {
  refreshInterval: { fallback: 30, min: 5, max: 86_400 },
  buildHistoryLimit: { fallback: 10, min: 1, max: 100 },
  'mcp.port': { fallback: 47_632, min: 1024, max: 65_535 },
};
const NOTIFICATION_MODES = ['failures', 'all', 'off'];
/** Settings a workspace can override. The others are only read from the user settings. */
const PREFERENCES = ['refreshInterval', 'buildHistoryLimit', 'notifications'];

type Message =
  | { type: 'ready' }
  | { type: 'test' | 'save'; url: string; username: string; token: string }
  | { type: 'setOption'; key: string; value: unknown }
  | { type: 'agents'; action: 'turnOn' | 'turnOff' | 'copyClaude' | 'copyJson' | 'resetToken' }
  | { type: 'openSettingsEditor' };

export class SettingsPage implements vscode.Disposable {
  private static current?: SettingsPage;
  private readonly disposables: vscode.Disposable[] = [];

  static show(secrets: vscode.SecretStorage, reconnect: () => Promise<void>, agents: AgentAccess): void {
    if (SettingsPage.current) {
      SettingsPage.current.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(`${SECTION}.settings`, 'Jenkins Settings', vscode.ViewColumn.Active, {
      enableScripts: true,
      // The page loads nothing from disk or the network.
      localResourceRoots: [],
    });
    SettingsPage.current = new SettingsPage(panel, secrets, reconnect, agents);
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly secrets: vscode.SecretStorage,
    private readonly reconnect: () => Promise<void>,
    private readonly agents: AgentAccess,
  ) {
    panel.webview.html = html(randomBytes(16).toString('base64'));
    this.disposables.push(
      panel.onDidDispose(() => this.dispose()),
      panel.webview.onDidReceiveMessage((message: Message) => void this.handle(message)),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(SECTION)) {
          void this.postState();
        }
      }),
      this.secrets.onDidChange(() => void this.postState()),
      agents.onDidChangeState(() => void this.postState()),
    );
  }

  dispose(): void {
    SettingsPage.current = undefined;
    this.panel.dispose();
    vscode.Disposable.from(...this.disposables).dispose();
  }

  private async handle(message: Message): Promise<void> {
    switch (message.type) {
      case 'ready':
        return this.postState();
      case 'test':
      case 'save':
        return this.connection(message);
      case 'setOption':
        return this.setOption(message.key, message.value);
      case 'agents':
        return this.agentAction(message.action);
      case 'openSettingsEditor':
        await vscode.commands.executeCommand('workbench.action.openSettings', `@ext:nihatcanco.pipeline-viewer-for-jenkins`);
        return;
    }
  }

  private async postState(): Promise<void> {
    const config = settings();
    const url = config.get<string>('url', '');
    const username = config.get<string>('username', '');
    // Values set in a workspace win over the user settings this page writes, so the page points them out.
    const overridden = PREFERENCES.filter((key) => {
      const inspected = config.inspect(key);
      return inspected?.workspaceValue !== undefined || inspected?.workspaceFolderValue !== undefined;
    });
    await this.panel.webview.postMessage({
      type: 'state',
      url,
      username,
      hasToken: !!(await storedToken(this.secrets, url, username)),
      ...Object.fromEntries(
        Object.entries(NUMBER_OPTIONS).map(([key, { fallback, min, max }]) => [key, numberSetting(key, fallback, min, max)]),
      ),
      notifications: config.get<string>('notifications', 'failures'),
      overridden,
      agents: { enabled: agentsEnabled(), url: serverUrl(), ...this.agents.state },
    });
  }

  private status(kind: 'busy' | 'ok' | 'error', text: string): void {
    void this.panel.webview.postMessage({ type: 'status', kind, text });
  }

  private async connection({ type, ...fields }: Extract<Message, { type: 'test' | 'save' }>): Promise<void> {
    const url = String(fields.url).trim();
    const username = String(fields.username).trim();
    if (!originOf(url)) {
      return this.status('error', 'Enter an http:// or https:// URL.');
    }
    // An empty token field keeps the token already stored for this server and user.
    const token = username ? String(fields.token).trim() || (await storedToken(this.secrets, url, username)) || '' : '';

    if (type === 'test') {
      this.status('busy', 'Connecting…');
      try {
        this.status('ok', await testConnection(url, username, token));
      } catch (err) {
        this.status('error', `Connection failed: ${errorMessage(err)}`);
      }
      return;
    }

    this.status('busy', 'Saving…');
    if (!(await saveConnection(this.secrets, url, username, token))) {
      return this.status('error', 'Not saved.');
    }
    await this.reconnect();
    this.status('ok', 'Connection saved.');
    // Lets the page replace its edited fields with what was stored.
    await this.panel.webview.postMessage({ type: 'saved' });
    await this.postState();
  }

  private async agentAction(action: Extract<Message, { type: 'agents' }>['action']): Promise<void> {
    switch (action) {
      case 'turnOn':
        // A cancelled confirmation leaves the switch on the page off again.
        if (!(await this.agents.turnOn())) {
          await this.postState();
        }
        return;
      case 'turnOff':
        return this.agents.turnOff();
      case 'copyClaude':
        return this.agents.copySetup('claude');
      case 'copyJson':
        return this.agents.copySetup('json');
      case 'resetToken':
        return this.agents.resetToken();
    }
  }

  private async setOption(key: string, value: unknown): Promise<void> {
    let checked: number | string;
    const bounds = NUMBER_OPTIONS[key];
    if (bounds) {
      const number = Math.round(Number(value));
      if (!Number.isFinite(number)) {
        return this.postState();
      }
      checked = Math.min(bounds.max, Math.max(bounds.min, number));
    } else if (key === 'notifications' && NOTIFICATION_MODES.includes(String(value))) {
      checked = String(value);
    } else {
      return;
    }
    await settings().update(key, checked, vscode.ConfigurationTarget.Global);
  }
}

function html(nonce: string): string {
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Jenkins Settings</title>
<style nonce="${nonce}">
  body {
    max-width: 640px;
    padding: 8px 20px 32px;
    color: var(--vscode-foreground);
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
  }
  h1 { font-size: 1.6em; font-weight: 600; margin: 16px 0 4px; }
  h2 { font-size: 1.15em; font-weight: 600; margin: 28px 0 4px; padding-bottom: 6px; border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); }
  p.lead { color: var(--vscode-descriptionForeground); margin: 0 0 8px; }
  .field { margin: 16px 0; }
  label { display: block; font-weight: 600; margin-bottom: 2px; }
  .hint { color: var(--vscode-descriptionForeground); margin: 0 0 6px; }
  .warn { color: var(--vscode-editorWarning-foreground); margin: 4px 0 0; }
  input, select {
    box-sizing: border-box;
    width: 100%;
    max-width: 420px;
    padding: 4px 6px;
    color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 2px;
    font: inherit;
  }
  select { color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background); border-color: var(--vscode-dropdown-border, transparent); }
  input[type=number] { max-width: 120px; }
  input:focus, select:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  input:disabled { opacity: 0.5; }
  .actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 20px; }
  button {
    padding: 4px 14px;
    color: var(--vscode-button-foreground);
    background: var(--vscode-button-background);
    border: 1px solid var(--vscode-button-border, transparent);
    border-radius: 2px;
    font: inherit;
    cursor: pointer;
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button:disabled { opacity: 0.5; cursor: default; }
  #status { margin-left: 4px; }
  #status.ok { color: var(--vscode-testing-iconPassed); }
  #status.error { color: var(--vscode-errorForeground); }
  #status.busy { color: var(--vscode-descriptionForeground); }
  a { color: var(--vscode-textLink-foreground); cursor: pointer; }
  a:hover { color: var(--vscode-textLink-activeForeground); }
  footer { margin-top: 32px; color: var(--vscode-descriptionForeground); }
  label.check { display: flex; align-items: center; gap: 8px; }
  input[type=checkbox] { width: auto; margin: 0; accent-color: var(--vscode-checkbox-background); }
  code { font-family: var(--vscode-editor-font-family); font-size: 0.95em; }
  #agentStatus { margin: 8px 0 0; }
  #agentStatus.running { color: var(--vscode-testing-iconPassed); }
  #agentStatus.portInUse { color: var(--vscode-editorWarning-foreground); }
  #agentStatus.failed { color: var(--vscode-errorForeground); }
  #agentStatus.off { color: var(--vscode-descriptionForeground); }
  ul.how { margin: 6px 0 0; padding-left: 20px; color: var(--vscode-descriptionForeground); }
  ul.how li { margin: 4px 0; }
</style>
</head>
<body>
<h1>Jenkins Settings</h1>
<p class="lead">Pipeline Viewer for Jenkins</p>

<h2>Connection</h2>
<form id="connection" autocomplete="off">
  <div class="field">
    <label for="url">Server URL</label>
    <p class="hint">Base URL of the Jenkins server, e.g. https://jenkins.example.com/</p>
    <input id="url" type="url" spellcheck="false" required>
  </div>
  <div class="field">
    <label for="username">Username</label>
    <p class="hint">Leave empty to connect anonymously.</p>
    <input id="username" type="text" spellcheck="false">
  </div>
  <div class="field">
    <label for="token">API token</label>
    <p class="hint">Create one in Jenkins under your user → Security → API Token. Kept in VS Code's secret storage.</p>
    <input id="token" type="password">
  </div>
  <div class="actions">
    <button type="submit" id="save">Save Connection</button>
    <button type="button" id="test" class="secondary">Test Connection</button>
    <span id="status" role="status"></span>
  </div>
</form>

<h2>Preferences</h2>
<p class="hint">Changes are saved to your user settings right away.</p>
<div class="field">
  <label for="refreshInterval">Refresh interval</label>
  <p class="hint">How often to poll Jenkins for job status, in seconds (5 to 86400).</p>
  <input id="refreshInterval" data-option type="number" min="5" max="86400" step="1">
</div>
<div class="field">
  <label for="buildHistoryLimit">Build history</label>
  <p class="hint">Number of recent builds to list under each job (1 to 100).</p>
  <input id="buildHistoryLimit" data-option type="number" min="1" max="100" step="1">
</div>
<div class="field">
  <label for="notifications">Notifications</label>
  <p class="hint">When to show a notification for finished builds.</p>
  <select id="notifications" data-option>
    <option value="failures">When a build fails or is unstable</option>
    <option value="all">Whenever a build finishes</option>
    <option value="off">Never</option>
  </select>
</div>

<h2>AI Agent Access (MCP)</h2>
<p class="hint">Lets AI agents such as Claude Code, Cursor or GitHub Copilot use Jenkins through a local MCP (Model Context Protocol) server, to check builds and read console logs for you.</p>
<div class="field">
  <label class="check" for="agentsEnabled"><input id="agentsEnabled" type="checkbox"> Allow AI agents to use Jenkins</label>
  <p id="agentStatus" role="status"></p>
</div>
<div class="field">
  <label for="mcp.port">Port</label>
  <p class="hint">Port of the server on 127.0.0.1 (1024 to 65535). Agents that are already set up need the new address after a change.</p>
  <input id="mcp.port" data-option type="number" min="1024" max="65535" step="1">
</div>
<div class="field">
  <label>Connect an agent</label>
  <p class="hint">Copies the setup to the clipboard. It contains the access token, so keep it out of repositories and shared files.</p>
  <div class="actions">
    <button type="button" id="copyClaude" data-agent-action>Copy Claude Code Command</button>
    <button type="button" id="copyJson" data-agent-action class="secondary">Copy JSON Configuration</button>
    <button type="button" id="resetToken" data-agent-action class="secondary">Reset Access Token</button>
  </div>
  <p class="hint">Run the Claude Code command in a terminal. Add the JSON to the MCP configuration file of other clients, e.g. Cursor's <code>mcp.json</code>.</p>
</div>
<div class="field">
  <label>How it works</label>
  <ul class="how">
    <li>While this is on, VS Code runs an MCP server at <code class="agentUrl"></code>. It listens on this computer only and cannot be reached from the network.</li>
    <li>Agents must send a random access token, kept in VS Code's secret storage. Web pages are refused. Resetting the token disconnects every agent set up with the old one.</li>
    <li>Agents use the connection above. They can list jobs and read builds, pipeline stages, parameters and console logs.</li>
    <li>When an agent asks to start or abort a build, VS Code shows a dialog, and nothing happens until you approve it.</li>
    <li>What an agent reads, such as console logs, is sent to its AI provider.</li>
    <li>The server runs while VS Code is open. With several windows open, one of them serves agents and shows the approvals; the others take over when it closes. With remote development (SSH, WSL or containers), it runs on the remote machine, so run the agent there too.</li>
    <li>These settings are only read from your user settings, so a repository you open cannot turn agent access on.</li>
  </ul>
</div>

<footer>These are regular VS Code settings. <a id="openSettingsEditor" tabindex="0">Open them in the Settings editor</a></footer>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const connectionFields = ['url', 'username', 'token'];
  let dirty = false;
  let hasToken = false;

  function updateTokenField() {
    const anonymous = !$('username').value.trim();
    $('token').disabled = anonymous;
    $('token').placeholder = anonymous ? 'Not used for anonymous access' : hasToken ? 'Leave empty to keep the stored token' : '';
  }

  function connection(type) {
    vscode.postMessage({ type, url: $('url').value, username: $('username').value, token: $('token').value });
  }

  for (const id of connectionFields) {
    $(id).addEventListener('input', () => {
      dirty = true;
      updateTokenField();
    });
  }
  $('connection').addEventListener('submit', (event) => {
    event.preventDefault();
    connection('save');
  });
  $('test').addEventListener('click', () => connection('test'));

  for (const element of document.querySelectorAll('[data-option]')) {
    element.addEventListener('change', () => vscode.postMessage({ type: 'setOption', key: element.id, value: element.value }));
  }

  $('agentsEnabled').addEventListener('change', () =>
    vscode.postMessage({ type: 'agents', action: $('agentsEnabled').checked ? 'turnOn' : 'turnOff' }),
  );
  for (const button of document.querySelectorAll('[data-agent-action]')) {
    button.addEventListener('click', () => vscode.postMessage({ type: 'agents', action: button.id }));
  }

  function agentStatus({ enabled, kind, url, message }) {
    if (!enabled) return ['off', 'Off.'];
    switch (kind) {
      case 'running': return ['running', 'Running at ' + url];
      case 'portInUse': return ['portInUse', 'The port is in use, usually by another VS Code window that serves agents. This window takes over once it is free.'];
      case 'failed': return ['failed', 'Could not start: ' + message];
      default: return ['off', 'Starting…'];
    }
  }

  const openSettingsEditor = () => vscode.postMessage({ type: 'openSettingsEditor' });
  $('openSettingsEditor').addEventListener('click', openSettingsEditor);
  $('openSettingsEditor').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') openSettingsEditor();
  });

  window.addEventListener('message', ({ data }) => {
    if (data.type === 'state') {
      hasToken = data.hasToken;
      // Unsaved edits to the connection are kept when settings change elsewhere.
      if (!dirty) {
        $('url').value = data.url;
        $('username').value = data.username;
        $('token').value = '';
      }
      for (const key of ['refreshInterval', 'buildHistoryLimit', 'notifications']) {
        $(key).value = String(data[key]);
        const field = $(key).closest('.field');
        field.querySelector('.warn')?.remove();
        if (data.overridden.includes(key)) {
          const warn = document.createElement('p');
          warn.className = 'warn';
          warn.textContent = 'A workspace setting overrides this value in the current workspace.';
          field.append(warn);
        }
      }
      updateTokenField();

      const agents = data.agents;
      $('agentsEnabled').checked = agents.enabled;
      $('mcp.port').value = String(data['mcp.port']);
      const [kind, text] = agentStatus(agents);
      $('agentStatus').className = kind;
      $('agentStatus').textContent = text;
      for (const element of document.querySelectorAll('.agentUrl')) element.textContent = agents.url;
      $('copyClaude').disabled = $('copyJson').disabled = !agents.enabled;
    } else if (data.type === 'status') {
      $('status').textContent = data.text;
      $('status').className = data.kind;
      $('save').disabled = $('test').disabled = data.kind === 'busy';
    } else if (data.type === 'saved') {
      dirty = false;
    }
  });

  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
