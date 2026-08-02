# Changelog

Redutok has not been released. There are no tags and no published package;
the version headings below are the internal architecture generations, in the
order they were built, each dated by the work itself. Every claim referenced
here is evidenced in [docs/BENCH-REPORT.md](docs/BENCH-REPORT.md).

Format: what changed, then what it cost or proved. House style: no
em-dashes, no exclamation marks, no emojis.

## Unreleased (packages: redutok 0.1.0, @redutok/vault 0.0.1)

Launch documentation. The full evidence record
([docs/BENCH-REPORT.md](docs/BENCH-REPORT.md)), the Vault field log
([docs/FIELD-LOG.md](docs/FIELD-LOG.md)), a rewritten README leading with the
receipt, and this file. The README claim guard gained rules for the new
language: ratio figures must name the scope they were measured at, a line
citing the 10x Definition of Done must carry its verdict, and the chatbench
sentence disclaiming any chat-savings multiple is now pinned by test.

The README was then rewritten again as a narrative, opening on the receipt
and the two measured peaks and closing on the field session. The guard gained
three sentence-level rules that survive rewrapping: a cost-avoided figure
must be labelled an estimate, energy and carbon must be banded rather than
stated as measured, and an `npx redutok` instruction must say that the
published package is a placeholder until the release publish.

## v4, the compounding codex (2026-07-30)

- **Graduation.** Candidate learnings mined from each session (error-fix
  pairs, zoom-back hotspots, recurrence signals) earn confidence from
  occurrence and recency, graduate into the codex above a threshold, and are
  withdrawn on recorded contradiction. Demotion is always evidence-driven;
  recency decay alone never withdraws an entry.
  See [docs/GRADUATION.md](docs/GRADUATION.md).
- **Session posture, the idle gear.** Governance now engages proportionally
  to what it can earn. A repository below the posture thresholds gets a
  one-line notice and zero per-turn overhead, because the ten-task bench had
  already shown that full governance on small work costs more than it saves.
  See [docs/POSTURE.md](docs/POSTURE.md).
- **Injection budget with a restore pass.** The degrade order is a priority
  ranking, not a death list. The observed failure it fixed: an 8k-token
  interfaces section that could never fit dragged the 500-token learned
  section down with it, so graduated knowledge never reached a session.
- **The slope tier.** A sequenced bench asking whether the system gets
  cheaper as it learns, with a third criterion, mechanism-engaged, added
  after a run whose numeric bars passed while the mechanism never engaged at
  all. Outcome: both numeric criteria NOT MET, mechanism-engaged MET on a
  single graduated-pitfall injection. No learning-slope claim is made.

## v3, the pipe distiller and the skeleton mirror (2026-07-28)

- **Never add a turn.** The design law that came out of v2's diagnosis. A
  large Read is answered with a skeleton through that same Read, rewritten at
  the hook, so compression costs no extra turn and no denial. Command output
  is distilled in place behind the same gates.
- **h03 rerun.** The pre-registered pass criterion, at least 1.2x at parity
  on the task that had been the worst loss at 0.5x, MET at exactly 1.2x.
- **The 4.36M incident.** A rerun against a stale build consumed 4,364,974
  tokens and 2.3615 USD in 45 turns. Diagnosed to a stale port pointing at a
  dead daemon (raw double-reads) followed by a 41-turn model-side repair
  loop. The harness now gates on build freshness and port wiring, and the
  incident transcripts are archived in the repository.
- **Contamination fix.** The MCP server resolves its port from the
  repository's own config, the installer stopped hardcoding it, and the
  daemon refuses cross-repository serve and zoom with an audited event.

## v2, turn economics (2026-07-28, design)

- **The corrected cost model.** Session cost is dominated by the accumulated
  window re-billed at cache-read rate on every turn, not by what a single
  turn adds. Context-increment-only compression was falsified by the heavy
  tier: median 0.7x, and h03 at 0.5x with 32 turns against vanilla's 12, ten
  of them zoom-backs. See [docs/ARCHITECTURE-V2.md](docs/ARCHITECTURE-V2.md).
- **Four pillars specified against it**: `dcp__explore` to collapse the
  many-small-turns loop into one call, scout subagents whose turns bill their
  own window, lifecycle promotion with a quantified split counterfactual, and
  cache discipline with an append-only injection posture.
- **One pillar could not be built.** Eager MCP tool registration, which would
  remove the one ToolSearch turn every session pays, is a client-side
  heuristic with no server-side lever. Researched, documented, not attempted.

## v1, the Delta Context Protocol (2026-07-18 to 2026-07-19)

Phases 0 through 7, built in order.

- **Meter.** Tolerant transcript parser, per-turn token ledger with tool
  attribution, cost from a cited price table, and energy and carbon as banded
  estimates that are never presented as measurements
  ([docs/METHODOLOGY.md](docs/METHODOLOGY.md)).
- **Sidecar.** SQLite state store with append-only audit trail, redaction on
  the only write path proven by a test that greps the database bytes, a
  localhost daemon with a Windows named-pipe transport, deterministic quality
  gates (entity preservation, verdict fidelity, size sanity), and five
  distillation profiles.
- **Protocol and hooks.** DCP v1, a JSON-RPC MCP server with fail-open tools,
  hooks that answer within a 50ms budget and pass raw whenever the sidecar is
  unavailable, and `init`/`remove` that reverts byte-identical.
- **Codex and delta registry.** A structural repository map with an optional
  local-model semantic pass, a first-serve-full then diff-thereafter registry
  whose served diffs reconstruct the file byte-equal, and rolling state under
  a hard token budget.
- **Scoring, bench, and launch hardening.** Four session scores with an A to F
  composite ([docs/SCORING.md](docs/SCORING.md)), the bench harness with
  pinned tasks and a mandatory failures section, `redutok doctor`, a weekly CI
  canary against the claude CLI surface, an SBOM, and a security pass that
  statically forbids network and telemetry markers in built output.
- **Cost model reconciled to billing.** The meter disagreed with the CLI by
  1.81x. Two causes were found, cache-write tier and rate row, both fixed,
  and fixture expectations were recomputed honestly rather than adjusted to
  keep tests green. The gap closed to 1.0009x.
- **Ten-task live bench.** Four measurement defects found and fixed before
  publishing anything, then a rerun: median 0.8x against a 10x bar, NOT MET.
  Published as a real product signal about a task set that does not represent
  the target scenario.

## The Vault (2026-07-31 to 2026-08-02)

The sidecar engines mounted on a corpus and exposed to ordinary chat clients
over MCP. Built in sessions, merged as pull requests 16 through 26.

- **Server core and ingest.** Streamable HTTP and stdio transports, bearer
  auth compared in constant time, and an ingest that builds full `.dcp` state
  for a directory of mixed files, incremental by hash, with per-file
  provenance. Scanned PDFs without a text layer are declared out of scope
  rather than silently empty.
- **Documents as first-class artifacts.** Structure maps with sections, page
  anchors, and summaries; prose entity gates holding document serves to the
  same discipline as code, so dates, defined terms, party names, section
  numbers, and figures survive verbatim or the raw is served instead.
- **Persistent ledger and receipts.** Every ask, zoom, and serve appends a
  line carrying tokens raw versus served, cost at the rate row pinned at
  write time, banded energy, and the audit reference behind it. Rollups by
  session, day, month, corpus, and document, plus a monthly statement.
  Counterfactual honesty is enforced in code: avoided tokens always compare
  against what was actually touched, and the whole-corpus figure appears only
  under its own label.
- **Zero-turn channel and conversational graduation.** `vault_codex` emits a
  compact block for a chat client's project instructions, with a staleness
  handshake so a stale paste is detectable end to end, and a miner that
  graduates recurring neighborhoods into it.
- **Ten field defects, found by real use.** PDF heading blindness, line
  fragmentation, CID hex-string body text, clipped-glyph doubling, retrieval
  ranking, heading collisions, handle durability, silent corpus defaulting,
  an accounting block that reported success through six consecutive retrieval
  misses, and one cross-component interaction caught by analysis before any
  live spend. Full log in [docs/FIELD-LOG.md](docs/FIELD-LOG.md).
- **Chatbench, pre-registered and unexecuted.** The PASTE versus VAULT matrix
  is built and frozen under a hashed registration id, with live mode
  deliberately unwired. No chat-savings multiple is claimed until it runs.

Redutok by Truveil.
