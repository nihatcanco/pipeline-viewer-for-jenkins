import { strict as assert } from 'node:assert';
import * as http from 'node:http';
import { after, before, test } from 'node:test';
import { McpServer, Tool } from '../mcpServer';

const TOKEN = 'test-token';
const tools: Tool[] = [
  {
    name: 'echo',
    title: 'Echo',
    description: 'Returns its text argument.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    annotations: { readOnlyHint: true },
    call: async (args) => `echo: ${String(args.text)}`,
  },
  {
    name: 'fail',
    title: 'Fail',
    description: 'Always fails.',
    inputSchema: { type: 'object' },
    annotations: {},
    call: async () => {
      throw new Error('it broke');
    },
  },
];

const server = new McpServer({ name: 'test', title: 'Test', version: '1.2.3', instructions: 'Be nice.' }, tools, TOKEN);
let port: number;

before(async () => {
  port = await server.listen(0);
});
after(() => server.close());

interface Reply {
  status: number;
  body: any;
}

/** Uses http.request rather than fetch, which does not let a test choose the Host header. */
function post(body: unknown, headers: Record<string, string> = {}, method = 'POST', path = '/mcp'): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
        headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...headers },
      },
      (res) => {
        let text = '';
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => resolve({ status: res.statusCode!, body: text ? JSON.parse(text) : undefined }));
      },
    );
    req.on('error', reject);
    req.end(typeof body === 'string' ? body : JSON.stringify(body));
  });
}

const rpc = (method: string, params?: unknown, id = 1) => ({ jsonrpc: '2.0', id, method, params });
const notification = (method: string) => ({ jsonrpc: '2.0', method });

test('requests without the right token are refused', async () => {
  assert.equal((await post(rpc('ping'), { Authorization: '' })).status, 401);
  assert.equal((await post(rpc('ping'), { Authorization: 'Bearer wrong-token' })).status, 401);
  assert.equal((await post(rpc('ping'), { Authorization: `Bearer ${TOKEN}x` })).status, 401);
});

test('browser requests are refused even with the token', async () => {
  assert.equal((await post(rpc('ping'), { Origin: 'https://evil.example' })).status, 403);
  // A DNS rebinding page reaches 127.0.0.1 under its own host name.
  assert.equal((await post(rpc('ping'), { Host: `evil.example:${port}` })).status, 403);
  assert.equal((await post(rpc('ping'), { Host: `localhost:${port}` })).status, 200);
});

test('only POST to /mcp is served', async () => {
  assert.equal((await post(rpc('ping'), {}, 'POST', '/other')).status, 404);
  assert.equal((await post('', {}, 'GET')).status, 405);
});

test('initialize agrees on a protocol version the client supports, or offers the newest', async () => {
  const { body } = await post(rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {} }));
  assert.equal(body.result.protocolVersion, '2025-06-18');
  assert.deepEqual(body.result.serverInfo, { name: 'test', title: 'Test', version: '1.2.3' });
  assert.equal(body.result.instructions, 'Be nice.');
  assert.ok(body.result.capabilities.tools);
  const newer = await post(rpc('initialize', { protocolVersion: '2099-01-01' }));
  assert.equal(newer.body.result.protocolVersion, '2025-11-25');
});

test('notifications are accepted without an answer', async () => {
  const reply = await post(notification('notifications/initialized'));
  assert.equal(reply.status, 202);
  assert.equal(reply.body, undefined);
});

test('tools/list describes the tools without their implementation', async () => {
  const { body } = await post(rpc('tools/list'));
  assert.deepEqual(
    body.result.tools.map((tool: Tool) => tool.name),
    ['echo', 'fail'],
  );
  assert.equal(body.result.tools[0].call, undefined);
  assert.deepEqual(body.result.tools[0].annotations, { readOnlyHint: true });
});

test('tools/call returns the text, and reports a failing tool as an error result', async () => {
  const ok = await post(rpc('tools/call', { name: 'echo', arguments: { text: 'hi' } }));
  assert.deepEqual(ok.body.result, { content: [{ type: 'text', text: 'echo: hi' }] });
  const failed = await post(rpc('tools/call', { name: 'fail', arguments: {} }));
  assert.deepEqual(failed.body.result, { content: [{ type: 'text', text: 'it broke' }], isError: true });
  const unknown = await post(rpc('tools/call', { name: 'missing' }));
  assert.equal(unknown.body.error.code, -32602);
});

test('malformed messages get JSON-RPC errors', async () => {
  const parse = await post('{not json');
  assert.equal(parse.status, 400);
  assert.equal(parse.body.error.code, -32700);
  assert.equal((await post({ id: 1, method: 'ping' })).body.error.code, -32600);
  assert.equal((await post(rpc('resources/list'))).body.error.code, -32601);
});

test('batches get one answer per request', async () => {
  const { body } = await post([rpc('ping', undefined, 1), notification('notifications/initialized'), rpc('ping', undefined, 2)]);
  assert.deepEqual(body, [
    { jsonrpc: '2.0', id: 1, result: {} },
    { jsonrpc: '2.0', id: 2, result: {} },
  ]);
});

test('oversized requests are refused', async () => {
  assert.equal((await post(JSON.stringify({ padding: 'x'.repeat(1024 * 1024) }))).status, 413);
});
