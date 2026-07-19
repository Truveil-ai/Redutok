# Provenance

Vendored from https://github.com/chalk/chalk at commit
`aa06bb5ac3f14df9fda8cfb54274dfc165ddfdef` (branch `main`), MIT licensed
(see `license`). Used as the bench harness's medium-tier fixture repo
(bench/tasks/t05.yaml, t06.yaml, t07.yaml): a real, moderately sized,
multi-file JavaScript library with vendored sub-dependencies, real tests,
and a real package.json, standing in for the "genuinely heavy artifact,
multi-file exploration" scenario the small-tier synthetic fixtures
(fixtures/repos/repo-a, repo-b) are too small to exercise.

Every vendored file's content was verified byte-exact against the git
blob SHA GitHub reports for that path at this commit (`git hash-object`
equivalent, matched via the GitHub Trees API) before being copied in.

Included: source/, test/chalk.js, package.json, license, readme.md.
Excluded: media/ (binary screenshots/logos, irrelevant to code tasks),
benchmark.js, examples/, and the non-chalk.js test files (visible.js,
level.js, index.test-d.ts) — kept to what the three medium-tier tasks
exercise, not a full mirror of the upstream repository.

To refresh this vendor copy for a future chalk commit: repeat the
verified-download procedure above and update the commit field in
bench/tasks/t05.yaml, t06.yaml, t07.yaml.
