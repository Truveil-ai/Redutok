/**
 * Hard latency budgets from BUILD.md guardrail 5.
 * These are contract values; tests assert them and other packages import them.
 */
export const LIMITS = {
  /** Hook scripts must return within this budget when the sidecar is down (fail-open). */
  HOOK_FAIL_OPEN_MS: 50,
  /** Local LLM calls time out after this and fall back to the rule engine. */
  LOCAL_LLM_TIMEOUT_MS: 2500,
  /** Size sanity gate: a distillate above this fraction of raw serves raw instead. */
  SIZE_SANITY_MAX_RATIO: 0.4,
  /** Rolling session_state.md hard cap, architecture 5.2. */
  SESSION_STATE_MAX_TOKENS: 600,
  /** Split advisor fires when a turn's context (input plus cache read) exceeds this. */
  SPLIT_ADVISOR_CONTEXT_TOKENS: 120_000,
  /** Rewriting an existing file above this size draws emit-a-patch guidance. */
  FULL_REWRITE_MAX_BYTES: 16_384,
  /** Prompts at or under this length with no hard markers classify as trivial. */
  TRIVIAL_PROMPT_MAX_CHARS: 120,
  /** Average output tokens per turn above this counts against verbosity adherence. */
  VERBOSE_OUTPUT_TOKENS_PER_TURN: 1500,
} as const;

export type Limits = typeof LIMITS;
