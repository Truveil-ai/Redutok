import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadEnergyFactors, loadGridIntensity } from '@redutok/shared';
import { computeSessionEnergy, contextMultiplierFor } from '../src/energy.js';
import { buildLedger } from '../src/ledger.js';
import { parseSessionFile } from '../src/parser.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => path.join(here, '..', '..', '..', 'fixtures', 'sessions', name);

const factors = loadEnergyFactors();
const grid = loadGridIntensity();

describe('contextMultiplierFor', () => {
  const curve = [
    { upToTokens: 10_000, multiplier: 1 },
    { upToTokens: 100_000, multiplier: 1.3 },
    { upToTokens: 500_000, multiplier: 2 },
    { upToTokens: 1_000_000, multiplier: 3 },
  ];

  it('selects the first breakpoint at or above the context length', () => {
    expect(contextMultiplierFor(curve, 5_000)).toBe(1);
    expect(contextMultiplierFor(curve, 10_000)).toBe(1);
    expect(contextMultiplierFor(curve, 10_001)).toBe(1.3);
    expect(contextMultiplierFor(curve, 400_000)).toBe(2);
  });

  it('uses the last multiplier beyond the final breakpoint', () => {
    expect(contextMultiplierFor(curve, 5_000_000)).toBe(3);
  });
});

describe('computeSessionEnergy on small.jsonl', () => {
  // Hand computation from the yaml inputs (guardrail: reproducible from yaml).
  // small.jsonl is all claude-sonnet-5, mapped to frontier-mid with
  // whPerMTok base 300, low 100, high 1000 in energy_factors.yaml.
  // Every turn's context length (input + cacheRead) is under 10k, so the
  // context multiplier is 1 throughout. Total tokens all classes: 20100.
  // Wh = 20100 / 1e6 * factor; gCO2e = Wh / 1000 * 473 (verified world row).
  it('reproduces hand-computed Wh and gCO2e bands from the yaml inputs', async () => {
    const ledger = buildLedger(await parseSessionFile(fixture('small.jsonl')));
    const energy = computeSessionEnergy(ledger, factors, grid);
    expect(energy.wh.base).toBeCloseTo(6.03, 9);
    expect(energy.wh.low).toBeCloseTo(2.01, 9);
    expect(energy.wh.high).toBeCloseTo(20.1, 9);
    expect(energy.gCo2e.base).toBeCloseTo((6.03 / 1000) * 473, 9);
    expect(energy.gCo2e.low).toBeCloseTo((2.01 / 1000) * 473, 9);
    expect(energy.gCo2e.high).toBeCloseTo((20.1 / 1000) * 473, 9);
    expect(energy.region).toBe('world');
    expect(energy.unestimatedModels).toEqual([]);
    expect(energy.sidecarWh).toBe(0);
  });

  it('honours an explicit region', async () => {
    const ledger = buildLedger(await parseSessionFile(fixture('small.jsonl')));
    const energy = computeSessionEnergy(ledger, factors, grid, 'IN');
    expect(energy.region).toBe('IN');
    expect(energy.gCo2e.base).toBeCloseTo((6.03 / 1000) * 708, 9);
  });

  it('throws on an unknown region instead of guessing', async () => {
    const ledger = buildLedger(await parseSessionFile(fixture('small.jsonl')));
    expect(() => computeSessionEnergy(ledger, factors, grid, 'XX')).toThrow();
  });
});

describe('computeSessionEnergy with unmapped models', () => {
  it('reports unmapped models and excludes them from the estimate', () => {
    const ledger = buildLedger({
      sessionId: 'x',
      assistantTurns: [
        {
          model: 'mystery-model',
          tools: [],
          tokens: { input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0, thinking: 0 },
        },
        {
          model: 'claude-haiku-4-5',
          tools: [],
          tokens: { input: 500_000, output: 500_000, cacheRead: 0, cacheWrite: 0, thinking: 0 },
        },
      ],
      counts: { lines: 2, known: 2, unknownType: 0, malformed: 0 },
      audit: [],
    });
    const energy = computeSessionEnergy(ledger, factors, grid);
    expect(energy.unestimatedModels).toEqual(['mystery-model']);
    // haiku turn: 1e6 tokens, context 500k hits the 500k breakpoint at
    // multiplier 1.2, small class base 110 Wh/MTok: 1.0 x 110 x 1.2 = 132.
    expect(energy.wh.base).toBeCloseTo(132, 9);
  });
});

describe('shipped energy_factors.yaml model coverage', () => {
  // A live claude-opus-5 session estimated 0.00 Wh because no class listed
  // the model. It joins frontier-large, the same class as claude-opus-4-8
  // and claude-fable-5; no new per-token figure is invented for it.
  it('maps claude-opus-5 and claude-fable-5 to frontier-large', () => {
    const frontierLarge = factors.classes.find((c) => c.modelClass === 'frontier-large');
    expect(frontierLarge?.models).toContain('claude-opus-5');
    expect(frontierLarge?.models).toContain('claude-fable-5');
  });

  it('estimates non-zero energy for a claude-opus-5 session', () => {
    const ledger = buildLedger({
      sessionId: 'opus5',
      assistantTurns: [
        {
          model: 'claude-opus-5',
          tools: [],
          tokens: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 },
        },
      ],
      counts: { lines: 1, known: 1, unknownType: 0, malformed: 0 },
      audit: [],
    });
    const energy = computeSessionEnergy(ledger, factors, grid);
    expect(energy.unestimatedModels).toEqual([]);
    // 1 MTok at the frontier-large base of 450 Wh/MTok; context 1M sits at
    // the final breakpoint, multiplier 1.4: 450 x 1.4 = 630.
    expect(energy.wh.base).toBeCloseTo(630, 9);
    expect(energy.wh.low).toBeCloseTo(210, 9);
    expect(energy.wh.high).toBeCloseTo(2100, 9);
  });
});
