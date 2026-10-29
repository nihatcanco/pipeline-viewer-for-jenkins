import { strict as assert } from 'node:assert';
import { afterEach, test } from 'node:test';
import { JenkinsClient, JenkinsError, displayName } from '../jenkinsClient';

const BASE = 'https://ci.example.com/jenkins/';
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Replaces fetch with a stub that records every request and answers with the given status. */
function stubFetch(status: number, body = '{}', headers: Record<string, string> = {}): { url: string; init: RequestInit }[] {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(body, { status, headers });
  };
  return calls;
}

test('resolve keeps the path of absolute URLs but always targets the configured server', () => {
  const client = new JenkinsClient(BASE, '', '');
  assert.equal(client.resolve('http://localhost:8080/jenkins/job/a/'), 'https://ci.example.com/jenkins/job/a/');
  assert.equal(client.resolve('//attacker.example/x'), 'https://ci.example.com/x');
  assert.equal(client.resolve('job/a/'), 'https://ci.example.com/jenkins/job/a/');
});

test('resolve refuses URLs that cannot be pinned to the configured server', () => {
  const client = new JenkinsClient(BASE, '', '');
  for (const url of ['javascript:alert(1)', 'data:text/plain,hi', 'file:///etc/passwd']) {
    assert.throws(() => client.resolve(url), JenkinsError, url);
  }
});

test('resolve refuses a configured URL that is not http or https', () => {
  assert.throws(() => new JenkinsClient('file:///tmp/', '', '').resolve('job/a/'), JenkinsError);
});

test('requests carry the credentials and never follow redirects', async () => {
  const calls = stubFetch(200, '{"jobs":[]}');
  await new JenkinsClient(BASE, 'alice', 's3cret').getJobs();
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /^https:\/\/ci\.example\.com\/jenkins\/api\/json\?tree=/);
  assert.equal(calls[0].init.redirect, 'manual');
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers.Authorization, 'Basic ' + Buffer.from('alice:s3cret').toString('base64'));
});

test('anonymous clients send no Authorization header', async () => {
  const calls = stubFetch(200, '{"jobs":[]}');
  await new JenkinsClient(BASE, '', '').getJobs();
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, undefined);
});

test('item URLs cannot add query parameters to an action', async () => {
  const calls = stubFetch(201);
  await new JenkinsClient(BASE, '', '').triggerBuild('/jenkins/scriptText?script=evil&x=#frag');
  assert.equal(calls[0].url, 'https://ci.example.com/jenkins/scriptText/build?delay=0sec');
  assert.equal(calls[0].init.method, 'POST');
});

test('parameters are read from the job properties, or from its actions on older Jenkins', async () => {
  const param = { name: 'ENV', type: 'ChoiceParameterDefinition', choices: ['dev', 'prod'] };
  stubFetch(200, JSON.stringify({ property: [{}, { parameterDefinitions: [param] }] }));
  assert.deepEqual(await new JenkinsClient(BASE, '', '').getParameters(`${BASE}job/a/`), [param]);
  stubFetch(200, JSON.stringify({ property: [], actions: [null, { parameterDefinitions: [param] }] }));
  assert.deepEqual(await new JenkinsClient(BASE, '', '').getParameters(`${BASE}job/a/`), [param]);
  stubFetch(200, JSON.stringify({ property: [{}], actions: [{}] }));
  assert.deepEqual(await new JenkinsClient(BASE, '', '').getParameters(`${BASE}job/a/`), []);
});

test('parameter values are sent in the request body, not the URL', async () => {
  const calls = stubFetch(201);
  await new JenkinsClient(BASE, '', '').triggerBuildWithParameters(`${BASE}job/a/`, { ENV: 'prod', TAG: 'a&b=c' });
  assert.equal(calls[0].url, 'https://ci.example.com/jenkins/job/a/buildWithParameters?delay=0sec');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(String(calls[0].init.body), 'ENV=prod&TAG=a%26b%3Dc');
});

test('a redirect on a read is reported instead of parsed', async () => {
  stubFetch(302, '', { location: 'https://sso.example.com/login' });
  await assert.rejects(new JenkinsClient(BASE, '', '').getJobs(), (err: JenkinsError) => {
    assert.equal(err.status, 302);
    assert.match(err.message, /sso\.example\.com/);
    return true;
  });
});

test('a redirect after a POST counts as success', async () => {
  stubFetch(302, '', { location: `${BASE}job/a/1/` });
  await new JenkinsClient(BASE, '', '').stopBuild(`${BASE}job/a/1/`);
});

test('an untrusted certificate is explained in terms of VS Code, not Node flags', async () => {
  globalThis.fetch = async () => {
    throw new TypeError('fetch failed', {
      cause: Object.assign(
        new Error('self-signed certificate; if the root CA is installed locally, try running Node.js with --use-system-ca'),
        { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' },
      ),
    });
  };
  await assert.rejects(new JenkinsClient(BASE, '', '').getJobs(), (err: JenkinsError) => {
    assert.match(err.message, /not trusted \(self-signed certificate\)/);
    assert.match(err.message, /operating system's trusted certificates/);
    assert.doesNotMatch(err.message, /--use-system-ca/);
    return true;
  });
});

test('other connection failures keep the underlying reason', async () => {
  globalThis.fetch = async () => {
    throw new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND ci.example.com'), { code: 'ENOTFOUND' }) });
  };
  await assert.rejects(new JenkinsClient(BASE, '', '').getJobs(), /Cannot reach Jenkins at https:\/\/ci\.example\.com\/jenkins\/: getaddrinfo ENOTFOUND/);
});

test('displayName decodes branch names and tolerates a literal %', () => {
  assert.equal(displayName({ _class: '', url: '', name: 'feature%2Flogin' }), 'feature/login');
  assert.equal(displayName({ _class: '', url: '', name: '100% done' }), '100% done');
  assert.equal(displayName({ _class: '', url: '', name: 'x', displayName: 'Shown' }), 'Shown');
});
