import * as vscode from 'vscode';
import { JenkinsClient, countJobs } from './jenkinsClient';
import { errorMessage } from './jobsProvider';
import { settings } from './settings';

const CREDENTIALS_KEY = 'credentials';

/** The API token is stored with the server and user it was entered for, and is never sent anywhere else. */
interface Credentials {
  origin: string;
  username: string;
  token: string;
}

export function originOf(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
}

export async function storedToken(secrets: vscode.SecretStorage, url: string, username: string): Promise<string | undefined> {
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

/** Fetches the job list once and describes the result, for a connection that has not been saved yet. */
export async function testConnection(url: string, username: string, token: string): Promise<string> {
  const jobs = await new JenkinsClient(url, username, token).getJobs();
  return `Connected to Jenkins: found ${countJobs(jobs)} jobs.`;
}

/**
 * Warns about plain http, tests the connection and stores it in user settings and secret storage.
 * Returns false when the user backs out, leaving everything as it was.
 */
export async function saveConnection(secrets: vscode.SecretStorage, url: string, username: string, token: string): Promise<boolean> {
  if (token && sendsTokenInClear(url)) {
    const choice = await vscode.window.showWarningMessage(
      'This Jenkins URL uses http://, so your API token would be sent unencrypted. Use https:// if the server supports it.',
      { modal: true },
      'Use http:// Anyway',
    );
    if (choice !== 'Use http:// Anyway') {
      return false;
    }
  }

  try {
    const message = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Connecting to Jenkins…' },
      () => testConnection(url, username, token),
    );
    void vscode.window.showInformationMessage(message);
  } catch (err) {
    const choice = await vscode.window.showErrorMessage(`Jenkins connection failed: ${errorMessage(err)}`, 'Save Anyway');
    if (choice !== 'Save Anyway') {
      return false;
    }
  }

  if (token) {
    const credentials: Credentials = { origin: originOf(url)!, username, token };
    await secrets.store(CREDENTIALS_KEY, JSON.stringify(credentials));
  } else {
    await secrets.delete(CREDENTIALS_KEY);
  }
  const config = settings();
  await config.update('url', url, vscode.ConfigurationTarget.Global);
  await config.update('username', username, vscode.ConfigurationTarget.Global);
  return true;
}
