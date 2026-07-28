import { LIMITS } from './limits.js';
import type { CandidateRecord } from './schemas.js';

/**
 * Candidate confidence, docs/GRADUATION.md. Derived from occurrence count
 * (saturating), recency (half-life decay on lastSeen), and recorded
 * contradictions (flat penalty each). Computed on demand so displayed and
 * decided values always reflect the current clock; the graduation pass also
 * persists the value it acted on in record.confidence.
 */

const DAY_MS = 24 * 3600 * 1000;

export function candidateConfidence(record: CandidateRecord, now: Date): number {
  const g = LIMITS.GRADUATION;
  const occurrenceScore = 1 - 0.5 ** (record.occurrences / g.OCCURRENCE_HALF_SATURATION);
  const ageDays = Math.max(0, now.getTime() - new Date(record.lastSeen).getTime()) / DAY_MS;
  const recencyFactor = 0.5 ** (ageDays / g.RECENCY_HALF_LIFE_DAYS);
  const penalty = g.CONTRADICTION_PENALTY * (record.contradiction ?? 0);
  return Math.min(1, Math.max(0, occurrenceScore * recencyFactor - penalty));
}

/** Eligible to graduate: still a candidate and at or above the graduation threshold. */
export function isEligibleForGraduation(record: CandidateRecord, now: Date): boolean {
  return (
    record.status === 'candidate' &&
    candidateConfidence(record, now) >= LIMITS.GRADUATION.GRADUATE_MIN_CONFIDENCE
  );
}

/**
 * Due for withdrawal: graduated, actually contradicted, and below the
 * demotion threshold. Contradiction evidence is required — recency decay
 * alone never withdraws an entry (docs/GRADUATION.md).
 */
export function isBelowWithdrawal(record: CandidateRecord, now: Date): boolean {
  return (
    record.status === 'graduated' &&
    (record.contradiction ?? 0) > 0 &&
    candidateConfidence(record, now) < LIMITS.GRADUATION.WITHDRAW_BELOW_CONFIDENCE
  );
}
