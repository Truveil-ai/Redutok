import type { ReceiptReconciliationConfig, ReconciliationResult } from './types.js';

/**
 * Reconcile the vault receipt's avoidedTokens claim against the measured
 * PASTE-minus-VAULT input-token delta from the platform meter. The VAULT
 * arm carries the codex block in the system prompt on every turn; that is
 * served (not avoided) and must be subtracted before the compare when
 * `subtractCodexInSystem` is set.
 */
export function reconcileReceipt(
  _pasteInputTokens: number,
  _vaultInputTokens: number,
  _codexInSystemTokens: number,
  _receiptAvoidedTokens: number,
  _cfg: ReceiptReconciliationConfig,
): ReconciliationResult {
  throw new Error('chatbench:reconcileReceipt not implemented');
}
