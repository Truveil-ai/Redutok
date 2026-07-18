# Energy and Carbon Estimation Methodology

DRAFT, PENDING FOUNDER VERIFICATION. Every numeric input referenced below is
currently marked TODO-VERIFY in its yaml file. Nothing in this document may be
quoted publicly until each citation has been verified by a human and the
TODO-VERIFY markers removed. All figures produced by this model are estimates,
never measurements.

## What is estimated

For each session the meter reports two quantities, each as a base value with
an uncertainty band:

- Estimated inference energy, in Wh.
- Estimated carbon, in gCO2e.

## Inputs

Every number in the model comes from one of two yaml files. This document
deliberately restates none of them, so that a value can never go stale here:

- `packages/shared/energy_factors.yaml`: per model class (frontier-large,
  frontier-mid, small), a Wh per million tokens factor as a base with low and
  high band columns, a model-to-class mapping, and a context-length multiplier
  curve given as breakpoints. Each row names its verification sources in
  `citation_hint`: the TokenPowerBench paper (AAAI 2026, arXiv 2512.03024) and
  the ML.ENERGY leaderboard v3 (University of Michigan).
- `packages/shared/grid_intensity.yaml`: gCO2e per kWh by region with a
  conservative world default. Each row names its verification sources in
  `citation_hint`: IEA, Ember, and EPA eGRID.

## Estimation model

Implemented in `packages/meter/src/energy.ts` and reproduced by tests from the
yaml inputs alone (`packages/meter/test/energy.test.ts`).

For each assistant turn in the session ledger:

1. Map the turn's model id to a model class via the `models` list in
   `energy_factors.yaml`. Turns with unmapped models are excluded from the
   estimate and reported by name; they are never silently costed at zero.
2. Token count for the turn is the sum of all five classes: input, output,
   cache read, cache write, thinking.
3. Context length for the turn is approximated as input plus cache read
   tokens. The context multiplier is the first curve breakpoint at or above
   that length; beyond the last breakpoint the last multiplier is used.
4. Turn energy in Wh, computed three times (base, low, high):
   tokens / 1,000,000 x whPerMTok x multiplier.

Session energy is the sum over turns. Carbon is session energy converted to
kWh and multiplied by the configured region's gCO2e per kWh; the region
defaults to the conservative world row.

The sidecar's own local consumption will be measured and charged against the
savings once the sidecar exists (Phase 3). Until then the report carries an
explicit self-consumption line item stubbed at 0 Wh so the omission is
visible rather than silent.

## Assumptions

- All token classes cost the same energy per token within a model class. In
  reality cache reads are cheaper than fresh prefill; treating them as equal
  overstates energy for cache-heavy sessions, which errs conservative for
  savings claims but overstates absolute footprint.
- The context multiplier curve is a step function over per-turn context
  length, standing in for the superlinear growth of attention cost. The
  breakpoint values are unverified placeholders.
- Thinking tokens are treated as ordinary generated tokens.
- Grid intensity is a single annual average per region; no time-of-day or
  marginal-emissions modelling.
- Datacenter overhead (PUE), embodied hardware carbon, networking, and
  training amortisation are all out of scope; this model covers inference
  electricity only.

## Limitations

- Model-class factors span an order of magnitude because provider-side
  batching, hardware generation, and serving efficiency are unobservable from
  the client. The band is the honest statement; the base is a midpoint
  convenience, not a claim.
- Anthropic does not publish per-request energy figures. Until the
  citation_hint sources are verified and transcribed by the founder, every
  output of this model is a placeholder magnitude, suitable for building and
  testing the pipeline and for nothing else.
- Session transcripts do not expose a separate thinking token count today;
  where absent it is tallied as zero inside output, understating thinking.

## Verification checklist for the founder

1. Replace every whPerMTok base, low, high in `energy_factors.yaml` with
   values traced to the named sources; update `source:` from TODO-VERIFY to
   the citation.
2. Replace the context multiplier breakpoints with curve data from the same
   sources, or remove the curve if the sources do not support one.
3. Replace each grid intensity value with the latest published figure and
   cite it.
4. Delete the TODO-VERIFY register entry in PROGRESS.md and the provisional
   header in each yaml, then remove the DRAFT marker at the top of this file.
