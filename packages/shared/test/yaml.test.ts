import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadEnergyFactors, loadGridIntensity, loadPrices } from '../src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => path.join(here, 'fixtures', name);

describe('loadPrices', () => {
  it('loads and validates a well-formed prices file', () => {
    const prices = loadPrices(fixture('prices.valid.yaml'));
    expect(prices.currency).toBe('USD');
    expect(prices.models[0]?.id).toBe('test-model-a');
    expect(prices.models[0]?.source).toBe('TODO-VERIFY');
  });

  it('loads the 1-hour cache-write rate alongside the 5-minute rate', () => {
    const prices = loadPrices(fixture('prices.valid.yaml'));
    expect(prices.models[0]?.cacheWritePerMTokUsd).toBe(3.75);
    expect(prices.models[0]?.cacheWrite1hPerMTokUsd).toBe(6);
  });

  it('rejects a row with no source field', () => {
    expect(() => loadPrices(fixture('prices.missing-source.yaml'))).toThrow();
  });

  it('rejects a row missing the 1-hour cache-write rate', () => {
    expect(() => loadPrices(fixture('prices.missing-1h-rate.yaml'))).toThrow();
  });
});

describe('loadEnergyFactors', () => {
  it('loads and validates a well-formed energy factors file', () => {
    const energy = loadEnergyFactors(fixture('energy.valid.yaml'));
    const row = energy.classes[0];
    expect(row?.modelClass).toBe('frontier-large');
    expect(row?.models).toEqual(['test-model-a']);
    expect(row?.whPerMTok).toEqual({ base: 300, low: 30, high: 1500 });
    expect(row?.assumption).toBe(true);
    expect(row?.contextMultipliers.confidence).toBe('low');
    expect(row?.contextMultipliers.curve[0]?.multiplier).toBe(1);
    expect(row?.verified).toBe('2026-07-18');
    expect(row?.citation_hint).toContain('TokenPowerBench');
  });

  it('rejects a band whose low exceeds base or base exceeds high', () => {
    expect(() => loadEnergyFactors(fixture('energy.bad-band.yaml'))).toThrow();
  });

  it('ships a default file whose rows are all verified with sources', () => {
    const energy = loadEnergyFactors();
    expect(energy.classes.length).toBeGreaterThanOrEqual(3);
    for (const row of energy.classes) {
      expect(row.source).not.toBe('TODO-VERIFY');
      expect(row.source.length).toBeGreaterThan(0);
      expect(row.verified).toBe('2026-07-18');
      expect(row.citation_hint.length).toBeGreaterThan(0);
      expect(row.whPerMTok.low).toBeLessThanOrEqual(row.whPerMTok.base);
      expect(row.whPerMTok.base).toBeLessThanOrEqual(row.whPerMTok.high);
      expect(row.contextMultipliers.confidence).toBe('low');
      expect(row.contextMultipliers.source.length).toBeGreaterThan(0);
      const tops = row.contextMultipliers.curve.map((m) => m.upToTokens);
      expect([...tops].sort((a, b) => a - b)).toEqual(tops);
    }
    // The frontier-large row is a class assumption, not a measurement, and
    // must say so.
    const large = energy.classes.find((c) => c.modelClass === 'frontier-large');
    expect(large?.assumption).toBe(true);
  });
});

describe('loadGridIntensity', () => {
  it('loads and validates a well-formed grid intensity file', () => {
    const grid = loadGridIntensity(fixture('grid.valid.yaml'));
    expect(grid.defaultRegion).toBe('world');
    expect(grid.regions[0]?.gCo2ePerKwh).toBe(480);
  });

  it('rejects a region row with no source field', () => {
    expect(() => loadGridIntensity(fixture('grid.missing-source.yaml'))).toThrow();
  });

  it('ships a default file with the world default plus IN, US, EU rows, all verified', () => {
    const grid = loadGridIntensity();
    const regions = grid.regions.map((r) => r.region);
    expect(regions).toEqual(expect.arrayContaining(['world', 'IN', 'US', 'EU']));
    expect(grid.regions.find((r) => r.region === grid.defaultRegion)).toBeDefined();
    for (const row of grid.regions) {
      expect(row.source).not.toBe('TODO-VERIFY');
      expect(row.source.length).toBeGreaterThan(0);
      expect(row.verified).toBe('2026-07-18');
      expect(row.citation_hint.length).toBeGreaterThan(0);
    }
  });

  it('keeps the verified world value and its IEA note through schema validation', () => {
    const world = loadGridIntensity().regions.find((r) => r.region === 'world');
    expect(world?.gCo2ePerKwh).toBe(473);
    expect(world?.source).toContain('Ember');
    expect(world?.note).toContain('IEA Electricity 2025');
  });
});
