# Bench results (live)

model: claude-sonnet-5
date: 2026-07-19
repetitions: 1
machine: win32-x64, node v24.14.1

Live-mode figures measure fresh headless claude CLI runs in isolated copies of the pinned repos. Energy and carbon are estimates with bands, never measurements.

| task | tier | variant | rep | input | output | cache read | cache write | thinking | total | USD | Wh (band) | gCO2e (band) | wall ms | grade | success |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | ---: | --- | --- |
| t01 | small | vanilla | 1 | 12 | 1,670 | 264,230 | 17,022 | 0 | 282,934 | 0.1121 | 84.88 (28.29 to 282.93) | 40.15 (13.38 to 133.83) | 38397 | A | pass |
| t01 | small | redutok | 1 | 10 | 1,711 | 224,234 | 19,230 | 0 | 245,185 | 0.1101 | 73.56 (24.52 to 245.19) | 34.79 (11.60 to 115.97) | 34852 | A | pass |
| t02 | small | vanilla | 1 | 8 | 517 | 166,844 | 16,021 | 0 | 183,390 | 0.0786 | 55.02 (18.34 to 183.39) | 26.02 (8.67 to 86.74) | 24941 | A | pass |
| t02 | small | redutok | 1 | 14 | 1,652 | 324,714 | 18,552 | 0 | 344,932 | 0.1279 | 103.48 (34.49 to 344.93) | 48.95 (16.32 to 163.15) | 46935 | A | pass |
| t03 | small | vanilla | 1 | 10 | 1,247 | 215,962 | 16,969 | 0 | 234,188 | 0.0981 | 70.26 (23.42 to 234.19) | 33.23 (11.08 to 110.77) | 29999 | A | pass |
| t03 | small | redutok | 1 | 14 | 2,197 | 325,813 | 20,142 | 0 | 348,166 | 0.1375 | 104.45 (34.82 to 348.17) | 49.40 (16.47 to 164.68) | 47174 | A | pass |
| t04 | small | vanilla | 1 | 16 | 1,701 | 362,672 | 17,500 | 0 | 381,889 | 0.1333 | 114.57 (38.19 to 381.89) | 54.19 (18.06 to 180.63) | 46933 | A | pass |
| t04 | small | redutok | 1 | 8 | 2,619 | 174,103 | 19,016 | 0 | 195,746 | 0.1086 | 58.72 (19.57 to 195.75) | 27.78 (9.26 to 92.59) | 50007 | A | pass |
| t05 | medium | vanilla | 1 | 26 | 3,173 | 626,505 | 20,327 | 0 | 650,031 | 0.2079 | 195.01 (65.00 to 650.03) | 92.24 (30.75 to 307.46) | 63615 | A | pass |
| t05 | medium | redutok | 1 | 60 | 10,672 | 1,687,417 | 33,811 | 0 | 1,731,960 | 0.5289 | 519.59 (173.20 to 1731.96) | 245.77 (81.92 to 819.22) | 214106 | A | pass |
| t06 | medium | vanilla | 1 | 6 | 418 | 122,450 | 17,926 | 0 | 140,800 | 0.0735 | 42.24 (14.08 to 140.80) | 19.98 (6.66 to 66.60) | 19580 | A | pass |
| t06 | medium | redutok | 1 | 12 | 830 | 279,902 | 19,600 | 0 | 300,344 | 0.1133 | 90.10 (30.03 to 300.34) | 42.62 (14.21 to 142.06) | 31107 | A | pass |
| t07 | medium | vanilla | 1 | 14 | 2,420 | 329,379 | 21,438 | 0 | 353,251 | 0.1437 | 105.98 (35.33 to 353.25) | 50.13 (16.71 to 167.09) | 50420 | A | pass |
| t07 | medium | redutok | 1 | 24 | 3,901 | 631,383 | 27,294 | 0 | 662,602 | 0.2336 | 198.78 (66.26 to 662.60) | 94.02 (31.34 to 313.41) | 232925 | A | pass |
| t08 | large | vanilla | 1 | 34 | 5,897 | 946,014 | 35,951 | 0 | 987,896 | 0.3381 | 296.37 (98.79 to 987.90) | 140.18 (46.73 to 467.27) | 89254 | A | pass |
| t08 | large | redutok | 1 | 30 | 4,973 | 864,282 | 43,426 | 0 | 912,711 | 0.3312 | 273.81 (91.27 to 912.71) | 129.51 (43.17 to 431.71) | 84431 | A | FAIL |
| t09 | large | vanilla | 1 | 18 | 5,249 | 475,371 | 37,781 | 0 | 518,419 | 0.2421 | 155.53 (51.84 to 518.42) | 73.56 (24.52 to 245.21) | 77301 | A | pass |
| t09 | large | redutok | 1 | 12 | 5,742 | 313,985 | 34,604 | 0 | 354,343 | 0.2068 | 106.30 (35.43 to 354.34) | 50.28 (16.76 to 167.60) | 95797 | A | pass |
| t10 | large | vanilla | 1 | 22 | 4,164 | 648,424 | 49,814 | 0 | 702,424 | 0.2959 | 210.73 (70.24 to 702.42) | 99.67 (33.22 to 332.25) | 79777 | A | pass |
| t10 | large | redutok | 1 | 24 | 8,793 | 706,472 | 53,412 | 0 | 768,701 | 0.3628 | 230.61 (76.87 to 768.70) | 109.08 (36.36 to 363.60) | 142951 | A | FAIL |

## Medians per task (across repetitions)

| task | vanilla tokens | redutok tokens | token reduction | vanilla USD | redutok USD | USD reduction | vanilla non-cache-read tokens | redutok non-cache-read tokens | non-cache-read reduction | vanilla success | redutok success |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| t01 | 282,934 | 245,185 | 1.2x | 0.1121 | 0.1101 | 1.0x | 18,704 | 20,951 | 0.9x | 1/1 | 1/1 |
| t02 | 183,390 | 344,932 | 0.5x | 0.0786 | 0.1279 | 0.6x | 16,546 | 20,218 | 0.8x | 1/1 | 1/1 |
| t03 | 234,188 | 348,166 | 0.7x | 0.0981 | 0.1375 | 0.7x | 18,226 | 22,353 | 0.8x | 1/1 | 1/1 |
| t04 | 381,889 | 195,746 | 2.0x | 0.1333 | 0.1086 | 1.2x | 19,217 | 21,643 | 0.9x | 1/1 | 1/1 |
| t05 | 650,031 | 1,731,960 | 0.4x | 0.2079 | 0.5289 | 0.4x | 23,526 | 44,543 | 0.5x | 1/1 | 1/1 |
| t06 | 140,800 | 300,344 | 0.5x | 0.0735 | 0.1133 | 0.6x | 18,350 | 20,442 | 0.9x | 1/1 | 1/1 |
| t07 | 353,251 | 662,602 | 0.5x | 0.1437 | 0.2336 | 0.6x | 23,872 | 31,219 | 0.8x | 1/1 | 1/1 |
| t08 | 987,896 | 912,711 | 1.1x | 0.3381 | 0.3312 | 1.0x | 41,882 | 48,429 | 0.9x | 1/1 | 0/1 |
| t09 | 518,419 | 354,343 | 1.5x | 0.2421 | 0.2068 | 1.2x | 43,048 | 40,358 | 1.1x | 1/1 | 1/1 |
| t10 | 702,424 | 768,701 | 0.9x | 0.2959 | 0.3628 | 0.8x | 54,000 | 62,229 | 0.9x | 1/1 | 0/1 |

## Definition of done

- median token reduction across tasks: 0.8x (threshold: at least 10x, applies to this metric, the raw total-token median) NOT MET
- median USD reduction across tasks: 0.8x (context only, no threshold)
- median non-cache-read token reduction across tasks: 0.9x (context only, no threshold; input plus output plus cache-write plus thinking, excludes the per-turn re-billed cache-read)
- success parity: redutok 80% vs vanilla 100%, parity 80% (threshold: at least 95%) NOT MET
- cumulative spend: 3.9838 USD (meter, prices.yaml), 7.1966 USD (claude CLI reported)

## Failures (savings with success degradation)

- t08 rep 1: 1.1x savings but the redutok run failed its success checks (answer-contains AuditEventSchema: pass; answer-contains audit-file: FAIL). Savings without success are failures.
