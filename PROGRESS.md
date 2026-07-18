# PROGRESS

Status file for cross-session handoff. Updated at the end of every session.
Last session: 2026-07-18 (Phase 2). Suite state: 50 tests green, lint clean, pnpm -r build clean.

## Complete

Phase 0, all items:

- pnpm workspace monorepo: packages/{shared,meter,sidecar,mcp,hooks}, profiles/, bench/, fixtures/, docs/, examples/, scripts/.
- @redutok/shared: zod schemas for TokenTally, LedgerEntry, AuditEvent, DistillProfile, CodexFile; LIMITS in limits.ts (50ms hook fail-open, 2500ms local LLM timeout); schema-validated yaml loaders for prices and energy factors.
- Tooling: vitest workspace, eslint flat config, prettier, GitHub Actions CI (lint, build, test), .claude/settings.json PostToolUse format-on-save hook (fail-open, dogfooding).

Phase 1, all four sub-steps:

- (a) Tolerant JSONL transcript parser in packages/meter/src/parser.ts. Unknown record types and malformed lines are counted, never thrown, and produce a skip AuditEvent (guardrail 3). Fixtures: fixtures/sessions/{small,malformed}.jsonl hand-written; {medium,long-agentic}.jsonl generated deterministically by scripts/gen-fixtures.mjs with independently summed .expected.json totals.
- (b) Token ledger in ledger.ts: per-turn LedgerEntry list, session totals across input, output, cache read, cache write, thinking, and per-tool attribution (calls plus output token share split evenly across a turn's tools).
- (c) packages/shared/prices.yaml and cost computation in cost.ts. Rows for claude-fable-5, claude-opus-4-8, claude-sonnet-4-6, claude-sonnet-5, claude-haiku-4-5, each citing https://platform.claude.com/docs/en/about-claude/pricing (checked 2026-07-18). Cache read is 0.10 of input, cache write is 1.25 of input, thinking tokens bill at the output rate. Unpriced models are reported, never silently zero-costed.
- (d) CLI: node packages/meter/dist/cli.js report <file> or --last, with --json. Bin entries redutok and rtk registered in packages/meter. Verified end to end on a real machine log under C:\Users\Karan\.claude\projects (108 turns parsed, totals rendered).

Phase 1 acceptance: totals match hand-computed values on small.jsonl to the token (test), generator-expected totals on medium and long-agentic (test), malformed-log test passes, report --last verified on a real log.

Phase 2, all items:

- energy_factors.yaml in packages/shared: three model classes (frontier-large, frontier-mid, small) with whPerMTok base plus low/high uncertainty band, model-to-class mapping, and a context multiplier curve at 10k/100k/500k/1M breakpoints. Every row source: TODO-VERIFY with a citation_hint naming TokenPowerBench (AAAI 2026, arXiv 2512.03024) and ML.ENERGY leaderboard v3. Bands are deliberately one order of magnitude wide; reasoning is in the file header comment.
- grid_intensity.yaml: world default (conservative, erring high) plus IN, US, EU placeholder rows, all TODO-VERIFY with citation_hint (IEA, Ember, EPA eGRID, CEA).
- Meter energy module (packages/meter/src/energy.ts): per-turn class lookup, context multiplier from input plus cacheRead, Wh and gCO2e computed as base/low/high bands. Unmapped models excluded and reported, unknown region throws. Report renders energy only with the word "estimated" and the band, plus a sidecar self-consumption line stubbed at 0 Wh for Phase 3. Tests reproduce the figures from the yaml inputs by hand computation.
- docs/METHODOLOGY.md: full estimation model, assumptions, limitations, founder verification checklist. Marked DRAFT, PENDING FOUNDER VERIFICATION. Restates no numbers; everything traces to the yaml rows.
- redutok badge: writes an SVG badge (grade placeholder "grade pending" until Phase 6) and prints the one-line share format ending "Redutok by Truveil". CLI: redutok badge [session.jsonl|--last] [--out file].

Phase 2 acceptance: energy figures reproducible from yaml inputs in tests (energy.test.ts hand-computes small.jsonl bands), METHODOLOGY.md exists and references yaml rows for every number.

## Half done or not started

- Nothing half done. Phases 2 to 7 not started.
- `redutok report --project` from the Phase 1 spec is not implemented; only an explicit path and --last work. The usage text does not advertise it.
- The redutok bin is not linked globally; run via node packages/meter/dist/cli.js until packaging is addressed.

## Dated follow-ups

- 2026-09-01: flip claude-sonnet-5 in packages/shared/prices.yaml from introductory 2.00/10.00 to standard 3.00/15.00 (see the note field on that row), and update the two shipped-prices tests in packages/meter/test/cost.test.ts.

## Exact next actions (next session, Phase 3)

1. Read docs/ARCHITECTURE.md, BUILD.md, this file. Build Phase 3 only: sidecar daemon, state store, audit.jsonl writer, redaction, rule-engine distillation profiles, quality gates, artifact handles with zoom.
2. When the sidecar can measure its own consumption, replace the sidecarWh stub (energy.ts, SessionEnergy.sidecarWh, currently constant 0) with the measured value.
3. Still open from Phase 1: `--project` mode for report; leave for Phase 6 polish unless time allows.

## Deviations from BUILD.md, with reasons

- Resolved 2026-07-18: docs/ARCHITECTURE.md was missing at first build; the DCP Architecture Blueprint v1.0 is now committed at docs/ARCHITECTURE.md.
- Real anonymized session logs (Phase 1 fixture spec) are replaced by synthetic deterministic fixtures for now, because no shareable anonymized logs existed at build time. The parser is verified against a real machine log via report --last, but committed fixtures are synthetic. Swap in real anonymized logs when available.
- thinking_tokens: real Claude Code usage blocks do not carry a separate thinking token field. The parser reads `thinking_tokens` when present (synthetic fixtures exercise it) and tallies 0 otherwise, so real-log thinking shows as 0 inside output. Revisit if the transcript format adds the field.
- Audit events are currently returned in memory and included in --json output. The append-only audit.jsonl writer is a Phase 3 deliverable and not built yet.
- Corepack could not activate pnpm (no admin rights to C:\Program Files\nodejs); pnpm 9.15.9 was installed through npm -g instead. packageManager field pins pnpm@9.15.9.

## TODO-VERIFY register (guardrail 2)

- prices.yaml: no TODO-VERIFY rows, but the rows remain under the separate provisional flag (file header) until the founder's pricing-page check; this line is the flag to clear when that sign-off lands.
- energy_factors.yaml and grid_intensity.yaml: cleared. No TODO-VERIFY rows remain; see the verification record below.

## Verification record

- 2026-07-18: founder verification completed for energy and grid data. grid_intensity.yaml verified to Ember Global Electricity Review 2025 (2024 data) for world 473, IN 708, EU 213 and EPA eGRID 2023 for US 350, each row carrying source and verified fields. energy_factors.yaml verified to banded anchors: frontier-mid 300 (100 to 1000) per the Oviedo et al. methodology as applied in arXiv 2510.24509, small 110 (30 to 300) per the John Snow Labs Tokens-per-Joule Llama3-70B measurement, frontier-large 450 (150 to 1500) as an explicit class assumption (assumption: true), context multiplier curve flattened to 1.0/1.0/1.2/1.4 and flagged confidence: low. docs/METHODOLOGY.md DRAFT marker replaced with the verification statement and an Evidence quality section.
