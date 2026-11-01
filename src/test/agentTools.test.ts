import { strict as assert } from 'node:assert';
import { afterEach, test } from 'node:test';
import { buildPath, fullName, jenkinsTools, jobPath, logPage, parameterValues } from '../agentTools';
import { JenkinsClient, JenkinsParameter } from '../jenkinsClient';

const BASE = 'https://ci.example.com/jenkins/';
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Answers each request with the first route whose pattern matches its URL, and records the requests. */
function stubRoutes(routes: [RegExp, number, unknown?][]): { url: string; init: RequestInit }[] {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    const route = routes.find(([pattern]) => pattern.test(url));
    if (!route) {
      return new Response('', { status: 404 });
    }
    return new Response(route[2] === undefined ? '' : JSON.stringify(route[2]), { status: route[1] });
  };
  return calls;
}

function tools(confirmed: boolean) {
  const host = {
    asked: [] as string[],
    changes: 0,
    client: () => new JenkinsClient(BASE, '', ''),
    confirm: async (message: string, detail: string) => {
      host.asked.push(`${message}\n${detail}`);
      return confirmed;
    },
    changed: () => void host.changes++,
  };
  const byName = Object.fromEntries(jenkinsTools(host).map((tool) => [tool.name, tool]));
  return { host, call: (name: string, args: Record<string, unknown>) => byName[name].call(args) };
}

test('job names and paths convert both ways, including multibranch branches and context paths', () => {
  assert.equal(jobPath('folder/my job'), 'job/folder/job/my%20job/');
  assert.equal(jobPath('repo/feature%2Fx'), 'job/repo/job/feature%252Fx/');
  assert.equal(fullName(new URL(jobPath('repo/feature%2Fx'), BASE).toString()), 'repo/feature%2Fx');
  assert.equal(fullName('https://ci.example.com/jenkins/job/a/job/job/'), 'a/job');
  assert.equal(fullName(BASE), '');
});

test('job URLs are taken as given, without their query', () => {
  assert.equal(jobPath('https://ci.example.com/jenkins/job/a?x=1#y'), 'https://ci.example.com/jenkins/job/a/');
});

test('job names cannot climb out of the job tree', () => {
  for (const job of ['', '/', 'a/../b', '.', 42, undefined]) {
    assert.throws(() => jobPath(job), /full name/, String(job));
  }
});

test('builds are numbers or permalinks, defaulting to the last build', () => {
  assert.equal(buildPath('a', undefined), 'job/a/lastBuild/');
  assert.equal(buildPath('a', 12), 'job/a/12/');
  assert.equal(buildPath('a', 'lastFailedBuild'), 'job/a/lastFailedBuild/');
  assert.throws(() => buildPath('a', '../../script'), /build must be/);
  assert.throws(() => buildPath('a', -1), /build must be/);
});

test('log pages show the end by default and page forward from a line', () => {
  const log = Array.from({ length: 10 }, (_, i) => `\x1b[31mline ${i + 1}\x1b[0m`).join('\n') + '\n';
  assert.equal(logPage(log, undefined, 3), 'Lines 8-10 of 10. Pass from_line to read earlier lines.\n\nline 8\nline 9\nline 10');
  assert.equal(logPage(log, 2, 2), 'Lines 2-3 of 10. Pass from_line 4 to read on.\n\nline 2\nline 3');
  assert.equal(logPage(log, 1, 100).split('\n')[0], 'Lines 1-10 of 10.');
  assert.equal(logPage(log, 11, 5), 'The console log has only 10 lines.');
  assert.equal(logPage('', undefined, 5), 'The console log is empty.');
});

test('log pages stay within the character limit, shortening huge lines', () => {
  const log = Array.from({ length: 200 }, () => 'x'.repeat(5000)).join('\n');
  const page = logPage(log, undefined, 2000);
  assert.ok(page.length < 110_000);
  assert.match(page, /^Lines 1\d\d-200 of 200\./);
  assert.match(page, /\(line shortened\)$/);
  const single = logPage('y'.repeat(500_000), undefined, 10);
  assert.match(single, /^Lines 1-1 of 1\./);
});

test('parameter values are checked against the job', () => {
  const params: JenkinsParameter[] = [
    { name: 'ENV', type: 'ChoiceParameterDefinition', choices: ['dev', 'prod'] },
    { name: 'DRY_RUN', type: 'BooleanParameterDefinition' },
    { name: 'COUNT', type: 'StringParameterDefinition' },
  ];
  assert.deepEqual(parameterValues(params, undefined), {});
  assert.deepEqual(parameterValues(params, { ENV: 'prod', DRY_RUN: false, COUNT: 3 }), { ENV: 'prod', DRY_RUN: 'false', COUNT: '3' });
  assert.throws(() => parameterValues(params, { ENV: 'staging' }), /one of: dev, prod/);
  assert.throws(() => parameterValues(params, { DRY_RUN: 'yes' }), /true or false/);
  assert.throws(() => parameterValues(params, { OTHER: 'x' }), /Unknown parameter OTHER/);
  assert.throws(() => parameterValues(params, { COUNT: { a: 1 } }), /string, number or boolean/);
  assert.throws(() => parameterValues([], { A: '1' }), /no parameters/);
  assert.throws(() => parameterValues(params, ['prod']), /must be an object/);
});

test('start_build does nothing on Jenkins until the user approves', async () => {
  const params = [{ name: 'ENV', type: 'ChoiceParameterDefinition', choices: ['dev', 'prod'] }];
  const calls = stubRoutes([
    [/api\/json/, 200, { property: [{ parameterDefinitions: params }] }],
    [/buildWithParameters/, 201],
  ]);
  const declined = tools(false);
  await assert.rejects(declined.call('start_build', { job: 'folder/deploy', parameters: { ENV: 'prod' } }), /declined/);
  assert.equal(calls.filter((call) => call.init.method === 'POST').length, 0);
  assert.match(declined.host.asked[0], /start a build of folder\/deploy\.\nParameters:\nENV: "prod"/);

  const approved = tools(true);
  await approved.call('start_build', { job: 'folder/deploy', parameters: { ENV: 'prod' } });
  const post = calls.find((call) => call.init.method === 'POST')!;
  assert.equal(post.url, 'https://ci.example.com/jenkins/job/folder/job/deploy/buildWithParameters?delay=0sec');
  assert.equal(String(post.init.body), 'ENV=prod');
  assert.equal(approved.host.changes, 1);
});

test('start_build checks parameters before asking the user', async () => {
  stubRoutes([[/api\/json/, 200, { property: [{ parameterDefinitions: [{ name: 'ENV', choices: ['dev'] }] }] }]]);
  const { host, call } = tools(true);
  await assert.rejects(call('start_build', { job: 'deploy', parameters: { ENV: 'prod' } }), /one of: dev/);
  assert.equal(host.asked.length, 0);
});

test('abort_build only asks about builds that are running', async () => {
  stubRoutes([
    [/\/7\/api\/json/, 200, { number: 7, building: false }],
    [/\/8\/api\/json/, 200, { number: 8, building: true }],
    [/\/8\/stop$/, 302],
  ]);
  const { host, call } = tools(true);
  await assert.rejects(call('abort_build', { job: 'deploy', build: 7 }), /deploy #7 is not running/);
  await assert.rejects(call('abort_build', { job: 'deploy', build: 'lastBuild' }), /number of a running build/);
  assert.equal(host.asked.length, 0);
  assert.equal(await call('abort_build', { job: 'deploy', build: 8 }), 'Abort of deploy #8 requested.');
  assert.equal(host.asked.length, 1);
});

test('list_jobs expands folders that the first request did not reach', async () => {
  const job = (name: string, url: string) => ({ _class: 'hudson.model.FreeStyleProject', name, url, color: 'red' });
  const calls = stubRoutes([
    [
      /\/jenkins\/api\/json/,
      200,
      { jobs: [job('a', `${BASE}job/a/`), { _class: 'com.cloudbees.hudson.plugins.folder.Folder', name: 'f', url: `${BASE}job/f/` }] },
    ],
    [/\/job\/f\/api\/json/, 200, { jobs: [job('b', 'http://localhost:8080/jenkins/job/f/job/b/')] }],
  ]);
  const result = JSON.parse(await tools(true).call('list_jobs', {}));
  assert.deepEqual(
    result.map((entry: { name: string; status: string; url: string }) => [entry.name, entry.status, entry.url]),
    [
      ['a', 'failed', `${BASE}job/a/`],
      ['f/b', 'failed', `${BASE}job/f/job/b/`],
    ],
  );
  assert.equal(calls.length, 2);
});
