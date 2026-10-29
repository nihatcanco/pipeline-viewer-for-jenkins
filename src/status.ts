import * as vscode from 'vscode';

export type Status = 'success' | 'failure' | 'unstable' | 'aborted' | 'running' | 'paused' | 'notbuilt' | 'disabled';

/** Job "color" from the Jenkins API; `_anime` means a build is in progress. */
export function statusFromColor(color: string | undefined): Status {
  if (!color) {
    return 'notbuilt';
  }
  if (color.endsWith('_anime')) {
    return 'running';
  }
  switch (color) {
    case 'blue':
      return 'success';
    case 'red':
      return 'failure';
    case 'yellow':
      return 'unstable';
    case 'aborted':
      return 'aborted';
    case 'disabled':
      return 'disabled';
    default:
      return 'notbuilt';
  }
}

export function statusFromResult(result: string | null, building = false): Status {
  if (building) {
    return 'running';
  }
  switch (result) {
    case 'SUCCESS':
      return 'success';
    case 'FAILURE':
      return 'failure';
    case 'UNSTABLE':
      return 'unstable';
    case 'ABORTED':
      return 'aborted';
    default:
      return 'notbuilt';
  }
}

/** Stage status from the Pipeline Stage View plugin (wfapi). */
export function statusFromStage(status: string): Status {
  switch (status) {
    case 'SUCCESS':
      return 'success';
    case 'FAILED':
      return 'failure';
    case 'UNSTABLE':
      return 'unstable';
    case 'ABORTED':
      return 'aborted';
    case 'IN_PROGRESS':
      return 'running';
    case 'PAUSED_PENDING_INPUT':
      return 'paused';
    default:
      return 'notbuilt';
  }
}

export function statusIcon(status: Status): vscode.ThemeIcon {
  switch (status) {
    case 'success':
      return new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('testing.iconPassed'));
    case 'failure':
      return new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'));
    case 'unstable':
      return new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'));
    case 'aborted':
      return new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('disabledForeground'));
    case 'running':
      return new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('charts.blue'));
    case 'paused':
      return new vscode.ThemeIcon('debug-pause', new vscode.ThemeColor('charts.yellow'));
    case 'disabled':
      return new vscode.ThemeIcon('circle-large-outline', new vscode.ThemeColor('disabledForeground'));
    case 'notbuilt':
      return new vscode.ThemeIcon('circle-outline', new vscode.ThemeColor('disabledForeground'));
  }
}

export function statusLabel(status: Status): string {
  switch (status) {
    case 'success':
      return 'passed';
    case 'failure':
      return 'failed';
    case 'unstable':
      return 'unstable';
    case 'aborted':
      return 'aborted';
    case 'running':
      return 'running';
    case 'paused':
      return 'waiting for input';
    case 'disabled':
      return 'disabled';
    case 'notbuilt':
      return 'not built';
  }
}

export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function timeAgo(timestamp: number): string {
  const minutes = Math.floor((Date.now() - timestamp) / 60_000);
  if (minutes < 1) {
    return 'just now';
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  return `${Math.floor(hours / 24)}d ago`;
}
