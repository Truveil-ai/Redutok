# PROGRESS

Status file for cross-session handoff. Updated at the end of every session.
Last session: 2026-07-18 (fix session after phases 0 and 1). Suite state: 37 tests green, lint clean, pnpm -r build clean.

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

## Half done or not started

- Nothing half done. Phases 2 to 7 not started.
- `redutok report --project` from the Phase 1 spec is not implemented; only an explicit path and --last work. The usage text does not advertise it.
- The redutok bin is not linked globally; run via node packages/meter/dist/cli.js until packaging is addressed.

## Dated follow-ups

- 2026-09-01: flip claude-sonnet-5 in packages/shared/prices.yaml from introductory 2.00/10.00 to standard 3.00/15.00 (see the note field on that row), and update the two shipped-prices tests in packages/meter/test/cost.test.ts.

## Exact next actions (next session, Phase 2)

1. Read docs/ARCHITECTURE.md, BUILD.md, this file. Build Phase 2 only.
2. Add `--project` filtering to report (list and aggregate sessions for the cwd project dir) if 30 minutes can be spared, else leave for Phase 6 polish.
3. Create packages/shared/energy_factors.yaml and grid_intensity.yaml with sourced or TODO-VERIFY rows; loaders and schemas for energy factors already exist in shared/src/yaml.ts (EnergyFactorsFileSchema). Add a grid intensity schema alongside.
4. Extend the meter report with estimated Wh and gCO2e, always labelled "estimated" with uncertainty bands.
5. Write docs/METHODOLOGY.md as a draft pending founder verification.

## Deviations from BUILD.md, with reasons

- Resolved 2026-07-18: docs/ARCHITECTURE.md was missing at first build; the DCP Architecture Blueprint v1.0 is now committed at docs/ARCHITECTURE.md.
- Real anonymized session logs (Phase 1 fixture spec) are replaced by synthetic deterministic fixtures for now, because no shareable anonymized logs existed at build time. The parser is verified against a real machine log via report --last, but committed fixtures are synthetic. Swap in real anonymized logs when available.
- thinking_tokens: real Claude Code usage blocks do not carry a separate thinking token field. The parser reads `thinking_tokens` when present (synthetic fixtures exercise it) and tallies 0 otherwise, so real-log thinking shows as 0 inside output. Revisit if the transcript format adds the field.
- Audit events are currently returned in memory and included in --json output. The append-only audit.jsonl writer is a Phase 3 deliverable and not built yet.
- Corepack could not activate pnpm (no admin rights to C:\Program Files\nodejs); pnpm 9.15.9 was installed through npm -g instead. packageManager field pins pnpm@9.15.9.

## TODO-VERIFY register (guardrail 2)

- prices.yaml: no TODO-VERIFY rows remain. All five rows cite https://platform.claude.com/docs/en/about-claude/pricing (checked 2026-07-18), but founder verification is still pending; the file header marks it provisional and this line is the flag to clear when the founder signs off.
- energy_factors.yaml and grid_intensity.yaml do not exist yet (Phase 2); every row added there needs a source or TODO-VERIFY.
