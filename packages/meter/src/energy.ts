import type { EnergyFactorsFile, GridIntensityFile } from '@redutok/shared';
import type { SessionLedger } from './ledger.js';

/**
 * Estimated energy and carbon for a session, from the yaml inputs alone.
 * These are estimates, never measurements. Bands come from the low and high
 * columns of energy_factors.yaml and must always be rendered with the base.
 */

export interface EstimateBand {
  base: number;
  low: number;
  high: number;
}

export interface SessionEnergy {
  wh: EstimateBand;
  gCo2e: EstimateBand;
  region: string;
  gCo2ePerKwh: number;
  unestimatedModels: string[];
  /** Sidecar self-consumption, Wh. Stub at 0 until the sidecar exists and can measure itself (Phase 3). */
  sidecarWh: number;
}

export function contextMultiplierFor(
  curve: { upToTokens: number; multiplier: number }[],
  contextTokens: number,
): number {
  for (const point of curve) {
    if (contextTokens <= point.upToTokens) return point.multiplier;
  }
  const last = curve[curve.length - 1];
  return last === undefined ? 1 : last.multiplier;
}

export function computeSessionEnergy(
  ledger: SessionLedger,
  factors: EnergyFactorsFile,
  grid: GridIntensityFile,
  region?: string,
): SessionEnergy {
  const byModel = new Map<string, (typeof factors.classes)[number]>();
  for (const row of factors.classes) {
    for (const model of row.models) byModel.set(model, row);
  }

  const regionKey = region ?? grid.defaultRegion;
  const gridRow = grid.regions.find((r) => r.region === regionKey);
  if (gridRow === undefined) {
    throw new Error(
      `unknown grid region "${regionKey}"; known regions: ${grid.regions.map((r) => r.region).join(', ')}`,
    );
  }

  const wh: EstimateBand = { base: 0, low: 0, high: 0 };
  const unestimatedModels = new Set<string>();

  for (const entry of ledger.entries) {
    const row = byModel.get(entry.model);
    if (row === undefined) {
      unestimatedModels.add(entry.model);
      continue;
    }
    const t = entry.tokens;
    const totalTokens = t.input + t.output + t.cacheRead + t.cacheWrite + t.thinking;
    const contextTokens = t.input + t.cacheRead;
    const multiplier = contextMultiplierFor(row.contextMultipliers, contextTokens);
    const mtok = totalTokens / 1_000_000;
    wh.base += mtok * row.whPerMTok.base * multiplier;
    wh.low += mtok * row.whPerMTok.low * multiplier;
    wh.high += mtok * row.whPerMTok.high * multiplier;
  }

  const toGrams = (x: number): number => (x / 1000) * gridRow.gCo2ePerKwh;
  return {
    wh,
    gCo2e: { base: toGrams(wh.base), low: toGrams(wh.low), high: toGrams(wh.high) },
    region: regionKey,
    gCo2ePerKwh: gridRow.gCo2ePerKwh,
    unestimatedModels: [...unestimatedModels].sort(),
    sidecarWh: 0,
  };
}
