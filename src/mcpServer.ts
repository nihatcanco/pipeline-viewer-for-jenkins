// A minimal Model Context Protocol server, so AI agents such as Claude Code can call the extension's tools.
// It speaks the Streamable HTTP transport with plain JSON replies and no sessions, which is all tool calls need.
// Kept free of `vscode` imports so it can be tested in plain Node.
import { timingSafeEqual } from 'node:crypto';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';

export interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean };
  /** Resolves to the text the agent reads. A thrown error is reported to the agent as a failed call. */
  call(args: Record<string, unknown>): Promise<string>;
}

export interface ServerInfo {
  name: string;
  title: string;
  version: string;
  instructions: string;
}

/** Newest first. The tools subset of the protocol is the same in all of them. */
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];
const MAX_BODY_BYTES = 1024 * 1024;

type Id = string | number | null;
type Message = Record<string, unknown>;

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

function isObject(value: unknown): value is Message {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function rpcError(id: Id, code: number, message: string): Message {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function reply(res: http.ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}): void {
  if (body === undefined) {
    res.writeHead(status, headers).end();
    return;
  }
  res.writeHead(status, { ...headers, 'Content-Type': 'application/json' }).end(JSON.stringify(body));
}

/** Resolves to undefined when the body is larger than the limit. */
function readBody(req: http.IncomingMessage): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) {
        chunks.push(chunk);
      }
    });
    req.on('end', () => resolve(size <= MAX_BODY_BYTES ? Buffer.concat(chunks).toString('utf8') : undefined));
    req.on('error', reject);
  });
}

export class McpServer {
  private server?: http.Server;

  constructor(
    private readonly info: ServerInfo,
    private readonly tools: Tool[],
    private readonly token: string,
  ) {}

  /** Listens on the loopback interface only and resolves to the port. Rejects with the listen error, such as EADDRINUSE. */
  listen(port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => void this.onRequest(req, res));
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        this.server = server;
        resolve((server.address() as AddressInfo).port);
      });
    });
  }

  close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  private async onRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const { port } = this.server!.address() as AddressInfo;
      // Browsers always send Origin on these requests and cannot choose the Host header. Refusing both keeps web pages,
      // including ones using DNS rebinding, from reaching the server. Agents connect without either restriction.
      const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
      if (req.headers.origin !== undefined || !hosts.includes(req.headers.host ?? '')) {
        return reply(res, 403, { error: 'Forbidden' });
      }
      if (!this.authorized(req.headers.authorization)) {
        return reply(res, 401, { error: 'Unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
      }
      if (new URL(req.url ?? '/', 'http://localhost').pathname !== '/mcp') {
        return reply(res, 404, { error: 'Not found' });
      }
      // GET would open a stream for server-initiated messages, which this server never sends.
      if (req.method !== 'POST') {
        return reply(res, 405, { error: 'Method not allowed' }, { Allow: 'POST' });
      }

      const body = await readBody(req);
      if (body === undefined) {
        return reply(res, 413, { error: 'Request too large' });
      }
      let message: unknown;
      try {
        message = JSON.parse(body);
      } catch {
        return reply(res, 400, rpcError(null, -32700, 'Parse error'));
      }

      // Older protocol versions allowed several messages in one batch.
      const replies: Message[] = [];
      for (const item of Array.isArray(message) && message.length ? message : [message]) {
        const answer = await this.handle(item);
        if (answer) {
          replies.push(answer);
        }
      }
      if (!replies.length) {
        // Only notifications, which get no answer.
        return reply(res, 202);
      }
      return reply(res, 200, Array.isArray(message) ? replies : replies[0]);
    } catch (err) {
      if (!res.headersSent) {
        reply(res, 500, { error: errorText(err) });
      }
    }
  }

  private authorized(header: string | undefined): boolean {
    const expected = Buffer.from(`Bearer ${this.token}`);
    const actual = Buffer.from(header ?? '');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  /** Answers one JSON-RPC message; resolves to undefined for notifications and responses, which need no answer. */
  async handle(message: unknown): Promise<Message | undefined> {
    if (!isObject(message) || message.jsonrpc !== '2.0') {
      return rpcError(null, -32600, 'Invalid request');
    }
    const id = message.id as Id | undefined;
    if (typeof message.method !== 'string') {
      // A response to a request from the server, which never sends any.
      return id === undefined ? rpcError(null, -32600, 'Invalid request') : undefined;
    }
    if (id === undefined) {
      return undefined;
    }
    try {
      const params = isObject(message.params) ? message.params : {};
      return { jsonrpc: '2.0', id, result: await this.dispatch(message.method, params) };
    } catch (err) {
      return err instanceof RpcError ? rpcError(id, err.code, err.message) : rpcError(id, -32603, errorText(err));
    }
  }

  private async dispatch(method: string, params: Message): Promise<Message> {
    switch (method) {
      case 'initialize': {
        const requested = String(params.protocolVersion);
        return {
          protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: this.info.name, title: this.info.title, version: this.info.version },
          instructions: this.info.instructions,
        };
      }
      case 'ping':
        return {};
      case 'tools/list':
        return { tools: this.tools.map(({ call, ...tool }) => tool) };
      case 'tools/call': {
        const tool = this.tools.find((candidate) => candidate.name === params.name);
        if (!tool) {
          throw new RpcError(-32602, `Unknown tool: ${String(params.name)}`);
        }
        try {
          const text = await tool.call(isObject(params.arguments) ? params.arguments : {});
          return { content: [{ type: 'text', text }] };
        } catch (err) {
          // Failures go back as a result rather than a protocol error, so the agent reads the reason and can adjust.
          return { content: [{ type: 'text', text: errorText(err) }], isError: true };
        }
      }
      default:
        throw new RpcError(-32601, `Method not found: ${method}`);
    }
  }
}
