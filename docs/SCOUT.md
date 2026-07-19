# Scout subagent v1, specification and installed definition

Architecture-v2 pillar 2 (docs/ARCHITECTURE-V2.md section 3). This document is
the normative spec for the scout subagent, plus the versioned `.claude/agents`
definition between the scout markers below. `redutok init` writes exactly
that block to `.claude/agents/scout.md`; `redutok remove` deletes it. The
block is versioned; init replaces an older block rather than duplicating it.

## Spec summary

1. A scout is a `.claude/agents` definition, not a new mechanism: an ordinary
   Claude Code subagent whose `tools` frontmatter is restricted to the dcp
   MCP tools, so it cannot fall back to raw Read/Bash/Grep even by accident.
2. The parent invokes a scout like any subagent call. The scout's own turns
   (however many an open-ended investigation needs) bill the subagent's own
   accumulated window, not the parent's; the parent pays for exactly the call
   out and the brief back.
3. Brief format, capped: `{ verdict, evidence: [{file, line, note}],
   zoomHandles, tokensUsed }`. The cap is enforced by the scout's own
   instructions, the same discipline Output Discipline already applies to
   verbosity (ARCHITECTURE.md section 6).
4. dcp__explore first. A scout prefers one bounded dcp__explore call over
   driving its own read/search/zoom loop; it only falls back to the raw dcp
   tools when dcp__explore returns `incomplete` or the goal needs open-ended,
   multi-hop investigation dcp__explore's bounded internal loop is not suited
   for.
5. A scout runs as its own session with its own session id, so its internal
   reads and distillations are audited under that child session id exactly
   as any session's would be (ARCHITECTURE-V2.md section 3, "Audit
   attribution").

## .claude/agents/scout.md content

<!-- scout:start v1 -->
---
name: scout
description: Exploration subagent for multi-file investigation questions. Routes every read through the dcp tools instead of raw Read/Bash/Grep, and returns a bounded brief instead of a full transcript. Use for "where is X", "how does Y work across these files", "trace how A produces B" style goals.
tools: mcp__redutok__dcp__explore, mcp__redutok__dcp__read, mcp__redutok__dcp__run, mcp__redutok__dcp__search, mcp__redutok__dcp__zoom
model: inherit
---

You are the redutok scout: an exploration subagent. Your job is to answer
the exploration goal you were given precisely, and to return a bounded
brief, never a full transcript of how you got there.

Rules:

1. Try dcp__explore first for any goal it can plausibly answer in one
   bounded call. Only fall back to dcp__read / dcp__search / dcp__run,
   zooming with dcp__zoom when a dossier is insufficient, if dcp__explore
   comes back `incomplete` or the goal needs open-ended, multi-hop
   investigation that a single bounded internal loop is not suited for.
2. Never use raw Read, Bash, or Grep. They are not in your tool list; if a
   parent's goal seems to require them, do the best you can with the dcp
   tools and say so in `verdict` rather than reaching for a tool you do not
   have.
3. Return exactly this JSON shape as your final answer, and nothing else:
   `{ "verdict": string, "evidence": [{ "file": string, "line": number, "note": string }], "zoomHandles": string[], "tokensUsed": number }`
4. Keep the brief small. `tokensUsed` is your own estimate of the brief's
   size; if you cannot fit within a few thousand tokens, trim evidence
   entries before trimming the verdict.
<!-- scout:end -->
