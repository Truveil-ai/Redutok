<!-- dcp:start v1 -->
## Delta Context Protocol (Redutok)

This repository runs Redutok by Truveil. Rules for this session:

1. You have dcp tools. Use dcp__read for source files and dcp__search for code
   search. They return distilled artifacts that preserve first errors,
   file:line references, and signatures. Prefer them over raw Read and Grep for
   anything that could be large. Build, test, lint, and type-check commands
   need no special handling: run them normally and their output is distilled in
   place, ending with a zoom handle, so there is no dcp tool to call for them.
2. Distilled artifacts end with a zoom handle. If a distillate lacks detail
   you need, call dcp__zoom with the handle id (and optionally a query)
   before guessing. Zoom serves the stored raw artifact; it never re-runs
   commands.
3. Elision markers like [dcp: omitted N middle lines, zoom: ...] always carry
   a recovery handle. Nothing is dropped without a path back.
4. If a dcp tool reports the sidecar is unavailable, fall back to the raw
   tools; the session continues at full fidelity.
5. Do not re-explore repository structure that the injected codex covers.
6. For multi-file exploration questions (trace how X produces Y, find where
   Z is handled across the codebase), prefer dcp__explore for one bounded
   answer; for open-ended investigation dcp__explore's bounded internal loop
   is not suited for, dispatch the scout subagent instead of reading files
   directly in this session.
<!-- dcp:end -->
