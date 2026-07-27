# Provenance

Base vendor: identical to `fixtures/repos/chalk` (see that directory's
PROVENANCE.md) — chalk at commit `aa06bb5ac3f14df9fda8cfb54274dfc165ddfdef`,
MIT licensed. This copy exists only for `bench/tasks/h02.yaml` (heavy tier,
test-log diagnosis) and deliberately diverges from that pristine vendor in
three ways:

1. **Seeded defect** (`source/index.js`, `createStyler`): the
   chained-style branch

   ```
   openAll = parent.openAll + open;
   ```

   has `open` swapped for `close`, so every style applied after the first
   in a chain (`chalk.red.bold(...)`, `chalk.a.b.c(...)`, etc.) opens with
   its own *closing* code instead of its opening one. A single style
   (`chalk.red(...)`) is unaffected, since it never reaches the `parent !==
   undefined` branch.
2. **`test/chalk.js` removed, `test/heavy.test.mjs` added**: the original
   suite needs ava/c8/xo, none of which are installed (isolated bench-live
   copies ship no `node_modules`). The replacement uses only `node:test`
   and `node:assert/strict` (both Node core) and forces `new Chalk({level:
   3})` so styling is exercised regardless of TTY/env color detection. 6 of
   its 10 cases (the single-style ones) pass; the 4 chained-style cases
   fail, all traceable to the one seeded line above.
3. **`package.json`**: `scripts.test` now runs `node --test
   test/heavy.test.mjs`; the unusable `xo`/`c8`/devDependencies fields were
   dropped.

To refresh: re-copy from `fixtures/repos/chalk` and re-apply the changes
above; do not hand-edit around them.
