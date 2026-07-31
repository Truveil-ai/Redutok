import type { AnthropicLike, MessageInput, MessagesResponse } from './types.js';

export interface VaultTools {
  /** Called when the model emits a `vault_ask` tool_use. */
  vaultAsk: (args: Record<string, unknown>) => Promise<string> | string;
  /** Called when the model emits a `vault_zoom` tool_use. */
  vaultZoom: (args: Record<string, unknown>) => Promise<string> | string;
}

export interface VaultLoopResult {
  assistantText: string;
  turns: number;
  toolCallCount: number;
  usage: { inputTokens: number; outputTokens: number };
  /** Full message history after the loop, for continuation across questions. */
  messages: MessageInput[];
}

/**
 * Runs a Messages-API tool-use loop with vault_ask / vault_zoom proxied to
 * the supplied `tools`. Returns aggregated usage across all turns of this
 * single-question call. Prior messages let follow-up questions ride the
 * same conversation.
 */
export async function runVaultLoop(
  _client: AnthropicLike,
  _model: string,
  _systemPrompt: string,
  _prior: MessageInput[],
  _userMessage: string,
  _tools: VaultTools,
  _opts: { maxTokensPerTurn: number; temperature: number; maxToolTurns?: number },
): Promise<VaultLoopResult> {
  throw new Error('chatbench:runVaultLoop not implemented');
}

/**
 * Runs the PASTE arm's turn: one message in, one response back, no tools.
 * Aggregates usage identically to `runVaultLoop` so downstream accounting
 * is arm-agnostic.
 */
export async function runPasteTurn(
  _client: AnthropicLike,
  _model: string,
  _prior: MessageInput[],
  _userMessage: string,
  _opts: { maxTokensPerTurn: number; temperature: number },
): Promise<{
  assistantText: string;
  usage: { inputTokens: number; outputTokens: number };
  response: MessagesResponse;
  messages: MessageInput[];
}> {
  throw new Error('chatbench:runPasteTurn not implemented');
}
