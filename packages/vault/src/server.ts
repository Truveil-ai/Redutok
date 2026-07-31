import type { Corpus } from './corpus.js';
import { vaultAsk, vaultReceipt, vaultZoom, type VaultSession } from './tools.js';

export { newVaultSession, type VaultSession } from './tools.js';

/**
 * Transport-agnostic JSON-RPC core, in the same hand-rolled house style as
 * packages/mcp. The transport decides `authorized`; only the initialize
 * handshake is served without it. Tool failures are explicit isError
 * results — there is no raw fallback path to a chat client.
 */

export const PROTOCOL_VERSION = '2025-06-18';

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface VaultDeps {
  corpora: Map<string, Corpus>;
  session: VaultSession;
}

export const TOOLS = [
  {
    name: 'vault_ask',
    description:
      'Ask a question about the mounted corpus. Returns a dossier: verdict, file:line evidence, a zoom handle for every elision, and a mandatory accounting block (raw bytes and estimated tokens touched versus served for this ask).',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question to answer from the corpus' },
        corpus: { type: 'string', description: 'Corpus name when more than one is mounted' },
      },
      required: ['question'],
    },
  },
  {
    name: 'vault_zoom',
    description:
      'Recover the raw artifact behind a vault handle (artifact id like a1b2c3 or file ref like F1a2b@hash), byte-recoverable, optionally sliced by a query. id is an accepted alias for handle.',
    inputSchema: {
      type: 'object',
      properties: {
        handle: { type: 'string', description: 'Reference from a dossier or elision marker' },
        query: { type: 'string', description: 'Optional slice query (symbol name or text)' },
        corpus: { type: 'string', description: 'Corpus name when more than one is mounted' },
      },
      required: ['handle'],
    },
  },
  {
    name: 'vault_receipt',
    description:
      'Ledger rollup of tokens avoided with artifact backing, cost avoided at current API rates from prices.yaml (rate row cited), and Wh/gCO2e bands per METHODOLOGY.md. scope "session" (default) covers this MCP session; "day", "month", and "corpus" cut the persistent ledger by time or lifetime; "document" ranks the documents consumed. json returns the rollup as JSON instead of the human render.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['session', 'day', 'month', 'corpus', 'document'] },
        day: { type: 'string', description: 'YYYY-MM-DD (UTC) for scope "day"; defaults to today' },
        month: {
          type: 'string',
          description: 'YYYY-MM (UTC) for scope "month"; defaults to the current month',
        },
        json: { type: 'boolean', description: 'Return the rollup as JSON' },
        corpus: { type: 'string', description: 'Corpus name when more than one is mounted' },
      },
    },
  },
];

export async function handleVaultRequest(
  req: JsonRpcRequest,
  deps: VaultDeps,
  ctx: { authorized: boolean },
): Promise<JsonRpcResponse | null> {
  const id = req.id ?? null;
  const reply = (result: unknown): JsonRpcResponse => ({ jsonrpc: '2.0', id, result });
  const fail = (code: number, message: string): JsonRpcResponse => ({
    jsonrpc: '2.0',
    id,
    error: { code, message },
  });
  if (req.method.startsWith('notifications/')) return null;
  if (req.method === 'initialize') {
    return reply({
      protocolVersion: PROTOCOL_VERSION,
      serverInfo: { name: 'redutok-vault', version: '0.0.1' },
      capabilities: { tools: {} },
    });
  }
  if (!ctx.authorized) {
    return fail(
      -32001,
      'unauthorized: a bearer agent secret is required for everything beyond the initialize handshake',
    );
  }
  if (req.method === 'tools/list') return reply({ tools: TOOLS });
  if (req.method === 'tools/call') {
    const params = (req.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
    const args = params.arguments ?? {};
    const run: Record<string, () => Promise<string> | string> = {
      vault_ask: () => vaultAsk(deps.corpora, deps.session, args),
      vault_zoom: () => vaultZoom(deps.corpora, deps.session, args),
      vault_receipt: () => vaultReceipt(deps.corpora, deps.session, args),
    };
    const fn = run[params.name ?? ''];
    if (fn === undefined) return fail(-32602, `unknown tool ${String(params.name)}`);
    try {
      return reply({ content: [{ type: 'text', text: await fn() }] });
    } catch (err) {
      // Guardrail: failures are explicit tool errors, never silence.
      const message = err instanceof Error ? err.message : String(err);
      return reply({
        content: [{ type: 'text', text: `${String(params.name)} failed: ${message}` }],
        isError: true,
      });
    }
  }
  return fail(-32601, `method not found: ${req.method}`);
}
