import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadEnergyFactors, loadPrices } from '../src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => path.join(here, 'fixtures', name);

describe('loadPrices', () => {
  it('loads and validates a well-formed prices file', () => {
    const prices = loadPrices(fixture('prices.valid.yaml'));
    expect(prices.currency).toBe('USD');
    expect(prices.models[0]?.id).toBe('test-model-a');
    expect(prices.models[0]?.source).toBe('TODO-VERIFY');
  });

  it('rejects a row with no source field', () => {
    expect(() => loadPrices(fixture('prices.missing-source.yaml'))).toThrow();
  });
});

describe('loadEnergyFactors', () => {
  it('loads and validates a well-formed energy factors file', () => {
    const energy = loadEnergyFactors(fixture('energy.valid.yaml'));
    expect(energy.factors[0]?.modelClass).toBe('frontier-large');
    expect(energy.factors[0]?.contextMultipliers[0]?.multiplier).toBe(1);
  });
});
