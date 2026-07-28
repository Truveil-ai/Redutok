# Session posture: the idle gear

Architecture-v2 pillar 4 (v4 Session 3). Governance engages proportionally
to what it can earn. The honest finding that motivates this is recorded in
PROGRESS.md and the h01/h03 bench sessions: on repos and tasks that never
produce an artifact large enough for the distiller to help with, redutok's
fixed per-session overhead (codex injection, per-turn probes, advisory
hints) costs more than it saves. The posture switch formalizes the response
instead of leaving every session on full governance.

## The assessment

At SessionStart the hook assesses the repo (`assessSessionPosture`,
`packages/sidecar/src/posture.ts`):

- **indexed file count** — from the codex when one exists, else counted by
  the walk;
- **total source bytes** — a bounded walk over indexable files (same
  extension whitelist, skip dirs, and sub-1MB rule the codex indexer uses);
- **presence of graduated knowledge** — learned entries and pitfalls in the
  codex.

The walk is bounded by construction: it stops as soon as either
full-posture threshold is crossed, so its cost is O(threshold), never
O(repo). A pathological tree (over 2,000 directories visited before a
verdict) aborts the walk and engages full governance: the fail-open
direction is never a wrongly idle session. The decision rules are pure
(`decidePosture`, `packages/shared/src/posture.ts`); the thresholds live in
`LIMITS.POSTURE` (`packages/shared/src/limits.ts`), product tuning
constants in the same spirit as `TRIVIAL_PROMPT_MAX_CHARS`:

| posture | rule |
| ------- | ---- |
| `full`  | files > `LIGHT_MAX_FILES` (120) or bytes > `LIGHT_MAX_SOURCE_BYTES` (2 MB) |
| `idle`  | at or below `IDLE_MAX_FILES` (25) and `IDLE_MAX_SOURCE_BYTES` (256 KB), with no graduated knowledge |
| `light` | everything between, and any small repo that has earned lessons |

Graduated or human-curated knowledge (learned entries, pitfalls) always
lifts a session to at least light: those entries are the product of
repeatedly observed friction and cost almost nothing to inject, so they are
never silenced by repo size. Knowledge never downgrades a full repo.

An operator can pin the posture in `.dcp/config.json`
(`{"posture": "full" | "light" | "idle"}`), which skips assessment
entirely and is marked `(pinned)` in the audit trail and receipt.

## What each posture does

- **full** — current behavior: protocol block, full codex injection (with
  the budget discipline below), read/pipe/mirror routing, advisory hints.
- **light** — protocol block plus a slim injection: codex summary, learned
  entries, and pitfalls only (`buildInjection(codex, { posture: 'light' })`).
  Per-turn hooks stay engaged.
- **idle** — a one-line notice is the entire injection. Every per-turn hook
  (PreToolUse, PostToolUse, UserPromptSubmit, PreCompact) passes through
  immediately: no sidecar probe, no rewrite, no advisory, zero per-turn
  overhead. Rolling state and incremental reindexing sleep with the hooks;
  the next engaged session or an explicit `redutok codex refresh` catches
  the repo up. The meter still records: the Stop summary, receipt, and
  ledger are untouched.

The decision is persisted to `.dcp/session-posture.json` (the per-turn
hooks and the Stop receipt read it; a missing or mismatched record means
full engagement) and audited through the sidecar as an `action: posture`
event carrying the full basis. The receipt prints it:

```
Redutok receipt for session <id>
  billed   ...
  posture  full (156 files, 2,900 KB source, 19 learned)
  ...
```

## Injection budgets

`LIMITS.INJECTION` documents the ceilings the SessionStart injection obeys
(asserted against this repository's own committed mirror in
`packages/sidecar/test/injection-budget.test.ts`):

- `CODEX_MAX_TOKENS` (3000) — the rendered codex injection, enforced by
  `buildInjection`.
- `TOTAL_MAX_TOKENS` (3500) — protocol block plus codex plus learned.

The degrade order (`glossary → conventions → importGraph → learned →
interfaces → keySymbols`, docs/GRADUATION.md) is a priority ranking, not a
death list: after the in-order drop loop fits the budget, a restore pass
brings back any dropped section — most-protected first — that the final
budget has room for. The observed case on this repository: the 8k-token
interfaces section can never fit the budget, and without the restore pass
it dragged the 500-token learned section down with it, so graduated
knowledge never reached a session. Learned-budget exclusions
(lowest-confidence first) and dropped sections ride the posture audit
event: nothing leaves the injection silently.

## Per-lesson attribution

So the graduation miner can detect contradictions and the slope bench can
measure cause per lesson (v4 Session 4):

- the posture audit event's details carry `injectedLearned`,
  `excludedLearned`, and `injectedPitfalls` candidate refs for the session;
- every `dcp__read` serve that applied a skeleton-enrichment directive tags
  its distill audit event with the directive's candidate ref
  (`details.enrichmentCandidate`).
