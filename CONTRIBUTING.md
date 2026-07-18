# Contributing to Redutok

Two surfaces are designed for contribution:

1. Distillation profiles (profiles/*.yaml). A profile is deterministic
   extraction rules plus quality gates. Add a yaml, a distiller case in
   packages/sidecar/src/distill.ts, and a fixture-driven test proving the
   ratio, the gates passing, and a corrupted-input case that serves raw with
   an audit event. Real captured fixtures beat synthetic ones.
2. Language plugins for the skeleton and codex passes
   (packages/sidecar/src/skeleton.ts). Grammars load as tree-sitter wasm;
   add the language mapping, declaration types, and a fixture file.

Ground rules, from BUILD.md and enforced in review: tests first; every
transformation writes an audit event; no fabricated numbers (yaml rows carry
a source or TODO-VERIFY); fail-open behavior gets an explicit test; no
network beyond localhost; house style in all docs and strings (no em-dashes,
no exclamation marks, no emojis). Run pnpm lint, pnpm -r build, and pnpm test
before opening a pull request; CI runs the same three. A pre-push hook in
.githooks enforces lint plus the full suite; enable it once per clone with
git config core.hooksPath .githooks.

Redutok by Truveil.
