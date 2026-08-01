import { describe, expect, it } from 'vitest';
import { loadPrices } from '@redutok/shared';
import { makeLedgerLine, type LedgerLine } from '../src/ledger.js';
import { parseStatementArgs } from '../src/main.js';
import { rollupLines } from '../src/rollup.js';
import { renderMonthlyStatement } from '../src/statement.js';

/**
 * Session 3 contracts: the monthly statement renders from the ledger with
 * totals, top documents, top sessions, avoided cost and energy with bands,
 * the methodology citation, and the estimates-never-measurements framing,
 * ready to attach to an internal report as-is. House style: no em-dashes.
 */

const line = (over: Partial<Parameters<typeof makeLedgerLine>[0]>): LedgerLine =>
  makeLedgerLine({
    kind: 'serve',
    corpus: 'practice',
    sessionId: 'vault-team-a',
    timestamp: '2026-07-05T10:00:00.000Z',
    rawBytes: 400_000,
    servedBytes: 4000,
    document: 'engagement-letter.docx',
    artifactRefs: ['a111111'],
    auditIds: ['e1'],
    ...over,
  });

const LINES: LedgerLine[] = [
  line({ kind: 'ask', askId: 'vault-team-a#ask1', document: undefined }),
  line({ askId: 'vault-team-a#ask1' }),
  line({ askId: 'vault-team-a#ask1', document: 'engagement-letter.docx', timestamp: '2026-07-06T10:00:00.000Z' }),
  line({
    sessionId: 'vault-team-b',
    document: 'retention-schedule.txt',
    rawBytes: 40_000,
    servedBytes: 4000,
    timestamp: '2026-07-12T10:00:00.000Z',
  }),
  line({ kind: 'zoom', document: 'retention-schedule.txt', rawBytes: 8000, servedBytes: 8000, timestamp: '2026-07-12T11:00:00.000Z' }),
  // A June line that the July statement must exclude.
  line({ timestamp: '2026-06-20T10:00:00.000Z', rawBytes: 4_000_000, servedBytes: 4000 }),
];

const JULY_AVOIDED = 2 * (100_000 - 1000) + (10_000 - 1000) + 0;

const statement = (): string =>
  renderMonthlyStatement(
    rollupLines(LINES, { scope: 'month', month: '2026-07' }, {
      corpus: 'practice',
      corpusResidentTokens: 2_000_000,
    }),
    '2026-07-31T12:00:00.000Z',
  );

describe('monthly statement', () => {
  it('renders totals for the month only, excluding other months', () => {
    const text = statement();
    expect(text).toContain('Redutok vault monthly statement');
    expect(text).toContain('practice');
    expect(text).toContain('2026-07');
    expect(text).toContain(`${JULY_AVOIDED.toLocaleString('en-US')} tok`);
    // The excluded June line alone would add 999,000 avoided tokens.
    expect(text).not.toContain('999,000');
  });

  it('ranks top documents and top sessions', () => {
    const text = statement();
    const letter = text.indexOf('engagement-letter.docx');
    const schedule = text.indexOf('retention-schedule.txt');
    expect(letter).toBeGreaterThan(-1);
    expect(schedule).toBeGreaterThan(-1);
    expect(letter).toBeLessThan(schedule);
    expect(text).toMatch(/2 reads/);
    const teamA = text.indexOf('vault-team-a');
    const teamB = text.indexOf('vault-team-b');
    expect(teamA).toBeGreaterThan(-1);
    expect(teamB).toBeGreaterThan(-1);
    expect(teamA).toBeLessThan(teamB);
  });

  it('cites the rate row it prices against', () => {
    const text = statement();
    const model = LINES[0]?.referenceModel ?? '';
    const row = loadPrices().models.find((m) => m.id === model);
    expect(row).toBeDefined();
    expect(text).toContain(model);
    expect(text).toContain(`$${(row?.inputPerMTokUsd ?? 0).toFixed(2)}/MTok`);
    expect(text).toContain(row?.source ?? 'MISSING');
  });

  it('carries energy bands, the methodology citation, and the estimates framing', () => {
    const text = statement();
    expect(text).toMatch(/Wh/);
    expect(text).toMatch(/gCO2e/);
    expect(text).toMatch(/band/);
    expect(text).toContain('docs/METHODOLOGY.md');
    expect(text).toMatch(/estimates, never measurements/);
  });

  it('uses no em-dashes or en-dashes anywhere', () => {
    expect(statement()).not.toMatch(/[\u2013\u2014]/);
  });

  it('refuses to render any scope but month', () => {
    const corpusRollup = rollupLines(LINES, { scope: 'corpus' }, {
      corpus: 'practice',
      corpusResidentTokens: 0,
    });
    expect(() => renderMonthlyStatement(corpusRollup, '2026-07-31T12:00:00.000Z')).toThrow(/month/);
  });
});

describe('statement CLI arguments', () => {
  it('parses target, month, corpus name, and json flag', () => {
    expect(parseStatementArgs(['C:/corpus', '--month', '2026-07', '--json'])).toEqual({
      target: 'C:/corpus',
      month: '2026-07',
      json: true,
    });
    expect(parseStatementArgs(['C:/corpus', '--corpus', 'practice'])).toEqual({
      target: 'C:/corpus',
      corpus: 'practice',
      month: new Date().toISOString().slice(0, 7),
      json: false,
    });
  });

  it('rejects a malformed month and a missing target', () => {
    expect(() => parseStatementArgs(['C:/corpus', '--month', 'July'])).toThrow(/month/i);
    expect(() => parseStatementArgs([])).toThrow(/usage/i);
  });
});
