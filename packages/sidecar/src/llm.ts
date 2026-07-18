/**
 * Hook point for the Phase 5 local-model pass. Nothing in Phase 3 calls a
 * model; profiles are rule-engine only. The interface exists so profiles can
 * be wired later without changing distiller signatures.
 */

export interface LlmPassInput {
  text: string;
  prompt: string;
  timeoutMs: number;
}

export interface LlmPass {
  name: string;
  /** Returns null when unavailable or on timeout; callers must have a rule fallback. */
  summarize(input: LlmPassInput): Promise<string | null>;
}

export class NoopLlmPass implements LlmPass {
  readonly name = 'noop';
  summarize(_input: LlmPassInput): Promise<string | null> {
    return Promise.resolve(null);
  }
}
