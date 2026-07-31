import type { ChatbenchConfig, QuestionSet } from './types.js';

/** Load and validate the pre-registered chatbench yaml at `path`. */
export function loadChatbenchConfig(_path: string): ChatbenchConfig {
  throw new Error('chatbench:loadChatbenchConfig not implemented');
}

/** Load a question set yaml (bench/chatbench/{docs,code}.yaml). */
export function loadQuestionSet(_path: string): QuestionSet {
  throw new Error('chatbench:loadQuestionSet not implemented');
}

/**
 * Deterministic hash over the config JSON with `excludeFields` removed.
 * The `failures` list is excluded so it can be appended post-run without
 * re-registering.
 */
export function computeConfigHash(_config: ChatbenchConfig): string {
  throw new Error('chatbench:computeConfigHash not implemented');
}
