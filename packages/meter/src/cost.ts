import type { PriceRow, PricesFile, TokenTally } from '@redutok/shared';
import type { SessionLedger } from './ledger.js';

/**
 * Cost computation from the sourced prices.yaml.
 * Thinking tokens are priced at the output rate; this assumption is stated in
 * the report output. Models with no price row are reported as unpriced, never
 * silently costed at zero.
 */

/**
 * Cache-write tokens bill at one of two rates depending on TTL tier (see
 * prices.yaml's cacheWritePerMTokUsd / cacheWrite1hPerMTokUsd). When a
 * TokenTally carries the tier split (both cacheWrite5m and cacheWrite1h
 * present, the normal case from parser.ts), each portion is billed at its
 * own rate. When a tally has no split at all (older/hand-built TokenTally
 * values that predate this field), the same conservative-against-ourselves
 * policy applies here as in the parser: bill the whole amount at the
 * higher-cost 1-hour rate rather than assuming the cheaper 5-minute rate.
 */
export function computeTallyCostUsd(tokens: TokenTally, row: PriceRow): number {
  const hasSplit = tokens.cacheWrite5m !== undefined && tokens.cacheWrite1h !== undefined;
  const cacheWrite5m = hasSplit ? (tokens.cacheWrite5m as number) : 0;
  const cacheWrite1h = hasSplit ? (tokens.cacheWrite1h as number) : tokens.cacheWrite;
  return (
    (tokens.input * row.inputPerMTokUsd +
      (tokens.output + tokens.thinking) * row.outputPerMTokUsd +
      tokens.cacheRead * row.cacheReadPerMTokUsd +
      cacheWrite5m * row.cacheWritePerMTokUsd +
      cacheWrite1h * row.cacheWrite1hPerMTokUsd) /
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
