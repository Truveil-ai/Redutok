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

Everything else is byte-identical to the pinned upstream commit.
