import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { bearerAuthorized } from './auth.js';
import type { Corpus } from './corpus.js';
import { handleVaultRequest, type JsonRpcRequest } from './server.js';
import { newVaultSession, type VaultSession } from './tools.js';

/**
 * Streamable HTTP transport per the current MCP spec, hand-rolled in the
 * house style: a single /mcp endpoint, JSON responses, Mcp-Session-Id
 * assigned on initialize, 405 on GET (no server-initiated stream), DELETE
 * terminates the session. Binds localhost unless external binding is
 * explicitly opted into — that is self-host territory.
 */

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const MAX_BODY_BYTES = 4 * 1024 * 1024;

export interface VaultServerOptions {
  corpora: Map<string, Corpus>;
  secret: string;
  port: number;
  host?: string;
  /** Explicit opt-in for non-loopback binding. */
  allowExternal?: boolean;
}

export interface VaultServerHandle {
  port: number;
  host: string;
  close: () => Promise<void>;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export async function startVaultServer(options: VaultServerOptions): Promise<VaultServerHandle> {
  const host = options.host ?? '127.0.0.1';
  if (!LOOPBACK_HOSTS.has(host) && options.allowExternal !== true) {
    throw new Error(
      `refusing to bind ${host}: external binding is self-host territory and needs the explicit allowExternal opt-in (--allow-external)`,
    );
  }
  if (options.secret === '') throw new Error('an empty agent secret is not a secret');

  const sessions = new Map<string, VaultSession>();

  const sendJson = (
    res: http.ServerResponse,
    status: number,
    payload: unknown,
    headers: Record<string, string> = {},
  ): void => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(payload));
  };

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const pathname = (req.url ?? '/').split('?')[0];
    if (pathname !== '/mcp') {
      sendJson(res, 404, { error: 'not found; the MCP endpoint is /mcp' });
      return;
    }
    const authorized = bearerAuthorized(req.headers.authorization, options.secret);
    if (req.method === 'DELETE') {
      if (!authorized) {
        sendJson(res, 401, { error: 'unauthorized' }, { 'www-authenticate': 'Bearer realm="redutok-vault"' });
        return;
      }
      const sid = String(req.headers['mcp-session-id'] ?? '');
      if (!sessions.delete(sid)) {
        sendJson(res, 404, { error: 'unknown mcp session' });
        return;
      }
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST, DELETE' });
      res.end();
      return;
    }
    let rpc: JsonRpcRequest;
    try {
      rpc = JSON.parse(await readBody(req)) as JsonRpcRequest;
    } catch {
      sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
      return;
    }
    if (Array.isArray(rpc)) {
      sendJson(res, 400, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: 'batching is not supported' },
      });
      return;
    }
    if (rpc.method === 'initialize') {
      // The one unauthenticated request: the handshake carries no corpus
      // content, and the session it creates is inert without the bearer.
      const mcpSessionId = randomBytes(8).toString('hex');
      const session = newVaultSession(mcpSessionId);
      sessions.set(mcpSessionId, session);
      const response = await handleVaultRequest(rpc, { corpora: options.corpora, session }, { authorized });
      sendJson(res, 200, response, { 'mcp-session-id': mcpSessionId });
      return;
    }
    const sid = String(req.headers['mcp-session-id'] ?? '');
    const session = sessions.get(sid);
    if (session === undefined) {
      sendJson(res, 404, {
        jsonrpc: '2.0',
        id: rpc.id ?? null,
        error: { code: -32000, message: 'unknown or expired mcp session; initialize first' },
      });
      return;
    }
    if (!authorized) {
      sendJson(
        res,
        401,
        { jsonrpc: '2.0', id: rpc.id ?? null, error: { code: -32001, message: 'unauthorized' } },
        { 'www-authenticate': 'Bearer realm="redutok-vault"' },
      );
      return;
    }
    const response = await handleVaultRequest(rpc, { corpora: options.corpora, session }, { authorized });
    if (response === null) {
      res.writeHead(202);
      res.end();
      return;
    }
    sendJson(res, 200, response);
  };

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (!res.headersSent) {
        sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      } else {
        res.end();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, host, resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : options.port;

  return {
    port,
    host,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
