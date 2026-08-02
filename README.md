# Redutok

Token and energy accounting for AI work, with a receipt for every byte.
Redutok by Truveil. MIT licensed, local-first, fully audited.

## The problem

Agentic coding sessions spend tokens like an expense account nobody reviews.
The same files get re-read, the same build logs replayed, and the whole
transcript is carried forward and re-billed on every single turn. It is the
Uber-budget problem: each ride looks small, the monthly bill does not.

The tools that promise to fix this ask you to take the saving on faith. They
show you a percentage and no arithmetic.

## The receipt

Redutok's core deliverable is not compression. It is the receipt.

Every byte dropped, truncated, or summarized is written to an append-only
audit trail with a handle that recovers the original, byte for byte, without
re-running anything. Every ledger line names the artifact behind it, the rate
row used to price it, and the audit event that produced it. Compression
without provenance is a liability. Compression with an audit trail is a
feature.

The same discipline applies to this project's own numbers. Redutok graded its
own construction session D, 68 out of 100. Most of its bench generations
missed their own pre-registered bar, and every one of them is published in
[docs/BENCH-REPORT.md](docs/BENCH-REPORT.md) with the failures at the same
volume as the wins.

## Honest numbers

Nothing here is guaranteed. Everything here traces to an artifact you can
open.

### Per-artifact peaks

These are single-artifact distillation ratios. They are not session savings,
and no session claim is derived from them. Fixture rows come from real
artifacts captured into `fixtures/artifacts/` and measured by
`scripts/measure-ratios.mjs`.

| what                                         |         raw |    served |   ratio |
| -------------------------------------------- | ----------: | --------: | ------: |
| large build log, fixture-measured            |  61,831 tok |    56 tok | 1104.1x |
| large test output, fixture-measured          |  28,044 tok | 1,125 tok |   24.9x |
| typescript source skeleton, fixture-measured |   1,343 tok |   135 tok |    9.9x |
| search result set, live in this repository   | 6,509,688 B |   4,701 B | 1384.7x |

That last row is the peak of this repository's own live audit trail, which is
also where the counterweights live:

| live audit trail, this repository         | value |
| ----------------------------------------- | ----: |
| distillations recorded                    |   280 |
| median ratio, all profiles                |  9.6x |
| median ratio, search results (37 of them) | 14.4x |
| serve-raw events, the gates refusing      |   314 |
| zoom-backs, each one a paid turn          |   176 |

Raw was served more often than it was distilled. That is the quality gates
working, and it is in the same file as the peak.

### Session level

| generation             | measure                   | result | pre-registered bar    |
| ---------------------- | ------------------------- | -----: | --------------------- |
| ten-task live matrix   | median token reduction    |   0.8x | at least 10x, NOT MET |
| heavy tier, first run  | median token reduction    |   0.7x | at least 10x, NOT MET |
| heavy task h03, rerun  | token reduction at parity |   1.2x | at least 1.2x, MET    |
| slope tier, five tasks | median token reduction    |   1.3x | at least 10x, NOT MET |

Every row is N of 1 on one machine with one model. The h03 rerun is the only
pre-registered bar Redutok has cleared at session level, and it cleared it
exactly, on the one task the mechanism was designed for.

### The Vault, in the field

One professional session over a 109-page USPTO patent-examples PDF and an
invention disclosure, read from the corpus ledger:

| quantity                  |     value |
| ------------------------- | --------: |
| raw tokens touched        | 3,258,423 |
| tokens served             |   222,813 |
| tokens avoided            | 3,037,338 |
| ratio, this field session |     14.6x |
| estimated cost avoided    |  9.11 USD |

The full log of what broke on the way there, ten defects with symptoms,
diagnoses, and fixes, is [docs/FIELD-LOG.md](docs/FIELD-LOG.md).

### Where Redutok does not help

- **Small and medium coding tasks.** On ten single-file edit and explain
  tasks, Redutok cost more than it saved, twice, measured with a harness that
  had been debugged first. The per-session overhead of injection and tool
  loading is not repaid when no artifact is large enough to distill.
- **Small repositories.** Below the posture thresholds the session runs
  effectively vanilla by design, because governance that cannot earn its
  overhead should not charge it.
- **Small documents.** In the field session above, the 14 KB disclosure
  contributed exactly zero avoided tokens. It is smaller than the slices
  served around it, and the per-document rollup says so instead of averaging
  it away.
- **Chat conversations, for now.** The chatbench that would measure this is
  built, frozen, and unexecuted. No chat-savings multiple is claimed until it
  runs.

## Install

Redutok is not published to npm yet. Build it from source:

    git clone https://github.com/imkaran7/redutok
    cd redutok
    pnpm install
    pnpm -r build

Then wire it into the repository you want to govern:

    node <redutok>/packages/meter/dist/cli.js init .
    node <redutok>/packages/meter/dist/cli.js up

`init` is idempotent, writes hooks to `.claude/settings.local.json`, registers
the MCP server, appends the protocol block to CLAUDE.md, and scaffolds
`.dcp/`. `remove` reverts every managed file byte-identical, which is a tested
property. See [docs/QUICKSTART.md](docs/QUICKSTART.md) for the full path and
[docs/RUNNING.md](docs/RUNNING.md) for details.

## How it works

    Claude Code session
      | hooks (fail-open, 50ms budget)     | MCP tools (dcp__explore, dcp__read,
      |  protocol + codex injection        |  dcp__run, dcp__search, dcp__zoom)
      v                                    v
    +----------------- sidecar (localhost only) ------------------+
    | codex engine | distiller + gates | delta registry | state   |
    |     skeleton mirror  |  sqlite store  |  audit.jsonl        |
    +--------------------------------------------------------------+
      ^ raw retained, zoom recovers anything          | meter CLI
      |                                               v
      +---- profiles/*.yaml (rule engine first) --- report, scores,
                                                    badge, bench

Four things happen. The codex gives the session a verified map of the
repository so it stops re-deriving structure. Large reads are answered with a
skeleton through the same Read call the model already made, so compression
never costs an extra turn. Command output is distilled in place behind
quality gates that serve raw whenever they are not satisfied. And everything
is metered, priced, and graded afterwards by a CLI that reconciles to the
provider's own billing within a tenth of a percent.

If the sidecar is down, every surface degrades to raw passthrough and the
session runs vanilla. That is a tested property, not a promise.

## The Vault, for chat

The same engines, mounted on a directory of documents and exposed to an
ordinary chat client over MCP. Ingest a folder of PDFs, DOCX, Markdown, and
code; the client then asks questions against it instead of pasting it.

- `vault_ask` returns a dossier: a verdict, evidence cited by document,
  section, and page, a zoom handle for every elision, and a mandatory
  accounting block carrying a retrieval-confidence band, so a compression
  figure can never read as an answer-quality figure.
- `vault_zoom` recovers any cited slice byte-equal from the store.
- `vault_receipt` and the monthly statement roll the persistent ledger up by
  session, day, month, corpus, or document, with the rate row cited and
  energy as banded estimates.

See [packages/vault/README.md](packages/vault/README.md).

## Roadmap

- Chatbench execution: the pre-registered PASTE versus VAULT matrix, run and
  published with whatever it says.
- Codex CLI adapter: the sidecar speaks to more agents than one.
- Truveil governance layer: org-level policy over what agents may spend.

## Documentation

- [docs/BENCH-REPORT.md](docs/BENCH-REPORT.md), the full evidence record
- [docs/FIELD-LOG.md](docs/FIELD-LOG.md), the Vault field test
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and
  [docs/ARCHITECTURE-V2.md](docs/ARCHITECTURE-V2.md), design and the
  corrected cost model
- [docs/METHODOLOGY.md](docs/METHODOLOGY.md), energy and carbon estimation
- [docs/SCORING.md](docs/SCORING.md), the four session scores
- [CHANGELOG.md](CHANGELOG.md), the arc by version

## Contributing

Profiles and language plugins are the contribution surfaces; see
CONTRIBUTING.md. House style everywhere: no em-dashes, no exclamation marks,
no emojis.

Redutok by Truveil.
