import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mountCorpus, type Corpus } from '../src/corpus.js';
import { startVaultServer, type VaultServerHandle } from '../src/http.js';
import { PROTOCOL_VERSION } from '../src/server.js';
import { makeCorpusDir, type TempCorpus } from './helpers.js';

const SECRET = 'http-test-agent-secret';

let temp: TempCorpus;
let corpus: Corpus;
let handle: VaultServerHandle;
let url = '';
let sessionId = '';

beforeAll(async () => {
  temp = makeCorpusDir();
  corpus = mountCorpus(temp.root);
  handle = await startVaultServer({
    corpora: new Map([[corpus.name, corpus]]),
    secret: SECRET,
    port: 0,
  });
  url = `http://127.0.0.1:${handle.port}/mcp`;
});

afterAll(async () => {
  await handle.close();
  corpus.store.close();
  temp.cleanup();
});

function post(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

const auth = { authorization: `Bearer ${SECRET}` };

const initializeBody = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'test-client', version: '0' } },
};

describe('streamable HTTP transport', () => {
  it('binds localhost by default and refuses external binding without the opt-in', async () => {
    expect(handle.host).toBe('127.0.0.1');
    await expect(
      startVaultServer({
        corpora: new Map([[corpus.name, corpus]]),
        secret: SECRET,
        port: 0,
        host: '0.0.0.0',
      }),
    ).rejects.toThrow(/allowExternal/);
  });

  it('answers the initialize handshake without a bearer and assigns a session id', async () => {
    const res = await post(initializeBody);
    expect(res.status).toBe(200);
    sessionId = res.headers.get('mcp-session-id') ?? '';
    expect(sessionId).not.toBe('');
    const body = (await res.json()) as { result?: { protocolVersion?: string } };
    expect(body.result?.protocolVersion).toBe(PROTOCOL_VERSION);
  });

  it('rejects requests without the bearer', async () => {
    const res = await post(
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { 'mcp-session-id': sessionId },
    );
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('Bearer');
  });

  it('rejects a wrong bearer', async () => {
    const res = await post(
      { jsonrpc: '2.0', id: 3, method: 'tools/list' },
      { 'mcp-session-id': sessionId, authorization: `Bearer ${SECRET}-wrong` },
    );
    expect(res.status).toBe(401);
  });

  it('rejects an unknown session id', async () => {
    const res = await post(
      { jsonrpc: '2.0', id: 4, method: 'tools/list' },
      { 'mcp-session-id': 'not-a-session', ...auth },
    );
    expect(res.status).toBe(404);
  });

  it('serves tools/list and a real vault_ask with the bearer', async () => {
    const list = await post(
      { jsonrpc: '2.0', id: 5, method: 'tools/list' },
      { 'mcp-session-id': sessionId, ...auth },
    );
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { result?: { tools?: { name: string }[] } };
    expect(listBody.result?.tools?.map((t) => t.name)).toContain('vault_ask');

    const ask = await post(
      {
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: {
          name: 'vault_ask',
          arguments: { question: 'How does combineSegments join the base and the relative segment?' },
        },
      },
      { 'mcp-session-id': sessionId, ...auth },
    );
    expect(ask.status).toBe(200);
    const askBody = (await ask.json()) as {
      result?: { content?: { text?: string }[]; isError?: boolean };
    };
    expect(askBody.result?.isError).not.toBe(true);
    expect(askBody.result?.content?.[0]?.text).toContain('[vault accounting: ask ');
  });

  it('accepts notifications with 202 and no body', async () => {
    const res = await post(
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { 'mcp-session-id': sessionId, ...auth },
    );
    expect(res.status).toBe(202);
    expect(await res.text()).toBe('');
  });

  it('answers GET with 405 (no server-initiated stream)', async () => {
    const res = await fetch(url, { headers: { accept: 'text/event-stream' } });
    expect(res.status).toBe(405);
  });

  it('answers unknown paths with 404', async () => {
    const res = await fetch(`http://127.0.0.1:${handle.port}/other`, { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('terminates the session on DELETE', async () => {
    const del = await fetch(url, { method: 'DELETE', headers: { 'mcp-session-id': sessionId, ...auth } });
    expect(del.status).toBe(204);
    const after = await post(
      { jsonrpc: '2.0', id: 8, method: 'tools/list' },
      { 'mcp-session-id': sessionId, ...auth },
    );
    expect(after.status).toBe(404);
  });
});
