import type { CallSpec, ChatbenchConfig, QuestionSet } from './types.js';

/**
 * Enumerate the full call matrix: for each corpus, for each arm, for each
 * replication, for each question, one CallSpec. Input-token bounds are
 * estimated from static byte counts (bytes/4 approximation); output bound
 * is `maxTokensPerTurn`.
 */
export function enumerateMatrix(
  _cfg: ChatbenchConfig,
  _questionSetsById: Map<string, QuestionSet>,
  _repoRoot: string,
): CallSpec[] {
  throw new Error('chatbench:enumerateMatrix not implemented');
}

/** Cost band ($USD) for a matrix row given input rate + output rate ($/MTok). */
export function estimateCostBand(
  _row: CallSpec,
  _inputPerMTokUsd: number,
  _outputPerMTokUsd: number,
): { minUsd: number; maxUsd: number } {
  throw new Error('chatbench:estimateCostBand not implemented');
}
