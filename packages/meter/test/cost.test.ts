import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadPrices } from '@redutok/shared';
import { computeSessionCost, computeTallyCostUsd } from '../src/cost.js';
import { buildLedger } from '../src/ledger.js';
import { parseSessionFile } from '../src/parser.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => path.join(here, '..', '..', '..', 'fixtures', 'sessions', name);

const row = {
  id: 'claude-sonnet-5',
  inputPerMTokUsd: 3,
  outputPerMTokUsd: 15,
  cacheReadPerMTokUsd: 0.3,
  cacheWritePerMTokUsd: 3.75,
  cacheWrite1hPerMTokUsd: 6,
  source: 'TODO-VERIFY',
};

describe('computeTallyCostUsd', () => {
  it('prices each token class, with thinking at the output rate', () => {
    const cost = computeTallyCostUsd(
      { input: 1_000_000, output: 500_000, cacheRead: 0, cacheWrite: 0, thinking: 500_000 },
      row,
    );
    expect(cost).toBeCloseTo(3 + 15, 10);
  });

  it('bills a known cache-write tier split at its own rate', () => {
    const cost = computeTallyCostUsd(
      {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 1_000_000,
        cacheWrite5m: 400_000,
        cacheWrite1h: 600_000,
        thinking: 0,
      },
      row,
    );
    // 400_000 * 3.75/MTok + 600_000 * 6/MTok, per million tokens.
    expect(cost).toBeCloseTo(400_000 * 3.75e-6 + 600_000 * 6e-6, 9);
  });

  it('bills a tally with no tier split entirely at the higher-cost 1-hour rate, conservative against ourselves', () => {
    const cost = computeTallyCostUsd(
      { input: 0, output: 0, cacheRead: 0, cacheWrite: 1_000_000, thinking: 0 },
      row,
    );
    expect(cost).toBeCloseTo(1_000_000 * 6e-6, 9);
    expect(cost).toBeGreaterThan(1_000_000 * 3.75e-6);
  });
});

describe('computeSessionCost on small.jsonl', () => {
  it('matches the hand-computed session cost', async () => {
    const ledger = buildLedger(await parseSessionFile(fixture('small.jsonl')));
    const cost = computeSessionCost(ledger, { version: 1, currency: 'USD', models: [row] });
    // input 2160 * 3, (output 1470 + thinking 450) * 15, cacheRead 15100 * 0.3,
    // all per million tokens. small.jsonl has no cache_creation tier
    // breakdown, so all 920 cache-write tokens are conservatively assumed at
    // the 1-hour tier (6.00, not the 5-minute 3.75): 920 * 6.
    expect(cost.totalUsd).toBeCloseTo(0.04533, 9);
    expect(cost.pricedTurns).toBe(3);
    expect(cost.unpricedModels).toEqual([]);
    expect(cost.unverifiedSources).toEqual(['claude-sonnet-5']);
  });

  it('reports unpriced models instead of silently costing them at zero', async () => {
    const ledger = buildLedger(await parseSessionFile(fixture('small.jsonl')));
    const cost = computeSessionCost(ledger, {
      version: 1,
      currency: 'USD',
      models: [{ ...row, id: 'some-other-model' }],
    });
    expect(cost.totalUsd).toBe(0);
    expect(cost.pricedTurns).toBe(0);
    expect(cost.unpricedModels).toEqual(['claude-sonnet-5']);
  });
});

describe('shipped prices.yaml', () => {
  it('loads, validates and covers the models used in the fixtures', () => {
    const prices = loadPrices();
    const ids = prices.models.map((m) => m.id);
    expect(ids).toEqual([
      'claude-fable-5',
      'claude-opus-4-8',
      'claude-sonnet-4-6',
      'claude-sonnet-5',
      'claude-haiku-4-5',
    ]);
    for (const model of prices.models) {
      expect(model.source).toBe('https://platform.claude.com/docs/en/about-claude/pricing');
      expect(model.cacheReadPerMTokUsd).toBeCloseTo(model.inputPerMTokUsd * 0.1, 10);
      expect(model.cacheWritePerMTokUsd).toBeCloseTo(model.inputPerMTokUsd * 1.25, 10);
      expect(model.cacheWrite1hPerMTokUsd).toBeCloseTo(model.inputPerMTokUsd * 2, 10);
    }
  });

  it('follows observed billing for claude-sonnet-5 (standard rate) rather than the documented introductory promise', () => {
    const sonnet = loadPrices().models.find((m) => m.id === 'claude-sonnet-5');
    // Reconciled 2026-07-19 against bench/runs/*.stream.jsonl: 20/20 real
    // requests billed at 3.00/15.00, not the page's promised 2.00/10.00.
    expect(sonnet?.inputPerMTokUsd).toBe(3);
    expect(sonnet?.outputPerMTokUsd).toBe(15);
    expect(sonnet?.cacheWritePerMTokUsd).toBe(3.75);
    expect(sonnet?.cacheWrite1hPerMTokUsd).toBe(6);
    expect(sonnet?.note).toMatch(/observed billing/i);
    expect(sonnet?.note).toMatch(/2026-07-19/);
  });
});
