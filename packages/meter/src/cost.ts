import type { PriceRow, PricesFile, TokenTally } from '@redutok/shared';
import type { SessionLedger } from './ledger.js';

/**
 * Cost computation from the sourced prices.yaml.
 * Thinking tokens are priced at the output rate; this assumption is stated in
 * the report output. Models with no price row are reported as unpriced, never
 * silently costed at zero.
 */

export function computeTallyCostUsd(tokens: TokenTally, row: PriceRow): number {
  return (
    (tokens.input * row.inputPerMTokUsd +
      (tokens.output + tokens.thinking) * row.outputPerMTokUsd +
      tokens.cacheRead * row.cacheReadPerMTokUsd +
      tokens.cacheWrite * row.cacheWritePerMTokUsd) /
    1_000_000
  );
}

export interface SessionCost {
  totalUsd: number;
  pricedTurns: number;
  unpricedModels: string[];
  unverifiedSources: string[];
}

export function computeSessionCost(ledger: SessionLedger, prices: PricesFile): SessionCost {
  const byId = new Map(prices.models.map((row) => [row.id, row]));
  let totalUsd = 0;
  let pricedTurns = 0;
  const unpricedModels = new Set<string>();
  const unverifiedSources = new Set<string>();

  for (const entry of ledger.entries) {
    const row = byId.get(entry.model);
    if (row === undefined) {
      unpricedModels.add(entry.model);
      continue;
    }
    totalUsd += computeTallyCostUsd(entry.tokens, row);
    pricedTurns += 1;
    if (row.source === 'TODO-VERIFY') unverifiedSources.add(row.id);
  }

  return {
    totalUsd,
    pricedTurns,
    unpricedModels: [...unpricedModels].sort(),
    unverifiedSources: [...unverifiedSources].sort(),
  };
}
