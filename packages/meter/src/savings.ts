import { LIMITS, type AuditEvent, type EnergyFactorsFile, type GridIntensityFile, type PricesFile } from '@redutok/shared';
import type { EstimateBand } from './energy.js';
import type { SessionLedger } from './ledger.js';
import type { ScoreResult } from './scoring.js';

/**
 * What a session saved, computed once.
 *
 * The receipt and the report both answer "what did this cost me, and what did
 * it save" and used to answer from separate code, which is how two surfaces
 * end up disagreeing about one session. Everything either of them says about
 * savings comes from here.
 *
 * Every figure is derived from the session-attributed audit trail and the
 * yaml rate inputs. Nothing here is measured: token counts come from the same
 * 4-bytes-per-token heuristic the sidecar uses for handles, and energy and
 * carbon are banded estimates per docs/METHODOLOGY.md.
 */

/** An artifact that entered context whole, with the reason it did. */
export interface Passthrough {
  path: string;
  rawTokens: number;
  reason: string;
}

export interface Distillation {
  /** Distill profile name when recorded, else the emitting module. */
  label: string;
  /** Artifact reference for zooming, else the audit event id. */
  ref: string;
  rawTokens: number;
  servedTokens: number;
  avoidedTokens: number;
}

export interface SessionSavings {
  /** False when the session produced no serve at all. */
  governed: boolean;
  /** Why context efficiency could not be scored, when it could not. */
  notScorableReason?: string;
  /** Serve events carrying both a raw and a served byte count. */
  serves: number;
  /** Raw tokens the session touched through those serves. */
  rawTokens: number;
  /** Tokens actually served into context. */
  servedTokens: number;
  avoidedTokens: number;
  /** rawTokens / servedTokens; undefined when nothing was served. */
  ratio?: number;
  /** Avoided tokens priced at the session's own input rate row. */
  costAvoidedUsd?: number;
  /** The model whose rate row priced it, so the figure is attributable. */
  rateModel?: string;
  /** Estimated, never measured; bands per docs/METHODOLOGY.md. */
  energyAvoidedWh?: EstimateBand;
  co2AvoidedGrams?: EstimateBand;
  region?: string;
  gCo2ePerKwh?: number;
  /** Top three distillations by tokens avoided. */
  topDistillations: Distillation[];
  passthroughs: Passthrough[];
  /**
   * A floor on what distilling the passthroughs would have saved. The size
   * gate refuses any distillate over SIZE_SANITY_MAX_RATIO of its raw, so at
   * least the remainder would have been avoided: arithmetic on a published
   * bound, not a projection.
   */
  estimatedAvoidableTokens: number;
}

/** The same 4-bytes-per-token heuristic the sidecar uses for handle estimates. */
export const bytesToTokens = (bytes: number): number => Math.round(bytes / 4);

export interface SavingsInputs {
  ledger: SessionLedger;
  /** Audit events already filtered to this session. */
  audit: AuditEvent[];
  contextEfficiency: ScoreResult;
  prices: PricesFile;
  factors: EnergyFactorsFile;
  grid: GridIntensityFile;
  region?: string;
}

/** The model that carried the most turns: the session's own rate row. */
function dominantModel(ledger: SessionLedger): string | undefined {
  const turns = new Map<string, number>();
  for (const entry of ledger.entries) turns.set(entry.model, (turns.get(entry.model) ?? 0) + 1);
  return [...turns.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

export function computeSessionSavings(inputs: SavingsInputs): SessionSavings {
  const { ledger, audit } = inputs;
  // Only serves that recorded both halves can say anything about savings: a
  // served byte count with no raw behind it is not a measurement of anything.
  const serves = audit.filter(
    (e): e is AuditEvent & { bytesIn: number; bytesOut: number } =>
      (e.action === 'distill' || e.action === 'serve-raw') &&
      e.bytesIn !== undefined &&
      e.bytesOut !== undefined,
  );
  const rawBytes = serves.reduce((n, e) => n + e.bytesIn, 0);
  const servedBytes = serves.reduce((n, e) => n + e.bytesOut, 0);
  const rawTokens = bytesToTokens(rawBytes);
  const servedTokens = bytesToTokens(servedBytes);
  const avoidedTokens = Math.max(0, rawTokens - servedTokens);

  const topDistillations = serves
    .filter((e) => e.action === 'distill')
    .map((e) => ({
      label: typeof e.details?.['profile'] === 'string' ? (e.details['profile'] as string) : e.module,
      ref: e.inputRef ?? e.id,
      rawTokens: bytesToTokens(e.bytesIn),
      servedTokens: bytesToTokens(e.bytesOut),
      avoidedTokens: Math.max(0, bytesToTokens(e.bytesIn) - bytesToTokens(e.bytesOut)),
    }))
    .sort((a, b) => b.avoidedTokens - a.avoidedTokens)
    .slice(0, 3);

  const passthroughs = audit
    .filter((e) => e.action === 'passthrough')
    .map((e) => ({
      path: typeof e.details?.['path'] === 'string' ? (e.details['path'] as string) : '(unnamed)',
      rawTokens: bytesToTokens(e.bytesIn ?? 0),
      reason:
        typeof e.details?.['reason'] === 'string'
          ? (e.details['reason'] as string)
          : 'no skeleton available',
    }))
    .sort((a, b) => b.rawTokens - a.rawTokens);

  const savings: SessionSavings = {
    governed: serves.length > 0,
    notScorableReason: inputs.contextEfficiency.scorable ? undefined : inputs.contextEfficiency.reason,
    serves: serves.length,
    rawTokens,
    servedTokens,
    avoidedTokens,
    ratio: servedTokens > 0 ? rawTokens / servedTokens : undefined,
    topDistillations,
    passthroughs,
    estimatedAvoidableTokens: Math.round(
      passthroughs.reduce((n, p) => n + p.rawTokens, 0) * (1 - LIMITS.SIZE_SANITY_MAX_RATIO),
    ),
  };

  const model = dominantModel(ledger);
  if (model === undefined || avoidedTokens === 0) return savings;

  // Avoided tokens are context tokens that never entered a prompt, so they
  // are priced at the input rate of the row that priced the session itself.
  const priceRow = inputs.prices.models.find((row) => row.id === model);
  if (priceRow !== undefined) {
    savings.costAvoidedUsd = (avoidedTokens * priceRow.inputPerMTokUsd) / 1_000_000;
    savings.rateModel = model;
  }

  // Energy the avoided tokens would have carried, at the model's factor class
  // and the session's grid region. Banded, and an estimate throughout.
  const factorRow = inputs.factors.classes.find((row) => row.models.includes(model));
  const regionKey = inputs.region ?? inputs.grid.defaultRegion;
  const gridRow = inputs.grid.regions.find((r) => r.region === regionKey);
  if (factorRow !== undefined && gridRow !== undefined) {
    const mtok = avoidedTokens / 1_000_000;
    const wh: EstimateBand = {
      base: mtok * factorRow.whPerMTok.base,
      low: mtok * factorRow.whPerMTok.low,
      high: mtok * factorRow.whPerMTok.high,
    };
    const toGrams = (x: number): number => (x / 1000) * gridRow.gCo2ePerKwh;
    savings.energyAvoidedWh = wh;
    savings.co2AvoidedGrams = { base: toGrams(wh.base), low: toGrams(wh.low), high: toGrams(wh.high) };
    savings.region = regionKey;
    savings.gCo2ePerKwh = gridRow.gCo2ePerKwh;
  }
  return savings;
}

const fmt = (n: number): string => Math.round(n).toLocaleString('en-US');

/**
 * The savings block, rendered once for both the report and any other surface
 * that wants it. Indented two spaces to match the report's other sections.
 */
export function renderSavingsLines(savings: SessionSavings): string[] {
  if (!savings.governed) {
    const lines = ['  nothing was governed this session: no artifact was distilled or served'];
    if (savings.notScorableReason !== undefined) {
      lines.push(`  context efficiency is not scorable: ${savings.notScorableReason}`);
    }
    lines.push(...passthroughLines(savings));
    return lines;
  }
  const lines = [
    `  raw touched     ${fmt(savings.rawTokens)} tokens across ${savings.serves} serves`,
    `  served          ${fmt(savings.servedTokens)} tokens`,
    `  avoided         ${fmt(savings.avoidedTokens)} tokens${
      savings.ratio === undefined ? '' : ` (${savings.ratio.toFixed(1)}x)`
    }`,
  ];
  if (savings.costAvoidedUsd !== undefined) {
    lines.push(
      `  cost avoided    estimated ${savings.costAvoidedUsd.toFixed(4)} USD at the ${savings.rateModel ?? 'session'} input rate`,
    );
  }
  const band = (b: EstimateBand, unit: string): string =>
    `estimated ${b.base.toFixed(2)} ${unit} (band ${b.low.toFixed(2)} to ${b.high.toFixed(2)} ${unit})`;
  if (savings.energyAvoidedWh !== undefined) {
    lines.push(`  energy avoided  ${band(savings.energyAvoidedWh, 'Wh')}`);
  }
  if (savings.co2AvoidedGrams !== undefined) {
    lines.push(
      `  carbon avoided  ${band(savings.co2AvoidedGrams, 'gCO2e')}, grid region ${savings.region ?? 'unknown'} at ${savings.gCo2ePerKwh ?? 0} gCO2e/kWh`,
    );
  }
  if (savings.topDistillations.length > 0) {
    lines.push('  top distillations by tokens avoided');
    savings.topDistillations.forEach((d, i) => {
      lines.push(
        `    ${i + 1}. ${d.label} (${d.ref}): ${fmt(d.rawTokens)} raw to ${fmt(d.servedTokens)} served, ${fmt(d.avoidedTokens)} avoided`,
      );
    });
  }
  lines.push(...passthroughLines(savings));
  return lines;
}

/**
 * The artifacts that entered context whole, each with the reason no skeleton
 * covered it, and what distilling them would have saved as a stated floor.
 */
export function passthroughLines(savings: SessionSavings): string[] {
  if (savings.passthroughs.length === 0) return [];
  const lines = [`  read raw        ${savings.passthroughs.length} large artifacts entered context whole`];
  for (const p of savings.passthroughs) {
    lines.push(`    ${p.path}: ${fmt(p.rawTokens)} tokens, ${p.reason}`);
  }
  lines.push(
    `  had those been distilled, an estimated ${fmt(savings.estimatedAvoidableTokens)} tokens would have been avoided ` +
      `(a floor: the size gate refuses any distillate over ${Math.round(LIMITS.SIZE_SANITY_MAX_RATIO * 100)} percent of its raw)`,
  );
  return lines;
}
