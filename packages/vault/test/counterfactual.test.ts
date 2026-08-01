import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openStore } from '@redutok/sidecar';
import { makeLedgerLine, type LedgerLine } from '../src/ledger.js';
import { rollupLines } from '../src/rollup.js';
import { renderMonthlyStatement } from '../src/statement.js';
import { renderVaultReceipt } from '../src/tools.js';

/**
 * Session 3 counterfactual honesty rule, enforced in code and pinned here:
 * avoided-tokens claims compare served size against the raw size of what was
 * actually touched. The whole-corpus figure may appear only under its own
 * "corpus resident size avoided" label; the two never conflate.
 */

const RESIDENT_TOKENS = 10_000_000;

const touched: LedgerLine[] = [
  makeLedgerLine({
    kind: 'serve',
    corpus: 'demo',
    sessionId: 'vault-team-a',
    timestamp: '2026-07-05T10:00:00.000Z',
    rawBytes: 4000,
    servedBytes: 400,
    document: 'contracts/msa.pdf',
    artifactRefs: ['a111111'],
    auditIds: ['e1'],
  }),
];
const TOUCHED_AVOIDED = 1000 - 100;

const rollup = () =>
  rollupLines(touched, { scope: 'month', month: '2026-07' }, {
    corpus: 'demo',
    corpusResidentTokens: RESIDENT_TOKENS,
  });

const countOf = (text: string, needle: string): number => text.split(needle).length - 1;

describe('counterfactual honesty', () => {
  it('avoided tokens come from touched lines, never from the corpus size', () => {
    const r = rollup();
    expect(r.avoidedTokens).toBe(TOUCHED_AVOIDED);
    expect(r.corpusResidentTokens).toBe(RESIDENT_TOKENS);
    expect(r.avoidedTokens).not.toBe(r.corpusResidentTokens);
  });

  it('the receipt shows the whole-corpus figure only under its own label', () => {
    const text = renderVaultReceipt(rollup());
    expect(text).toMatch(/avoided 900 tok/);
    expect(countOf(text, '10,000,000')).toBe(1);
    const residentLine = text
      .split('\n')
      .find((l) => l.includes('10,000,000'));
    expect(residentLine).toContain('corpus resident size avoided');
    const totalsLine = text.split('\n').find((l) => /avoided 900 tok/.test(l));
    expect(totalsLine).not.toContain('10,000,000');
  });

  it('the monthly statement keeps the same separation', () => {
    const text = renderMonthlyStatement(rollup(), '2026-07-31T00:00:00.000Z');
    expect(countOf(text, '10,000,000')).toBe(1);
    const residentLine = text.split('\n').find((l) => l.includes('10,000,000'));
    expect(residentLine).toContain('corpus resident size avoided');
    expect(text).toContain('900');
  });
});

describe('corpus resident size measures latest artifacts, deduplicated by file', () => {
  it('counts one raw copy per file path, the latest', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'vault-resident-'));
    const store = openStore(path.join(dir, 'state.db'));
    const base = {
      sessionId: 's1',
      artifactClass: 'file-skeleton',
      gatesPassed: true,
      meta: { filePath: 'src/a.ts' },
    };
    store.insertArtifact({ ...base, id: 'a000001', createdAt: '2026-07-01T00:00:00.000Z', raw: 'x'.repeat(1000) });
    store.insertArtifact({ ...base, id: 'a000002', createdAt: '2026-07-02T00:00:00.000Z', raw: 'y'.repeat(500) });
    store.insertArtifact({
      ...base,
      id: 'a000003',
      createdAt: '2026-07-01T12:00:00.000Z',
      raw: 'z'.repeat(300),
      meta: { filePath: 'src/b.ts' },
    });
    expect(store.residentRawBytes()).toBe(500 + 300);
    store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  });
});
