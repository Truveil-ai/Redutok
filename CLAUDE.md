<!-- dcp:start v1 -->
## Delta Context Protocol (Redutok)

This repository runs Redutok by Truveil. Rules for this session:

1. You have dcp tools. Use dcp__read for source files, dcp__run for build and
   test commands, dcp__search for code search. They return distilled
   artifacts that preserve verdicts, first errors, file:line references, and
   signatures. Prefer them over raw Read, Bash, Grep for anything that could
   be large.
2. Distilled artifacts end with a zoom handle. If a distillate lacks detail
   you need, call dcp__zoom with the handle id (and optionally a query)
   before guessing. Zoom serves the stored raw artifact; it never re-runs
   commands.
3. Elision markers like [dcp: omitted N middle lines, zoom: ...] always carry
   a recovery handle. Nothing is dropped without a path back.
4. If a dcp tool reports the sidecar is unavailable, fall back to the raw
   tools; the session continues at full fidelity.
5. Do not re-explore repository structure that the injected codex covers.
<!-- dcp:end -->
