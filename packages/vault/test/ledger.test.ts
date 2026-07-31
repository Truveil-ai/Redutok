import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  loadEnergyFactors,
  loadGridIntensity,
  loadPrices,
  readAuditFile,
} from '@redutok/shared';
import { mountCorpus, type Corpus } from '../src/corpus.js';
import { VaultLedger, type LedgerLine } from '../src/ledger.js';
import { handleVaultRequest, newVaultSession, type VaultDeps } from '../src/server.js';
import { makeCorpusDir, type TempCorpus } from './helpers.js';

/**
 * Session 3 contracts: every ask, zoom, and internal serve appends to a
 * per-corpus SQLite ledger alongside the store. Ledger and audit reconcile
 * by construction; the ledger survives restarts.
 */

interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}

const tok = (bytes: number): number => Math.round(bytes / 4);

let temp: TempCorpus;
let corpus: Corpus;
let deps: VaultDeps;
let askText = '';
let zoomHandle = '';

async function call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const res = await handleVaultRequest(
    { jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name, arguments: args } },
    deps,
    { authorized: true },
  );
  return res?.result as ToolResult;
}

const textOf = (r: ToolResult): string => r.content[0]?.text ?? '';

beforeAll(async () => {
  temp = makeCorpusDir();
  corpus = mountCorpus(temp.root, { name: 'ledgercorp' });
  deps = { corpora: new Map([[corpus.name, corpus]]), session: newVaultSession('ledger-test') };
  askText = textOf(
    await call('vault_ask', {
      question:
        'How does combineSegments assemble the final address from the base and the relative segment?',
    }),
  );
  await call('vault_ask', {
    question: 'Where does encodeQuery sort and encode the query params before appending?',
  });
  zoomHandle = /vault_zoom\("(a[0-9a-f]{6})"/.exec(askText)?.[1] ?? '';
  expect(zoomHandle).not.toBe('');
  await call('vault_zoom', { handle: zoomHandle });
}, 120_000);

afterAll(() => {
  corpus.store.close();
  corpus.ledger.close();
  temp.cleanup();
});

const sessionLines = (): LedgerLine[] =>
  corpus.ledger.lines({ sessionId: deps.session.id });

describe('persistent vault ledger', () => {
  it('lives alongside the store and appends a line per ask, zoom, and serve', () => {
    expect(existsSync(path.join(temp.root, '.dcp', 'ledger.db'))).toBe(true);
    const lines = sessionLines();
    expect(lines.filter((l) => l.kind === 'ask')).toHaveLength(2);
    expect(lines.filter((l) => l.kind === 'zoom')).toHaveLength(1);
    expect(lines.filter((l) => l.kind === 'serve').length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line.corpus).toBe('ledgercorp');
      expect(line.sessionId).toBe(deps.session.id);
      expect(line.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });

  it('cites the rate row and carries energy bands on every line', () => {
    const row = loadPrices().models.find((m) => m.id === sessionLines()[0]?.referenceModel);
    expect(row).toBeDefined();
    const cls = loadEnergyFactors().classes.find((c) =>
      c.models.includes(sessionLines()[0]?.referenceModel ?? ''),
    );
    expect(cls).toBeDefined();
    const grid = loadGridIntensity();
    const gridRow = grid.regions.find((r) => r.region === grid.defaultRegion);
    for (const line of sessionLines()) {
      expect(line.inputPerMTokUsd).toBe(row?.inputPerMTokUsd);
      expect(line.priceSource).toBe(row?.source);
      expect(line.costAvoidedUsd).toBeCloseTo(
        (line.avoidedTokens / 1e6) * (row?.inputPerMTokUsd ?? 0),
        10,
      );
      expect(line.wh.base).toBeCloseTo((line.avoidedTokens / 1e6) * (cls?.whPerMTok.base ?? 0), 10);
      expect(line.wh.low).toBeLessThanOrEqual(line.wh.base);
      expect(line.wh.base).toBeLessThanOrEqual(line.wh.high);
      expect(line.gCo2e.base).toBeCloseTo((line.wh.base / 1000) * (gridRow?.gCo2ePerKwh ?? 0), 10);
      expect(line.region).toBe(grid.defaultRegion);
    }
  });

  it('reconciles serve and zoom lines with the audit trail by construction', () => {
    const events = readAuditFile(corpus.auditPath).events.filter(
      (e) => typeof e.sessionId === 'string' && e.sessionId.startsWith(deps.session.id),
    );
    const measured = events.filter((e) => e.bytesIn !== undefined && e.bytesOut !== undefined);
    const auditAvoided = measured.reduce(
      (n, e) => n + Math.max(0, tok(e.bytesIn ?? 0) - tok(e.bytesOut ?? 0)),
      0,
    );
    const counted = sessionLines().filter((l) => l.kind !== 'ask');
    const ledgerAvoided = counted.reduce((n, l) => n + l.avoidedTokens, 0);
    expect(ledgerAvoided).toBe(auditAvoided);
    expect(ledgerAvoided).toBeGreaterThan(0);
    const auditIds = new Set(events.map((e) => e.id));
    for (const line of counted) {
      expect(line.auditIds.length).toBeGreaterThan(0);
      for (const id of line.auditIds) expect(auditIds.has(id)).toBe(true);
    }
  });

  it('never double counts an ask: its serve lines already carry the bytes', () => {
    const asks = sessionLines().filter((l) => l.kind === 'ask');
    for (const ask of asks) {
      expect(ask.askId).toMatch(new RegExp(`^${deps.session.id}#ask\\d+$`));
      expect(ask.rawBytes).toBeGreaterThan(ask.servedBytes);
      expect(ask.servedBytes).toBeGreaterThan(0);
      const serves = sessionLines().filter((l) => l.kind === 'serve' && l.askId === ask.askId);
      expect(serves.length).toBeGreaterThan(0);
      // The ask's raw bytes are exactly its serve lines' raw bytes: counting
      // both in a rollup would double the figure, so totals take serve+zoom.
      expect(serves.reduce((n, l) => n + l.rawBytes, 0)).toBe(ask.rawBytes);
    }
  });

  it('backs each line with artifact references', () => {
    for (const line of sessionLines()) {
      if (line.kind === 'ask') continue;
      expect(line.artifactRefs.length).toBeGreaterThan(0);
      for (const ref of line.artifactRefs) expect(ref).toMatch(/^a[0-9a-f]{6}$/);
    }
    const zoom = sessionLines().find((l) => l.kind === 'zoom');
    expect(zoom?.artifactRefs).toContain(zoomHandle);
  });

  it('attributes serve lines to the file or document they served', () => {
    const serves = sessionLines().filter((l) => l.kind === 'serve');
    expect(serves.some((l) => (l.document ?? '').includes('url-builder.ts'))).toBe(true);
  });

  it('survives a restart: a fresh handle on the same file reads every line', async () => {
    const before = sessionLines().map((l) => l.id);
    corpus.store.close();
    corpus.ledger.close();
    corpus = mountCorpus(temp.root, { name: 'ledgercorp' });
    deps = { corpora: new Map([[corpus.name, corpus]]), session: deps.session };
    const after = sessionLines().map((l) => l.id);
    expect(after).toEqual(before);
    await call('vault_ask', { question: 'What does segmentIsAbsolute treat as an absolute segment?' });
    expect(sessionLines().length).toBeGreaterThan(before.length);
    const reopened = new VaultLedger(path.join(temp.root, '.dcp', 'ledger.db'));
    expect(reopened.lines({ sessionId: deps.session.id }).length).toBe(sessionLines().length);
    reopened.close();
  }, 60_000);
});
