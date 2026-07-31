import childProcess from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import { describe, expect, it, vi } from 'vitest';
import { mountCorpus } from '../src/corpus.js';
import { startVaultServer } from '../src/http.js';
import { makeCorpusDir } from './helpers.js';

const SECRET = 'no-network-secret';

describe('no outbound network from the vault process', () => {
  it('serves ask, zoom, and receipt over the inbound socket without any outbound transport', async () => {
    const temp = makeCorpusDir();
    const corpus = mountCorpus(temp.root);
    const handle = await startVaultServer({
      corpora: new Map([[corpus.name, corpus]]),
      secret: SECRET,
      port: 0,
    });
    // The listening server itself is the allowed inbound socket. The test
    // client keeps a reference to the un-spied fetch so its own requests do
    // not count as vault-side outbound calls.
    const realFetch = globalThis.fetch;
    const spies = [
      vi.spyOn(http, 'request'),
      vi.spyOn(https, 'request'),
      vi.spyOn(globalThis, 'fetch'),
      vi.spyOn(childProcess, 'spawn'),
      vi.spyOn(childProcess, 'exec'),
    ];
    try {
      const url = `http://127.0.0.1:${handle.port}/mcp`;
      const post = (body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
        realFetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
          body: JSON.stringify(body),
        });

      const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
      expect(init.status).toBe(200);
      const sessionHeaders = {
        'mcp-session-id': init.headers.get('mcp-session-id') ?? '',
        authorization: `Bearer ${SECRET}`,
      };

      const ask = await post(
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'vault_ask',
            arguments: { question: 'How does assembleAddress combine the stem with the encoded query?' },
          },
        },
        sessionHeaders,
      );
      expect(ask.status).toBe(200);
      const askBody = (await ask.json()) as { result?: { content?: { text?: string }[] } };
      const askText = askBody.result?.content?.[0]?.text ?? '';
      const zoomHandle = /vault_zoom\("(a[0-9a-f]{6})"/.exec(askText)?.[1] ?? '';
      expect(zoomHandle).not.toBe('');

      const zoom = await post(
        {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'vault_zoom', arguments: { handle: zoomHandle } },
        },
        sessionHeaders,
      );
      expect(zoom.status).toBe(200);

      const receipt = await post(
        {
          jsonrpc: '2.0',
          id: 4,
          method: 'tools/call',
          params: { name: 'vault_receipt', arguments: { scope: 'session' } },
        },
        sessionHeaders,
      );
      expect(receipt.status).toBe(200);

      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      await handle.close();
      corpus.store.close();
      corpus.ledger.close();
      temp.cleanup();
    }
  });
});
