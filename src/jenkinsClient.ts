// Thin wrapper around the Jenkins JSON API. Kept free of `vscode` imports so it can be tested in plain Node.

export interface JenkinsJob {
  _class: string;
  name: string;
  displayName?: string;
  url: string;
  color?: string;
  lastCompletedBuild?: { number: number; result: string | null } | null;
  /** Present on folders and multibranch projects. */
  jobs?: JenkinsJob[];
}

export interface JenkinsBuild {
  number: number;
  url: string;
  result: string | null;
  building: boolean;
  timestamp: number;
  duration: number;
  estimatedDuration: number;
}

export interface JenkinsStage {
  id: string;
  name: string;
  status: string;
  durationMillis: number;
}

export interface JenkinsParameter {
  name: string;
  /** Class name of the definition, such as StringParameterDefinition. */
  type?: string;
  description?: string | null;
  defaultParameterValue?: { value?: unknown } | null;
  /** Present on choice parameters. */
  choices?: string[];
}

export class JenkinsError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

const JOB_FIELDS = 'name,displayName,url,color,_class,lastCompletedBuild[number,result]';
// Three levels covers root → folder/multibranch → branch; deeper folders are fetched when expanded.
const JOBS_TREE = `jobs[${JOB_FIELDS},jobs[${JOB_FIELDS},jobs[${JOB_FIELDS}]]]`;
const BUILD_FIELDS = 'number,url,result,building,timestamp,duration,estimatedDuration';
const PARAMETER_FIELDS = 'parameterDefinitions[name,type,description,defaultParameterValue[value],choices]';

export function displayName(job: JenkinsJob): string {
  return job.displayName ?? decodeName(job.name);
}

/** Multibranch jobs are named after URL-encoded branch names, but a plain job name may contain a literal %. */
function decodeName(name: string): string {
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

/** TLS error codes for a certificate that does not chain to a trusted root, such as a self-signed one. */
const UNTRUSTED_CERTIFICATE = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);

function connectionError(err: unknown): string {
  const cause = (err as { cause?: { code?: string; message?: string } }).cause;
  if (cause?.code && UNTRUSTED_CERTIFICATE.has(cause.code)) {
    // Node appends advice about its own command line flags, which VS Code users cannot pass.
    const reason = cause.message?.split(';')[0] ?? cause.code;
    return (
      `its certificate is not trusted (${reason}). If Jenkins uses a self-signed or company certificate, ` +
      `add it to your operating system's trusted certificates and reload the window.`
    );
  }
  return cause?.message ?? (err as Error).message;
}

export function isFolder(job: JenkinsJob): boolean {
  return job.jobs !== undefined || /Folder|MultiBranchProject/.test(job._class);
}

export function isPipeline(job: JenkinsJob): boolean {
  return /WorkflowJob/.test(job._class);
}

export class JenkinsClient {
  readonly baseUrl: string;
  private readonly auth?: string;

  constructor(baseUrl: string, username: string, token: string) {
    this.baseUrl = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
    if (username && token) {
      this.auth = 'Basic ' + Buffer.from(`${username}:${token}`).toString('base64');
    }
  }

  /**
   * Jenkins returns absolute URLs built from its own "Jenkins URL" setting, which is often
   * localhost or a stale hostname. Keep the path but always talk to the host we were configured with.
   * The configured server is the only host this extension may ever contact.
   */
  resolve(urlOrPath: string): string {
    const base = new URL(this.baseUrl);
    if (base.protocol !== 'http:' && base.protocol !== 'https:') {
      throw new JenkinsError(`The Jenkins URL must start with http:// or https://, not ${base.protocol}`);
    }
    const target = new URL(urlOrPath, base);
    target.protocol = base.protocol;
    target.host = base.host;
    // Setting host keeps the old port when the new host has none, so set it explicitly.
    target.port = base.port;
    // The setters above are silent no-ops for schemes like data: or file:, so verify the result.
    if (target.origin !== base.origin) {
      throw new JenkinsError(`Refusing to access ${urlOrPath}: not on the configured Jenkins server`);
    }
    return target.toString();
  }

  /**
   * URL of an endpoint below a folder, job or build. The item URL's own query and fragment are dropped,
   * so a crafted item URL can only pick which item is acted on, never add parameters to the request.
   */
  private endpoint(itemUrl: string, rest: string): string {
    const item = new URL(this.resolve(itemUrl));
    item.search = '';
    item.hash = '';
    if (!item.pathname.endsWith('/')) {
      item.pathname += '/';
    }
    return item.toString() + rest;
  }

  async getJobs(folderUrl?: string): Promise<JenkinsJob[]> {
    const data = await this.json<{ jobs?: JenkinsJob[] }>(
      this.endpoint(folderUrl ?? this.baseUrl, `api/json?tree=${JOBS_TREE}`),
    );
    return data.jobs ?? [];
  }

  async getBuilds(jobUrl: string, limit: number): Promise<JenkinsBuild[]> {
    const data = await this.json<{ builds?: JenkinsBuild[] }>(
      this.endpoint(jobUrl, `api/json?tree=builds[${BUILD_FIELDS}]{0,${limit}}`),
    );
    return data.builds ?? [];
  }

  /** Stage data from the Pipeline Stage View plugin; undefined when the plugin or the data is missing. */
  async getStages(buildUrl: string): Promise<JenkinsStage[] | undefined> {
    try {
      const data = await this.json<{ stages?: JenkinsStage[] }>(this.endpoint(buildUrl, 'wfapi/describe'));
      return data.stages;
    } catch (err) {
      if (err instanceof JenkinsError && err.status === 404) {
        return undefined;
      }
      throw err;
    }
  }

  async getConsoleText(buildUrl: string): Promise<string> {
    const res = await this.request(this.endpoint(buildUrl, 'consoleText'));
    return res.text();
  }

  /** Build parameters the job declares; empty when it has none. */
  async getParameters(jobUrl: string): Promise<JenkinsParameter[]> {
    type Holder = { parameterDefinitions?: JenkinsParameter[] } | null;
    const data = await this.json<{ property?: Holder[]; actions?: Holder[] }>(
      this.endpoint(jobUrl, `api/json?tree=property[${PARAMETER_FIELDS}],actions[${PARAMETER_FIELDS}]`),
    );
    // Current Jenkins lists them under the job's properties, older versions under its actions.
    for (const holder of [...(data.property ?? []), ...(data.actions ?? [])]) {
      if (holder?.parameterDefinitions?.length) {
        return holder.parameterDefinitions;
      }
    }
    return [];
  }

  /** Parameters left out of `values` take the job's default values. */
  async triggerBuildWithParameters(jobUrl: string, values: Record<string, string>): Promise<void> {
    // Values travel in the form body rather than the URL, so they stay out of proxy and access logs.
    await this.request(this.endpoint(jobUrl, 'buildWithParameters?delay=0sec'), {
      method: 'POST',
      body: new URLSearchParams(values),
    });
  }

  async triggerBuild(jobUrl: string): Promise<void> {
    try {
      await this.request(this.endpoint(jobUrl, 'build?delay=0sec'), { method: 'POST' });
    } catch (err) {
      // Parameterized jobs reject /build; /buildWithParameters runs them with their default values.
      if (err instanceof JenkinsError && err.status === 400) {
        await this.request(this.endpoint(jobUrl, 'buildWithParameters?delay=0sec'), { method: 'POST' });
        return;
      }
      throw err;
    }
  }

  async stopBuild(buildUrl: string): Promise<void> {
    await this.request(this.endpoint(buildUrl, 'stop'), { method: 'POST' });
  }

  private async json<T>(urlOrPath: string): Promise<T> {
    const res = await this.request(urlOrPath);
    return (await res.json()) as T;
  }

  private async request(urlOrPath: string, init: RequestInit = {}): Promise<Response> {
    const headers: Record<string, string> = {};
    if (this.auth) {
      headers.Authorization = this.auth;
    }
    let res: Response;
    try {
      res = await fetch(this.resolve(urlOrPath), {
        ...init,
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new JenkinsError(`Cannot reach Jenkins at ${this.baseUrl}: ${connectionError(err)}`);
    }
    // Redirects are never followed, so the credentials cannot be forwarded to another host. POST endpoints such
    // as /stop answer with a redirect back to the build page; anywhere else a redirect means the URL is wrong.
    if (res.status >= 300 && res.status < 400 && init.method !== 'POST') {
      const location = res.headers.get('location');
      throw new JenkinsError(
        `Jenkins redirected the request${location ? ` to ${location}` : ''}; check the Jenkins URL`,
        res.status,
      );
    }
    if (res.status >= 400) {
      const hint = res.status === 401 || res.status === 403 ? ' (check the username and API token)' : '';
      throw new JenkinsError(`Jenkins returned ${res.status} ${res.statusText}${hint}`, res.status);
    }
    return res;
  }
}
