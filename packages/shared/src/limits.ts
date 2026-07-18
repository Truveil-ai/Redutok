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
} as const;

export type Limits = typeof LIMITS;
