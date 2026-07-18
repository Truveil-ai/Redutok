import { LIMITS, type AuditEvent } from '@redutok/shared';
import { verbosityReport } from './discipline.js';
import type { SessionEnergy } from './energy.js';
import type { SessionLedger } from './ledger.js';

/**
 * Session scoring, architecture 7.4. Formulas in docs/SCORING.md; every input
 * traces to ledger or audit fields. A score with missing inputs is explicitly
 * not scorable with a reason, never a silent default.
 */

export type ScoreResult =
  | { scorable: true; score: number; detail: string }
  | { scorable: false; reason: string };

export interface CompositeScore {
  value: number;
  grade: string;
  weightsUsed: Record<string, number>;
}

export interface SessionScores {
  contextEfficiency: ScoreResult;
  outputDiscipline: ScoreResult;
  cacheUtilization: ScoreResult;
  energyPerOutcome: ScoreResult;
  composite?: CompositeScore;
}

const round = (x: number): number => Math.round(x);

function contextEfficiency(audit: AuditEvent[]): ScoreResult {
  if (audit.length === 0) {
    return { scorable: false, reason: 'no audit events recorded for this session (sidecar not installed or not used)' };
  }
  const served = audit.filter(
    (e) => (e.action === 'distill' || e.action === 'serve-raw') && e.bytesOut !== undefined,
  );
  const rawBytes = served.filter((e) => e.action === 'serve-raw').reduce((n, e) => n + (e.bytesOut ?? 0), 0);
  const distilledBytes = served.filter((e) => e.action === 'distill').reduce((n, e) => n + (e.bytesOut ?? 0), 0);
  const total = rawBytes + distilledBytes;
  if (total === 0) return { scorable: false, reason: 'audit trail has no serve events with byte counts' };
  const score = round((100 * distilledBytes) / total);
  return {
    scorable: true,
    score,
    detail: `${distilledBytes}B distilled vs ${rawBytes}B raw across ${served.length} serves`,
  };
}

function outputDiscipline(ledger: SessionLedger): ScoreResult {
  if (ledger.entries.length === 0) return { scorable: false, reason: 'no assistant turns in the ledger' };
  const v = verbosityReport(ledger);
  const score = round(
    100 * Math.min(1, LIMITS.VERBOSE_OUTPUT_TOKENS_PER_TURN / Math.max(v.avgOutputTokensPerTurn, 1)),
  );
  return {
    scorable: true,
    score,
    detail: `${v.avgOutputTokensPerTurn} avg output tokens per turn, ${v.verboseTurns} verbose of ${v.totalTurns}`,
  };
}

function cacheUtilization(ledger: SessionLedger): ScoreResult {
  if (ledger.entries.length < 2) {
    return { scorable: false, reason: 'fewer than two turns; caching is not possible on the first turn' };
  }
  const later = ledger.entries.slice(1);
  const cacheRead = later.reduce((n, e) => n + e.tokens.cacheRead, 0);
  const input = later.reduce((n, e) => n + e.tokens.input, 0);
  if (cacheRead + input === 0) return { scorable: false, reason: 'no cacheable input tokens after the first turn' };
  const score = round((100 * cacheRead) / (cacheRead + input));
  return { scorable: true, score, detail: `${cacheRead} cache-read of ${cacheRead + input} cacheable input tokens` };
}

function energyPerOutcome(ledger: SessionLedger, energy?: SessionEnergy): ScoreResult {
  if (energy === undefined) return { scorable: false, reason: 'no energy estimate available' };
  if (ledger.entries.length === 0) return { scorable: false, reason: 'no assistant turns in the ledger' };
  if (energy.unestimatedModels.length > 0 && energy.wh.base === 0) {
    return { scorable: false, reason: `no energy factor class for: ${energy.unestimatedModels.join(', ')}` };
  }
  const whPerTurn = energy.wh.base / ledger.entries.length;
  const score = round(100 * Math.min(1, LIMITS.EPO_BASELINE_WH_PER_TURN / Math.max(whPerTurn, 1e-6)));
  return {
    scorable: true,
    score,
    detail: `estimated ${whPerTurn.toFixed(2)} Wh per completed turn against the ${LIMITS.EPO_BASELINE_WH_PER_TURN} Wh reference`,
  };
}

export function gradeFor(value: number): string {
  for (const [bound, letter] of LIMITS.GRADE_BOUNDS) {
    if (value >= bound) return letter;
  }
  return 'F';
}

export function scoreSession(
  ledger: SessionLedger,
  energy: SessionEnergy | undefined,
  audit: AuditEvent[],
): SessionScores {
  const scores: SessionScores = {
    contextEfficiency: contextEfficiency(audit),
    outputDiscipline: outputDiscipline(ledger),
    cacheUtilization: cacheUtilization(ledger),
    energyPerOutcome: energyPerOutcome(ledger, energy),
  };
  const weightsUsed: Record<string, number> = {};
  let weighted = 0;
  let weightSum = 0;
  for (const key of ['contextEfficiency', 'outputDiscipline', 'cacheUtilization', 'energyPerOutcome'] as const) {
    const result = scores[key];
    if (result.scorable) {
      const w = LIMITS.SCORE_WEIGHTS[key];
      weightsUsed[key] = w;
      weighted += w * result.score;
      weightSum += w;
    }
  }
  if (weightSum > 0) {
    const value = round(weighted / weightSum);
    scores.composite = { value, grade: gradeFor(value), weightsUsed };
  }
  return scores;
}
