# Bench results (live)

model: claude-sonnet-5
date: 2026-07-30
repetitions: 1
machine: win32-x64, node v24.14.1

Live-mode figures measure fresh headless claude CLI runs in isolated copies of the pinned repos. Energy and carbon are estimates with bands, never measurements.

## Provenance of these figures (hand-added, not emitted by the generator)

The slope-tier rows below come from the harness checkpoint output of the 2026-07-30 five-task run. That run's per-run transcripts are not under `bench/runs/`: they were superseded during the harness rework and no s0\* log was ever committed. So this file is the record for the slope tier, and the rows cannot be recomputed from raw logs the way earlier tiers can. Treat them accordingly.

Every other tier cites logs committed under `bench/runs/`. Those results are not in this file's current contents, because a regeneration replaces the whole file with the tier that was just run. They live in this file's own history:

- ten-task tier t01 to t10, commit `9d32c34`, transcripts and `.stream.jsonl` captures at `bench/runs/t0*` and `t10*`.
- heavy task h03, clean rerun, commit `6f24ca4`, transcripts at `bench/runs/h03-*`. The same revision carries the Incidents section recording the 4,364,974-token h03 run of 2026-07-28, whose transcripts are archived at `bench/runs/v3-h03-incident/`.
- heavy tasks h01 and h02, first run 2026-07-27: figures recorded in `docs/ARCHITECTURE-V2.md` section 1 only. Their RESULTS.md revision and their transcripts were never committed.

The full narrative, with pre-registered criteria and verdicts per generation, is `docs/BENCH-REPORT.md`.

Regenerating this file replaces this section along with everything else. Restore it, or move the note into the generator, if that happens.

| task | tier | variant | rep | input | output | cache read | cache write | thinking | total | USD | Wh (band) | gCO2e (band) | wall ms | grade | success |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | ---: | --- | --- |
| s01 | slope | vanilla | 1 | 22 | 5,265 | 476,231 | 20,708 | 0 | 502,226 | 0.3462 | 150.67 (50.22 to 502.23) | 71.27 (23.76 to 237.55) | 0 | A | pass |
| s02 | slope | vanilla | 1 | 12 | 2,295 | 240,417 | 17,240 | 0 | 259,964 | 0.2100 | 77.99 (26.00 to 259.96) | 36.89 (12.30 to 122.96) | 0 | A | pass |
| s03 | slope | vanilla | 1 | 8 | 774 | 150,161 | 15,378 | 0 | 166,321 | 0.1490 | 49.90 (16.63 to 166.32) | 23.60 (7.87 to 78.67) | 0 | A | pass |
| s04 | slope | vanilla | 1 | 20 | 2,872 | 426,943 | 18,368 | 0 | 448,203 | 0.2814 | 134.46 (44.82 to 448.20) | 63.60 (21.20 to 212.00) | 0 | A | pass |
| s05 | slope | vanilla | 1 | 12 | 3,547 | 248,102 | 20,287 | 0 | 271,948 | 0.2494 | 81.58 (27.19 to 271.95) | 38.59 (12.86 to 128.63) | 0 | A | pass |
| s01 | slope | redutok | 1 | 14 | 7,539 | 311,355 | 29,318 | 0 | 348,226 | 0.3824 | 104.47 (34.82 to 348.23) | 49.41 (16.47 to 164.71) | 101140 | A | pass |
| s02 | slope | redutok | 1 | 14 | 2,556 | 304,899 | 13,746 | 0 | 321,215 | 0.2123 | 96.36 (32.12 to 321.22) | 45.58 (15.19 to 151.93) | 52669 | A | pass |
| s03 | slope | redutok | 1 | 6 | 717 | 118,052 | 11,015 | 0 | 129,790 | 0.1123 | 38.94 (12.98 to 129.79) | 18.42 (6.14 to 61.39) | 22054 | A | pass |
| s04 | slope | redutok | 1 | 12 | 1,216 | 256,544 | 12,606 | 0 | 270,378 | 0.1709 | 81.11 (27.04 to 270.38) | 38.37 (12.79 to 127.89) | 39789 | A | pass |
| s05 | slope | redutok | 1 | 16 | 2,160 | 352,343 | 14,154 | 0 | 368,673 | 0.2231 | 110.60 (36.87 to 368.67) | 52.31 (17.44 to 174.38) | 50664 | A | pass |

## Medians per task (across repetitions)

| task | vanilla tokens | redutok tokens | token reduction | vanilla USD | redutok USD | USD reduction | vanilla non-cache-read tokens | redutok non-cache-read tokens | non-cache-read reduction | vanilla success | redutok success |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| s01 | 502,226 | 348,226 | 1.4x | 0.3462 | 0.3824 | 0.9x | 25,995 | 36,871 | 0.7x | 1/1 | 1/1 |
| s02 | 259,964 | 321,215 | 0.8x | 0.2100 | 0.2123 | 1.0x | 19,547 | 16,316 | 1.2x | 1/1 | 1/1 |
| s03 | 166,321 | 129,790 | 1.3x | 0.1490 | 0.1123 | 1.3x | 16,160 | 11,738 | 1.4x | 1/1 | 1/1 |
| s04 | 448,203 | 270,378 | 1.7x | 0.2814 | 0.1709 | 1.6x | 21,260 | 13,834 | 1.5x | 1/1 | 1/1 |
| s05 | 271,948 | 368,673 | 0.7x | 0.2494 | 0.2231 | 1.1x | 23,846 | 16,330 | 1.5x | 1/1 | 1/1 |

## Definition of done

- median token reduction across tasks: 1.3x (threshold: at least 10x, applies to this metric, the raw total-token median) NOT MET
- median USD reduction across tasks: 1.1x (context only, no threshold)
- median non-cache-read token reduction across tasks: 1.4x (context only, no threshold; input plus output plus cache-write plus thinking, excludes the per-turn re-billed cache-read)
- success parity: redutok 100% vs vanilla 100%, parity 100% (threshold: at least 95%) MET
- cumulative spend: 2.3370 USD (meter, prices.yaml), 2.3404 USD (claude CLI reported)

## Slope (sequence slope-axios)

Sequenced runs on one fixture repo: the redutok variant carries its .dcp state (candidates, codex, mirror) across the sequence with a graduation pass between tasks; vanilla starts cold each task. Zoom-backs and enrichment serves come from each redutok copy’s .dcp/audit.jsonl attribution counts (vanilla has no .dcp; runs recovered from committed logs have no audit file and show —).

| task | position | variant | tokens (median) | turns (median) | zoom-backs | enrichment serves | learned injected | pitfalls injected | success |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| s01 | 1 | vanilla | 502,226 | 11 | — | — | — | — | 1/1 |
| s01 | 1 | redutok | 348,226 | 7 | 0 | 0 | 0 | 0 | 1/1 |
| s02 | 2 | vanilla | 259,964 | 6 | — | — | — | — | 1/1 |
| s02 | 2 | redutok | 321,215 | 7 | 0 | 0 | 0 | 0 | 1/1 |
| s03 | 3 | vanilla | 166,321 | 4 | — | — | — | — | 1/1 |
| s03 | 3 | redutok | 129,790 | 3 | 0 | 0 | 0 | 0 | 1/1 |
| s04 | 4 | vanilla | 448,203 | 10 | — | — | — | — | 1/1 |
| s04 | 4 | redutok | 270,378 | 6 | 0 | 0 | 0 | 0 | 1/1 |
| s05 | 5 | vanilla | 271,948 | 6 | — | — | — | — | 1/1 |
| s05 | 5 | redutok | 368,673 | 8 | 0 | 0 | 0 | 1 | 1/1 |

- vanilla slope (s5/s1): tokens 0.54x, turns 0.55x
- redutok slope (s5/s1): tokens 1.06x, turns 1.14x
- headline: vanilla s5 over redutok s5: 0.7x tokens

### Pre-registered criteria (bench/tiers/slope.yaml; no bar movement after the fact)

- slope-exists: redutok s5 must show fewer median total tokens AND fewer median turns than redutok s1 — the learning slope exists — NOT MET (redutok s5 368,673 tokens / 8 turns vs s1 348,226 tokens / 7 turns)
- learning-pays: redutok s5 must beat vanilla s5 on median total tokens, with redutok s5 success rate at least vanilla s5's — the learning pays at parity — NOT MET (redutok s5 368,673 tokens vs vanilla s5 271,948; success parity 100% vs 100%)
- mechanism-engaged: at least one nonzero attribution counter (enrichment serve, learned injection, or graduated-pitfall injection) must appear across the redutok sequence by s5; numeric bars met with zero attribution are MET-UNATTRIBUTED and not citable — MET (0 enrichment serves, 0 learned injections, 1 pitfall injection(s) across the redutok sequence)

## Failures (savings with success degradation)

None in this run set.
