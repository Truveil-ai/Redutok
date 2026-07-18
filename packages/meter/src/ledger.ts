import {
  LedgerEntrySchema,
  addTally,
  emptyTally,
  type LedgerEntry,
  type TokenTally,
} from '@redutok/shared';
import type { ParsedSession } from './parser.js';

/**
 * Token ledger: per-turn entries plus session totals and per-tool attribution.
 * A turn's output tokens are split evenly across the tools it invoked; turns
 * with no tool calls attribute nothing. Documented in the report output.
 */

export interface ToolAttribution {
  calls: number;
  outputTokenShare: number;
}

export interface SessionLedger {
  sessionId: string;
  entries: LedgerEntry[];
  totals: TokenTally;
  byTool: Record<string, ToolAttribution>;
}

const FALLBACK_TIMESTAMP = '1970-01-01T00:00:00.000Z';

export function buildLedger(parsed: ParsedSession, sessionIdFallback = 'unknown'): SessionLedger {
  const sessionId = parsed.sessionId ?? sessionIdFallback;
  const entries: LedgerEntry[] = [];
  const byTool: Record<string, ToolAttribution> = {};
  let totals = emptyTally();

  parsed.assistantTurns.forEach((turn, index) => {
    const entry = LedgerEntrySchema.parse({
      sessionId: turn.sessionId ?? sessionId,
      turn: index + 1,
      timestamp: turn.timestamp ?? FALLBACK_TIMESTAMP,
      model: turn.model,
      tools: turn.tools,
      tokens: turn.tokens,
    });
    entries.push(entry);
    totals = addTally(totals, entry.tokens);

    const share = entry.tools.length > 0 ? entry.tokens.output / entry.tools.length : 0;
    for (const tool of entry.tools) {
      const current = byTool[tool] ?? { calls: 0, outputTokenShare: 0 };
      current.calls += 1;
      current.outputTokenShare += share;
      byTool[tool] = current;
    }
  });

  return { sessionId, entries, totals, byTool };
}

export function grandTotal(totals: TokenTally): number {
  return totals.input + totals.output + totals.cacheRead + totals.cacheWrite + totals.thinking;
}
