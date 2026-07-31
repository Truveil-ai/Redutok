import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mountCorpus, type Corpus } from '../src/corpus.js';
import { startVaultServer, type VaultServerHandle } from '../src/http.js';
import { createStdioHandler } from '../src/main.js';
import type { JsonRpcResponse } from '../src/server.js';
import { makeCorpusDir, type TempCorpus } from './helpers.js';

const SECRET = 'session-identity-secret';

let temp: TempCorpus;
let corpus: Corpus;
let corpora: Map<string, Corpus>;
let handle: VaultServerHandle;

beforeAll(async () => {
  temp = makeCorpusDir();
  corpus = mountCorpus(temp.root, { name: 'idcorp' });
  corpora = new Map([[corpus.name, corpus]]);
  handle = await startVaultServer({ corpora, secret: SECRET, port: 0 });
});

afterAll(async () => {
  await handle.close();
  corpus.store.close();
  corpus.ledger.close();
  temp.cleanup();
});

const post = (body: unknown, headers: Record<string, string> = {}) =>
  fetch(`http://127.0.0.1:${handle.port}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
};

async function receiptSession(mcpSessionId: string): Promise<string> {
  const res = await post(
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'vault_receipt', arguments: {} } },
    { 'mcp-session-id': mcpSessionId, authorization: `Bearer ${SECRET}` },
  );
  const body = (await res.json()) as { result?: { content?: { text?: string }[] } };
  const text = body.result?.content?.[0]?.text ?? '';
  return /session\s+(\S+)/.exec(text)?.[1] ?? '';
}

describe('session identity over http', () => {
  it('an explicit X-Vault-Session names the vault session', async () => {
    const init = await post(INIT, { 'x-vault-session': 'matter-451' });
    expect(init.status).toBe(200);
    const mcpSessionId = init.headers.get('mcp-session-id') ?? '';
    expect(await receiptSession(mcpSessionId)).toBe('vault-matter-451');
  });

  it('rejects a malformed X-Vault-Session instead of silently ignoring it', async () => {
    const init = await post(INIT, { 'x-vault-session': 'bad session!' });
    expect(init.status).toBe(400);
  });

  it('without the header, each initialize gets its own generated id', async () => {
    const first = await post(INIT);
    const second = await post(INIT);
    const a = await receiptSession(first.headers.get('mcp-session-id') ?? '');
    const b = await receiptSession(second.headers.get('mcp-session-id') ?? '');
    expect(a).not.toBe('');
    expect(b).not.toBe('');
    expect(a).not.toBe(b);
  });
});

describe('session identity over stdio', () => {
  it('each initialize gets a fresh session, never a shared per-process id', async () => {
    const handler = createStdioHandler(corpora);
    const sessionOf = async (): Promise<string> => {
      await handler(JSON.stringify(INIT));
      const res = (await handler(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'vault_receipt', arguments: {} },
        }),
      )) as JsonRpcResponse & { result?: { content?: { text?: string }[] } };
      const text = res.result?.content?.[0]?.text ?? '';
      return /session\s+(\S+)/.exec(text)?.[1] ?? '';
    };
    const a = await sessionOf();
    const b = await sessionOf();
    expect(a).not.toBe('');
    expect(b).not.toBe('');
    expect(a).not.toBe(b);
  });

  it('tool calls before any initialize are refused, not served on a fallback id', async () => {
    const handler = createStdioHandler(corpora);
    const res = (await handler(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'vault_receipt', arguments: {} },
      }),
    )) as JsonRpcResponse;
    expect(res?.error?.message ?? '').toMatch(/initialize/i);
  });
});
