import * as vscode from 'vscode';

export const SECTION = 'pipelineViewerForJenkins';

export function settings(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(SECTION);
}

/** A workspace's settings file can hold any JSON value, so numbers are checked and clamped before use. */
export function numberSetting(key: string, fallback: number, min: number, max: number): number {
  const value = Number(settings().get(key));
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
}
