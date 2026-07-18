# Redutok — Build Kickoff Pack
## Instructions for building with Claude Code, phase by phase

**Product:** Redutok by Truveil — open-source token and energy reduction layer for Claude Code
**Protocol:** Delta Context Protocol (DCP) v1
**CLI:** `redutok`, alias `rtk`
**Reference document:** `dcp-architecture-v1.md` (keep in repo root as `docs/ARCHITECTURE.md`)

---

## How to use this pack

Work in **one phase per Claude Code session**. Each session gets three files as context: this pack, the architecture document, and the phase's acceptance criteria. Do not carry a session across phases; start fresh (we practice the delta principle while building the delta tool). At the end of every phase, commit, run the full test suite, and update `PROGRESS.md` with what was completed and any deviations from the architecture, so the next session cold-starts from a 200-token status instead of a transcript.

**Session opener (paste at the start of each phase):**

> Read docs/ARCHITECTURE.md, BUILD.md (this file), and PROGRESS.md. We are building Phase N only. Do not build ahead. Follow the guardrails section strictly. Write tests first for every module in this phase. When acceptance criteria are met, stop and summarize.

---

## Global guardrails (apply to every session)

1. **TypeScript everywhere.** Node 20+, pnpm workspaces, strict mode, ESM. Test runner: vitest. Lint: eslint + prettier, enforced via a PostToolUse hook in this repo itself.
2. **No fabricated numbers.** Pricing goes in `packages/shared/prices.yaml` and energy factors in `packages/shared/energy_factors.yaml`, every row carrying a `source:` field. Where a real citation is not yet verified, write `source: TODO-VERIFY` and list it in `PROGRESS.md`. Never invent a Wh/token value silently.
3. **Every compression decision is logged.** If a module drops, truncates, or summarizes anything, it must write an audit event. No silent transformation anywhere in the codebase. This is the Truveil DNA and it is non-negotiable.
4. **Graceful degradation is a test case, not a comment.** Every integration (Ollama, sidecar socket, hooks) ships with an explicit test proving the system works when that dependency is absent.
5. **Hard latency budgets.** Hook scripts: 50ms if sidecar is down (fail-open). Local LLM calls: 2500ms timeout with rule-engine fallback. These are constants in `packages/shared/limits.ts` and tested.
6. **Deterministic before neural.** Every distillation profile implements its rule-based extraction first; the local-model pass is an optional enhancement layered on top, never the only path.
7. **Fixtures over mocks where possible.** Real captured artifacts (build logs, test output, JSONL session logs) live in `fixtures/` and drive the tests.
8. **No network calls at runtime** except localhost (Ollama, sidecar). The meter and sidecar must work fully offline.
9. **House style for all docs and user-facing strings:** no em-dashes, no exclamation marks, no emojis, no filler phrases.

---

## Phase 0 — Scaffold (half day)

Build:
- Monorepo: `packages/{shared,meter,sidecar,mcp,hooks}` + `profiles/ bench/ fixtures/ docs/ examples/`.
- `packages/shared`: zod schemas for LedgerEntry, AuditEvent, DistillProfile, CodexFile; `limits.ts`; yaml loaders for prices and energy factors (schema-validated).
- Repo tooling: vitest workspace config, eslint, prettier, CI workflow (lint + test), `PROGRESS.md`, `docs/ARCHITECTURE.md` copied in.
- This repo's own `.claude/settings.json` with a PostToolUse format-on-save hook (dogfooding).

Accept when: `pnpm test` green on schema round-trip tests; CI passes; `pnpm -r build` clean.

## Phase 1 — Meter core (1–2 days)

Build (`packages/meter`):
- JSONL session-log discovery and parser for Claude Code transcripts (auto-locate default log directory per OS; also accept explicit paths). Tolerant parsing: unknown record types skipped with a counter, never a crash.
- Token ledger: per-turn and per-session input / output / cache-read / cache-write / thinking token tallies, per-tool attribution.
- `prices.yaml` (sourced rows) + cost computation.
- CLI: `redutok report [session|--last|--project]` rendering a terminal report; `--json` output.
- Fixtures: at least three real anonymized session logs (small, medium, one long agentic session).

Accept when: report totals match hand-computed values on fixtures to the token; malformed-log test passes; `redutok report --last` runs end to end on a real machine log.

## Phase 2 — Green ledger + methodology (1 day)

Build:
- `energy_factors.yaml`: per-model-class Wh per token factors with uncertainty bands and context-length multiplier curve; every row `source:`-cited or TODO-VERIFY.
- Carbon: `grid_intensity.yaml` (region-keyed, conservative default) and gCO2e computation.
- Meter report extended: estimated Wh and gCO2e per session, always labelled "estimated", with the uncertainty band shown.
- `docs/METHODOLOGY.md`: full estimation model, assumptions, limitations. Drafted for human review; mark clearly as draft pending founder verification of every citation.
- `redutok badge` → SVG (grade placeholder until Phase 6 scoring lands) and the one-line share format ending "Redutok by Truveil".

Accept when: energy figures reproducible from yaml inputs in tests; METHODOLOGY.md exists and every number in it traces to a yaml row.

## Phase 3 — Sidecar core + rule-engine distiller (2–3 days)

Build (`packages/sidecar`):
- Daemon: localhost HTTP + unix socket, `redutok up/down/status`, PID handling, structured logs.
- State store: better-sqlite3; tables for artifacts (raw retained per session), served-files registry, session state, audit.
- Append-only `audit.jsonl` writer + `redutok audit <session>` renderer in the meter.
- Redaction pass (keys, tokens, .env patterns) before storage.
- Rule-engine distillation profiles (no LLM yet), loaded from `profiles/*.yaml`: build-log, test-output, file-skeleton (tree-sitter for TS/JS and Python), search-results, generic-stdout.
- Quality gates as a standalone tested module: entity-preservation (extraction-set comparison), verdict double-extraction agreement, size sanity, per-profile config.
- Artifact handle format + `zoom(handle, query?)` returning raw or query-focused slice from the store.

Accept when: each profile has fixture-driven tests showing ratio achieved AND gates passing; a gate failure demonstrably serves raw and logs the event; redaction test passes; kill the daemon mid-request test confirms clean failure.

## Phase 4 — MCP server + hooks + installer (2 days)

Build:
- `packages/mcp`: stdio MCP server exposing `dcp__read`, `dcp__run`, `dcp__search`, `dcp__zoom`, `dcp__state`, all thin clients of the sidecar with the fail-open rule (sidecar down → passthrough raw with a notice).
- `packages/hooks`: SessionStart (inject codex + protocol block; handle source=resume and source=compact), PreToolUse on Read|Bash|Grep|Glob (size estimation; allow small; redirect large via updatedInput to dcp tools; block-with-guidance as fallback), PostToolUse (metering ping + file-change notify), PreCompact (inject rolling state), Stop/SessionEnd (flush ledger, print one-line session summary).
- `redutok init` / `redutok remove`: idempotent install into a target repo (.claude/settings.json merge, MCP registration, CLAUDE.md protocol block append between markers, .dcp/ scaffold); remove reverts cleanly.
- `docs/PROTOCOL.md`: the DCP v1 spec text and the CLAUDE.md protocol block (versioned, between `<!-- dcp:start -->` markers).

Accept when: end-to-end smoke test on a sample repo: init, run a scripted Claude Code session (headless) that reads a large fixture file, verify the distilled path was taken, zoom works, remove reverts everything byte-identical. Hook fail-open verified with sidecar stopped.

## Phase 5 — Codex engine (2–3 days)

Build:
- Structural pass: tree-sitter walk → file map, symbol index, signatures, import graph → `codex.yaml` `files`/`map`/`interfaces` sections + `codex.lock` hashes. Languages: TS/JS, Python (plugin interface for more).
- Semantic pass behind `--with-llm`: Ollama client (model configurable, default qwen2.5:7b-instruct), per-module role/convention drafting, chunked, timeout-governed, resumable.
- Locked-entry handling (human sections never overwritten).
- Incremental update path wired to PostToolUse notifications and `redutok codex refresh`.
- SessionStart injection of the codex (minus file index) with the trust preamble.
- Optional one-time frontier polish step, explicit cost disclosure, off by default.

Accept when: codex generated for two real open-source fixture repos; token count of injected codex under 3k on both; hash-drift test triggers re-index of exactly the changed files; no-Ollama path produces a valid structural-only codex.

## Phase 6 — Delta engine, output discipline, scoring, bench (3–4 days)

Build:
- Served-file registry: first serve full (skeleton or raw per profile), subsequent serves as unified diff against last-served hash; stable `F####@hash` references.
- Rolling `session_state.md` maintenance (local model, ≤600 tokens, rule fallback = last-actions list); PreCompact wiring.
- `redutok handoff`: write handoff file, print resume command.
- Output discipline: Stop-hook full-file-rewrite check with exit-2 guidance; UserPromptSubmit complexity classifier (rules first) injecting advisory thinking hints; verbosity scoring in the meter.
- Four session scores + A–F composite; badge and share-line finalized.
- `bench/`: harness (`redutok bench`), 10 tasks across 3 pinned repos, vanilla-vs-redutok headless runs, success assertions per task, `bench/RESULTS.md` generator with raw logs.

Accept when: full harness runs green locally; results file generated from real runs; at least one long-session task demonstrates ≥30x with success parity; every public README claim maps to a harness number.

## Phase 7 — Launch hardening (1–2 days)

- README with before/after screenshots from real bench runs, install one-liner, architecture diagram, roadmap (Codex-CLI adapter, personal codex for chats, Truveil governance gateway).
- CONTRIBUTING.md pointing at profiles and language plugins as the contribution surfaces.
- `redutok doctor` (environment diagnostics), version-detection shim for Claude Code internals isolated in one module, CI canary against latest Claude Code.
- Security review pass: redaction coverage, no telemetry confirmation, SBOM.

---

## Definition of done for v1.0 public

1. All phase acceptance criteria green in CI.
2. `bench/RESULTS.md` shows median ≥10x with ≥95% task-success parity, from committed raw logs.
3. METHODOLOGY.md citations verified by founder (no TODO-VERIFY remaining).
4. Trademark knockout on REDUTOK cleared; npm name and GitHub org registered.
5. Fresh-machine install test: `npx redutok init` to first graded session in under five minutes.
