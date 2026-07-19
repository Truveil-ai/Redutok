# Bench results

model: claude-sonnet-5
date: 2026-07-18 (latest fixture log timestamp)
repetitions: 1 (replay mode measures committed fixture logs once)
machine: win32-x64, node v24.14.1

Replay-mode figures measure committed fixture session logs, not fresh live runs. Energy and carbon are estimates with bands, never measurements.

| task | tier | variant | input | output | cache read | cache write | thinking | total | USD | Wh (band) | gCO2e (band) | wall ms | grade | success |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | ---: | --- | --- |
| t01 | small | vanilla | 193,448 | 124,680 | 8,348,542 | 66,678 | 39,461 | 8,772,809 | 2.8921 | 1800.38 (568.55 to 5685.48) | 851.58 (268.92 to 2689.23) | 2235000 | A | pass |
| t01 | small | redutok | 2,160 | 1,470 | 15,100 | 920 | 450 | 20,100 | 0.0288 | 6.03 (2.01 to 20.10) | 2.85 (0.95 to 9.51) | 15000 | A | pass |
| t02 | small | vanilla | 26,335 | 18,717 | 190,299 | 9,524 | 5,975 | 250,850 | 0.3615 | 75.25 (25.09 to 250.85) | 35.60 (11.87 to 118.65) | 285000 | A | FAIL |
| t02 | small | redutok | 2,160 | 1,470 | 15,100 | 920 | 450 | 20,100 | 0.0288 | 6.03 (2.01 to 20.10) | 2.85 (0.95 to 9.51) | 15000 | A | FAIL |
| t03 | small | vanilla | 193,448 | 124,680 | 8,348,542 | 66,678 | 39,461 | 8,772,809 | 2.8921 | 1800.38 (568.55 to 5685.48) | 851.58 (268.92 to 2689.23) | 2235000 | A | pass |
| t03 | small | redutok | 2,160 | 1,470 | 15,100 | 920 | 450 | 20,100 | 0.0288 | 6.03 (2.01 to 20.10) | 2.85 (0.95 to 9.51) | 15000 | A | pass |
| t04 | small | vanilla | 26,335 | 18,717 | 190,299 | 9,524 | 5,975 | 250,850 | 0.3615 | 75.25 (25.09 to 250.85) | 35.60 (11.87 to 118.65) | 285000 | A | pass |
| t04 | small | redutok | 2,160 | 1,470 | 15,100 | 920 | 450 | 20,100 | 0.0288 | 6.03 (2.01 to 20.10) | 2.85 (0.95 to 9.51) | 15000 | A | pass |
| t05 | medium | vanilla | 193,448 | 124,680 | 8,348,542 | 66,678 | 39,461 | 8,772,809 | 2.8921 | 1800.38 (568.55 to 5685.48) | 851.58 (268.92 to 2689.23) | 2235000 | A | FAIL |
| t05 | medium | redutok | 26,335 | 18,717 | 190,299 | 9,524 | 5,975 | 250,850 | 0.3615 | 75.25 (25.09 to 250.85) | 35.60 (11.87 to 118.65) | 285000 | A | FAIL |
| t06 | medium | vanilla | 193,448 | 124,680 | 8,348,542 | 66,678 | 39,461 | 8,772,809 | 2.8921 | 1800.38 (568.55 to 5685.48) | 851.58 (268.92 to 2689.23) | 2235000 | A | FAIL |
| t06 | medium | redutok | 26,335 | 18,717 | 190,299 | 9,524 | 5,975 | 250,850 | 0.3615 | 75.25 (25.09 to 250.85) | 35.60 (11.87 to 118.65) | 285000 | A | FAIL |
| t07 | medium | vanilla | 193,448 | 124,680 | 8,348,542 | 66,678 | 39,461 | 8,772,809 | 2.8921 | 1800.38 (568.55 to 5685.48) | 851.58 (268.92 to 2689.23) | 2235000 | A | FAIL |
| t07 | medium | redutok | 26,335 | 18,717 | 190,299 | 9,524 | 5,975 | 250,850 | 0.3615 | 75.25 (25.09 to 250.85) | 35.60 (11.87 to 118.65) | 285000 | A | FAIL |
| t08 | large | vanilla | 193,448 | 124,680 | 8,348,542 | 66,678 | 39,461 | 8,772,809 | 2.8921 | 1800.38 (568.55 to 5685.48) | 851.58 (268.92 to 2689.23) | 2235000 | A | pass |
| t08 | large | redutok | 2,160 | 1,470 | 15,100 | 920 | 450 | 20,100 | 0.0288 | 6.03 (2.01 to 20.10) | 2.85 (0.95 to 9.51) | 15000 | A | pass |
| t09 | large | vanilla | 193,448 | 124,680 | 8,348,542 | 66,678 | 39,461 | 8,772,809 | 2.8921 | 1800.38 (568.55 to 5685.48) | 851.58 (268.92 to 2689.23) | 2235000 | A | pass |
| t09 | large | redutok | 26,335 | 18,717 | 190,299 | 9,524 | 5,975 | 250,850 | 0.3615 | 75.25 (25.09 to 250.85) | 35.60 (11.87 to 118.65) | 285000 | A | pass |
| t10 | large | vanilla | 193,448 | 124,680 | 8,348,542 | 66,678 | 39,461 | 8,772,809 | 2.8921 | 1800.38 (568.55 to 5685.48) | 851.58 (268.92 to 2689.23) | 2235000 | A | pass |
| t10 | large | redutok | 2,160 | 1,470 | 15,100 | 920 | 450 | 20,100 | 0.0288 | 6.03 (2.01 to 20.10) | 2.85 (0.95 to 9.51) | 15000 | A | FAIL |

## Savings per task (vanilla over redutok, medians across repetitions)

- t01: 436.5x tokens (8,772,809 to 20,100)
- t02: 12.5x tokens (250,850 to 20,100)
- t03: 436.5x tokens (8,772,809 to 20,100)
- t04: 12.5x tokens (250,850 to 20,100)
- t05: 35.0x tokens (8,772,809 to 250,850)
- t06: 35.0x tokens (8,772,809 to 250,850)
- t07: 35.0x tokens (8,772,809 to 250,850)
- t08: 436.5x tokens (8,772,809 to 20,100)
- t09: 35.0x tokens (8,772,809 to 250,850)
- t10: 436.5x tokens (8,772,809 to 20,100)

## Failures (savings with success degradation)

- t10: 436.5x savings but redutok run failed its success checks (file-contains packages/sidecar/src/distill.ts: pass; file-contains packages/sidecar/src/distill.ts: FAIL). Savings without success are failures.
