# Delta Context Protocol v1, specification and injection block

This document is the normative DCP v1 spec for Redutok. The block between the
dcp markers below is what redutok init appends to a repository's CLAUDE.md;
redutok remove deletes exactly that block. The block is versioned; init
replaces an older block rather than duplicating it.

## Spec summary

1. Tool routing. Reads and commands govern themselves: a PreToolUse hook
   rewrites oversized raw Reads to the file's skeleton mirror entry under
   .dcp/mirror (header line first: real path, raw size, recovery path), and
   rewrites allowlisted build/test commands through redutok-pipe so their
   output is distilled in place. Neither needs a dcp tool call or costs a
   turn; the dcp tools remain available as optional equipment.
2. Artifact handles. Every distilled artifact ends with a handle of the form
   [dcp:artifact aXXXX, raw N tok to M tok, zoom: dcp__zoom("aXXXX", query?)].
   Raw artifacts are retained in the local sidecar store for the session;
   zoom never re-executes anything.
3. Fail-open. If the sidecar is down, every surface degrades to raw
   passthrough with a notice; hooks answer within the 50ms budget from
   limits.ts and never block a session.
4. Audit. Every distillation, redirect, zoom, and redaction is an event in
   .dcp/audit.jsonl, renderable with redutok audit <session>.

## CLAUDE.md protocol block

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
