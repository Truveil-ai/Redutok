# Provenance: fixtures/repos/axios

Vendored copy of [axios](https://github.com/axios/axios) at tag **v1.7.9**,
commit `b2cb45d5a533a5465c99559b16987e4d5fc08cbc` (MIT, LICENSE retained).

## Why this fixture

The slope tier's first fixture (chalk, 8 source files / ~33 KB) sat far
below the idle-posture thresholds, so redutok governance disengaged and the
sequence measured nothing (the 2026-07-30 idle-posture diagnosis). This
fixture assesses **full** posture legitimately: 156 indexable source files,
~494 KB source — above `LIMITS.POSTURE.LIGHT_MAX_FILES` (120), which is the
full-posture boundary — with genuine internal structure (core /
adapters / helpers / cancel / platform, plus a real test tree).

## What was vendored

`lib/`, `test/`, `examples/`, `bin/`, `index.js`, `index.d.ts`,
`package.json`, `LICENSE`, `README.md`. Omitted from upstream: `.git`,
`dist/`, `node_modules/`, `sandbox/`, `templates/`, docs and CI config —
none of it needed by the bench, and `dist`/`node_modules` are outside the
posture walk anyway.

## Bench-added and bench-modified files

- **Added** `scripts/verify-url-assembly.mjs`: zero-dependency check of the
  URL-assembly neighborhood. Imports only `lib/core/buildFullPath.js`,
  `lib/helpers/isAbsoluteURL.js`, and `lib/helpers/combineURLs.js` (pure
  ESM with explicit `.js` extensions; `package.json` has `"type":
  "module"`), so it runs with no npm install inside the isolated bench
  working copy.
- **Seeded defect** in `lib/helpers/combineURLs.js` (line 13): the
  leading-slash strip on the relative part was changed from `/^\/+/` to
  `/^\/{2,}/`, so combining `base/v1/` with `/users/list` yields a
  double slash at the joint (`…/v1//users/list`).
  `node scripts/verify-url-assembly.mjs` fails on exactly this case; the
  s02 bench task is to diagnose and fix it. Upstream's correct line is the
  single-character-class strip `/^\/+/`.
- **Added** `scripts/verify-joint-collapse.mjs` (v4 session 6): spec for
  `lib/helpers/normalizeJoin.js`, a helper the fixture deliberately does
  not ship. The s05 bench task is to implement it, so until then the
  script fails on its own import in every variant. Same conventions as
  verify-url-assembly (`ok:`/`FAIL:` lines, fail-fast, a column-0
  `... verified` summary line).
- **Boundary seed for s04** (applied by the bench runner, not vendored;
  declared in `bench/tasks/s04.yaml`): at the s04 task boundary the
  harness overwrites `lib/helpers/combineURLs.js` wholesale with a
  canonical seeded version whose base side keeps every trailing slash
  (`baseURL + '/' + …`, no strip) while the relative side carries
  upstream's correct leading strip `/^\/+/` — so the verify script's
  first assertion fails again with the same signature as s02 but a
  different root cause, and s02's answer is not pasteable. The seed is a
  deterministic content-write, not a find/replace: the 2026-07-30 rep-1
  run aborted when the s02 session's fix rewrote both halves of the
  joint line and a find string matched 0 times. The write lands
  identically on the redutok carried tree (whatever the s02 fix looked
  like) and on the vanilla cold copy (replacing the still-unfixed
  vendored defect), so both variants face the exact same file at s04.
  This harness-applied recurrence is disclosed here because it is the
  only way the same failure can legitimately recur in a persistent
  working tree, which is what the graduation miner's occurrence count
  measures.

Everything else is byte-identical to the pinned upstream commit.
