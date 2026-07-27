# Provenance

Base vendor: identical to `fixtures/repos/chalk` (see that directory's
PROVENANCE.md) — chalk at commit `aa06bb5ac3f14df9fda8cfb54274dfc165ddfdef`,
MIT licensed. This copy exists only for `bench/tasks/h01.yaml` (heavy tier,
build-log diagnosis) and deliberately diverges from that pristine vendor in
two ways:

1. **Seeded defect** (`source/utilities.js`, `stringReplaceAll`): the line

   ```
   returnValue += string.slice(endIndex, index) + substring + replacer;
   ```

   has an extra closing parenthesis inserted after `index)`, producing a
   genuine `SyntaxError: Unexpected token ')'` at `source/utilities.js:12`
   under both `node --check` and Node's ESM loader. This is the one fact
   the task's diagnosis is graded against.
2. **Added `scripts/verbose-build.mjs`**: a zero-dependency build check
   (uses only `node:child_process`, `node:fs`, `node:path`, `node:url` — no
   npm install, since isolated bench-live copies ship no `node_modules`).
   It syntax-checks every file under `source/`, dumps context around any
   failure, and attempts the real ESM import chain from `source/index.js`
   so the propagated module-resolution stack shows up too. `package.json`'s
   `test`/`xo`/`c8` fields (unusable without installed devDependencies)
   were dropped and `scripts.build` now points at this script.

To refresh: re-copy from `fixtures/repos/chalk` and re-apply the two changes
above; do not hand-edit around them.
