# Redutok

Redutok distills the large artifacts an agentic coding session reads, in
place and without ever adding a turn, then prices exactly what it did. Every
byte it drops is written to an append-only audit trail with a handle that
recovers the original, byte for byte, without re-running anything.

Redutok by Truveil. MIT licensed, local-first, fully audited.

## The receipt

The tools that promise to fix token spend ask you to take the saving on
faith. They show a percentage and no arithmetic.

Redutok closes every session with a receipt: tokens by class, cost at a
cited rate row, watt-hours and grams of CO2 as banded estimates, and an
audit reference behind every line. The cost side is checked against the
provider rather than asserted. Across the twenty committed live-run stream
captures, the meter totals 7.1904 USD against the 7.1966 USD the claude CLI
reported for itself. That is a residual of 0.09 percent, and the residual is
identified rather than rounded away: it is small statusline-helper calls
that land in the CLI's total and sit outside the session ledger. The working
is [docs/BENCH-REPORT.md](docs/BENCH-REPORT.md) section 6.

Two measured peaks sit under that receipt.

**One working session in the field.** A professional using the Vault on a
109-page federal guidance document and an invention disclosure, read from
the corpus ledger: 3,258,423 raw tokens touched, 222,813 served, and
3,037,338 avoided. That is 14.6x for the field session as a whole, and an
estimated 9.11 USD of cost avoided in one working session. The full receipt
closes this file.

**The largest single distillations.** This repository's own live audit trail
records 280 distillations of its own development work. Its peak
search-results event served 6,509,688 bytes of raw as 4,701 bytes, a
per-artifact ratio of 1384.7x. The steepest ratio anywhere in that trail is
a file skeleton at 2282.0x, per-artifact again.

Those last two are per-artifact figures and are labelled as such everywhere
they appear. They are not session savings, and no session claim is derived
from them.

## Why this exists

An agentic coding session spends context invisibly. The same files get
re-read, the same build logs replayed, and the whole transcript is carried
forward and re-billed on every single turn. Nobody sees the meter until the
invoice arrives, and teams hit budget walls with no line-item account of
what bought what.

The industry's answer so far is advice: clear your context more often, write
shorter prompts, be careful. Advice is aimed at humans. The spend is made by
an agent, turn by turn, faster than a human can supervise it.

The reason the advice does not add up to a fix is the cost model. A session
does not cost the sum of what its turns add. Claude Code re-bills the
accumulated window on every turn:

    session_cost = sum over turns of (
        accumulated_window_tokens_so_far x cache_read_rate
      + new_content_tokens_this_turn      x cache_write_rate
      + output_tokens_this_turn           x output_rate
    )

The bill is turns multiplied by accumulated window, with output priced at
five times input. That is why naive compression does not work. Shrinking one
artifact from 14,000 tokens to 100 does nothing for the other twenty-nine
turns that each re-read the accumulated window, and if reaching that shrunk
artifact costs three extra turns of exploration, those three turns of window
re-read can outweigh the 13,900 tokens saved. The full statement of the
model is [docs/ARCHITECTURE-V2.md](docs/ARCHITECTURE-V2.md) section 1.

## What was falsified on the way here

Two designs were built and then refuted by criteria written down before the
runs that tested them. v1 made each artifact smaller and assumed the session
would follow: the heavy tier answered with a median that missed its
pre-registered bar of at least 10x, NOT MET, and its worst task spent 32
turns against vanilla's 12, ten of its tool calls being zoom-backs to raw
and each zoom being a turn the session paid for in full. v4's
compounding codex was meant to get cheaper as it learned: its own
pre-registered criteria returned slope-exists NOT MET and learning-pays NOT
MET, with only the attribution guard passing, on one graduated-pitfall
injection.

The design that holds carries a law rather than a promise: never add a turn.
Compression happens inside the call the model already made, so it can never
buy a smaller artifact with an extra billed turn, which is the thing both
falsified designs got wrong.

The complete evidence, including the two self-caught contaminations and one
incident that cost real money, is
[docs/BENCH-REPORT.md](docs/BENCH-REPORT.md). The Vault's field defects,
each with symptom, diagnosis, and fix, are
[docs/FIELD-LOG.md](docs/FIELD-LOG.md).

## What shipped

- **Ambient distillation.** Hooks answer inside a 50ms budget and pass raw
  whenever the sidecar is unavailable. Build, test, and lint output is
  distilled in place behind deterministic quality gates that serve raw
  whenever they are not satisfied. You call nothing.
- **The skeleton mirror.** A large Read is answered with a skeleton through
  that same Read, rewritten at the hook, so compression costs no extra turn
  and no denial. The skeleton's first line names the real path, the raw
  size, and the way back to full fidelity.
- **The codex.** A verified structural map of the repository, injected once,
  so the session stops re-deriving structure it could have been told.
- **Graduation.** Each session's miner proposes candidate learnings from
  error-fix pairs, zoom-back hotspots, and recurrence signals. They earn
  confidence from occurrence and recency, graduate into the codex above a
  threshold, and are withdrawn on recorded contradiction. Recency decay
  alone never withdraws an entry. See [docs/GRADUATION.md](docs/GRADUATION.md).
- **Receipts and the energy ledger.** Tokens by class, cost from a cited
  price row, energy and carbon as banded estimates that are never presented
  as measurements, four session scores with an A to F composite, and
  `redutok audit <session-id>` to render the trail behind any figure.
- **The Vault.** The same engines mounted on a directory of documents and
  exposed to an ordinary chat client over MCP. `vault_ask` returns a
  dossier: a verdict, evidence cited by document, section, and page, a zoom
  handle for every elision, and a mandatory accounting block carrying a
  retrieval-confidence band, so a compression figure can never read as an
  answer-quality figure. `vault_zoom` recovers any cited slice byte-equal
  from the store. `vault_receipt` and the monthly statement roll the
  persistent ledger up by session, day, month, corpus, or document. See
  [packages/vault/README.md](packages/vault/README.md).

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

If the sidecar is down, every surface degrades to raw passthrough and the
session runs vanilla. That is a tested property, not a promise.

## Install

Per project, in the repository you want to govern:

    npm install --save-dev redutok
    npx redutok init
    npx redutok codex refresh
    npx redutok doctor

Install it into the project first. This is not optional, and `init` will
refuse rather than let you skip it. The hooks and the MCP server are launched
by small generated scripts under `.claude/redutok/`, and those resolve redutok
from the project's own `node_modules` every time they run. `npx` on its own
executes from a temporary cache that is never part of the project, so a bare
`npx redutok init` would write launchers that cannot find the package: the MCP
server dies at startup and every hook silently no-ops. If the install lives
outside the project, point `REDUTOK_HOME` at the directory that holds it.

Finish with `doctor`. It runs the same resolution the launchers do and fails
if the setup cannot actually run, which is the one check that distinguishes a
working install from a well-formed but inert one.

`init` is idempotent. It writes hooks to `.claude/settings.local.json`,
registers the MCP server, appends the protocol block to CLAUDE.md, and
scaffolds `.dcp/`. `remove` reverts every managed file byte-identical, which
is a tested property.

Then `npx redutok up` to start the sidecar. The full path, including the
one-time MCP approval prompt that is easy to miss, is
[docs/QUICKSTART.md](docs/QUICKSTART.md), with details in
[docs/RUNNING.md](docs/RUNNING.md).

## Documentation

- [docs/BENCH-REPORT.md](docs/BENCH-REPORT.md), the full evidence record
- [docs/FIELD-LOG.md](docs/FIELD-LOG.md), the Vault field test
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and
  [docs/ARCHITECTURE-V2.md](docs/ARCHITECTURE-V2.md), design and the
  corrected cost model
- [docs/METHODOLOGY.md](docs/METHODOLOGY.md), energy and carbon estimation
- [docs/SCORING.md](docs/SCORING.md), the four session scores
- [CHANGELOG.md](CHANGELOG.md), the arc by version

## Roadmap

- Chatbench execution: the pre-registered PASTE versus VAULT matrix, run and
  published with whatever it says.
- Codex CLI adapter: the sidecar speaks to more agents than one.
- Truveil governance layer: org-level policy over what agents may spend.

## Contributing

Profiles and language plugins are the contribution surfaces; see
CONTRIBUTING.md. House style everywhere: no em-dashes, no exclamation marks,
no emojis.

## Honest numbers

Nothing here is guaranteed. Everything here traces to an artifact you can
open. The same discipline applies to this project's own numbers: Redutok
graded its own construction session D, 68 out of 100, and most of its bench
generations missed their own pre-registered bar.

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

That last row is the peak of this repository's own live audit trail, which
is also where the counterweights live:

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

### Where Redutok does not help

This is scoping, not apology. The boundary is measured, and knowing it is
part of the product.

- **Small and medium coding tasks.** On ten single-file edit and explain
  tasks, Redutok cost more than it saved, twice, measured with a harness that
  had been debugged first. The per-session overhead of injection and tool
  loading is not repaid when no artifact is large enough to distill.
- **Small repositories.** Below the posture thresholds the session runs
  effectively vanilla by design, because governance that cannot earn its
  overhead should not charge it.
- **Small documents.** In the field session below, the 14 KB disclosure
  contributed exactly zero avoided tokens. It is smaller than the slices
  served around it, and the per-document rollup says so instead of averaging
  it away.
- **Chat conversations, for now.** The chatbench that would measure this is
  built, frozen, and unexecuted. No chat-savings multiple is claimed until it
  runs.

## The field session, and the standard

The corpus was two documents: the USPTO's subject-matter-eligibility
examples, 109 pages of federal guidance that renumbers its examples from 1
inside every part, mixes literal and hex-encoded text, and is typeset by a
producer that repaints clipped glyphs, plus a 14 KB invention disclosure. It
was not chosen to be difficult. It was the work in front of the user.

Ten defects came out of that session, and none of them was found by the
tests that shipped with the feature: heading blindness, line fragmentation,
CID hex-string body text, clipped-glyph doubling, retrieval ranking, heading
collisions, handle durability, silent corpus defaulting, one cross-component
interaction caught on paper before any live spend, and the one that matters
most, an accounting block that reported a large reduction on six consecutive
wrong answers. That last one was fixed by making the receipt unable to look
good when retrieval fails: a deterministic confidence band on every ask, and
a reduction line that now reads "compression only, never answer quality".

The receipt that closed the session, read from the corpus ledger at
`.dcp/ledger.db`, session `vault-stdio-3ba5a316`:

| quantity                    |     value |
| --------------------------- | --------: |
| asks                        |        13 |
| serve and zoom ledger lines |        52 |
| raw tokens touched          | 3,258,423 |
| tokens served               |   222,813 |
| tokens avoided              | 3,037,338 |
| ratio, this field session   |     14.6x |
| estimated cost avoided      |  9.11 USD |

Retrieval confidence across those 13 asks: 3 high, 10 medium, 0 low. Of the
3,037,338 tokens avoided, zero are attributable to the 14 KB disclosure, and
the per-document rollup says so rather than averaging it away. The cost
figure is an estimate at the input rate for tokens a chat client would
otherwise have carried in its context. It is what the work would have cost
to paste, not a refund.

The standard behind all of it is one line. Criteria are pre-registered
before the run, outcomes are published either way, and every compression
decision is audited and recoverable byte for byte.

Redutok by Truveil.
