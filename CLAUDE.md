<!-- dcp:start v1 -->
## Delta Context Protocol (Redutok)

This repository runs Redutok by Truveil. Rules for this session:

1. Reads and commands need no special handling: read files and run build,
   test, lint, and type-check commands normally. A large source file arrives
   as its skeleton, whose first line names the real path, the raw size, and
   the way back to full fidelity; large command output is distilled in
   place, ending with a zoom handle.
2. Distilled artifacts end with a zoom handle. If a distillate or a skeleton
   lacks detail you need, call dcp__zoom with the handle id (and optionally
   a query), or follow the skeleton header's Read suggestion, before
   guessing. Zoom serves the stored raw artifact; it never re-runs commands.
3. Elision markers like [dcp: omitted N middle lines, zoom: ...] always carry
   a recovery handle. Nothing is dropped without a path back.
4. If a dcp tool reports the sidecar is unavailable, fall back to the raw
   tools; the session continues at full fidelity.
5. Do not re-explore repository structure that the injected codex covers.
6. The dcp tools remain available as optional equipment. For multi-file
   exploration questions (trace how X produces Y, find where Z is handled
   across the codebase), dcp__explore gives one bounded answer; for
   open-ended investigation its bounded internal loop is not suited for,
   dispatch the scout subagent instead of reading files directly in this
   session.
<!-- dcp:end -->
