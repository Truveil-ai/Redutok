import type { CallSpec, ChatbenchConfig } from './types.js';

/**
 * Format the dry-run summary the founder approves the spend from:
 * per-corpus call counts, per-arm token totals, and a cost band from the
 * model's list rate. Nothing is called; the founder-facing preview must
 * make it obvious what a live run would cost.
 */
export function renderDryRun(
  _cfg: ChatbenchConfig,
  _matrix: CallSpec[],
  _rates: { inputPerMTokUsd: number; outputPerMTokUsd: number },
): string {
  throw new Error('chatbench:renderDryRun not implemented');
}
