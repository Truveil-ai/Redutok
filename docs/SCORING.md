# Session scoring

Four scores, each 0 to 100, plus an A to F composite. All formula inputs
trace to ledger fields (packages/meter/src/ledger.ts) or audit events
(.dcp/audit.jsonl). A score whose inputs are missing is reported as
"not scorable" with the reason; it is never silently defaulted and it is
excluded from the composite, whose weights renormalize over the scorable
scores. Implementation: packages/meter/src/scoring.ts; constants in
packages/shared/src/limits.ts. All thresholds and weights are product tuning
constants, not measured claims.

## Context Efficiency (weight 0.35)

100 x (rawBytes - servedBytes) / rawBytes, over audit events with action
distill or serve-raw carrying **both** bytesIn and bytesOut: the share of the
raw a session touched that never entered its context. Only events attributed
to the transcript's session id count (see ARCHITECTURE.md 7.3). Clamped to
0..100, since a distillate can exceed its raw on a short artifact.

Raw serves where a distillation path existed remain the redundancy signal: a
raw serve carries bytesOut equal to bytesIn, so it avoids nothing and pulls
the score down by its full weight.

Not scorable without an audit trail, without serve events, or when no serve
carries a raw byte count — a served byte count with nothing behind it says
what was served and nothing about what it replaced. When dcp tools are visible
in the session's tool table but no audit events carry its session id, the
reason reads "audit events not attributable to this session" — never a claim
of non-use that the ledger contradicts.

**This definition changed in 0.1.4.** Through 0.1.3 the score was
100 x distilledBytes / (distilledBytes + rawServedBytes): a ratio against the
bytes a session served raw, rather than against the raw those serves stood in
for. It was degenerate in the common case, because a session where nothing
failed open scored 100 regardless of what it saved, and the same artifact
scored differently depending on which serve path handled it. A live 0.1.3
session scored 100 with the detail "22138B distilled vs 0B raw across 2
serves". Scores computed under the two definitions are not comparable; see
[BENCH-REPORT.md](BENCH-REPORT.md) section 8.

The detail string changed with it, from "<distilled>B distilled vs <raw>B raw"
to "<served>B served for <raw>B raw", so which definition produced a given
figure is legible from the figure itself.

## Output Discipline (weight 0.25)

100 x min(1, VERBOSE_OUTPUT_TOKENS_PER_TURN / avgOutputTokensPerTurn), where
the average includes thinking tokens (ledger totals over turns). Full-rewrite
denial and patch-compliance terms are defined but held at neutral until hook
decisions reach the audit trail; this is a stated limitation, not a hidden
default. Not scorable with zero turns.

## Cache Utilization (weight 0.25)

100 x cacheRead / (cacheRead + input) over turns 2..N (the first turn cannot
hit cache). Not scorable with fewer than two turns or zero cacheable tokens.

## Energy per Outcome (weight 0.15)

100 x min(1, baseline / whPerTurn), where whPerTurn is the session's
estimated base Wh divided by completed assistant turns and baseline comes
from EPO_BASELINE_WH_PER_TURN_BY_SHAPE for the session's shape. Shape is
derived from tool-cycle density, the share of turns invoking at least one
tool (ledger tools field): chat below SESSION_SHAPE_TOOL_DENSITY.chatMax,
agentic at or above mixedMax, mixed between. Rationale: agentic turns carry
tool payload processing and repeated prefill that chat turns do not, so a
flat per-turn reference would structurally punish agentic sessions. The
outcome proxy remains completed turns (docs/METHODOLOGY.md) and the score's
report line says so inline. Not scorable without an energy estimate.

## Composite

Weighted mean of scorable scores with weights renormalized, rounded.
Grades from GRADE_BOUNDS: A at 90, B at 80, C at 70, D at 60, F below.

### Disclosure of how many scores contributed

Renormalizing over the scorable scores keeps the arithmetic honest, but the
rendered composite used to hide how thin it was: a session with only output
discipline and cache utilization computable rendered "composite 100 (A)",
which reads as a verdict on all four dimensions when it is a verdict on two.
The count now travels with the number:

- **Four of four.** `composite 97 (A)`. Nothing to disclose.
- **Three of four.** `composite 97 (A, from 3 of 4 scores)`. The grade still
  stands; the reader is told what it rests on.
- **Fewer than three** (COMPOSITE_MIN_SCORES_FOR_GRADE in
  packages/shared/src/limits.ts). No letter grade at all:
  `composite 100 (partial, from 2 of 4 scores; no grade below 3)`. The value
  stays visible, because suppressing it would be its own dishonesty, but it
  no longer wears a grade the session did not earn.
- **None scorable.** `composite not scorable: no individual score was
  computable`, as before.

The letter is absent from the `CompositeScore` object itself on a partial
composite, not merely hidden at render time, so a consumer cannot print a
grade by forgetting to check a flag. Every surface that shows a composite —
the report, the SVG badge, the session receipt, the bench tables — renders it
through `renderCompositeValue` or `compositeCell` in
packages/meter/src/scoring.ts, so the disclosure cannot drift between them.

The threshold of three is a product tuning constant, not a measured claim.
The reasoning: at three of four the missing dimension shifts the mean but the
remaining evidence still spans context, output, and one of cache or energy; at
two it does not.
