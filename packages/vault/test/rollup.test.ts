import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mountCorpus, type Corpus } from '../src/corpus.js';
import { makeLedgerLine, type LedgerLine } from '../src/ledger.js';
import { rollupLines, type RollupQuery } from '../src/rollup.js';
import { handleVaultRequest, newVaultSession, type VaultDeps } from '../src/server.js';
import { makeCorpusDir, type TempCorpus } from './helpers.js';

/**
 * Session 3 contracts: vault_receipt gains scopes (session, day, month,
 * corpus lifetime, per-document) rolled up from the ledger, with json output
 * alongside the human render.
 */

interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}

const line = (over: Partial<Parameters<typeof makeLedgerLine>[0]>): LedgerLine =>
  makeLedgerLine({
    kind: 'serve',
    corpus: 'demo',
    sessionId: 'vault-team-a',
    timestamp: '2026-07-05T10:00:00.000Z',
    rawBytes: 4000,
    servedBytes: 400,
    artifactRefs: ['a111111'],
    auditIds: ['e1'],
    ...over,
  });

const roll = (lines: LedgerLine[], query: RollupQuery) =>
  rollupLines(lines, query, { corpus: 'demo', corpusResidentTokens: 50_000 });

describe('rollup scopes over ledger lines', () => {
  it('filters by month and by day from the line timestamps', () => {
    const lines = [
      line({ timestamp: '2026-07-05T10:00:00.000Z' }),
      line({ timestamp: '2026-07-28T23:59:00.000Z' }),
      line({ timestamp: '2026-06-30T10:00:00.000Z' }),
    ];
    const july = roll(lines, { scope: 'month', month: '2026-07' });
    expect(july.month).toBe('2026-07');
    expect(july.avoidedTokens).toBe(2 * (1000 - 100));
    const day = roll(lines, { scope: 'day', day: '2026-07-05' });
    expect(day.day).toBe('2026-07-05');
    expect(day.avoidedTokens).toBe(1000 - 100);
  });

  it('filters session scope by session id and counts distinct sessions', () => {
    const lines = [
      line({}),
      line({ sessionId: 'vault-team-b', timestamp: '2026-07-06T10:00:00.000Z' }),
    ];
    const session = roll(lines, { scope: 'session', sessionId: 'vault-team-b' });
    expect(session.sessionId).toBe('vault-team-b');
    expect(session.avoidedTokens).toBe(1000 - 100);
    const corpusWide = roll(lines, { scope: 'corpus' });
    expect(corpusWide.sessions).toBe(2);
    expect(corpusWide.avoidedTokens).toBe(2 * (1000 - 100));
  });

  it('sums totals from serve and zoom lines only, never the ask line on top', () => {
    const lines = [
      line({ kind: 'ask', askId: 'vault-team-a#ask1', rawBytes: 8000, servedBytes: 200 }),
      line({ kind: 'serve', askId: 'vault-team-a#ask1', rawBytes: 4000, servedBytes: 400 }),
      line({ kind: 'serve', askId: 'vault-team-a#ask1', rawBytes: 4000, servedBytes: 600 }),
      line({ kind: 'zoom', rawBytes: 2000, servedBytes: 2000 }),
    ];
    const r = roll(lines, { scope: 'corpus' });
    expect(r.asks).toBe(1);
    expect(r.serves).toBe(2);
    expect(r.zooms).toBe(1);
    expect(r.rawTokens).toBe(1000 + 1000 + 500);
    expect(r.avoidedTokens).toBe((1000 - 100) + (1000 - 150) + 0);
    expect(r.costAvoidedUsd).toBeCloseTo(
      lines.filter((l) => l.kind !== 'ask').reduce((n, l) => n + l.costAvoidedUsd, 0),
      12,
    );
  });

  it('ranks documents by reads, then tokens avoided', () => {
    const lines = [
      line({ document: 'contracts/msa.pdf', rawBytes: 1000, servedBytes: 900 }),
      line({ document: 'contracts/msa.pdf', rawBytes: 1000, servedBytes: 900 }),
      line({ document: 'contracts/msa.pdf', rawBytes: 1000, servedBytes: 900 }),
      line({ document: 'contracts/nda.pdf', rawBytes: 400_000, servedBytes: 4000 }),
    ];
    const r = roll(lines, { scope: 'document' });
    expect(r.documents.map((d) => d.document)).toEqual(['contracts/msa.pdf', 'contracts/nda.pdf']);
    expect(r.documents[0]?.reads).toBe(3);
    expect(r.documents[1]?.avoidedTokens).toBe(100_000 - 1000);
    const tied = roll(
      [
        line({ document: 'a.md', rawBytes: 1000, servedBytes: 900 }),
        line({ document: 'b.md', rawBytes: 100_000, servedBytes: 1000 }),
      ],
      { scope: 'document' },
    );
    expect(tied.documents.map((d) => d.document)).toEqual(['b.md', 'a.md']);
  });

  it('ranks sessions by tokens avoided', () => {
    const lines = [
      line({ sessionId: 'vault-small', rawBytes: 1000, servedBytes: 900 }),
      line({ sessionId: 'vault-big', rawBytes: 100_000, servedBytes: 1000 }),
      line({ kind: 'ask', sessionId: 'vault-big', askId: 'vault-big#ask1' }),
    ];
    const r = roll(lines, { scope: 'corpus' });
    expect(r.topSessions.map((s) => s.sessionId)).toEqual(['vault-big', 'vault-small']);
    expect(r.topSessions[0]?.asks).toBe(1);
    expect(r.topSessions[1]?.asks).toBe(0);
  });
});

describe('vault_receipt scopes over a live corpus', () => {
  let temp: TempCorpus;
  let corpus: Corpus;
  let deps: VaultDeps;

  async function call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const res = await handleVaultRequest(
      { jsonrpc: '2.0', id: 21, method: 'tools/call', params: { name, arguments: args } },
      deps,
      { authorized: true },
    );
    return res?.result as ToolResult;
  }

  const textOf = (r: ToolResult): string => r.content[0]?.text ?? '';

  beforeAll(async () => {
    temp = makeCorpusDir();
    corpus = mountCorpus(temp.root, { name: 'scopecorp' });
    deps = { corpora: new Map([[corpus.name, corpus]]), session: newVaultSession('scope-test') };
    await call('vault_ask', {
      question:
        'How does combineSegments assemble the final address from the base and the relative segment?',
    });
  }, 120_000);

  afterAll(() => {
    corpus.store.close();
    corpus.ledger.close();
    temp.cleanup();
  });

  it('serves month and day scopes that cover the just-written lines', async () => {
    const month = textOf(await call('vault_receipt', { scope: 'month' }));
    expect(month).toContain(`scope: month`);
    expect(month).toContain(new Date().toISOString().slice(0, 7));
    expect(month).toMatch(/avoided [\d,]+ tok/);
    const day = textOf(await call('vault_receipt', { scope: 'day' }));
    expect(day).toContain(new Date().toISOString().slice(0, 10));
    expect(day).toMatch(/avoided [\d,]+ tok/);
  });

  it('serves a per-document scope naming what was consumed', async () => {
    const text = textOf(await call('vault_receipt', { scope: 'document' }));
    expect(text).toContain('url-builder.ts');
    expect(text).toMatch(/\d+ read/);
  });

  it('serves json output that matches the human render', async () => {
    const raw = textOf(await call('vault_receipt', { scope: 'month', json: true }));
    const parsed = JSON.parse(raw) as { scope: string; month?: string; avoidedTokens: number };
    expect(parsed.scope).toBe('month');
    expect(parsed.month).toBe(new Date().toISOString().slice(0, 7));
    expect(parsed.avoidedTokens).toBeGreaterThan(0);
    const human = textOf(await call('vault_receipt', { scope: 'month' }));
    expect(human).toContain(parsed.avoidedTokens.toLocaleString('en-US'));
  });

  it('still rejects an unknown scope explicitly', async () => {
    const res = await call('vault_receipt', { scope: 'week' });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/unknown scope/);
  });
});
