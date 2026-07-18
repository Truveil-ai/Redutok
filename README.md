# Redutok

Token and energy reduction layer for Claude Code, implementing the Delta
Context Protocol. Redutok by Truveil. MIT licensed, local-first, fully
audited.

## Why

Agentic coding sessions spend tokens like an expense account nobody reviews:
the same files re-read, the same build logs replayed, whole transcripts
carried forward turn after turn. It is the Uber-budget problem: each ride
looks small, the monthly bill does not. Redutok is the review layer. Its
thesis is the delta: never re-send what the model already understands. Send
the diff, not the world. And when compression needs intelligence, local watts
come before datacenter watts: a small model on your machine preprocesses so
frontier-scale attention never sees the bulk.

Every byte dropped, truncated, or summarized is logged with a recovery
handle. Compression without provenance is a liability; compression with an
audit trail is a feature.

## Install

    npx redutok init

Run it inside a repo, then `redutok up`. Uninstall with `redutok remove`,
which reverts managed files byte-identical. See docs/QUICKSTART.md for the
five-minute path and docs/RUNNING.md for details.

## How it works

    Claude Code session
      | hooks (fail-open, 50ms budget)     | MCP tools (dcp__read, dcp__run,
      |  protocol + codex injection        |  dcp__search, dcp__zoom, dcp__state)
      v                                    v
    +----------------- sidecar (localhost only) ------------------+
    | codex engine | distiller + gates | delta registry | state   |
    |          sqlite store  |  append-only audit.jsonl           |
    +--------------------------------------------------------------+
      ^ raw retained, zoom recovers anything          | meter CLI
      |                                               v
      +---- profiles/*.yaml (rule engine first) --- report, scores,
                                                    badge, bench

If the sidecar is down, every surface degrades to raw passthrough and the
session runs vanilla. That is a tested property, not a promise.

## Honest numbers

The figures below are fixture-measured, per-artifact distillation ratios from
this repository's own captured logs (scripts/measure-ratios.mjs). They are
not session-level savings; session-level claims wait for the live bench
harness (`redutok bench`), which runs vanilla-versus-redutok sessions on
pinned repos with success assertions and publishes bench/RESULTS.md from raw
logs. Nothing here is guaranteed; everything here is reproducible.

| profile | fixture size | ratio (fixture-measured) |
| --- | --- | ---: |
| build-log | small (2,280 tok) | 40.7x |
| build-log | large (61,831 tok) | 1104.1x |
| test-output | small (4,245 tok) | 4.0x |
| test-output | large (28,044 tok) | 24.9x |
| file-skeleton | typescript source | 9.9x |
| search-results | grep set | 5.1x |

A disclosure in the same spirit: Redutok graded its own construction session
D (68 of 100). The build ran agentic and energy-heavy, and the meter said so
instead of flattering its maker. That is the audit trail working.

## Roadmap

- Codex CLI adapter: the sidecar speaks to more agents than one.
- Personal codex for chats: the delta principle applied to conversations.
- Truveil governance layer: org-level policy over what agents may spend.

## Contributing

Profiles and language plugins are the contribution surfaces; see
CONTRIBUTING.md. House style everywhere: no em-dashes, no exclamation marks,
no emojis.

Redutok by Truveil.
