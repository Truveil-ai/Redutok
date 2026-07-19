# Redutok v2: Turn Economics

Design addendum to [ARCHITECTURE.md](ARCHITECTURE.md). This document proposes no code; it states the corrected cost model that motivates v2 and specifies four pillars against it. Implementation is out of scope here.

## 1. The corrected cost model

v1 optimized context increment: make each individual tool-output artifact smaller (the distillation profiles in section 4.2 of ARCHITECTURE.md). That is necessary but not sufficient, because Claude Code's prompt-caching billing charges for the accumulated window on every turn, not just for what a single turn adds.

Session cost is the sum over turns of three components:

```
session_cost = sum over turns of (
    accumulated_window_tokens_so_far x cache_read_rate
  + new_content_tokens_this_turn      x cache_write_rate
  + output_tokens_this_turn           x output_rate
)
```

For claude-sonnet-5 (packages/shared/prices.yaml, standard rate as observed in the live bench, not the introductory rate): input 3.00 USD/MTok, cache read 0.30 (0.1x input), cache write 3.75 at the 5-minute tier or 6.00 at the 1-hour tier (1.25x and 2x input), output 15.00 (5x input). The output multiplier alone means a verbose extra turn costs more than a cheap one avoids; the cache-read term means every turn re-bills the entire prior window, so turn count multiplies against accumulated size, not against per-turn content.

A distillation pass that shrinks one artifact from 14,000 tokens to 100 tokens does nothing for the other 29 turns in the session that each re-read the accumulated window at cache rate. If reaching that shrunk artifact costs three extra turns of exploration, the accumulated-window re-read across those three turns can outweigh the 13,900 tokens saved.

### The falsifying evidence

bench/RESULTS.md, live mode, N=1, claude-sonnet-5:

| task | vanilla tokens | redutok tokens | token reduction |
| --- | ---: | ---: | ---: |
| h01 | 171,463 | 229,420 | 0.7x |
| h02 | 323,336 | 245,554 | 1.3x |
| h03 | 256,284 | 490,585 | 0.5x |

Median token reduction: 0.7x, against a 10x Definition of Done threshold. NOT MET.

The turn-count breakdown (counted directly from the committed transcripts, bench/runs/h0{1,2,3}-{vanilla,redutok}-1.jsonl, assistant messages and tool_use blocks) shows why context-increment-only optimization is not enough:

| task | variant | assistant turns | tool calls | tool call breakdown |
| --- | --- | ---: | ---: | --- |
| h01 | vanilla | 8 | 3 | Bash:1, Read:1, Write:1 |
| h01 | redutok | 9 | 4 | ToolSearch:1, dcp__run:1, Read:1, Write:1 |
| h02 | vanilla | 12 | 6 | Bash:5, Write:1 |
| h02 | redutok | 11 | 4 | Bash:2, Read:1, Write:1 |
| h03 | vanilla | 12 | 8 | Bash:2, Read:5, Write:1 |
| h03 | redutok | 32 | 22 | ToolSearch:1, dcp__read:5, dcp__zoom:10, Read:5, Write:1 |

h03-redutok is the clearest case. Ten of its twenty-two tool calls are dcp__zoom: the agent read a distilled artifact, found it insufficient, and zoomed back to the raw content, repeatedly. Each zoom is its own turn, and each turn re-bills the accumulated window at cache rate on top of whatever the zoom itself costs. The distillation on the first pass was correctly shrunk per the section 4.2 profile, and the zoom escape hatch worked exactly as specified in section 4.4, but the two together produced 32 turns against vanilla's 12, and the accumulated-window re-read across that gap is what turns a per-artifact win into a 0.5x session-level loss.

This matches the PROGRESS.md diagnosis already on record: redutok's fixed per-session overhead (codex injection, MCP tool-schema loading via ToolSearch, exploration turns to reach the relevant file) can cost more than it saves on tasks that do not generate a raw artifact large enough for the distiller to matter. h02, where redutok used fewer turns than vanilla (11 vs 12) and won on tokens (1.3x), is the counterexample that proves the mechanism: turn count, not artifact size, is the lever.

v2's four pillars all attack turn count directly: collapse many small exploration turns into one (Pillar 1), move exploration into a subagent whose turns do not bill the parent's accumulated window (Pillar 2), make the cost of turn count visible and actionable (Pillar 3), and remove fixed per-turn overhead that has nothing to do with the task (Pillar 4).

## 2. Pillar 1: dcp__explore

Problem it kills: the many-small-turns pattern from the h03-redutok evidence above (32 turns, 10 of them zoom-backs). Today the model drives exploration turn by turn: read, evaluate, zoom, search again. Every one of those turns re-bills the accumulated window. dcp__explore replaces the turn-by-turn loop with one call: the model states a goal, the sidecar runs the multi-step hunt internally, and the model receives one dossier back.

### Tool schema

```
dcp__explore(goal: string, scope?: string[], budget?: "quick" | "standard" | "thorough")
```

- `goal`: natural-language statement of what the model needs to know or find (mirrors how the model would phrase a Task-tool delegation today).
- `scope`: optional path or glob hints to bound the search; omitted means repo-wide.
- `budget`: maps to an internal step-count and wall-clock ceiling (see Safety bounds); default `standard`.

### Dossier format

```
{
  verdict: string,          // one paragraph, direct answer to the goal
  evidence: [
    { file: string, line: number, snippet: string, why: string }
  ],
  zoomHandles: string[],   // dcp__zoom handles for every artifact touched internally
  stepsTaken: number,
  distillationRatio: number,   // raw tokens seen internally / tokens in this dossier
  incomplete?: { reason: string, continuationHint: string }
}
```

The dossier is the only thing that enters the model's context. Every artifact the sidecar read internally while assembling it is retained in the state store exactly as section 4.4 already specifies, so a zoom handle in `evidence` or `zoomHandles` still resolves to the raw content without re-executing anything. The model gets the zoom escape hatch without paying a turn for every zoom-back that the internal hunt needed.

### Internal execution

The sidecar runs its own bounded loop using the mechanisms that already exist: the profile table (section 4.2), the quality gates (section 4.3), and the local model when Ollama is present, rule-engine fallback when it is not (section 4.4's escape hatch and the graceful-degradation principle in section 1). This is not new inference infrastructure; it is the existing per-artifact pipeline invoked repeatedly inside one sidecar-side loop instead of once per model-visible turn.

### Safety bounds

- Read-only. The internal loop may call the sidecar's own read/search/skeleton paths; it may not call Write, Edit, or execute arbitrary shell commands. A goal that requires a mutation is answered with `incomplete` and a continuation hint back to the model, which performs the mutation itself in its own turn.
- No network. Consistent with guardrail 8 (ARCHITECTURE.md section 4, e2e-smoke acceptance test): the internal loop may call the local Ollama model; it may not reach the network.
- No frontier model calls. dcp__explore does not itself call Claude; the sidecar's own local-model pass (or rule-engine fallback) does the internal reasoning. This keeps the pillar's cost off the metered session entirely except for the one dcp__explore turn and its dossier.
- Step cap and timeout. `budget` bounds both the number of internal read/search steps and wall-clock time. Exceeding either produces `incomplete` with whatever evidence was gathered, rather than blocking the model indefinitely.
- Full audit trail. One audit event per dcp__explore call records the internal step count, which profiles fired, gate pass/fail per step, and the overall distillation ratio, exactly as any other audited distillation today (section 7.3). The internal steps are not separately metered as session turns, but they are not invisible either.

### Failure modes

- Sidecar not running: tool absent from the registration; the model falls back to raw Read/Bash/Grep per the existing graceful-degradation principle.
- Step cap or timeout hit before a verdict is reached: dossier returns `incomplete` with a continuation hint (for example, a narrower `scope` or a raised `budget`).
- Local model absent or times out mid-loop: the affected internal step falls back to the rule engine per the existing per-profile quality gate (section 4.3), same as it does for a single dcp__read today; the dossier's `distillationRatio` reflects the resulting mix.
- Goal requires a write: dossier returns `incomplete`, the model performs the mutation directly.

## 3. Pillar 2: scout subagents

Problem it kills: the same many-turns pattern as Pillar 1, but for exploration that genuinely benefits from a model driving it (open-ended investigation dcp__explore's bounded internal loop is not suited for), where every turn today still lands in the parent session's accumulated window.

A scout is a `.claude/agents` definition, not a new mechanism: it is a subagent whose instructions route all reading through the dcp tools (dcp__read, dcp__run, dcp__search, dcp__zoom) instead of raw Read/Bash/Grep, and whose final output is constrained to a bounded brief rather than a full transcript. The parent invokes it like any subagent call; the difference from an ordinary subagent is the routing instruction and the brief-format contract.

### Brief format

```
{
  verdict: string,
  evidence: [{ file: string, line: number, note: string }],
  zoomHandles: string[],
  tokensUsed: number
}
```

### Token cap

The brief is capped (a fixed budget in tokens, tuned during implementation the same way VERBOSE_OUTPUT_TOKENS_PER_TURN is today, not asserted here as a validated number). The cap is enforced the way Output Discipline already enforces verbosity today (section 6 of ARCHITECTURE.md): the scout's own protocol instructs it to stay under the cap, and the parent-side hook that receives the brief can flag an over-cap return the same way the Stop hook flags a full-file rewrite.

### Why this attacks turn count

The scout's internal turns (however many it takes to explore) run in the subagent's own context and bill the subagent's own accumulated window. The parent session pays for exactly one turn: the call out, and one turn back: the brief. Ten internal zoom-backs inside a scout cost ten turns of that scout's own, smaller, disposable window; they cost the parent zero turns. This is the direct fix for the h03-redutok pattern: if the equivalent exploration had run inside a scout, the parent's accumulated-window re-read would only ever have included the final brief, not the 22 tool calls that produced it.

### Audit attribution

Claude Code already passes a transcript session id to hooks but not to MCP servers (ARCHITECTURE.md section 7.3), which is why the sidecar registers the active session id on SessionStart and PostToolUse and stamps it on every audit event and artifact. A scout subagent runs as its own session with its own session id, so its internal reads, distillations, and zooms are audited under that child session id exactly as they would be for any session. The parent's audit trail gets one additional event: the scout invocation itself, referencing the child session id and the brief's token count. A cost or audit rollup that wants the full picture follows that reference to the child session's own audit trail rather than merging turn counts; the parent's own ledger and turn count are unaffected by what happened inside the scout.

## 4. Pillar 3: lifecycle promoted

v1 already has a split advisor (ARCHITECTURE.md section 5.4, discipline.ts, SPLIT_ADVISOR_CONTEXT_TOKENS at 120,000) and a compaction alliance (section 5.3, PreCompact hook plus handoff). Both were secondary in v1 relative to the codex and distiller. Under the corrected cost model, they are headline features: they are the direct lever against accumulated-window re-read cost, which the model above shows dominates once turn count grows.

### Quantified counterfactual insights

The split advisor already fires on a threshold. v2 adds a computed insight alongside the fire: using the session's own ledger (per-turn token counts, already recorded) and audit trail (already recorded), the sidecar computes what the session would have cost had it split at an earlier turn versus what it actually cost by continuing. This is arithmetic over data the meter already has, no new measurement:

```
counterfactual_savings ~= sum over turns after the proposed split point of (
    (accumulated_window_at_that_turn - accumulated_window_at_split_point) x cache_read_rate
)
```

This number is disclosed as an estimate, the same discipline v1 already applies to energy and carbon figures (ARCHITECTURE.md section 7.2: "never measurements"). The Stop-hook summary states it plainly, for example: "Splitting after turn 14 would have saved an estimated N tokens of accumulated-window re-read across the remaining session." No claim stronger than "estimated" is made, and the arithmetic above is disclosed alongside the number so it can be checked.

### Compaction alliance and handoff, promoted

The mechanism is unchanged from ARCHITECTURE.md section 5.3: PreCompact injects rolling state and codex reference so native compaction preserves DCP state, and the handoff command writes a handoff file plus a resume command. What changes in v2 is prominence: because the cost model shows turn count multiplying accumulated-window re-read, a session that keeps going past its natural split point is not a minor inefficiency, it is the largest single lever available. v2 promotes the handoff prompt from an advisory aside to a headline action the split advisor's Stop-summary line actively recommends, with the quantified counterfactual above as the justification shown inline.

## 5. Pillar 4: cache discipline and the idle gear

Problem it kills: fixed per-turn and per-session overhead that exists regardless of task size, which the corrected cost model shows is punished on every turn, not amortized once.

### Append-only injection posture

Claude Code's prompt cache is a prefix cache: a turn's accumulated window is billed at the cheap cache-read rate only for the portion of the prefix that is unchanged from the previous turn. Any mutation of already-injected context (rewriting an earlier hook's additionalContext, editing the codex block after it has been injected) invalidates the cache from that point forward, forcing the remainder of the prefix to be billed at the pricier cache-write rate on the next turn instead of cache-read. v2's injection posture is append-only: SessionStart, PreCompact, and any other hook that injects context may only add to the end of what has already been injected in the session, never rewrite or reorder prior injections. This is a rule, not a new mechanism; it costs nothing to state and it protects the cache-read discount the cost model in section 1 depends on.

### Eager tool registration

The h01-redutok and h03-redutok transcripts each spend one tool call on ToolSearch to load the dcp tool schemas before any dcp tool can be called; this is a real, measured turn in both transcripts (see the turn-count table in section 1), not a hypothetical. v2 registers the dcp__* tool schemas eagerly at session start instead of leaving them deferred behind ToolSearch, eliminating that turn entirely on every session that uses any dcp tool.

### Session-posture rules: idle gear versus engaged

PROGRESS.md's own honest finding stands: on tasks that do not generate a raw artifact large enough for the distiller to help with, redutok's fixed per-session overhead costs more than it saves (the h01 and h03 results above are exactly this). v2 formalizes a posture switch instead of leaving every session on full governance:

- **Idle gear**: no codex injection beyond the minimal handle, no ToolSearch, no dcp routing hook active, session runs effectively vanilla. Engaged when the sidecar's own signal (comparable in kind to the existing SMALL_READ_BYTES threshold that already gates raw-versus-distilled at the single-file level, ARCHITECTURE.md section 4.1) indicates the session is unlikely to touch anything large enough for distillation to matter.
- **Engaged gear**: full protocol, full routing, full distillation, as v1 and this document's Pillars 1 through 3 specify.

The exact thresholds that decide which gear a session starts in, and what triggers a mid-session upgrade from idle to engaged, are implementation tuning constants in the same spirit as SPLIT_ADVISOR_CONTEXT_TOKENS, FULL_REWRITE_MAX_BYTES, TRIVIAL_PROMPT_MAX_CHARS, and VERBOSE_OUTPUT_TOKENS_PER_TURN already are (ARCHITECTURE.md section 5.4 and section 6): product tuning constants, not measured claims, to be set and revised against bench evidence during implementation rather than asserted here.

## 6. Unchanged from v1

The following carry forward from ARCHITECTURE.md without modification:

- The meter (packages/meter): token ledger, cost computation, energy and carbon estimation, grading and badges.
- Receipts (packages/meter/src/receipt.ts): the session receipt, assembled entirely from local files with no model call and no network.
- The energy ledger and its estimation discipline (ARCHITECTURE.md section 7.2): estimates with bands, never measurements.
- The audit trail (ARCHITECTURE.md section 7.3): append-only audit.jsonl, session attribution, per-artifact distillation records.
- The quality gates (ARCHITECTURE.md section 4.3): entity preservation, verdict fidelity, size sanity, latency budget.
- The distiller as a library: the profile table and gate pipeline that Pillar 1's internal loop and Pillar 2's scout routing both call into are the same distiller, invoked more often and from more places, not replaced.

## 7. Validation plan

### Prototype scope

A minimal implementation of dcp__explore (Pillar 1) and one scout subagent definition (Pillar 2) only. No lifecycle promotion (Pillar 3) and no session-posture switch (Pillar 4) in the prototype; those pillars change when governance engages, not how much a single engaged session costs, and are validated separately once Pillars 1 and 2 are in place.

### The falsifiable test

Rerun h03 only, same conditions as the live bench already on record: claude-sonnet-5, N=1, live headless mode, same task file (bench/tasks/h03.yaml), same fixture repo. h03 is the task where the turn-count table in section 1 shows the clearest many-small-turns failure (32 turns, 10 zoom-backs, 0.5x token reduction), so it is the task most directly targeted by dcp__explore and the scout pattern.

### Pass criterion, stated in advance

redutok h03 must move from 0.5x to at least 1.2x token reduction at parity (task success unchanged, pass to pass), N of 1.

This is deliberately a narrow bar, not the v1 Definition of Done's 10x threshold: it asks only whether collapsing h03-redutok's 32-turn, 10-zoom-back pattern into fewer, larger turns is sufficient to flip that one task from a loss to a win. A result at or above 1.2x is evidence the turn-count mechanism in section 1 is real and addressable; a result below 1.2x means Pillars 1 and 2 as specified here did not fix it and the mechanism needs re-diagnosis before further pillars are built.
