# Bench report: the full evidence record

Why this document exists: Redutok writes its criteria down before a run and
publishes the outcome either way. That only means something if the outcomes
are somewhere a reader can reach, at the volume they were recorded at rather
than the volume that flatters the project. This file is that place. It is a
working document, not a summary assembled afterwards to fit a result.

This is the complete measurement history of Redutok, including the runs that
went against it. It exists so that anyone deciding whether to trust the
project can check the arithmetic instead of the adjectives.

Rules this document follows:

- Every figure names the artifact it came from. Where an artifact is not
  committed, that is stated on the spot rather than glossed.
- Pre-registered criteria are quoted as they were written before the run.
  No bar was moved after a run recorded a result.
- Negative results are reported at the same volume as positive ones. Of the
  five bench generations below, three failed their own headline criterion,
  one met a deliberately narrow one, and the first set no savings claim at
  all.

## 1. The corrected cost model

Redutok v1 optimized the wrong quantity. It made each individual tool output
smaller, on the assumption that a session costs the sum of what its turns add.
It does not. Claude Code bills the accumulated window on every turn:

```
session_cost = sum over turns of (
    accumulated_window_tokens_so_far x cache_read_rate
  + new_content_tokens_this_turn      x cache_write_rate
  + output_tokens_this_turn           x output_rate
)
```

For claude-sonnet-5 at the rates in
[packages/shared/prices.yaml](../packages/shared/prices.yaml): input 3.00
USD per MTok, cache read 0.30 (a tenth of input), cache write 3.75 at the
5-minute tier or 6.00 at the 1-hour tier, output 15.00 (five times input).

Two consequences follow. Output tokens cost five times input, so a verbose
extra turn costs more than a cheap turn saves. And the cache-read term
re-bills the entire prior window every turn, so turn count multiplies against
accumulated size rather than against per-turn content.

Shrinking one artifact from 14,000 tokens to 100 does nothing for the other
twenty-nine turns that each re-read the accumulated window. If reaching that
shrunk artifact costs three extra turns of exploration, those three turns of
window re-read can outweigh the 13,900 tokens saved.

The full statement of the model, and the four pillars specified against it,
is [docs/ARCHITECTURE-V2.md](ARCHITECTURE-V2.md) section 1.

### Why context-only compression was falsified

The heavy tier, run live on 2026-07-27 with claude-sonnet-5 at N=1, is the
falsifying evidence. Figures as recorded in
[docs/ARCHITECTURE-V2.md](ARCHITECTURE-V2.md) section 1:

| task | vanilla tokens | redutok tokens | token reduction |
| ---- | -------------: | -------------: | --------------: |
| h01  |        171,463 |        229,420 |            0.7x |
| h02  |        323,336 |        245,554 |            1.3x |
| h03  |        256,284 |        490,585 |            0.5x |

Median 0.7x against a Definition of Done threshold of at least 10x. NOT MET.
Redutok used more tokens than vanilla on two tasks out of three.

The turn counts, taken directly from the run transcripts, show the mechanism:

| task | variant | assistant turns | tool calls | breakdown                                                |
| ---- | ------- | --------------: | ---------: | -------------------------------------------------------- |
| h01  | vanilla |               8 |          3 | Bash 1, Read 1, Write 1                                  |
| h01  | redutok |               9 |          4 | ToolSearch 1, dcp__run 1, Read 1, Write 1                |
| h02  | vanilla |              12 |          6 | Bash 5, Write 1                                          |
| h02  | redutok |              11 |          4 | Bash 2, Read 1, Write 1                                  |
| h03  | vanilla |              12 |          8 | Bash 2, Read 5, Write 1                                  |
| h03  | redutok |              32 |         22 | ToolSearch 1, dcp__read 5, dcp__zoom 10, Read 5, Write 1 |

h03-redutok is the clearest case. Ten of its twenty-two tool calls are zooms:
the agent read a distilled artifact, found it insufficient, and went back to
raw, repeatedly. Each zoom is its own turn, and each turn re-bills the
accumulated window. The distillation was correct per its profile and the zoom
escape hatch worked exactly as specified, and the two together produced 32
turns against vanilla's 12. That gap is what turned a per-artifact win into a
session-level loss.

h02 is the counterexample that proves the same mechanism from the other side,
and it is the only heavy task redutok won. It won by using fewer turns than
vanilla, 11 against 12, not by compressing harder. Turn count, not artifact
size, is the lever.

No further h02 attempts are recorded in this repository. The single committed
h02 record is the row above, and nothing here claims more than it.

### One pillar that could not be built

Architecture v2's Pillar 4 includes eager registration of the dcp tool
schemas, to remove the one ToolSearch turn that both h01-redutok and
h03-redutok pay before any dcp tool becomes callable. That turn is real and
measured in the table above.

It was researched and not built. Deferred-versus-eager tool loading is a
client-side heuristic in Claude Code, decided by the client's own token
budget across every connected MCP server. There is no field in `.mcp.json`,
no `tools/list` response field, and no naming convention a single server can
declare to opt in. This is a capability gap in the client, recorded in
[PROGRESS.md](../PROGRESS.md) under the 2026-07-19 entry, not a Redutok
defect and not an unbuilt deliverable.

## 2. Generation by generation

### Generation 1: replay harness (Phase 6B, 2026-07-19)

Ten pinned tasks measured against committed fixture session logs. This
generation produced no savings claim and was never intended to: replay
measures the meter, not the product. Its value was the harness contract, the
`bench/RESULTS.md` format with its mandatory header, per-run token classes,
and mandatory failures section.

### Generation 2: first live matrix (t01 to t10, 2026-07-19)

Criterion, pre-registered in the Definition of Done: median token reduction
of at least 10x with success parity of at least 95 percent, both read from
committed raw logs.

The first execution returned a median of 0.9x and two tasks at 0 of 2
successes. That result was not published, because it was diagnosed first, and
four independent measurement bugs came out of the diagnosis. None was a
Redutok efficiency regression:

1. The runner spawned the claude CLI with `shell: true` plus an argument
   array on Windows, so cmd.exe word-split the unquoted prompt and every run
   received only the prompt's first word. Fixed by
   [packages/meter/src/safe-spawn.ts](../packages/meter/src/safe-spawn.ts),
   which resolves the PATH command to a directly executable target and never
   uses a shell.
2. The parser summed usage per JSONL record, but Claude Code streams one API
   response as several records sharing `message.id`. Real transcripts were
   inflated roughly two to two and a half times. Fixed by folding turns on
   `message.id`. Committed fixture logs carry no `message.id` and were
   unaffected, verified by a byte-identical replay before and after.
3. Every task's success check was a needle that already existed in the
   unedited fixture repo, so a no-op run graded identically to a real
   completion. One task's needle was case-broken and could never pass.
   Replaced with graded ANSWER.md content for explain tasks and
   changed-file plus substance-regex checks for edit tasks.
4. The medium tier ran against the same two-file synthetic fixture as the
   small tier, so it never exercised anything larger. Replaced by a real
   vendored repository, chalk at commit
   `aa06bb5ac3f14df9fda8cfb54274dfc165ddfdef`, every file verified against
   its GitHub blob SHA before copying in. See
   [fixtures/repos/chalk/PROVENANCE.md](../fixtures/repos/chalk/PROVENANCE.md).

Rerun with all four fixes, claude-sonnet-5, N=1, all ten tasks, twenty runs,
zero not-run:

- median token reduction 0.8x against the 10x threshold, NOT MET
- success parity 80 percent against the 95 percent threshold, NOT MET
- one savings-with-degradation case, t08-redutok at 1.1x, which failed its
  answer check; t10-redutok's failure is the harness's deliberate
  degradation case

Raw logs are committed at
[bench/runs/](../bench/runs/) as `t01..t10-{vanilla,redutok}-1.jsonl` with
the matching `.stream.jsonl` CLI captures.

The t08 failure was investigated rather than accepted. Both transcripts were
read in full. The check's needle targets a real, load-bearing validation site
that the redutok run's own first search had surfaced verbatim, undistorted,
inside the visible window. The agent then wrote an answer claiming validation
happened in exactly two places. Governance withheld nothing. The verdict is a
genuine completeness miss in the run's own synthesis, so the check, the FAIL,
and the results entry all stand as recorded.

This generation's result is honest rather than broken. None of the ten small
to medium single-file tasks generates a raw artifact large enough for the
distiller to matter, so Redutok's fixed per-session overhead costs more than
it saves. The finding is a real product signal about a task set that does not
represent the target scenario, and it is why the heavy tier exists.

### Generation 3: heavy tier (h01 to h03, 2026-07-27)

Tasks built to produce genuinely large artifacts: a verbose failing build log
(h01), a failing test suite with ten cases and a seeded root cause (h02), and
a large-source exploration task (h03). Fixture provenance in
[fixtures/repos/chalk-heavy-test/PROVENANCE.md](../fixtures/repos/chalk-heavy-test/PROVENANCE.md).

Result: the table in section 1. Median 0.7x, NOT MET.

This generation also produced the first of the two contaminations in section
3, which invalidated h03's row before it could be cited.

### Generation 4: v3 pillars and the h03 rerun (2026-07-28)

Pre-registered pass criterion, written into
[docs/ARCHITECTURE-V2.md](ARCHITECTURE-V2.md) section 7 before the work
started:

> redutok h03 must move from 0.5x to at least 1.2x token reduction at parity
> (task success unchanged, pass to pass), N of 1.

Stated in that document as deliberately narrow, not the 10x Definition of
Done: it asks only whether collapsing the 32-turn, 10-zoom-back pattern into
fewer, larger turns flips one task from a loss to a win.

Result, committed at commit `6f24ca4`, `bench/RESULTS.md` of that revision,
transcripts at [bench/runs/](../bench/runs/) `h03-{vanilla,redutok}-1.jsonl`:

| task | vanilla tokens | redutok tokens | token reduction | success       |
| ---- | -------------: | -------------: | --------------: | ------------- |
| h03  |        352,192 |        286,297 |            1.2x | 1/1 both arms |

Cumulative spend for the pair: 0.7860 USD by the meter, 0.7869 USD reported
by the claude CLI.

Verdict: MET, exactly at the bar, at parity. What it licenses is narrow and
worth stating precisely. It is evidence that the turn-count mechanism
described in section 1 is real and addressable. It is not a 10x result, not
a median over a task set, and not N greater than 1. The non-cache-read
reduction on the same run was 0.9x, meaning Redutok's win came from carrying
a smaller accumulated window, not from sending fewer fresh tokens.

Between the contaminated h03 and this clean rerun sits the 4.36M incident,
section 4.

### Generation 5: slope tier (s01 to s05, 2026-07-30)

The slope tier asks a different question: does the system get cheaper as it
learns? Five sequenced tasks on one fixture repository, axios v1.7.9. The
redutok arm carries its `.dcp` state across the sequence with a graduation
pass between tasks; vanilla starts cold every task.

Criteria pre-registered in [bench/tiers/slope.yaml](../bench/tiers/slope.yaml),
with the loader refusing any criterion id not in that file:

- **slope-exists**: redutok s5 must show fewer median total tokens and fewer
  median turns than redutok s1.
- **learning-pays**: redutok s5 must beat vanilla s5 on median total tokens,
  with success at least at vanilla's rate.
- **mechanism-engaged**: at least one nonzero attribution counter
  (enrichment serve, learned injection, or graduated-pitfall injection) must
  appear across the redutok sequence by s5. Numeric bars met with zero
  attribution are recorded as MET-UNATTRIBUTED and are not citable.

Result as recorded in [bench/RESULTS.md](../bench/RESULTS.md):

| criterion         | verdict | basis                                                          |
| ----------------- | ------- | -------------------------------------------------------------- |
| slope-exists      | NOT MET | s5 368,673 tokens / 8 turns against s1 348,226 / 7             |
| learning-pays     | NOT MET | s5 368,673 tokens against vanilla s5 271,948                   |
| mechanism-engaged | MET     | 0 enrichment serves, 0 learned injections, 1 pitfall injection |

Session-level medians across the five tasks: token reduction 1.3x against the
10x threshold, NOT MET; success parity 100 percent against the 95 percent
threshold, MET, with both arms passing every task; cumulative spend 2.3370
USD by the meter against 2.3404 USD reported by the CLI.

Two figures in that table point in opposite directions and both are real.
Vanilla's own s5-over-s1 drift is 0.54x on tokens and 0.55x on turns, steeper
than redutok's 1.06x and 1.14x. The sequence has a task-size gradient, and
that gradient, not learning, dominates the shape.

**What MET-UNATTRIBUTED does and does not license.** The third criterion
exists because an earlier slope run produced numeric bars that read MET while
the mechanism under test never engaged at all: the fixture sat under the idle
posture thresholds, so every redutok session ran effectively vanilla, with no
codex injection, no dcp routing, no zoom-backs, and nothing for the miner to
mine. Numbers moved; the product did nothing. The criterion was added so that
a repeat of that shape renders as MET-UNATTRIBUTED and is barred from
citation.

In the run recorded above the guard is not what failed. The numeric bars
failed outright, and mechanism-engaged passed on a single graduated-pitfall
injection. So the licensed claim is exactly this: the attribution machinery
works and one graduated lesson reached a session. Nothing about a learning
slope is claimed, because no learning slope was measured.

**Evidence caveat, stated rather than hidden.** The slope figures are the
harness checkpoint output of the 2026-07-30 five-task run, committed as
[bench/RESULTS.md](../bench/RESULTS.md) with a provenance header saying so.
Unlike the t-tier and h-tier generations, that run's per-run transcripts are
not under `bench/runs/`: they were superseded during the harness rework and
no `s0*` log was ever committed. The table therefore cannot be recomputed
from raw logs the way the earlier generations can, and that file is itself
the record. Treat the slope row as the weakest evidence in this document.

Note on the same file: a regeneration replaces its entire contents with the
tier that was just run, so earlier tiers are reachable through its history
rather than its current text. The t-tier results sit at commit `9d32c34`,
the h03 rerun and the incidents section at `6f24ca4`, and the h01 and h02
figures only in [docs/ARCHITECTURE-V2.md](ARCHITECTURE-V2.md) section 1.
The provenance header in `bench/RESULTS.md` carries the same index.

## 3. The two self-caught contaminations

Both were found by the project, before publication, by auditing evidence
rather than by trusting a green number.

### 3.1 h03 answered by the dogfood daemon (2026-07-27)

**Symptom.** The h03-redutok run completed and produced a plausible row.

**How it was caught.** Every bench run's tool calls were reconciled against
the audit trail that should have served them. h01-redutok made zero
`mcp__redutok` calls, so its result stood. h03-redutok made five
`dcp__read` calls, and matching events for all five appeared in this
repository's own dogfood `.dcp/audit.jsonl`, attributed to the orchestrator
session, timestamped to the second. The bench temp copy's `.mcp.json`
hardcoded port 48642, the dogfood daemon's port, so the isolated run was
being served by the developer's live sidecar.

**Consequence.** The first read of `source/index.js` did not return the file.
It returned a cross-session unified diff against a base that had been served
earlier to a different session, because the delta registry correctly
recognized content it had already sent to that store. The h03 row was
measuring the wrong thing, and it was discarded rather than published.

**Fix**, merged as PR #6: the MCP server resolves its port from the
repository's own `.dcp/config.json` with `REDUTOK_PORT` as an explicit
override only; the installer stopped hardcoding the port; and the daemon now
refuses cross-repository serve and zoom with an audited `refuse` event.
Sixteen bench-attributed events remain in the dogfood audit trail,
identifiable by fixture paths that do not exist in this repository. They feed
no ledger or receipt, which are transcript-based.

### 3.2 Chatbench fixtures inside the ingest corpus (2026-08-01)

**Symptom.** None yet. This one was caught before it could produce a number.

**How it was caught.** The chatbench docs corpus was first assembled inside
`fixtures/doc-corpus`, which the vault ingest test copies wholesale. Any
chatbench-only file added there would have been indexed by an unrelated test
fixture, and, in the other direction, the paste arm's token count would have
depended on files placed for a different purpose. The overlap was noticed
while wiring the harness.

**Fix**, commit `48063e9`: the chatbench fixture moved to its own corpus at
`fixtures/chatbench-docs`, isolated by construction, with the paste arm
reading committed `.extracted.txt` shadows so its token count is
deterministic. The relocation happened before any live chatbench run, so no
recorded result was ever affected.

## 4. The 4.36M incident (2026-07-28)

**What happened.** A same-day rerun of h03-redutok consumed 4,364,974 tokens
and 2.3615 USD across 45 turns, against a normal run of roughly 286,000
tokens. That is a fifteen-fold blowout on a task that had just been measured.

**Diagnosis**, recorded in `bench/RESULTS.md` at commit `6f24ca4` with the
transcripts archived at
[bench/runs/v3-h03-incident/](../bench/runs/v3-h03-incident/):

1. The run executed against a stale `dist`. A stale `.mcp.json` still carried
   `REDUTOK_PORT=48642`, pointing at a daemon that was no longer there, so
   every dcp read fell through to raw. Files were read twice, once through
   the failed path and once raw.
2. The inflated context then met a model-side repair loop: the Write tool
   materialized escape bytes into ANSWER.md, the model noticed the corruption
   and rewrote the file, and the cycle repeated for 41 turns. Each of those
   turns re-billed the by-then inflated accumulated window.

The second half is model behavior outside governance scope, and it is
reported as such rather than blamed on the harness. The first half is a
harness defect and was fixed as one.

**Fix**, merged as PR #7: `scripts/bench-live.mjs` now gates every live run
on build freshness and port wiring. A stale `dist` in any package, or a
hardcoded `REDUTOK_PORT` in the environment handed to the CLI, aborts the run
instead of measuring the wrong code.

**Why it is in this document.** The incident cost real money and produced a
number fifteen times worse than the honest one. Publishing the clean rerun
without it would be the exact kind of selective reporting this project exists
to make impossible.

## 5. Fixture-measured profile ratios

These are per-artifact distillation ratios, measured on real artifacts
captured from this repository into
[fixtures/artifacts/](../fixtures/artifacts/) by
`scripts/measure-ratios.mjs`. They are not session-level savings, and no
session-level claim is derived from them. Token counts use the chars-over-4
estimate that the handle format uses.

| profile        | fixture           | raw tok (est) | distilled tok (est) |   ratio | served    |
| -------------- | ----------------- | ------------: | ------------------: | ------: | --------- |
| build-log      | small             |         2,280 |                  56 |   40.7x | distilled |
| build-log      | large             |        61,831 |                  56 | 1104.1x | distilled |
| test-output    | small             |         4,245 |               1,058 |    4.0x | distilled |
| test-output    | large             |        28,044 |               1,125 |   24.9x | distilled |
| file-skeleton  | typescript source |         1,343 |                 135 |    9.9x | distilled |
| file-skeleton  | python source     |           971 |                 363 |    2.7x | distilled |
| search-results | grep set          |         3,065 |                 604 |    5.1x | distilled |
| generic-stdout | stdout stream     |         2,564 |                 448 |    5.7x | distilled |

Every row passed its gates. Gate configuration and pass or fail per gate is
recorded per row in [PROGRESS.md](../PROGRESS.md); a row that fails a gate
serves raw and is audited as such.

The obvious caution: the 1104.1x row is a large build log reduced to a
verdict line and a file reference. It is a real measurement of a real
artifact and a terrible predictor of what a session saves, because a session
that reads one build log spends the rest of its turns doing something else.

### Live audit trail, this repository

The same distiller running against this repository's own development
sessions, 2026-07-18 to 2026-07-30, read from `.dcp/audit.jsonl`:

| profile        | distills | median ratio | peak ratio |
| -------------- | -------: | -----------: | ---------: |
| file-skeleton  |      203 |         9.6x |    2282.0x |
| search-results |       37 |        14.4x |    1384.7x |
| build-log      |       22 |         6.9x |      50.0x |
| generic-stdout |        6 |         4.9x |       6.3x |
| all profiles   |      280 |         9.6x |            |

Aggregate over those 280 distillations: 48,448,465 bytes of raw artifact
served as 1,904,115 bytes. The peak search-results event served 4,701 bytes
for 6,509,688 bytes of raw, a ratio of 1384.7x, on 2026-07-28.

Three counterweights belong beside that table. The same audit trail records
314 serve-raw events against those 280 distills, meaning raw was served more
often than distilled, which is the gates and the size thresholds doing their
job. It records 176 zooms, meaning the escape hatch was used, and every zoom
is a turn the session paid for. And `.dcp/audit.jsonl` is machine-local
state, excluded from version control by `.gitignore`, so this is the one
table in this document that a third party cannot recompute from the
repository. It is reproducible only in the sense that running Redutok on your
own work produces your own version of it.

## 6. The meter reconciles to CLI billing

A cost model nobody checks is a decoration. The meter's totals were reconciled
against the claude CLI's own reported `total_cost_usd` on the twenty
committed live-run stream captures.

The first reconciliation failed. The meter said 3.9838 USD; the CLI said
7.1966 USD, a gap of 1.81x. The gap was not accepted and not explained away.

Two independent causes were found by reverse-computing each run's exact
reported cost from its own usage blocks:

1. **Cache-write tier.** Every run's `cache_creation` block was entirely
   `ephemeral_1h_input_tokens`, billed at twice base input, while `cost.ts`
   priced all cache writes at the 5-minute tier of 1.25 times input.
2. **Rate row.** The introductory claude-sonnet-5 rate hypothesis (2.00/10.00)
   matched 0 of 20 runs. The standard rate (3.00/15.00) with full 1-hour
   cache-write billing matched 20 of 20 to the sub-cent, including
   t01-vanilla at a reported 0.20648699999999998 against a computed 0.206487.

Both were fixed rather than papered over. The tally schema gained a
5-minute/1-hour split, the parser reads the transcript's own breakdown and
trusts it only when it reconciles exactly to the reported total, and any
unknown-tier token is conservatively assumed at the more expensive 1-hour
tier and disclosed as assumed in the report. The price row now carries the
standard rate with a note recording the deviation from the published
introductory rate and the evidence for it.

Result: 7.1904 USD by the meter against 7.1966 USD reported by the CLI. The
gap closed from 1.81x to 1.0009x. The residual 0.0062 USD, about 0.09
percent, is small claude-haiku-4-5 statusline-helper calls that land in the
CLI's total but sit outside the session ledger.

Fixture expectations were recomputed honestly under the new policy rather
than adjusted to keep tests green: the small fixture's hand-computed cost
moved from 0.04326 to 0.04533 because all 920 of its cache-write tokens now
bill at the assumed 1-hour rate.

One process note from the same fix. Regenerating `bench/RESULTS.md` wholesale
would have silently turned the real t08 and t10 FAIL verdicts into passes,
because the recovery path cannot re-derive success from a bare transcript.
That was caught before committing, and the file was patched surgically to
touch only the USD-derived cells, leaving wall times, grades, successes, and
the failures section exactly as originally recorded.

## 7. The chatbench tier: built, pre-registered, not executed

The chatbench measures the Vault against how people actually use a chat client
with documents: paste the corpus into the first message, then ask questions
across a multi-turn conversation. Two arms, PASTE and VAULT, same model, same
questions in the same order, three replications per arm and corpus.

**It has not been run. No chat-savings multiple is claimed until it runs.**

What exists today, on branch `claude/vault-session5-chatbench` as pull request
20, not yet merged to main:

- `bench/chatbench.yaml`, the frozen registration, `registrationId`
  `chatbench-v1b-2026-08-01`, hashed with sha256 over every field except
  `failures[]`, which is the only field editable after a run.
- `bench/chatbench/docs.yaml` and `code.yaml`, ten questions each with
  follow-up dependencies.
- The harness in `packages/meter/src/chatbench/`, 34 tests, and a driver with
  a dry-run mode that enumerates the full 120-call matrix and prints a cost
  band, plus a prep-check mode that runs the whole pipeline end to end
  against a mocked client. Neither makes a network call.
- `bench/CHATBENCH.md`, describing arms, corpora, metrics, and the house-law
  constraints on pre-registration.

Pre-registered criteria, frozen before any live run:

| criterion                                |  docs corpus |  code corpus |
| ---------------------------------------- | -----------: | -----------: |
| median input-token reduction             |  at least 3x | at least 20x |
| total conversation cost reduction        |  at least 2x | at least 10x |
| grader parity rate (score at least 0.75) | at least 85% | at least 85% |
| receipt reconciliation error             |   within 25% |   within 25% |

Live mode is deliberately not wired: the driver falls back to the prep-check
and names the two functions that would take a real API client. The dry-run
cost band for the full matrix is 15 to 20 USD, and the founder approves that
spend before the switch is flipped.

One honest prediction is already on record, published here before the run
rather than after it. The prep-check shows that on the small docs fixture the
VAULT arm's roughly 2.7 KTok system-prompt overhead, the codex block plus the
Skill text, exceeds the entire pasted corpus. The docs floor of 3x is
therefore unlikely to hold at fixture scale, while the 550 KB axios code
corpus clears its 20x floor comfortably. The expected published result is
asymmetric: docs NOT MET at fixture scale, code MET. House law forbids moving
either threshold after the first live run; any adjustment requires a new
registration id and a clean rerun.

## 8. What we cannot claim

- **No 10x session-level reduction.** The Definition of Done threshold of at
  least 10x median has never been met by any generation. The best committed
  session-level results are 1.2x on a single heavy task and a 1.3x median on
  the slope tier, both at N of 1.
- **No general savings claim for coding sessions.** On small and medium
  single-file tasks Redutok costs more than it saves, measured twice, and
  that is the honest finding for that class of work.
- **No learning-slope claim.** The slope tier's two numeric criteria are NOT
  MET, and the run that did show movement showed it with the mechanism
  disengaged.
- **No chat-savings multiple.** The chatbench is built and frozen and has not
  been run. Every number in section 7 is a threshold, not a result.
- **No statistical confidence anywhere.** Every live figure in this document
  is N of 1 or N of 3 on a single machine with a single model. Nothing here
  supports a confidence interval.
- **No energy measurement.** Every Wh and gCO2e figure is an estimate with a
  deliberately wide band, from the model in
  [docs/METHODOLOGY.md](METHODOLOGY.md). Model-class energy factors span an
  order of magnitude because provider-side serving efficiency is
  unobservable from a client. The band is the claim; the base is a midpoint
  convenience.
- **No claim that compression means quality.** A dossier can report a large
  reduction on a wrong answer, and did, six times in a row, before retrieval
  confidence was added. See [docs/FIELD-LOG.md](FIELD-LOG.md).
- **No third-party reproducibility for the live audit table** in section 5.
  It comes from machine-local state that is not in version control.
- **No comparison of context-efficiency scores across 0.1.4.** The metric
  changed definition in that release, from a ratio against the bytes a session
  served raw to the share of touched raw that never entered context (see
  [docs/SCORING.md](SCORING.md)). Every run in this document predates 0.1.4
  and therefore used the prior denominator, so its context-efficiency figures,
  and the composite grades that carry them at weight 0.35, cannot be placed
  beside anything scored on 0.1.4 or later. The change moves scores in no
  fixed direction, so there is no correction factor: a session would have to
  be rescored from its audit trail to be comparable. This affects the scores
  only. The per-distillation ratios in section 5 are raw over served bytes on
  individual artifacts and are untouched by it.

Redutok by Truveil.
