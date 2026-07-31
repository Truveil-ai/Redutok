import type {
  AnthropicLike,
  ChatbenchConfig,
  QuestionRecord,
  QuestionSet,
} from './types.js';

export interface RunOptions {
  cfg: ChatbenchConfig;
  questionSets: Map<string, QuestionSet>;
  client: AnthropicLike;
  repoRoot: string;
  /** Emit a per-record line to this callback for streaming persistence. */
  onRecord?: (r: QuestionRecord) => void;
}

export interface RunResult {
  configHash: string;
  records: QuestionRecord[];
  /** Per (corpus, rep) VAULT arm's vault session id, so callers can fetch a
   * receipt for reconciliation. Empty for PASTE. */
  vaultSessionIds: { corpus: string; rep: number; sessionId: string }[];
}

/** Orchestrate the full matrix live. Not invoked from tests directly. */
export async function runChatbench(_opts: RunOptions): Promise<RunResult> {
  throw new Error('chatbench:runChatbench not implemented');
}
