import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { originOf, saveConnection, storedToken, testConnection } from './connection';
import { errorMessage } from './jobsProvider';
import { SECTION, numberSetting, settings } from './settings';

/** Settings the page may write, with the bounds declared in package.json. */
const NUMBER_OPTIONS: Record<string, { fallback: number; min: number; max: number }> = {
  refreshInterval: { fallback: 30, min: 5, max: 86_400 },
  buildHistoryLimit: { fallback: 10, min: 1, max: 100 },
};
const NOTIFICATION_MODES = ['failures', 'all', 'off'];

type Message =
  | { type: 'ready' }
  | { type: 'test' | 'save'; url: string; username: string; token: string }
  | { type: 'setOption'; key: string; value: unknown }
  | { type: 'openSettingsEditor' };

export class SettingsPage implements vscode.Disposable {
  private static current?: SettingsPage;
  private readonly disposables: vscode.Disposable[] = [];

  static show(secrets: vscode.SecretStorage, reconnect: () => Promise<void>): void {
    if (SettingsPage.current) {
      SettingsPage.current.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(`${SECTION}.settings`, 'Jenkins Settings', vscode.ViewColumn.Active, {
      enableScripts: true,
      // The page loads nothing from disk or the network.
      localResourceRoots: [],
    });
    SettingsPage.current = new SettingsPage(panel, secrets, reconnect);
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly secrets: vscode.SecretStorage,
    private readonly reconnect: () => Promise<void>,
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
    const overridden = [...Object.keys(NUMBER_OPTIONS), 'notifications'].filter((key) => {
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
