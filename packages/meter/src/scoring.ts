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
  /**
   * Letter grade, present only when at least
   * LIMITS.COMPOSITE_MIN_SCORES_FOR_GRADE of the four scores contributed.
   * Absent on a partial composite so no consumer can render a grade the
   * session did not earn; the type makes that a compile error, not a habit.
   */
  grade?: string;
  /** How many of the four scores were scorable and fed the weighted mean. */
  contributing: number;
  /** How many scores exist in total; four, per docs/SCORING.md. */
  total: number;
  /** True when too few scores contributed for a letter grade. */
  partial: boolean;
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

function contextEfficiency(audit: AuditEvent[], ledger: SessionLedger): ScoreResult {
  if (audit.length === 0) {
    // Guardrail: never claim non-use when dcp calls are visible in the tool
    // table. Zero matching events plus visible use means the recorded events
    // are not attributed to this transcript session id, not that the sidecar
    // was absent.
    const dcpVisible = Object.keys(ledger.byTool).some((tool) => /(^|__)dcp__/.test(tool));
    if (dcpVisible) {
      return {
        scorable: false,
        reason:
          'audit events not attributable to this session (dcp tools appear in the tool table but no audit events carry this session id; restart the sidecar so the hooks can register the session)',
      };
    }
    return { scorable: false, reason: 'no audit events recorded for this session (sidecar not installed or not used)' };
  }
  // Every serve is measured against the raw it stood in for, so the score is
  // the share of touched bytes that never entered context. A serve carrying
  // no raw byte count cannot contribute: it says what was served and nothing
  // about what that replaced.
  //
  // The redundancy signal the older ratio carried is preserved exactly. A raw
  // serve (gate failure, no skeleton) has bytesOut equal to bytesIn, so it
  // avoids nothing and pulls the score down by its full weight. What is gone
  // is the degenerate case: a session where nothing failed open used to score
  // 100 no matter how little it saved, and the on-demand document path
  // contributed no raw serve at all, so that ratio ran against zero.
  const served = audit.filter(
    (e): e is AuditEvent & { bytesIn: number; bytesOut: number } =>
      (e.action === 'distill' || e.action === 'serve-raw') &&
      e.bytesIn !== undefined &&
      e.bytesOut !== undefined,
  );
  const rawBytes = served.reduce((n, e) => n + e.bytesIn, 0);
  const servedBytes = served.reduce((n, e) => n + e.bytesOut, 0);
  if (rawBytes === 0) {
    return {
      scorable: false,
      reason:
        'audit trail has no serve events carrying a raw byte count, so there is nothing to measure the served bytes against',
    };
  }
  // Clamped: a distillate larger than its raw (a short document whose
  // structure map exceeds it) would otherwise render a negative share.
  const score = Math.min(100, Math.max(0, round((100 * (rawBytes - servedBytes)) / rawBytes)));
  return {
    scorable: true,
    score,
    detail: `${servedBytes}B served for ${rawBytes}B raw across ${served.length} serves`,
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

export type SessionShape = 'chat' | 'mixed' | 'agentic';

/** Session shape from tool-cycle density: the share of turns invoking tools. */
export function sessionShape(ledger: SessionLedger): { shape: SessionShape; toolDensity: number } {
  const turns = ledger.entries.length;
  const toolTurns = ledger.entries.filter((e) => e.tools.length > 0).length;
  const toolDensity = turns === 0 ? 0 : toolTurns / turns;
  const bounds = LIMITS.SESSION_SHAPE_TOOL_DENSITY;
  const shape: SessionShape =
    toolDensity < bounds.chatMax ? 'chat' : toolDensity < bounds.mixedMax ? 'mixed' : 'agentic';
  return { shape, toolDensity };
}

function energyPerOutcome(ledger: SessionLedger, energy?: SessionEnergy): ScoreResult {
  if (energy === undefined) return { scorable: false, reason: 'no energy estimate available' };
  if (ledger.entries.length === 0) return { scorable: false, reason: 'no assistant turns in the ledger' };
  if (energy.unestimatedModels.length > 0 && energy.wh.base === 0) {
    return { scorable: false, reason: `no energy factor class for: ${energy.unestimatedModels.join(', ')}` };
  }
  const { shape, toolDensity } = sessionShape(ledger);
  const baseline = LIMITS.EPO_BASELINE_WH_PER_TURN_BY_SHAPE[shape];
  const whPerTurn = energy.wh.base / ledger.entries.length;
  const score = round(100 * Math.min(1, baseline / Math.max(whPerTurn, 1e-6)));
  return {
    scorable: true,
    score,
    detail: `estimated ${whPerTurn.toFixed(2)} Wh per completed turn against the ${baseline} Wh ${shape} reference, tool density ${toolDensity.toFixed(2)} (proxy: turns, see docs/SCORING.md)`,
  };
}

export function gradeFor(value: number): string {
  for (const [bound, letter] of LIMITS.GRADE_BOUNDS) {
    if (value >= bound) return letter;
  }
  return 'F';
}

/**
 * The one place a composite is turned into text. Every surface that shows a
 * composite goes through here so the disclosure cannot drift between the
 * report, the badge, and the receipt.
 */
export function renderCompositeValue(composite: CompositeScore): string {
  const { value, grade, contributing, total, partial } = composite;
  if (partial) {
    return `${value} (partial, from ${contributing} of ${total} scores; no grade below ${LIMITS.COMPOSITE_MIN_SCORES_FOR_GRADE})`;
  }
  if (contributing < total) return `${value} (${grade}, from ${contributing} of ${total} scores)`;
  return `${value} (${grade})`;
}

/**
 * Compact composite for table cells (bench tables, badges): the letter when
 * one was earned, an explicit partial marker when it was not.
 */
export function compositeCell(composite: CompositeScore | undefined): string {
  if (composite === undefined) return 'n/a';
  if (composite.partial) return `partial ${composite.contributing}/${composite.total}`;
  return composite.grade ?? 'n/a';
}

export function scoreSession(
  ledger: SessionLedger,
  energy: SessionEnergy | undefined,
  audit: AuditEvent[],
): SessionScores {
  const scores: SessionScores = {
    contextEfficiency: contextEfficiency(audit, ledger),
    outputDiscipline: outputDiscipline(ledger),
    cacheUtilization: cacheUtilization(ledger),
    energyPerOutcome: energyPerOutcome(ledger, energy),
  };
  const keys = ['contextEfficiency', 'outputDiscipline', 'cacheUtilization', 'energyPerOutcome'] as const;
  const weightsUsed: Record<string, number> = {};
  let weighted = 0;
  let weightSum = 0;
  let contributing = 0;
  for (const key of keys) {
    const result = scores[key];
    if (result.scorable) {
      const w = LIMITS.SCORE_WEIGHTS[key];
      weightsUsed[key] = w;
      weighted += w * result.score;
      weightSum += w;
      contributing += 1;
    }
  }
  if (weightSum > 0) {
    const value = round(weighted / weightSum);
    const partial = contributing < LIMITS.COMPOSITE_MIN_SCORES_FOR_GRADE;
    scores.composite = {
      value,
      // Withheld outright when partial, rather than carried alongside a flag
      // a caller might forget to check.
      ...(partial ? {} : { grade: gradeFor(value) }),
      contributing,
      total: keys.length,
      partial,
      weightsUsed,
    };
  }
  return scores;
}
