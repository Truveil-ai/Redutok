# Bench results (live)

model: claude-sonnet-5
date: 2026-07-28
repetitions: 1
machine: win32-x64, node v24.14.1

Live-mode figures measure fresh headless claude CLI runs in isolated copies of the pinned repos. Energy and carbon are estimates with bands, never measurements.

| task | tier | variant | rep | input | output | cache read | cache write | thinking | total | USD | Wh (band) | gCO2e (band) | wall ms | grade | success |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | ---: | --- | --- |
| h03 | heavy | vanilla | 1 | 14 | 7,797 | 313,248 | 31,133 | 0 | 352,192 | 0.3978 | 105.66 (35.22 to 352.19) | 49.98 (16.66 to 166.59) | 0 | A | pass |
| h03 | heavy | redutok | 1 | 10 | 6,606 | 243,680 | 36,001 | 0 | 286,297 | 0.3882 | 85.89 (28.63 to 286.30) | 40.63 (13.54 to 135.42) | 78215 | A | pass |

## Medians per task (across repetitions)

| task | vanilla tokens | redutok tokens | token reduction | vanilla USD | redutok USD | USD reduction | vanilla non-cache-read tokens | redutok non-cache-read tokens | non-cache-read reduction | vanilla success | redutok success |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| h03 | 352,192 | 286,297 | 1.2x | 0.3978 | 0.3882 | 1.0x | 38,944 | 42,617 | 0.9x | 1/1 | 1/1 |

## Definition of done

- median token reduction across tasks: 1.2x (threshold: at least 10x, applies to this metric, the raw total-token median) NOT MET
- median USD reduction across tasks: 1.0x (context only, no threshold)
- median non-cache-read token reduction across tasks: 0.9x (context only, no threshold; input plus output plus cache-write plus thinking, excludes the per-turn re-billed cache-read)
- success parity: redutok 100% vs vanilla 100%, parity 100% (threshold: at least 95%) MET
- cumulative spend: 0.7860 USD (meter, prices.yaml), 0.7869 USD (claude CLI reported)

## Failures (savings with success degradation)

None in this run set.

## Incidents

- h03 redutok rep 1, 2026-07-28 (superseded by the clean rerun above; transcripts archived in bench/runs/v3-h03-incident/): 4,364,974 tokens, 2.3615 USD, 45 turns. Verdict: a stale-build port defect caused raw double-reading, and a Write-tool escape-materialization repair loop, model behavior outside governance scope, re-billed the inflated context 41 times. The harness now gates on build freshness and port wiring (scripts/bench-live.mjs), so a stale dist or a hardcoded REDUTOK_PORT aborts the run instead of measuring the wrong code.
