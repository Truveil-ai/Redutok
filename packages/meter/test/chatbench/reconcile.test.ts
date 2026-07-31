import { describe, expect, it } from 'vitest';
import { reconcileReceipt } from '../../src/chatbench/index.js';

const cfg = { maxRelativeError: 0.25, subtractCodexInSystem: true } as const;

describe('reconcileReceipt', () => {
  it('reports zero relative error when receipt matches measured delta', () => {
    // PASTE sent 100_000 input tokens across the whole conversation.
    // VAULT sent 8_000, of which 3_000 was the codex block in every system
    // message. Measured "avoided" = paste - (vault - codex) = 100_000 - 5_000
    // = 95_000. Receipt claims 95_000.
    const r = reconcileReceipt(100_000, 8_000, 3_000, 95_000, cfg);
    expect(r.measuredAvoidedTokens).toBe(95_000);
    expect(r.receiptAvoidedTokens).toBe(95_000);
    expect(r.codexInSystemTokens).toBe(3_000);
    expect(r.relativeError).toBe(0);
    expect(r.withinBand).toBe(true);
  });

  it('passes when receipt claim is within the band', () => {
    // Receipt claims 90_000 while measured is 95_000; rel error ~= 5.26%.
    const r = reconcileReceipt(100_000, 8_000, 3_000, 90_000, cfg);
    expect(r.withinBand).toBe(true);
    expect(r.relativeError).toBeLessThan(0.06);
  });

  it('fails outside the band', () => {
    // Receipt claims 40_000 while measured is 95_000; rel error ~= 57.9%.
    const r = reconcileReceipt(100_000, 8_000, 3_000, 40_000, cfg);
    expect(r.withinBand).toBe(false);
    expect(r.relativeError).toBeGreaterThan(0.25);
  });

  it('does not subtract codex when subtractCodexInSystem is false', () => {
    const r = reconcileReceipt(100_000, 8_000, 3_000, 92_000, {
      maxRelativeError: 0.25,
      subtractCodexInSystem: false,
    });
    expect(r.measuredAvoidedTokens).toBe(100_000 - 8_000);
    expect(r.relativeError).toBe(0);
    expect(r.withinBand).toBe(true);
  });

  it('handles the zero-avoided edge case symmetrically', () => {
    const r = reconcileReceipt(50_000, 50_000, 0, 0, cfg);
    expect(r.measuredAvoidedTokens).toBe(0);
    expect(r.relativeError).toBe(0);
    expect(r.withinBand).toBe(true);
  });
});
