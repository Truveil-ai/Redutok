import type { ReceiptReconciliationConfig, ReconciliationResult } from './types.js';

export function reconcileReceipt(
  pasteInputTokens: number,
  vaultInputTokens: number,
  codexInSystemTokens: number,
  receiptAvoidedTokens: number,
  cfg: ReceiptReconciliationConfig,
): ReconciliationResult {
  const effectiveVault = cfg.subtractCodexInSystem
    ? Math.max(0, vaultInputTokens - codexInSystemTokens)
    : vaultInputTokens;
  const measured = Math.max(0, pasteInputTokens - effectiveVault);
  // Symmetric relative error: max of the two magnitudes as denominator so
  // (measured=0, receipt=0) reconciles cleanly instead of dividing by zero.
  const denom = Math.max(measured, receiptAvoidedTokens, 1);
  const relativeError = Math.abs(receiptAvoidedTokens - measured) / denom;
  return {
    measuredAvoidedTokens: measured,
    receiptAvoidedTokens,
    codexInSystemTokens,
    relativeError,
    withinBand: relativeError <= cfg.maxRelativeError,
  };
}
