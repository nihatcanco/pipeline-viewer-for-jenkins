import * as vscode from 'vscode';
import {
  JenkinsBuild,
  JenkinsClient,
  JenkinsJob,
  JenkinsStage,
  displayName,
  isFolder,
  isPipeline,
} from './jenkinsClient';
import { numberSetting } from './settings';
import { formatDuration, statusFromColor, statusFromResult, statusFromStage, statusIcon, statusLabel, timeAgo } from './status';

export type Node =
  | { kind: 'folder'; job: JenkinsJob }
  | { kind: 'job'; job: JenkinsJob }
  | { kind: 'build'; job: JenkinsJob; build: JenkinsBuild }
  | { kind: 'stage'; job: JenkinsJob; build: JenkinsBuild; stage: JenkinsStage }
  | { kind: 'message'; message: string; icon: string; command?: vscode.Command };

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function jobNode(job: JenkinsJob): Node {
  return isFolder(job) ? { kind: 'folder', job } : { kind: 'job', job };
}

export class JobsProvider implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  private client?: JenkinsClient;
  private jobs?: JenkinsJob[];
  private error?: string;

  setClient(client: JenkinsClient | undefined): void {
    this.client = client;
    this.jobs = undefined;
    this.error = undefined;
    this.emitter.fire(undefined);
  }

  setJobs(jobs: JenkinsJob[]): void {
    this.jobs = jobs;
    this.error = undefined;
    this.emitter.fire(undefined);
  }

  setError(error: string): void {
    this.error = error;
    this.emitter.fire(undefined);
  }

  get lastError(): string | undefined {
    return this.error;
  }

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getTreeItem(node: Node): vscode.TreeItem {
    const { Collapsed, None } = vscode.TreeItemCollapsibleState;
    switch (node.kind) {
      case 'folder': {
        const item = new vscode.TreeItem(displayName(node.job), Collapsed);
        item.id = node.job.url;
        item.iconPath = new vscode.ThemeIcon(/MultiBranchProject/.test(node.job._class) ? 'git-branch' : 'folder');
        item.contextValue = 'folder';
        item.tooltip = node.job.url;
        return item;
      }
      case 'job': {
        const status = statusFromColor(node.job.color);
        const item = new vscode.TreeItem(displayName(node.job), Collapsed);
        item.id = node.job.url;
        item.iconPath = statusIcon(status);
        item.description = statusLabel(status);
        item.contextValue = status === 'disabled' ? 'job.disabled' : 'job';
        item.tooltip = node.job.url;
        return item;
      }
      case 'build': {
        const { build } = node;
        const status = statusFromResult(build.result, build.building);
        const item = new vscode.TreeItem(`#${build.number}`, isPipeline(node.job) ? Collapsed : None);
        item.id = build.url;
        item.iconPath = statusIcon(status);
        item.description = build.building
          ? `running for ${formatDuration(Date.now() - build.timestamp)}`
          : `${statusLabel(status)} · ${timeAgo(build.timestamp)} · ${formatDuration(build.duration)}`;
        item.tooltip = `${displayName(node.job)} #${build.number}\nStarted ${new Date(build.timestamp).toLocaleString()}`;
        item.contextValue = build.building ? 'build.running' : 'build';
        item.command = { command: 'pipelineViewerForJenkins.openLog', title: 'Show Console Log', arguments: [node] };
        return item;
      }
      case 'stage': {
        const status = statusFromStage(node.stage.status);
        const item = new vscode.TreeItem(node.stage.name, None);
        item.id = `${node.build.url}#${node.stage.id}`;
        item.iconPath = statusIcon(status);
        item.description = status === 'notbuilt' ? 'skipped' : formatDuration(node.stage.durationMillis);
        item.contextValue = 'stage';
        item.command = { command: 'pipelineViewerForJenkins.openLog', title: 'Show Console Log', arguments: [node] };
        return item;
      }
      case 'message': {
        const item = new vscode.TreeItem(node.message, None);
        item.iconPath = new vscode.ThemeIcon(node.icon);
        item.tooltip = node.message;
        item.command = node.command;
        return item;
      }
    }
  }

  async getChildren(node?: Node): Promise<Node[]> {
    const client = this.client;
    if (!client) {
      // An empty root shows the "Configure Jenkins" welcome view.
      return [];
    }
    if (!node) {
      if (this.error) {
        return [
          {
            kind: 'message',
            message: this.error,
            icon: 'error',
            command: { command: 'pipelineViewerForJenkins.configure', title: 'Configure Connection' },
          },
        ];
      }
      if (!this.jobs) {
        return [{ kind: 'message', message: 'Loading…', icon: 'loading~spin' }];
      }
      return this.jobs.map(jobNode);
    }

    try {
      switch (node.kind) {
        case 'folder': {
          const jobs = node.job.jobs ?? (await client.getJobs(node.job.url));
          return jobs.length ? jobs.map(jobNode) : [{ kind: 'message', message: 'Empty folder', icon: 'info' }];
        }
        case 'job': {
          const limit = numberSetting('buildHistoryLimit', 10, 1, 100);
          const builds = await client.getBuilds(node.job.url, limit);
          if (!builds.length) {
            return [{ kind: 'message', message: 'No builds yet', icon: 'info' }];
          }
          return builds.map((build) => ({ kind: 'build', job: node.job, build }));
        }
        case 'build': {
          const stages = await client.getStages(node.build.url);
          if (!stages) {
            return [{ kind: 'message', message: 'No stage data (needs the Pipeline Stage View plugin)', icon: 'info' }];
          }
          if (!stages.length) {
            return [{ kind: 'message', message: 'No stages', icon: 'info' }];
          }
          return stages.map((stage) => ({ kind: 'stage', job: node.job, build: node.build, stage }));
        }
        default:
          return [];
      }
    } catch (err) {
      return [{ kind: 'message', message: errorMessage(err), icon: 'error' }];
    }
  }
}
