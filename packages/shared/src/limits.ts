/**
 * Hard latency budgets from BUILD.md guardrail 5.
 * These are contract values; tests assert them and other packages import them.
 */
export const LIMITS = {
  /** Hook scripts must return within this budget when the sidecar is down (fail-open). */
  HOOK_FAIL_OPEN_MS: 50,
  /** Local LLM calls time out after this and fall back to the rule engine. */
  LOCAL_LLM_TIMEOUT_MS: 2500,
  /**
   * redutok-pipe's budget for the post-command /distill round-trip to the
   * sidecar (v3 pillar A). Pure overhead added after the wrapped command has
   * already finished, so it is bounded tightly: a profile's own local-model
   * pass is guarded separately by LOCAL_LLM_TIMEOUT_MS inside the sidecar, and
   * this sits just above it so an LLM-backed profile is not cut off, while a
   * hung or dead sidecar fails open to raw passthrough within this ceiling.
   */
  PIPE_SIDECAR_TIMEOUT_MS: 3000,
  /**
   * One-time model warmup budget before a semantic drafting loop. The first
   * inference after Ollama starts loads the model from disk (measured 9.2s
   * for qwen2.5:7b-instruct on this machine) and must not eat the per-call
   * budget, which stays LOCAL_LLM_TIMEOUT_MS for every drafting call.
   */
  OLLAMA_WARMUP_TIMEOUT_MS: 120_000,
  /**
   * Per-call budget for offline batch drafting (redutok codex refresh
   * --with-llm). The 2500ms LOCAL_LLM_TIMEOUT_MS guards in-session calls so a
   * session never waits on the sidecar; an operator-invoked offline refresh
   * is in no session's path and may wait longer per call. Measured on this
   * machine: a warm one-sentence draft takes about 5.5s on CPU.
   */
  SEMANTIC_BATCH_DRAFT_TIMEOUT_MS: 15_000,
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
  /**
   * Energy-per-outcome reference band by session shape, docs/SCORING.md.
   * Agentic turns carry tool payloads and re-prefill cost that chat turns do
   * not, so a flat per-turn reference would structurally punish agentic work.
   * Product tuning constants, not measured claims.
   */
  EPO_BASELINE_WH_PER_TURN_BY_SHAPE: { chat: 2.5, mixed: 8, agentic: 25 },
  /** Session shape from tool-cycle density (share of turns invoking tools). */
  SESSION_SHAPE_TOOL_DENSITY: { chatMax: 0.2, mixedMax: 0.6 },
  /** Composite weights per score, docs/SCORING.md. Renormalized over scorable scores. */
  SCORE_WEIGHTS: {
    contextEfficiency: 0.35,
    outputDiscipline: 0.25,
    cacheUtilization: 0.25,
    energyPerOutcome: 0.15,
  },
  /** Grade boundaries: composite at or above the bound earns the letter; below all is F. */
  GRADE_BOUNDS: [
    [90, 'A'],
    [80, 'B'],
    [70, 'C'],
    [60, 'D'],
  ],
  /**
   * dcp__explore internal step ceiling per budget tier (architecture-v2
   * pillar 1). One search sweep counts as a step; each file skeleton-read
   * counts as another. Exceeding the cap before a verdict is reached
   * produces `incomplete` with whatever evidence was gathered, per spec.
   * Product tuning constants, not measured claims.
   */
  EXPLORE_STEP_CAP: { quick: 3, standard: 6, thorough: 12 },
  /** dcp__explore wall-clock ceiling per budget tier, paired with EXPLORE_STEP_CAP. */
  EXPLORE_WALL_CLOCK_MS: { quick: 5_000, standard: 15_000, thorough: 30_000 },
  /**
   * Graduation confidence formula and thresholds, docs/GRADUATION.md (v4
   * Compounding Codex phase 2). Confidence is
   *   clamp((1 - 0.5^(occurrences / OCCURRENCE_HALF_SATURATION))
   *         * 0.5^(daysSince(lastSeen) / RECENCY_HALF_LIFE_DAYS)
   *         - CONTRADICTION_PENALTY * contradictions, 0, 1).
   * Two fresh observations sit exactly at GRADUATE_MIN_CONFIDENCE; a weakly
   * supported graduated entry withdraws on its first contradiction while a
   * seven-session entry takes three. Product tuning constants, not measured
   * claims.
   */
  GRADUATION: {
    /** Occurrence count at which the occurrence term reaches 0.5 (saturating toward 1). */
    OCCURRENCE_HALF_SATURATION: 2,
    /** Days since lastSeen that halve the confidence. */
    RECENCY_HALF_LIFE_DAYS: 14,
    /** Flat confidence cost per recorded contradiction. */
    CONTRADICTION_PENALTY: 0.25,
    /** A candidate at or above this is eligible to graduate into the codex. */
    GRADUATE_MIN_CONFIDENCE: 0.5,
    /** A contradicted graduated entry below this is withdrawn from the codex. */
    WITHDRAW_BELOW_CONFIDENCE: 0.3,
    /** Hard token budget for the codex learned section at injection time. */
    LEARNED_SECTION_MAX_TOKENS: 500,
  },
} as const;

export type Limits = typeof LIMITS;
