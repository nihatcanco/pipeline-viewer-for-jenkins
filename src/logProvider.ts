import * as vscode from 'vscode';
import { JenkinsClient, stripAnsi } from './jenkinsClient';
import { errorMessage } from './jobsProvider';

export const LOG_SCHEME = 'pipeline-viewer-log';

/** Serves build console output as read-only documents at pipeline-viewer-log:/<title>.log?<build url>. */
export class LogProvider implements vscode.TextDocumentContentProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;

  constructor(private readonly getClient: () => JenkinsClient | undefined) {}

  static uri(title: string, buildUrl: string): vscode.Uri {
    return vscode.Uri.from({ scheme: LOG_SCHEME, path: `/${title.replace(/[\\/]/g, '_')}.log`, query: buildUrl });
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const client = this.getClient();
    if (!client) {
      return 'Jenkins is not configured. Run "Jenkins: Configure Connection".';
    }
    try {
      return stripAnsi(await client.getConsoleText(uri.query));
    } catch (err) {
      return `Could not load the console log: ${errorMessage(err)}`;
    }
  }

  reload(uri: vscode.Uri): void {
    this.emitter.fire(uri);
  }
}
