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
  /**
   * How many of the four scores must contribute before the composite is
   * allowed to wear a letter grade. Below this it renders as an explicitly
   * partial result: a weighted mean of two scores is not evidence about the
   * two that could not be computed, and a bare letter reads as if it were.
   */
  COMPOSITE_MIN_SCORES_FOR_GRADE: 3,
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
  /**
   * Session-posture thresholds, architecture-v2 pillar 4 (docs/POSTURE.md).
   * Governance engages proportionally to what it can earn: at or below the
   * IDLE bounds (and with no graduated knowledge to serve) the fixed
   * per-session overhead cannot pay for itself — the h01/h03 bench sessions
   * are the honest evidence — so the session runs effectively vanilla. Above
   * the LIGHT bounds the full protocol engages. Between them, the session
   * gets the cheap high-value injection only (summary, learned, pitfalls).
   * Product tuning constants, not measured claims.
   */
  POSTURE: {
    IDLE_MAX_FILES: 25,
    IDLE_MAX_SOURCE_BYTES: 262_144,
    LIGHT_MAX_FILES: 120,
    LIGHT_MAX_SOURCE_BYTES: 2_097_152,
  },
  /**
   * The artifact-size escape hatch (docs/POSTURE.md). Posture decides the
   * session's default engagement; it never vetoes an individual artifact. A
   * single read at or above this size engages distillation in every posture,
   * idle included, because one artifact this large outweighs the whole
   * per-session overhead the idle bound was protecting against: at the
   * meter's ~4 bytes per token heuristic it is roughly 32,000 tokens from one
   * tool call, a sixth of a 200K context window. Everything below it in idle
   * stays vanilla, so the idle worst case is unchanged. The field case is a
   * documents repo assessed light at 81 files where a 263KB Markdown, a 186KB
   * Markdown and a 1.2MB PDF all entered context raw.
   * Product tuning constant, not a measured claim.
   */
  GOVERN_ANY_ARTIFACT_BYTES: 131_072,
  /**
   * Budget for the on-demand skeleton build the escape hatch falls back to
   * when nothing has indexed the artifact yet (docs/POSTURE.md). Deliberately
   * far above HOOK_FAIL_OPEN_MS: that budget bounds a liveness probe against a
   * dead sidecar, while this one pays for real work on an artifact already
   * known to be over GOVERN_ANY_ARTIFACT_BYTES — parsing a 1.2MB PDF text
   * layer is seconds, and the alternative is that artifact entering context
   * whole. A timeout here still fails open to the raw read.
   */
  SKELETON_PREPARE_TIMEOUT_MS: 8_000,
  /**
   * Size ceiling for the offline mirror pre-build of a prose document or an
   * HTML page (`redutok codex refresh`). The source walk stops at 1MB because
   * a source file that large is generated rather than written; a document
   * that large is ordinary — the field case was a 1.2MB PDF — so documents and
   * pages get their own, higher bound. Above it the artifact is left to the
   * on-demand path, which builds its skeleton when a read actually asks for
   * it, rather than making every refresh pay for a file nothing has opened.
   * Product tuning constant, not a measured claim.
   */
  MIRROR_PREBUILD_MAX_BYTES: 8_388_608,
  /**
   * SessionStart injection budgets (docs/POSTURE.md). CODEX_MAX_TOKENS caps
   * the rendered codex injection via the degrade-and-restore order in
   * buildInjection; TOTAL_MAX_TOKENS is the documented ceiling for the whole
   * SessionStart injection (protocol block plus codex plus learned), asserted
   * against this repository's own mirror in injection-budget.test.ts. Product
   * tuning constants, not measured claims.
   */
  INJECTION: {
    CODEX_MAX_TOKENS: 3000,
    TOTAL_MAX_TOKENS: 3500,
  },
  /**
   * Vault codex emission budget (Session 4, zero-turn channel). The codex
   * emitted by `vault codex` is pasted into a claude.ai Project instructions
   * block; MAX_TOKENS is the hard ceiling for the whole rendered Markdown,
   * GRADUATED_MAX_TOKENS the sub-budget for graduated entries within it.
   * When either budget is exceeded, entries are excluded lowest-confidence
   * first (mirroring GRADUATION.LEARNED_SECTION_MAX_TOKENS discipline in
   * buildInjection). Product tuning constants, not measured claims.
   */
  VAULT_CODEX: {
    MAX_TOKENS: 2000,
    GRADUATED_MAX_TOKENS: 600,
  },
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
