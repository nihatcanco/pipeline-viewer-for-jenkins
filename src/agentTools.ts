// Tools that let AI agents read Jenkins and, with the user's approval, start and abort builds.
// Kept free of `vscode` imports so they can be tested in plain Node; the extension supplies the confirmation dialog.
import {
  JenkinsBuild,
  JenkinsClient,
  JenkinsJob,
  JenkinsParameter,
  isFolder,
  needsBrowser,
  parameterKind,
  stripAnsi,
} from './jenkinsClient';
import { Tool } from './mcpServer';
import { statusFromColor, statusFromResult, statusFromStage, statusLabel } from './status';

export interface ToolHost {
  client(): JenkinsClient | undefined;
  /** Asks the user to approve an action an agent requested; resolves to false when they decline. */
  confirm(message: string, detail: string, action: string): Promise<boolean>;
  /** Called after an action changed something on Jenkins. */
  changed(): void;
}

export const INSTRUCTIONS =
  'Reads the Jenkins server configured in the user\'s VS Code. Name jobs by the full name list_jobs returns, such as ' +
  '"folder/job", and builds by number or by a permalink such as lastBuild. Starting or aborting a build waits for the ' +
  'user to approve it in VS Code, and fails if they decline.';

const PERMALINKS = [
  'lastBuild',
  'lastCompletedBuild',
  'lastSuccessfulBuild',
  'lastFailedBuild',
  'lastUnsuccessfulBuild',
  'lastStableBuild',
  'lastUnstableBuild',
];
/** Folders below the depth getJobs fetches in one request cost a request each, so list_jobs expands only so many. */
const MAX_FOLDER_FETCHES = 50;
const MAX_LOG_LINE = 2000;
const MAX_LOG_CHARS = 100_000;

/** Full name of a job, such as "folder/job", read from the `job/<name>` pairs at the end of its URL. */
export function fullName(url: string): string {
  const segments = new URL(url).pathname.split('/').filter(Boolean);
  const names: string[] = [];
  while (segments.length >= 2 && segments[segments.length - 2] === 'job') {
    const name = segments.pop()!;
    segments.pop();
    try {
      names.unshift(decodeURIComponent(name));
    } catch {
      names.unshift(name);
    }
  }
  return names.join('/');
}

/** Path of a job given by its full name, or the URL itself when the agent passed one. */
export function jobPath(job: unknown): string {
  const value = typeof job === 'string' ? job.trim() : '';
  if (/^https?:\/\//i.test(value)) {
    const url = new URL(value);
    url.search = '';
    url.hash = '';
    if (!url.pathname.endsWith('/')) {
      url.pathname += '/';
    }
    return url.toString();
  }
  const names = value.split('/').filter(Boolean);
  if (!names.length || names.some((name) => name === '.' || name === '..')) {
    throw new Error('Pass the job as its full name from list_jobs, such as "folder/job", or as its URL.');
  }
  return `job/${names.map(encodeURIComponent).join('/job/')}/`;
}

export function buildPath(job: unknown, build: unknown): string {
  const ref = build === undefined || build === null ? 'lastBuild' : String(build).trim();
  if (!/^\d+$/.test(ref) && !PERMALINKS.includes(ref)) {
    throw new Error(`build must be a build number or one of ${PERMALINKS.join(', ')}.`);
  }
  return `${jobPath(job)}${ref}/`;
}

function integer(value: unknown, name: string, fallback: number, min: number, max: number): number {
  if (value === undefined || value === null) {
    return fallback;
  }
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`${name} must be a whole number from ${min} to ${max}.`);
  }
  return number;
}

/**
 * A page of the log: the last `maxLines` lines, or `maxLines` lines from `fromLine` (1-based). Lines and the whole
 * page are also capped in characters, since one minified line can be larger than the rest of the log.
 */
export function logPage(text: string, fromLine: number | undefined, maxLines: number): string {
  const lines = stripAnsi(text).split(/\r?\n/);
  if (lines[lines.length - 1] === '') {
    lines.pop();
  }
  const total = lines.length;
  if (!total) {
    return 'The console log is empty.';
  }
  if (fromLine !== undefined && fromLine > total) {
    return `The console log has only ${total} lines.`;
  }
  const clip = (line: string) => (line.length > MAX_LOG_LINE ? `${line.slice(0, MAX_LOG_LINE)} … (line shortened)` : line);

  let first = fromLine === undefined ? Math.max(0, total - maxLines) : fromLine - 1;
  let last = Math.min(total, first + maxLines);
  const page: string[] = [];
  let size = 0;
  // The tail keeps the end of the log, where failures usually are.
  const tail = fromLine === undefined;
  for (let i = tail ? last - 1 : first; tail ? i >= first : i < last; i += tail ? -1 : 1) {
    const line = clip(lines[i]);
    if (size + line.length >= MAX_LOG_CHARS) {
      break;
    }
    size += line.length + 1;
    if (tail) {
      page.unshift(line);
    } else {
      page.push(line);
    }
  }
  if (tail) {
    first = last - page.length;
  } else {
    last = first + page.length;
  }

  let header = `Lines ${first + 1}-${last} of ${total}.`;
  if (last < total) {
    header += ` Pass from_line ${last + 1} to read on.`;
  }
  if (tail && first > 0) {
    header += ' Pass from_line to read earlier lines.';
  }
  return `${header}\n\n${page.join('\n')}`;
}

/** Checks the values an agent passed against the job's parameters and turns them into the strings Jenkins expects. */
export function parameterValues(params: JenkinsParameter[], given: unknown): Record<string, string> {
  if (given === undefined || given === null) {
    return {};
  }
  if (typeof given !== 'object' || Array.isArray(given)) {
    throw new Error('parameters must be an object that maps parameter names to values.');
  }
  const values: Record<string, string> = {};
  for (const [name, raw] of Object.entries(given)) {
    const param = params.find((candidate) => candidate.name === name);
    if (!param) {
      const known = params.map((candidate) => candidate.name).join(', ');
      throw new Error(known ? `Unknown parameter ${name}. The job takes: ${known}.` : 'The job takes no parameters.');
    }
    if (!['string', 'number', 'boolean'].includes(typeof raw)) {
      throw new Error(`The value of ${name} must be a string, number or boolean.`);
    }
    const value = String(raw);
    const kind = parameterKind(param);
    if (kind === 'boolean' && value !== 'true' && value !== 'false') {
      throw new Error(`${name} must be true or false.`);
    }
    if (kind === 'choice' && !param.choices!.includes(value)) {
      throw new Error(`${name} must be one of: ${param.choices!.join(', ')}.`);
    }
    values[name] = value;
  }
  return values;
}

/** Parameter values as the confirmation dialog shows them. Values are quoted so a line break cannot fake another line. */
function describeValues(params: JenkinsParameter[], values: Record<string, string>): string {
  if (!params.length) {
    return 'The job takes no parameters.';
  }
  const lines = params.map((param) => {
    if (!(param.name in values)) {
      return `${param.name}: (default)`;
    }
    return `${param.name}: ${parameterKind(param) === 'password' ? '••••••' : JSON.stringify(values[param.name])}`;
  });
  return `Parameters:\n${lines.join('\n')}`;
}

function iso(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function buildSummary(client: JenkinsClient, build: JenkinsBuild): Record<string, unknown> {
  const timing = build.building
    ? { runningForSeconds: Math.round((Date.now() - build.timestamp) / 1000), estimatedSeconds: Math.round(build.estimatedDuration / 1000) }
    : { durationSeconds: Math.round(build.duration / 1000) };
  return {
    number: build.number,
    status: statusLabel(statusFromResult(build.result, build.building)),
    started: iso(build.timestamp),
    ...timing,
    url: client.resolve(build.url),
  };
}

function jobSummary(client: JenkinsClient, job: JenkinsJob): Record<string, unknown> {
  const last = job.lastCompletedBuild;
  return {
    name: fullName(client.resolve(job.url)),
    status: statusLabel(statusFromColor(job.color)),
    url: client.resolve(job.url),
    lastCompletedBuild: last
      ? { number: last.number, result: last.result, finished: last.timestamp ? iso(last.timestamp + (last.duration ?? 0)) : undefined }
      : null,
  };
}

const jobArg = { type: 'string', description: 'Full name of the job as list_jobs returns it, such as "folder/job", or its URL.' };
const buildArg = {
  type: ['integer', 'string'],
  description: `Build number, or one of ${PERMALINKS.join(', ')}. Defaults to lastBuild.`,
};

export function jenkinsTools(host: ToolHost): Tool[] {
  const client = (): JenkinsClient => {
    const configured = host.client();
    if (!configured) {
      throw new Error('Jenkins is not configured in VS Code. Ask the user to run "Jenkins: Configure Connection".');
    }
    return configured;
  };
  /** The job's full name, which also checks that a URL the agent passed points at a job. */
  const nameOf = (jenkins: JenkinsClient, path: string): string => {
    const name = fullName(jenkins.resolve(path));
    if (!name) {
      throw new Error(`${path} is not the URL of a job.`);
    }
    return name;
  };

  return [
    {
      name: 'list_jobs',
      title: 'List Jenkins jobs',
      description:
        'Lists the jobs on the Jenkins server with their status and last completed build. Folders and multibranch ' +
        'projects are expanded, so each job appears with its full name, such as "folder/job".',
      inputSchema: {
        type: 'object',
        properties: { folder: { type: 'string', description: 'Full name or URL of a folder, to list only the jobs in it.' } },
      },
      annotations: { readOnlyHint: true },
      async call(args) {
        const jenkins = client();
        const out: Record<string, unknown>[] = [];
        let fetches = MAX_FOLDER_FETCHES;
        const collect = async (jobs: JenkinsJob[]): Promise<void> => {
          for (const job of jobs) {
            if (!isFolder(job)) {
              out.push(jobSummary(jenkins, job));
              continue;
            }
            let children = job.jobs;
            if (!children && fetches > 0) {
              fetches--;
              children = await jenkins.getJobs(job.url);
            }
            if (children) {
              await collect(children);
            } else {
              out.push({ name: fullName(jenkins.resolve(job.url)), folder: true, note: 'Not expanded; list it with the folder argument.' });
            }
          }
        };
        await collect(await jenkins.getJobs(args.folder === undefined ? undefined : jobPath(args.folder)));
        return out.length ? json(out) : 'No jobs found.';
      },
    },
    {
      name: 'get_builds',
      title: 'List recent builds of a Jenkins job',
      description: 'Lists the most recent builds of a job, newest first, with their status and timing.',
      inputSchema: {
        type: 'object',
        properties: {
          job: jobArg,
          limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Number of builds to list. Defaults to 10.' },
        },
        required: ['job'],
      },
      annotations: { readOnlyHint: true },
      async call(args) {
        const jenkins = client();
        const builds = await jenkins.getBuilds(jobPath(args.job), integer(args.limit, 'limit', 10, 1, 100));
        return builds.length ? json(builds.map((build) => buildSummary(jenkins, build))) : 'The job has no builds yet.';
      },
    },
    {
      name: 'get_build',
      title: 'Get a Jenkins build',
      description:
        'Shows the status and timing of one build and, for pipelines, its stages. Poll it to follow a running build.',
      inputSchema: { type: 'object', properties: { job: jobArg, build: buildArg }, required: ['job'] },
      annotations: { readOnlyHint: true },
      async call(args) {
        const jenkins = client();
        const path = buildPath(args.job, args.build);
        const build = await jenkins.getBuild(path);
        const stages = await jenkins.getStages(path);
        return json({
          job: nameOf(jenkins, jobPath(args.job)),
          ...buildSummary(jenkins, build),
          stages:
            stages?.map((stage) => {
              const status = statusFromStage(stage.status);
              return {
                name: stage.name,
                status: status === 'notbuilt' ? 'skipped' : statusLabel(status),
                durationSeconds: Math.round(stage.durationMillis / 1000),
              };
            }) ?? 'Not available: not a pipeline, or the Pipeline Stage View plugin is missing.',
        });
      },
    },
    {
      name: 'get_job_parameters',
      title: 'Get the parameters of a Jenkins job',
      description: 'Lists the build parameters a job declares, with their types, defaults and allowed choices.',
      inputSchema: { type: 'object', properties: { job: jobArg }, required: ['job'] },
      annotations: { readOnlyHint: true },
      async call(args) {
        const params = await client().getParameters(jobPath(args.job));
        if (!params.length) {
          return 'The job takes no parameters.';
        }
        return json(
          params.map((param) => {
            const kind = parameterKind(param);
            return {
              name: param.name,
              type: kind,
              description: param.description || undefined,
              default: kind === 'password' ? undefined : param.defaultParameterValue?.value,
              choices: param.choices,
            };
          }),
        );
      },
    },
    {
      name: 'get_console_log',
      title: 'Read a Jenkins console log',
      description:
        'Reads the console output of a build, ANSI colours removed. Returns the last lines by default, since ' +
        'failures are usually at the end; pass from_line to page through earlier output.',
      inputSchema: {
        type: 'object',
        properties: {
          job: jobArg,
          build: buildArg,
          from_line: { type: 'integer', minimum: 1, description: 'First line to return, counting from 1. Omit to read the end of the log.' },
          max_lines: { type: 'integer', minimum: 1, maximum: 2000, description: 'Number of lines to return. Defaults to 200.' },
        },
        required: ['job'],
      },
      annotations: { readOnlyHint: true },
      async call(args) {
        const fromLine = args.from_line === undefined ? undefined : integer(args.from_line, 'from_line', 1, 1, Number.MAX_SAFE_INTEGER);
        const maxLines = integer(args.max_lines, 'max_lines', 200, 1, 2000);
        const text = await client().getConsoleText(buildPath(args.job, args.build));
        return logPage(text, fromLine, maxLines);
      },
    },
    {
      name: 'start_build',
      title: 'Start a Jenkins build',
      description:
        'Starts a build of a job. The user must approve it in VS Code first. Parameters left out take their default ' +
        'values; call get_job_parameters to see them. Jobs with a file parameter cannot be started this way.',
      inputSchema: {
        type: 'object',
        properties: {
          job: jobArg,
          parameters: {
            type: 'object',
            description: 'Parameter values by name, for parameterized jobs.',
            additionalProperties: { type: ['string', 'number', 'boolean'] },
          },
        },
        required: ['job'],
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      async call(args) {
        const jenkins = client();
        const path = jobPath(args.job);
        const name = nameOf(jenkins, path);
        const params = await jenkins.getParameters(path);
        if (needsBrowser(params)) {
          throw new Error(`${name} takes a file parameter, which can only be supplied from the Jenkins web page.`);
        }
        const values = parameterValues(params, args.parameters);
        if (!(await host.confirm(`An AI agent asks to start a build of ${name}.`, describeValues(params, values), 'Start Build'))) {
          throw new Error('The user declined to start the build.');
        }
        if (params.length) {
          await jenkins.triggerBuildWithParameters(path, values);
        } else {
          await jenkins.triggerBuild(path);
        }
        host.changed();
        return `Build of ${name} scheduled. It can take a few seconds to leave the queue; call get_builds to find it.`;
      },
    },
    {
      name: 'abort_build',
      title: 'Abort a running Jenkins build',
      description: 'Aborts a running build. The user must approve it in VS Code first.',
      inputSchema: {
        type: 'object',
        properties: { job: jobArg, build: { type: 'integer', description: 'Number of the running build.' } },
        required: ['job', 'build'],
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
      async call(args) {
        const jenkins = client();
        if (!/^\d+$/.test(String(args.build ?? ''))) {
          throw new Error('build must be the number of a running build.');
        }
        const path = buildPath(args.job, args.build);
        const name = `${nameOf(jenkins, jobPath(args.job))} #${args.build}`;
        if (!(await jenkins.getBuild(path)).building) {
          throw new Error(`${name} is not running.`);
        }
        if (!(await host.confirm(`An AI agent asks to abort ${name}.`, 'The build stops and is marked as aborted.', 'Abort Build'))) {
          throw new Error('The user declined to abort the build.');
        }
        await jenkins.stopBuild(path);
        host.changed();
        return `Abort of ${name} requested.`;
      },
    },
  ];
}
