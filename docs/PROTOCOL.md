# Delta Context Protocol v1, specification and injection block

This document is the normative DCP v1 spec for Redutok. The block between the
dcp markers below is what redutok init appends to a repository's CLAUDE.md;
redutok remove deletes exactly that block. The block is versioned; init
replaces an older block rather than duplicating it.

## Spec summary

1. Tool routing. For anything potentially large, the model should prefer the
   dcp tools (dcp__read, dcp__search) over raw Read, Grep. These return
   distilled artifacts by design. A PreToolUse hook backstops this by
   redirecting oversized raw reads, and rewrites allowlisted build/test
   commands through redutok-pipe so their output is distilled in place without
   a separate dcp__run turn.
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
