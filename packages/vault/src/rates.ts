import {
  loadEnergyFactors,
  loadGridIntensity,
  loadPrices,
  type EnergyBand,
} from '@redutok/shared';

/** All avoided-cost and energy numbers are stated against this row of
 * prices.yaml / energy_factors.yaml, named in every ledger line and receipt. */
export const REFERENCE_MODEL = 'claude-sonnet-5';

export interface ReferenceRates {
  referenceModel: string;
  inputPerMTokUsd: number;
  priceSource: string;
  whPerMTok: EnergyBand;
  gCo2ePerKwh: number;
  region: string;
}

let cached: ReferenceRates | undefined;

export function loadReferenceRates(): ReferenceRates {
  if (cached !== undefined) return cached;
  const priceRow = loadPrices().models.find((m) => m.id === REFERENCE_MODEL);
  if (priceRow === undefined) {
    throw new Error(`reference model ${REFERENCE_MODEL} has no row in prices.yaml`);
  }
  const factorRow = loadEnergyFactors().classes.find((c) => c.models.includes(REFERENCE_MODEL));
  if (factorRow === undefined) {
    throw new Error(`reference model ${REFERENCE_MODEL} has no class in energy_factors.yaml`);
  }
  const grid = loadGridIntensity();
  const gridRow = grid.regions.find((r) => r.region === grid.defaultRegion);
  if (gridRow === undefined) {
    throw new Error('grid_intensity.yaml has no row for its own default region');
  }
  cached = {
    referenceModel: REFERENCE_MODEL,
    inputPerMTokUsd: priceRow.inputPerMTokUsd,
    priceSource: priceRow.source,
    whPerMTok: factorRow.whPerMTok,
    gCo2ePerKwh: gridRow.gCo2ePerKwh,
    region: grid.defaultRegion,
  };
  return cached;
}

/**
 * Cost and energy for avoided tokens, bands per docs/METHODOLOGY.md, with the
 * context multiplier held at 1.0 because the counterfactual context shape of
 * avoided tokens is unknowable.
 */
export function priceAvoidedTokens(
  avoidedTokens: number,
  rates: ReferenceRates,
): { costAvoidedUsd: number; wh: EnergyBand; gCo2e: EnergyBand } {
  const mtok = avoidedTokens / 1e6;
  const wh: EnergyBand = {
    base: mtok * rates.whPerMTok.base,
    low: mtok * rates.whPerMTok.low,
    high: mtok * rates.whPerMTok.high,
  };
  const toGrams = (x: number): number => (x / 1000) * rates.gCo2ePerKwh;
  return {
    costAvoidedUsd: mtok * rates.inputPerMTokUsd,
    wh,
    gCo2e: { base: toGrams(wh.base), low: toGrams(wh.low), high: toGrams(wh.high) },
  };
}
