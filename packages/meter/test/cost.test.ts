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
});

describe('computeSessionCost on small.jsonl', () => {
  it('matches the hand-computed session cost', async () => {
    const ledger = buildLedger(await parseSessionFile(fixture('small.jsonl')));
    const cost = computeSessionCost(ledger, { version: 1, currency: 'USD', models: [row] });
    // input 2160 * 3, (output 1470 + thinking 450) * 15, cacheRead 15100 * 0.3,
    // cacheWrite 920 * 3.75, all per million tokens.
    expect(cost.totalUsd).toBeCloseTo(0.04326, 9);
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
    }
  });

  it('keeps the sonnet-5 introductory pricing note through schema validation', () => {
    const sonnet = loadPrices().models.find((m) => m.id === 'claude-sonnet-5');
    expect(sonnet?.inputPerMTokUsd).toBe(2);
    expect(sonnet?.outputPerMTokUsd).toBe(10);
    expect(sonnet?.note).toBe(
      'introductory through 2026-08-31, standard 3.00/15.00 from 2026-09-01',
    );
  });
});
