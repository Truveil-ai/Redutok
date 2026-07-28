# Graduation: confidence, codex writes, and demotion

v4 (Compounding Codex) phase 2. Phase 1 gave the miner: after every session
the sidecar extracts candidate learnings (error-fix pairs, zoom-back
hotspots, recurrence signals) into `.dcp/candidates.jsonl`. This phase makes
the system act on them: candidates that earn enough confidence graduate into
the codex, contradicted entries are demoted, and everything is audited.

## Confidence

Every candidate carries a confidence score derived from occurrence count and
recency, with a flat penalty per recorded contradiction. Constants live in
`LIMITS.GRADUATION` (`packages/shared/src/limits.ts`); the formula lives in
`candidateConfidence` (`packages/shared/src/confidence.ts`):

```
occurrenceScore = 1 - 0.5^(occurrences / OCCURRENCE_HALF_SATURATION)   # 2
recencyFactor   = 0.5^(daysSince(lastSeen) / RECENCY_HALF_LIFE_DAYS)   # 14
confidence      = clamp(occurrenceScore * recencyFactor
                        - CONTRADICTION_PENALTY * contradictions, 0, 1)  # penalty 0.25
```

Anchor points: one fresh observation scores ~0.29; two fresh observations
score exactly 0.50; seven score ~0.91. Fourteen days of silence halve the
score. Each contradiction costs a flat 0.25, so a two-session entry dies on
its first contradiction while a seven-session entry survives two.

Confidence is computed on demand (so displayed values reflect the current
clock), quantized to four decimals so the seconds between the miner
stamping `lastSeen` and the pass evaluating never decay a fresh
two-session candidate below the graduation threshold; the graduation pass
also persists the value it acted on in the record's `confidence` field.

### Thresholds

- `GRADUATE_MIN_CONFIDENCE` (0.5): a candidate at or above this is eligible
  to graduate. Two fresh sessions observing the same learning are enough.
- `WITHDRAW_BELOW_CONFIDENCE` (0.3): a graduated entry below this is
  withdrawn from the codex — but only when it has at least one recorded
  contradiction. Recency decay alone never withdraws an entry; demotion is
  always evidence-driven and never silent.

## The graduation pass

Graduation runs in the same async post-session pass as the miner
(`runGraduationMiner` in `packages/sidecar/src/graduation.ts`, triggered by
the session-end notify, off the hook path). It is idempotent: re-running the
pass over the same history changes nothing — codex entries are keyed by
candidate id, and contradiction counting remembers the last session that
contributed. Every graduation and every withdrawal writes its own audit
event (`action: graduate` / `action: withdraw`, module `sidecar.graduation`)
to `.dcp/audit.jsonl`.

### What graduation does, per type

- **zoom-hotspot** (a file whose distillate kept sending the session back to
  raw): graduates into a *skeleton-enrichment directive* in the codex's
  generated `learned` section. The directive names the file and the union of
  symbols queried across the observing sessions. From then on the mirror
  entry and the `file-skeleton` profile keep the full bodies of those
  symbols for that file, so the distillate that caused repeated zooming
  stops being inadequate. Only hotspots whose target resolved to a file
  graduate; artifact-class hotspots stay candidates.
- **error-fix**: graduates into a `pitfalls` entry — the normalized error
  signature plus the fix summary (the drafted lesson when one exists,
  otherwise the changed files and command). Pitfalls are injected with the
  codex at SessionStart.
- **recurrence**: graduates into a `conventions` entry (the drafted lesson,
  otherwise the recurring signal).

All generated entries carry `source: graduated` and the candidate id that
produced them. Human-authored (`source: human`) or locked entries are
untouchable by this entire pipeline: graduation never edits them and
withdrawal never removes them.

### Directive matching

A skeleton-enrichment directive's `path` matches a mirror entry either
exactly or as a `/`-boundary suffix (`source/index.js` also enriches
`fixtures/repos/chalk/source/index.js`). Bench sessions observe fixture
repos through their own relative paths; the suffix rule lets the learning
land on every copy of the file the repo mirrors. Enrichment changes are
fingerprinted in the mirror index, so adding or withdrawing a directive
regenerates the affected entries even when the source is unchanged. The
size-sanity gate still applies on the live distill path — enrichment never
bypasses gates.

## Contradiction and demotion

New evidence conflicting with a graduated entry decrements confidence via
the record's `contradiction` counter (one increment per contradicting
session, remembered so re-runs stay idempotent):

- **error-fix**: the same normalized error signature fails again in a
  session that started after the entry graduated — the fix was present in
  the codex, yet the error recurred.
- **zoom-hotspot**: the enriched file still produces zoom-backs in a
  session after graduation — the enrichment did not remove the need to
  zoom.
- **recurrence**: no contradiction rule; conventions age out only through
  the confidence recency term (which lowers budget rank but never
  withdraws).

When a contradicted entry's confidence falls below
`WITHDRAW_BELOW_CONFIDENCE`, the graduation pass withdraws it: the generated
codex entry is removed (locked entries are left in place and noted in the
audit reason), the candidate's status moves to `withdrawn`, and a `withdraw`
audit event records the confidence and contradiction count. Withdrawn
records keep their full history in `candidates.jsonl` and may re-graduate
only if overwhelming re-observation outweighs the standing contradiction
penalty.

## Budget guard

The `learned` section has a hard token budget:
`LIMITS.GRADUATION.LEARNED_SECTION_MAX_TOKENS` (500). At injection time
(`buildCodexInjection`), when the section serializes over budget, the
lowest-confidence directives are excluded first until it fits; a note in the
injection records how many were excluded.

The injector's overall degradation order gains `learned` between
`importGraph` and `interfaces`:

```
glossary → conventions → importGraph → learned → interfaces → keySymbols
```

Rationale: learned entries are the product of repeated observed friction, so
they outrank the generic glossary/conventions/import-graph context — but raw
interface truth (the identifiers needed to write correct code) still
outranks them.

## Lifecycle and visibility

`redutok candidates` shows each record's status — `candidate`, `graduated`,
or `withdrawn` — alongside its live confidence. The audit trail carries one
event per mining run, one per graduation, and one per withdrawal.
